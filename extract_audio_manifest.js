// Extracts every piece of text that needs audio across all 22 lessons into
// one structured manifest.json, for generate_audio.py to consume.
//
// Three categories, matching what the course actually plays audio for:
//   1. vocab      — one clip per vocabulary word (word itself only, not
//                   the example sentence — matches how the vocab popup's
//                   "🔊 Hear it" button already works: Course.speak(data.word))
//   2. listening  — one clip PER LESSON, combining all dialogue lines with
//                   per-speaker voices, saved at the exact path
//                   (audio/lesson-XX-listening.mp3) each lesson already
//                   checks for via fetch HEAD — no code changes needed,
//                   just dropping files at these paths
//   3. l21_articles — L21's "a/an" compare-card: BOTH the label (e.g. "a
//                   university") and the full example sentence get their
//                   own audio button, so both need separate clips
//
// Vocab words are deduplicated by exact text across all lessons (the same
// word can appear in multiple lessons; pronunciation doesn't change based
// on which lesson it's in), keyed by a filesystem-safe slug.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LESSON_DIR = __dirname; // run this script from inside your course folder
const OUTPUT_PATH = path.join(__dirname, 'audio-manifest.json');

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractBalancedBlock(source, startIdx) {
  // startIdx points at the opening '{' — walk forward tracking string state
  // and brace depth so we grab the exact matching '}', robust to nested
  // braces/quotes/escapes inside example sentences.
  let depth = 0, i = startIdx, inString = false, quoteChar = null, escaped = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (c === '\\') { escaped = true; }
      else if (c === quoteChar) { inString = false; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = true; quoteChar = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return source.slice(startIdx, i + 1); }
  }
  return null;
}

function extractBalancedArray(source, startIdx) {
  let depth = 0, i = startIdx, inString = false, quoteChar = null, escaped = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (c === '\\') { escaped = true; }
      else if (c === quoteChar) { inString = false; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = true; quoteChar = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return source.slice(startIdx, i + 1); }
  }
  return null;
}

function safeEval(jsSourceLiteral) {
  // Evaluate a JS object/array literal in an isolated context — safe here
  // since the source is our own lesson files, not untrusted input.
  const sandbox = {};
  vm.createContext(sandbox);
  return vm.runInContext(`(${jsSourceLiteral})`, sandbox);
}

const vocabByText = {};      // slug -> { text, lessons: [ids] }
const listeningByLesson = {}; // lessonId -> [{speaker, line}]
const l21Articles = [];       // [{key, kind: 'label'|'sentence', text}]

const lessonFiles = fs.readdirSync(LESSON_DIR)
  .filter(f => /^lesson-\d\d-.*\.html$/.test(f) && !f.includes('standalone'))
  .sort();

console.log(`Found ${lessonFiles.length} lesson files.\n`);

for (const file of lessonFiles) {
  const lessonId = file.replace('.html', '');
  const html = fs.readFileSync(path.join(LESSON_DIR, file), 'utf8');

  // ---- 1. vocabData ----
  const vocabMatch = html.match(/const vocabData = (\{)/);
  if (vocabMatch) {
    const block = extractBalancedBlock(html, vocabMatch.index + vocabMatch[0].length - 1);
    if (block) {
      try {
        const vocabObj = safeEval(block);
        Object.values(vocabObj).forEach(entry => {
          const text = entry.word;
          const slug = slugify(text);
          if (!vocabByText[slug]) vocabByText[slug] = { text, lessons: [] };
          if (!vocabByText[slug].lessons.includes(lessonId)) vocabByText[slug].lessons.push(lessonId);
        });
      } catch (e) {
        console.log(`  WARN: failed to parse vocabData in ${file}: ${e.message}`);
      }
    } else {
      console.log(`  WARN: could not find balanced vocabData block in ${file}`);
    }
  } else {
    console.log(`  WARN: no vocabData found in ${file}`);
  }

  // ---- 2. dialogue (listening) ----
  const dialogueMatch = html.match(/const dialogue = (\[)/);
  if (dialogueMatch) {
    const block = extractBalancedArray(html, dialogueMatch.index + dialogueMatch[0].length - 1);
    if (block) {
      try {
        const dialogueArr = safeEval(block);
        listeningByLesson[lessonId] = dialogueArr.map(d => ({ speaker: d.speaker, line: d.line }));
      } catch (e) {
        console.log(`  WARN: failed to parse dialogue in ${file}: ${e.message}`);
      }
    } else {
      console.log(`  WARN: could not find balanced dialogue block in ${file}`);
    }
  } else {
    console.log(`  WARN: no dialogue array found in ${file}`);
  }
}

// ---- 3. L21's compare-a-an (label + sentence, both need audio) ----
const l21Html = fs.readFileSync(path.join(LESSON_DIR, 'lesson-21-articles-determiners.html'), 'utf8');
const aAnMatch = l21Html.match(/renderCompareCardWithAudio\('compare-a-an',\s*(\[)/);
if (aAnMatch) {
  const block = extractBalancedArray(l21Html, aAnMatch.index + aAnMatch[0].length - 1);
  if (block) {
    try {
      const items = safeEval(block);
      items.forEach(it => {
        l21Articles.push({ key: it.key, kind: 'label', text: it.label });
        l21Articles.push({ key: it.key, kind: 'sentence', text: it.text });
      });
    } catch (e) {
      console.log(`  WARN: failed to parse compare-a-an in lesson-21: ${e.message}`);
    }
  }
} else {
  console.log('  WARN: could not find compare-a-an block in lesson-21');
}

// ---- Assemble manifest ----
const manifest = {
  vocab: Object.entries(vocabByText).map(([slug, data]) => ({
    slug, text: data.text, lessons: data.lessons, outputPath: `audio/vocab/${slug}.mp3`
  })),
  listening: Object.entries(listeningByLesson).map(([lessonId, lines]) => ({
    lessonId, lines, outputPath: `audio/${lessonId.replace('-present-simple-vs-continuous','').replace(/-.*/, '')}-listening-placeholder.mp3` // fixed below
  })),
  l21Articles: l21Articles.map(a => ({ ...a, slug: slugify(a.text), outputPath: `audio/vocab/${slugify(a.text)}.mp3` }))
};

// Fix listening output paths properly: audio/lesson-XX-listening.mp3
manifest.listening.forEach(l => {
  const num = l.lessonId.match(/lesson-(\d\d)-/)[1];
  l.outputPath = `audio/lesson-${num}-listening.mp3`;
});

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2));

console.log(`\n=== Manifest summary ===`);
console.log(`Unique vocab words: ${manifest.vocab.length}`);
console.log(`Listening dialogues: ${manifest.listening.length} (expect 22)`);
console.log(`Total dialogue lines: ${manifest.listening.reduce((sum, l) => sum + l.lines.length, 0)}`);
console.log(`L21 article items (label+sentence): ${manifest.l21Articles.length}`);
console.log(`\nWritten to ${OUTPUT_PATH}`);
