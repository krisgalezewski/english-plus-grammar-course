#!/usr/bin/env python3
"""
Generates every audio file the English+ course expects, using the Google
Cloud Text-to-Speech REST API.

Usage:
    python3 generate_audio.py YOUR_API_KEY

Requirements:
    pip install requests pydub
    Also needs ffmpeg installed and on PATH (pydub uses it to write mp3s).
    macOS:  brew install ffmpeg
    Ubuntu: sudo apt install ffmpeg
    Windows: https://ffmpeg.org/download.html

Reads audio-manifest.json (produced by extract_audio_manifest.js) and
writes files to the exact paths the course already expects:
    audio/vocab/<slug>.mp3            — one per unique vocabulary word
    audio/lesson-XX-listening.mp3     — one per lesson, multi-speaker dialogue
    audio/lesson-21/<slug>.mp3        — L21's "a/an" article examples

Nothing in the course's HTML/JS needs to change for the listening files —
each lesson already does a fetch(HEAD) check for exactly this path and
falls back to the browser's speechSynthesis if the file isn't there yet.
Vocab-word and L21-article audio, however, currently always uses
speechSynthesis (see the note printed at the end of this script for the
one-time course-engine.js change needed to make those actually use these
generated files).

Safe to re-run: any file that already exists on disk is skipped, so an
interrupted run (or one you're topping up later) never re-pays for clips
you've already generated.
"""

import sys
import os
import json
import base64
import time

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: run `pip install requests pydub` first.")

try:
    from pydub import AudioSegment
    from pydub.generators import Sine  # unused, just confirms ffmpeg-backed pydub imports cleanly
except ImportError:
    sys.exit("Missing dependency: run `pip install requests pydub` first.")

TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
MANIFEST_PATH = "audio-manifest.json"

# Two consistent voices for the entire course's listening dialogues —
# every lesson only ever uses "Anna" and "Tomasz" as speaker names, so a
# single mapping here covers all 22 lessons.
VOICE_NARRATOR = {"languageCode": "en-GB", "name": "en-GB-Neural2-F"}   # vocab words, L21 articles
VOICE_ANNA     = {"languageCode": "en-GB", "name": "en-GB-Neural2-A"}   # female
VOICE_TOMASZ   = {"languageCode": "en-GB", "name": "en-GB-Neural2-B"}   # male
SPEAKER_VOICES = {"Anna": VOICE_ANNA, "Tomasz": VOICE_TOMASZ}

AUDIO_CONFIG = {"audioEncoding": "MP3", "speakingRate": 0.95}


def synthesize(text, voice, api_key, retries=3):
    """Calls the TTS REST API once, returns raw MP3 bytes."""
    payload = {
        "input": {"text": text},
        "voice": voice,
        "audioConfig": AUDIO_CONFIG,
    }
    for attempt in range(retries):
        resp = requests.post(f"{TTS_URL}?key={api_key}", json=payload, timeout=30)
        if resp.status_code == 200:
            return base64.b64decode(resp.json()["audioContent"])
        if resp.status_code == 429:  # rate limited — back off and retry
            time.sleep(2 ** attempt)
            continue
        raise RuntimeError(f"TTS API error {resp.status_code}: {resp.text[:300]}")
    raise RuntimeError(f"TTS API rate-limited after {retries} retries for: {text[:60]}")


def ensure_dir(filepath):
    d = os.path.dirname(filepath)
    if d:
        os.makedirs(d, exist_ok=True)


def generate_simple_clips(items, api_key, label):
    """items: list of {text, outputPath} — one API call, one file, each."""
    total = len(items)
    skipped = 0
    made = 0
    for i, item in enumerate(items, 1):
        out_path = item["outputPath"]
        if os.path.exists(out_path):
            skipped += 1
            continue
        ensure_dir(out_path)
        print(f"[{label} {i}/{total}] {item['text'][:60]}")
        audio_bytes = synthesize(item["text"], VOICE_NARRATOR, api_key)
        with open(out_path, "wb") as f:
            f.write(audio_bytes)
        made += 1
    print(f"{label}: {made} generated, {skipped} already existed, {total} total.\n")


def generate_listening_dialogues(listening_entries, api_key):
    total = len(listening_entries)
    skipped = 0
    made = 0
    for i, entry in enumerate(listening_entries, 1):
        out_path = entry["outputPath"]
        if os.path.exists(out_path):
            skipped += 1
            continue
        ensure_dir(out_path)
        print(f"[listening {i}/{total}] {entry['lessonId']} ({len(entry['lines'])} lines)")

        combined = AudioSegment.silent(duration=200)
        pause = AudioSegment.silent(duration=450)  # gap between speaker turns

        for line in entry["lines"]:
            voice = SPEAKER_VOICES.get(line["speaker"], VOICE_NARRATOR)
            audio_bytes = synthesize(line["line"], voice, api_key)
            tmp_path = out_path + ".tmp_line.mp3"
            with open(tmp_path, "wb") as f:
                f.write(audio_bytes)
            segment = AudioSegment.from_mp3(tmp_path)
            os.remove(tmp_path)
            combined += segment + pause

        combined.export(out_path, format="mp3")
        made += 1
    print(f"listening: {made} generated, {skipped} already existed, {total} total.\n")


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(
            "Usage: python3 generate_audio.py YOUR_API_KEY [--lesson=lesson-01-present-simple-vs-continuous]\n"
            "  The optional --lesson flag limits generation to just that lesson's vocab words,\n"
            "  its listening dialogue, and (for lesson-21 only) its article clips — useful for a\n"
            "  cheap first test before generating everything."
        )
    api_key = sys.argv[1]
    lesson_filter = None
    if len(sys.argv) == 3:
        if not sys.argv[2].startswith('--lesson='):
            sys.exit("Second argument must be --lesson=<lesson-id>, e.g. --lesson=lesson-01-present-simple-vs-continuous")
        lesson_filter = sys.argv[2].split('=', 1)[1]

    if not os.path.exists(MANIFEST_PATH):
        sys.exit(
            f"'{MANIFEST_PATH}' not found. Run extract_audio_manifest.js first "
            f"(node extract_audio_manifest.js) to generate it from the lesson files."
        )

    with open(MANIFEST_PATH) as f:
        manifest = json.load(f)

    vocab_items = manifest["vocab"]
    l21_items = manifest["l21Articles"]
    listening_items = manifest["listening"]

    if lesson_filter:
        vocab_items = [v for v in vocab_items if lesson_filter in v["lessons"]]
        listening_items = [l for l in listening_items if l["lessonId"] == lesson_filter]
        l21_items = l21_items if lesson_filter == 'lesson-21-articles-determiners' else []
        print(f"Filtering to lesson: {lesson_filter}\n")
        if not vocab_items and not listening_items and not l21_items:
            sys.exit(f"No manifest entries matched '{lesson_filter}' — check the id against audio-manifest.json.")

    print(f"Manifest loaded: {len(vocab_items)} vocab words, "
          f"{len(listening_items)} listening dialogues, "
          f"{len(l21_items)} L21 article clips.\n")

    generate_simple_clips(vocab_items, api_key, "vocab")
    generate_simple_clips(l21_items, api_key, "l21-articles")
    generate_listening_dialogues(listening_items, api_key)

    print("Done.")
    print(
        "\nNOTE: the 22 listening files will already work with zero code changes — "
        "each lesson checks for exactly this path and plays it automatically.\n"
        "Vocab-word and L21-article audio needs one small change to "
        "shared/course-engine.js's speak() function to check for these files "
        "before falling back to the browser's built-in voice — ask Claude to "
        "make that change once you've generated the files, so it can verify "
        "the file-naming (slugified word text) lines up exactly."
    )


if __name__ == "__main__":
    main()
