/* ============================================================
   English+ Grammar Course — Shared Engine
   Used by every lesson-*.html. Handles:
     - progress logging (local stand-in for the Supabase schema
       described in the course design doc, §9 — swap point marked
       below so lessons 2-22 don't need to change when we wire up
       the real backend)
     - vocab popovers (audio / IPA / example sentence / glossary)
     - generic exercise-checking helpers (MCQ, gap-fill, builder)
     - end-of-lesson score summary + JSON export (stand-in for the
       PDF report until that's built)
   ============================================================ */

const Course = (() => {

  /* ----------------------------------------------------------
     SUPABASE CLIENT
     Loaded from shared/supabase-config.js + the supabase-js CDN
     script, both included before this file. If either is missing
     (offline, or a lesson opened before those scripts are added),
     Course still works entirely on localStorage — every Supabase
     call below is wrapped so a missing/failed connection never
     breaks the lesson itself, it just means that device's progress
     doesn't sync until it's back online.
     ---------------------------------------------------------- */
  let supabaseClient = null;
  try {
    if (window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY){
      supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    }
  } catch (e){ console.warn('Supabase client not initialised:', e); }

  function getGroupId(){
    const params = new URLSearchParams(window.location.search);
    return params.get('group') || 'local-demo';
  }
  const GROUP_ID = getGroupId();

  const knownMemberships = new Set(); // avoids re-checking group membership on every single answer
  async function ensureGroupMembership(groupId, studentName){
    if (!supabaseClient) return;
    const cacheKey = `${groupId}::${studentName}`;
    if (knownMemberships.has(cacheKey)) return;
    try {
      const { data } = await supabaseClient.from('groups').select('student_names').eq('group_id', groupId).maybeSingle();
      if (!data){
        await supabaseClient.from('groups').insert({ group_id: groupId, group_name: groupId, student_names: [studentName] });
      } else if (!data.student_names.includes(studentName)){
        await supabaseClient.from('groups').update({ student_names: [...data.student_names, studentName] }).eq('group_id', groupId);
      }
      knownMemberships.add(cacheKey);
    } catch (e){ console.warn('Supabase group membership check failed (will retry next answer):', e); }
  }

  /* ----------------------------------------------------------
     PROGRESS LOG
     Row shape intentionally mirrors the planned `lesson_progress`
     Supabase table so swapping localStorage.setItem() below for a
     supabase.from('lesson_progress').insert() call is a drop-in
     change — nothing else in a lesson file needs to know the
     difference.
     ---------------------------------------------------------- */
  const STORAGE_KEY = 'englishplus_progress';
  const GLOSSARY_KEY = 'englishplus_glossary';

  function getStudentName(){
    let name = localStorage.getItem('englishplus_student_name');
    if (!name){
      name = prompt("What's your name? (used to save your progress on this device)") || 'You';
      localStorage.setItem('englishplus_student_name', name);
    }
    return name;
  }

  function readLog(){
    try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch(e){ return []; }
  }
  function writeLog(rows){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  }

  /**
   * Log one row of progress.
   * @param {Object} p
   * @param {string} p.lessonId
   * @param {string} p.sectionId
   * @param {'auto_graded'|'oral'} p.exerciseType
   * @param {'completed'|'absent'|'not_attempted'} p.status
   * @param {string} [p.answerGiven]
   * @param {boolean|null} [p.isCorrect]
   */
  function logProgress(p){
    const rows = readLog();
    const row = {
      group_id: GROUP_ID,
      student_name: getStudentName(),
      lesson_id: p.lessonId,
      section_id: p.sectionId,
      exercise_type: p.exerciseType || 'auto_graded',
      status: p.status || 'completed',
      answer_given: p.answerGiven ?? null,
      is_correct: p.isCorrect ?? null,
      override_correct: null,
      teacher_verdict: null,
      session_date: new Date().toISOString().slice(0,10),
      timestamp: new Date().toISOString()
    };
    rows.push(row);
    writeLog(rows);

    // Mirror to Supabase in the background — never blocks the UI, and a
    // failed/offline write here doesn't lose the answer, since the
    // localStorage copy above is already saved either way.
    if (supabaseClient){
      (async () => {
        await ensureGroupMembership(row.group_id, row.student_name);
        const { session_date, timestamp, ...dbRow } = row; // timestamp has a DB default; session_date matches the DB column
        dbRow.session_date = session_date;
        const { error } = await supabaseClient.from('lesson_progress').insert(dbRow);
        if (error) console.warn('Supabase progress insert failed:', error.message);
      })();
    }
  }

  function getLessonRows(lessonId){
    return readLog().filter(r => r.lesson_id === lessonId && r.student_name === getStudentName());
  }

  /**
   * Same rows as getLessonRows, but deduplicated to only the most recent
   * attempt per section_id. Without this, a student re-attempting a
   * section (or, during testing, the same person answering a lesson
   * across many separate sessions) would have every historical attempt
   * summed together, inflating both the score and the total — this is
   * what "current progress" should actually mean.
   */
  function getCurrentRows(lessonId){
    const rows = getLessonRows(lessonId);
    const latestBySection = {};
    rows.forEach(r => {
      const existing = latestBySection[r.section_id];
      if (!existing || new Date(r.timestamp) >= new Date(existing.timestamp)){
        latestBySection[r.section_id] = r;
      }
    });
    return Object.values(latestBySection);
  }

  /** Same as getCurrentRows, but keyed by section_id for quick lookup — the shape rehydration needs. */
  function getSectionMap(lessonId){
    const map = {};
    getCurrentRows(lessonId).forEach(r => { map[r.section_id] = r; });
    return map;
  }

  function resetLocalProgress(lessonId){
    const rows = readLog().filter(r => !(r.lesson_id === lessonId && r.student_name === getStudentName()));
    writeLog(rows);
  }

  function lessonScore(lessonId, sectionPrefix){
    const rows = getCurrentRows(lessonId).filter(r =>
      r.exercise_type === 'auto_graded' &&
      (!sectionPrefix || r.section_id.startsWith(sectionPrefix)) &&
      r.is_correct !== null
    );
    const correct = rows.filter(r => (r.override_correct ?? r.is_correct)).length;
    return { correct, total: rows.length };
  }

  function weakSections(lessonId){
    const rows = getCurrentRows(lessonId).filter(r => (r.override_correct ?? r.is_correct) === false);
    return [...new Set(rows.map(r => r.section_id))];
  }

  /**
   * Pulls this student's rows down from Supabase and merges them into
   * local storage — patching override_correct/teacher_verdict onto rows
   * that already exist locally, AND adding any row that exists remotely
   * but not locally at all (e.g. this device's local storage is empty,
   * fresh, or was cleared, but the student has answers on Supabase from
   * another session/device). Also PRUNES any local row whose section no
   * longer exists remotely — this is what makes a teacher's "wipe" on the
   * dashboard actually show up on the student's own device, not just on
   * Supabase. Pruning only ever happens right here, immediately after a
   * confirmed-successful fetch, never on a failed one — so a dropped
   * connection can never masquerade as a wipe and erase real local
   * progress that just hasn't synced yet.
   * Call this right before showing/exporting results, not continuously.
   */
  async function syncFromSupabase(lessonId){
    if (!supabaseClient) return;
    try {
      const { data, error } = await supabaseClient
        .from('lesson_progress')
        .select('*')
        .eq('group_id', GROUP_ID)
        .eq('student_name', getStudentName())
        .eq('lesson_id', lessonId);
      if (error || !data) { if (error) console.warn('Sync from Supabase failed:', error.message); return; }
      // Past this point the fetch has genuinely succeeded — `data` is an
      // authoritative snapshot (possibly empty) of this student's rows for
      // this lesson, safe to reconcile local storage against.
      const remoteSections = new Set(data.map(r => r.section_id));
      let rows = readLog();
      let changed = false;

      data.forEach(remote => {
        const idx = rows.findIndex(r => r.lesson_id === lessonId && r.student_name === getStudentName() && r.section_id === remote.section_id);
        if (idx >= 0){
          if (rows[idx].override_correct !== remote.override_correct || rows[idx].teacher_verdict !== remote.teacher_verdict){
            rows[idx].override_correct = remote.override_correct;
            rows[idx].teacher_verdict = remote.teacher_verdict;
            changed = true;
          }
        } else {
          rows.push({ ...remote, timestamp: remote.created_at || new Date().toISOString() });
          changed = true;
        }
      });

      const beforeCount = rows.length;
      rows = rows.filter(r => {
        if (r.lesson_id !== lessonId || r.student_name !== getStudentName()) return true; // different lesson/student, not our concern here
        return remoteSections.has(r.section_id);
      });
      if (rows.length !== beforeCount) changed = true;

      if (changed) writeLog(rows);
    } catch (e){ console.warn('Sync from Supabase failed:', e); }
  }

  function exportReport(lessonId, lessonTitle){
    const rows = getLessonRows(lessonId);
    const report = {
      student: getStudentName(),
      lesson_id: lessonId,
      lesson_title: lessonTitle,
      generated_at: new Date().toISOString(),
      rows
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${lessonId}-${getStudentName()}-progress.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportReportPDF(lessonId, lessonTitle, totalPossible){
    const rows = getCurrentRows(lessonId);
    const student = getStudentName();
    const date = new Date().toLocaleDateString();
    const autoRows = rows.filter(r => r.exercise_type === 'auto_graded');
    const oralRows = rows.filter(r => r.exercise_type === 'oral' && r.status === 'completed');
    const correct = autoRows.filter(r => (r.override_correct ?? r.is_correct)).length;
    const pct = autoRows.length ? Math.round((correct / autoRows.length) * 100) : 0;
    const esc = (s) => (s ?? '').toString().replace(/</g, '&lt;');

    let printRoot = document.getElementById('course-print-report');
    if (!printRoot){
      printRoot = document.createElement('div');
      printRoot.id = 'course-print-report';
      document.body.appendChild(printRoot);
    }
    printRoot.innerHTML = `
      <div style="border-bottom:3px solid #185FA5;padding-bottom:12px;margin-bottom:20px">
        <div style="font-size:11px;color:#5B6472;text-transform:uppercase;letter-spacing:.05em">English+ Grammar Course</div>
        <h1 style="font-size:21px;margin:4px 0 0">${esc(lessonTitle)}</h1>
      </div>
      <p style="font-size:13px;margin:0 0 3px"><b>Student:</b> ${esc(student)}</p>
      <p style="font-size:13px;margin:0 0 18px"><b>Date:</b> ${esc(date)}</p>
      <div style="background:#E6F1FB;border-radius:10px;padding:14px 18px;margin-bottom:${typeof totalPossible === 'number' ? '8px' : '22px'}">
        <div style="font-size:19px;font-weight:700;color:#0C4577">${correct} / ${autoRows.length} correct (${pct}%)</div>
      </div>
      ${typeof totalPossible === 'number' ? (autoRows.length < totalPossible ? `
      <div style="background:#FAEEDA;border:1px solid #E8C080;border-radius:8px;padding:10px 14px;margin-bottom:22px;font-size:12px;color:#633806">
        ⚠ Only ${Math.round((autoRows.length / totalPossible) * 100)}% of the lesson attempted (${autoRows.length} of ${totalPossible} exercises) — this score reflects only what's been answered so far.
      </div>` : `
      <div style="background:#EAF3DE;border:1px solid #C0DD97;border-radius:8px;padding:10px 14px;margin-bottom:22px;font-size:12px;color:#27500A">
        ✓ Every exercise in this lesson has been attempted.
      </div>`) : ''}
      <h2 style="font-size:14px;margin-bottom:8px">Exercise breakdown</h2>
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;margin-bottom:22px">
        <thead><tr style="background:#EEF1F5;text-align:left">
          <th style="padding:5px 7px;border-bottom:1px solid #DFE3E9">Section</th>
          <th style="padding:5px 7px;border-bottom:1px solid #DFE3E9">Your answer</th>
          <th style="padding:5px 7px;border-bottom:1px solid #DFE3E9">Result</th>
        </tr></thead>
        <tbody>
          ${autoRows.map(r => {
            const ok = r.override_correct ?? r.is_correct;
            const resultLabel = r.override_correct !== null && r.override_correct !== undefined ? (ok ? 'Correct (revised)' : 'Needs review (revised)') : (ok ? 'Correct' : 'Needs review');
            return `<tr>
              <td style="padding:5px 7px;border-bottom:1px solid #EEF1F5">${esc(r.section_id)}</td>
              <td style="padding:5px 7px;border-bottom:1px solid #EEF1F5">${esc(r.answer_given)}</td>
              <td style="padding:5px 7px;border-bottom:1px solid #EEF1F5;color:${ok ? '#27500A' : '#791F1F'}">${resultLabel}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${oralRows.length ? `
        <h2 style="font-size:14px;margin-bottom:8px">Speaking / discussion</h2>
        <ul style="font-size:11.5px;padding-left:16px;margin:0">
          ${oralRows.map(r => `<li style="margin-bottom:5px">${esc(r.answer_given)} — <i>${esc(r.teacher_verdict) || 'not yet marked'}</i></li>`).join('')}
        </ul>` : ''}
    `;
    window.print();
  }

  /* ----------------------------------------------------------
     VOCAB POPOVERS
     ---------------------------------------------------------- */
  /* ----------------------------------------------------------
     AUDIO: file-first, speechSynthesis fallback
     Mirrors the pattern each lesson's listening dialogue already
     uses (fetch HEAD once, cache the result, play the real file if
     present) — generalised here so vocab words and any other
     hoverable/clickable audio button gets the same upgrade path
     for free the moment real files are dropped into audio/vocab/.
     Slugifying the spoken text itself (rather than requiring a
     separate key at every call site) means no lesson file needs to
     change when real audio arrives — only this function does.
     ---------------------------------------------------------- */
  function slugifyForAudio(text){
    return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  const audioFileCache = new Map(); // slug -> true|false, checked once per session
  let currentAudioEl = null;
  async function speakSmart(text, fallback){
    const slug = slugifyForAudio(text);
    const src = `audio/vocab/${slug}.mp3`;
    if (!audioFileCache.has(slug)){
      try {
        const res = await fetch(src, { method: 'HEAD' });
        audioFileCache.set(slug, res.ok);
      } catch (e) { audioFileCache.set(slug, false); }
    }
    if (audioFileCache.get(slug)){
      if (currentAudioEl) currentAudioEl.pause();
      currentAudioEl = new Audio(src);
      currentAudioEl.play().catch(() => fallback());
    } else {
      fallback();
    }
  }
  function speak(text){
    speakSmart(text, () => {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.92;
      window.speechSynthesis.speak(u);
    });
  }

  /* ----------------------------------------------------------
     GLOSSARY
     Same local-write-plus-background-mirror pattern as progress
     logging — instant local save, best-effort sync to Supabase so
     it's durable and follows the student across devices.
     ---------------------------------------------------------- */
  function getGlossary(){
    try { return JSON.parse(localStorage.getItem(GLOSSARY_KEY)) || {}; }
    catch (e){ return {}; }
  }
  function writeGlossaryLocal(glossary){
    localStorage.setItem(GLOSSARY_KEY, JSON.stringify(glossary));
  }

  async function saveToGlossary(wordKey, data, lessonId){
    const glossary = getGlossary();
    glossary[wordKey] = { word: data.word, ipa: data.ipa, meaning: data.meaning, example: data.example, lessonId: lessonId || null };
    writeGlossaryLocal(glossary);

    if (supabaseClient){
      (async () => {
        await ensureGroupMembership(GROUP_ID, getStudentName());
        const { error } = await supabaseClient.from('glossary').upsert({
          group_id: GROUP_ID, student_name: getStudentName(), word_key: wordKey,
          word: data.word, ipa: data.ipa, meaning: data.meaning, example: data.example, lesson_id: lessonId || null
        }, { onConflict: 'group_id,student_name,word_key' });
        if (error) console.warn('Glossary sync failed:', error.message);
      })();
    }
  }

  async function removeFromGlossary(wordKey){
    const glossary = getGlossary();
    delete glossary[wordKey];
    writeGlossaryLocal(glossary);
    if (supabaseClient){
      const { error } = await supabaseClient.from('glossary').delete()
        .eq('group_id', GROUP_ID).eq('student_name', getStudentName()).eq('word_key', wordKey);
      if (error) console.warn('Glossary remove failed:', error.message);
    }
  }

  async function syncGlossaryFromSupabase(){
    if (!supabaseClient) return;
    try {
      const { data, error } = await supabaseClient.from('glossary').select('*')
        .eq('group_id', GROUP_ID).eq('student_name', getStudentName());
      if (error || !data) { if (error) console.warn('Glossary sync failed:', error.message); return; }
      const glossary = getGlossary();
      data.forEach(r => {
        glossary[r.word_key] = { word: r.word, ipa: r.ipa, meaning: r.meaning, example: r.example, lessonId: r.lesson_id };
      });
      writeGlossaryLocal(glossary);
    } catch (e){ console.warn('Glossary sync failed:', e); }
  }

  function initVocab(vocabData, lessonId){
    document.querySelectorAll('.vocab').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.word;
        const data = vocabData[key];
        if (!data) return;
        if (popupTrigger === el){ hidePopup(); return; }
        const alreadySaved = !!getGlossary()[key];
        const html = `
          <div class="vocab-pop-word">${data.word}</div>
          <div class="vocab-pop-ipa">${data.ipa}</div>
          <button class="audio-btn vocab-audio-btn" data-speak="${data.word}">🔊 Hear it</button>
          <div style="font-size:14px;margin-bottom:8px">${data.meaning}</div>
          <div class="vocab-pop-ex">"${data.example}"</div>
          <button class="btn btn-sm glossary-btn" data-word="${key}" ${alreadySaved ? 'disabled' : ''}>${alreadySaved ? 'Saved ✓' : '+ Add to my glossary'}</button>
        `;
        showPopup(html, el);
        const content = document.getElementById('course-popup-content');
        content.querySelector('.vocab-audio-btn')?.addEventListener('click', (e) => { e.stopPropagation(); speak(data.word); });
        content.querySelector('.glossary-btn')?.addEventListener('click', async (e) => {
          e.stopPropagation();
          await saveToGlossary(key, data, lessonId);
          const btn = content.querySelector('.glossary-btn');
          btn.textContent = 'Saved ✓'; btn.disabled = true;
        });
      });
    });
  }

  /* ----------------------------------------------------------
     SHUFFLING
     Used for MCQ option order and sentence-builder word banks so
     the correct answer/order is never predictably in the same
     position — applies across every lesson via the shared engine.
     ---------------------------------------------------------- */
  function shuffleArray(arr){
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function shuffleOptions(containerId){
    const container = document.getElementById(containerId);
    if (!container) return;
    const buttons = Array.from(container.querySelectorAll('.opt'));
    shuffleArray(buttons).forEach(btn => container.appendChild(btn));
  }

  /* ----------------------------------------------------------
     POPUP
     Shared by vocab words, grammar highlights, and any other
     "click a term, see an explanation" pattern. Closes via the X
     button, clicking outside, or clicking the same trigger again.
     ---------------------------------------------------------- */
  let popupTrigger = null;
  function ensurePopupRoot(){
    let root = document.getElementById('course-popup-root');
    if (!root){
      root = document.createElement('div');
      root.id = 'course-popup-root';
      root.innerHTML = `
        <div id="course-popup-backdrop" class="course-popup-backdrop"></div>
        <div id="course-popup-box" class="course-popup-box" role="dialog">
          <button id="course-popup-close" class="course-popup-close" aria-label="Close">&times;</button>
          <div id="course-popup-content"></div>
        </div>
      `;
      document.body.appendChild(root);
      document.getElementById('course-popup-backdrop').addEventListener('click', hidePopup);
      document.getElementById('course-popup-close').addEventListener('click', hidePopup);
    }
    return root;
  }
  function showPopup(html, triggerEl){
    const root = ensurePopupRoot();
    if (triggerEl && popupTrigger === triggerEl){ hidePopup(); return; }
    document.getElementById('course-popup-content').innerHTML = html;
    root.classList.add('open');
    popupTrigger = triggerEl || null;
  }
  function hidePopup(){
    const root = document.getElementById('course-popup-root');
    if (root) root.classList.remove('open');
    popupTrigger = null;
  }

  /* ----------------------------------------------------------
     SHUFFLE-WITH-VARIETY
     Shuffles each container normally, then checks whether the
     correct answer landed in the same position (usually top) for
     every single question in the group — if so, forces one to be
     different, so a themed set of questions never visually looks
     like "the answer is always first" even by chance.
     ---------------------------------------------------------- */
  function ensureGroupVariety(containerIds){
    if (containerIds.length < 2) return;
    const firstIsCorrect = containerIds.map(id => {
      const first = document.querySelector(`#${id} .opt`);
      return first && first.dataset.value === 'right';
    });
    const allSame = firstIsCorrect.every(v => v === firstIsCorrect[0]);
    if (!allSame) return;
    // Force one container (at random) to have a different top position.
    const targetId = containerIds[Math.floor(Math.random() * containerIds.length)];
    const container = document.getElementById(targetId);
    const opts = Array.from(container.querySelectorAll('.opt'));
    const differentIdx = opts.findIndex(o => o.dataset.value !== opts[0].dataset.value);
    if (differentIdx > 0) container.insertBefore(opts[differentIdx], opts[0]);
  }

  /* ----------------------------------------------------------
     GENERIC MULTIPLE-CHOICE EXERCISE
     Container needs: data-lesson, data-section, data-correct
     Options: <button class="opt" data-value="...">
     ---------------------------------------------------------- */
  function initMCQ(containerId, {lessonId, sectionId, correctValue, onAnswered, restoreAnswer}){
    const container = document.getElementById(containerId);
    if (!container) return;
    const opts = container.querySelectorAll('.opt');
    let answered = false;

    function applyResult(chosenValue){
      opts.forEach(o => {
        if (o.dataset.value === correctValue) o.classList.add('ok');
        else if (o.dataset.value === chosenValue) o.classList.add('bad');
        else o.classList.add('dim');
      });
    }

    // Restoring a prior answer (e.g. reopening a lesson already in progress)
    // applies the same visual result a click would, without re-logging it.
    if (restoreAnswer !== undefined && restoreAnswer !== null){
      answered = true;
      applyResult(restoreAnswer);
    }

    opts.forEach(opt => {
      opt.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        const chosen = opt.dataset.value;
        const isCorrect = chosen === correctValue;
        applyResult(chosen);
        logProgress({ lessonId, sectionId, answerGiven: chosen, isCorrect });
        if (onAnswered) onAnswered(isCorrect, chosen);
      });
    });
  }

  /* ----------------------------------------------------------
     FIND-THE-ERROR (click the wrong word/phrase within a sentence)
     A different interaction from the two-option MCQ pair used in
     Lesson 1's "spot the correct sentence" — same underlying skill
     (identify the tense mistake), different format, so lessons can
     genuinely vary which exercise types appear.
     ---------------------------------------------------------- */
  function initErrorSpot(containerId, {lessonId, sectionId, words, errorIndices, correction, onAnswered, restore}){
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = words.map((w, i) => `<span class="err-word" data-idx="${i}">${w}</span>`).join(' ');
    const spans = container.querySelectorAll('.err-word');
    let answered = false;

    function reveal(clickedIdx){
      spans.forEach(s => {
        const idx = Number(s.dataset.idx);
        if (errorIndices.includes(idx)) s.classList.add('err-target');
        else if (idx === clickedIdx) s.classList.add('err-wrong-pick');
        s.style.pointerEvents = 'none';
      });
      const isCorrect = errorIndices.includes(clickedIdx);
      const note = document.createElement('div');
      note.className = isCorrect ? 'fb-ok' : 'fb-no';
      note.style.marginTop = '8px';
      note.textContent = isCorrect
        ? `✓ Correct — should be "${correction}"`
        : `Not quite — the error was "${errorIndices.map(i => words[i]).join(' ')}", which should be "${correction}"`;
      container.insertAdjacentElement('afterend', note);
    }

    if (restore){
      answered = true;
      reveal(Number(restore.answerGiven));
      return;
    }

    spans.forEach(s => {
      s.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        const idx = Number(s.dataset.idx);
        const isCorrect = errorIndices.includes(idx);
        reveal(idx);
        logProgress({ lessonId, sectionId, answerGiven: String(idx), isCorrect });
        if (onAnswered) onAnswered(isCorrect);
      });
    });
  }

  /* ----------------------------------------------------------
     MATCHING (click a left item, then its matching right item)
     A third exercise format for the practice slot that's used
     "spot the correct sentence" (L1) and "find the error" (L2) —
     lessons can rotate through these so consecutive lessons never
     feel identical. Each pair gets its own section_id so it's
     individually restorable/reveal-able, same as everything else.
     A wrong attempt locks that LEFT item (shown in red) but leaves
     the right item available, since it may still be the correct
     partner for a different, not-yet-answered left item.
     ---------------------------------------------------------- */
  function initMatching(containerId, {lessonId, sectionPrefix, pairs, onAnswered, sectionMap}){
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px">
        <div id="${containerId}-left" style="display:flex;flex-direction:column;gap:8px"></div>
        <div id="${containerId}-right" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
    `;
    const leftEl = document.getElementById(`${containerId}-left`);
    const rightEl = document.getElementById(`${containerId}-right`);
    const leftItems = pairs.map((p, i) => ({ text: p.left, idx: i }));
    // Plain shuffle can, by chance, leave a pair's true partner sitting on the
    // same visual row as its left half — which reads as though the answer is
    // already given away. Reshuffle (bounded) until at most one row does that.
    let rightItems;
    let attempts = 0;
    do {
      rightItems = shuffleArray(pairs.map((p, i) => ({ text: p.right, idx: i })));
      attempts++;
    } while (rightItems.filter((item, row) => item.idx === row).length > 1 && attempts < 50);

    let selectedLeftIdx = null;
    const answeredLeft = new Map();  // idx -> isCorrect
    const usedRight = new Set();     // idx of right items already correctly claimed

    if (sectionMap){
      pairs.forEach((p, i) => {
        const row = sectionMap[`${sectionPrefix}-${i + 1}`];
        if (row){
          const isCorrect = row.override_correct ?? row.is_correct;
          answeredLeft.set(i, isCorrect);
          if (isCorrect) usedRight.add(i);
        }
      });
    }

    function renderLeft(){
      leftEl.innerHTML = '';
      leftItems.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'chip match-item';
        if (answeredLeft.has(item.idx)){
          btn.classList.add(answeredLeft.get(item.idx) ? 'match-correct' : 'match-wrong');
          btn.disabled = true;
        } else {
          if (selectedLeftIdx === item.idx) btn.classList.add('sel');
          btn.addEventListener('click', () => { selectedLeftIdx = item.idx; renderLeft(); });
        }
        btn.textContent = item.text;
        leftEl.appendChild(btn);
      });
    }
    function renderRight(){
      rightEl.innerHTML = '';
      rightItems.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'chip match-item';
        if (usedRight.has(item.idx)){
          btn.classList.add('match-correct');
          btn.disabled = true;
        } else {
          btn.addEventListener('click', () => {
            if (selectedLeftIdx === null || answeredLeft.has(selectedLeftIdx)) return;
            const isCorrect = item.idx === selectedLeftIdx;
            const sectionId = `${sectionPrefix}-${selectedLeftIdx + 1}`;
            answeredLeft.set(selectedLeftIdx, isCorrect);
            if (isCorrect) usedRight.add(item.idx);
            logProgress({ lessonId, sectionId, answerGiven: item.text, isCorrect });
            selectedLeftIdx = null;
            renderLeft(); renderRight();
            if (onAnswered) onAnswered(isCorrect);
          });
        }
        btn.textContent = item.text;
        rightEl.appendChild(btn);
      });
    }
    renderLeft();
    renderRight();
  }

  /* ----------------------------------------------------------
     GENERIC GAP-FILL (typed answer, case-insensitive, trims)
     showAnswerHint controls whether the feedback reveals the
     expected answer(s) — intended for just the first exercise in a
     themed set, to model the expected format, while the rest stay
     silent on the exact answer so students genuinely have to recall
     it (any review then happens live, e.g. via the teacher's reveal
     panel, rather than being handed to them instantly).
     ---------------------------------------------------------- */
  /**
   * Given a list of full-form correct answers, returns the list with a
   * contracted variant added for any answer starting with a word that
   * naturally contracts with a preceding subject pronoun (have -> 've,
   * has/is -> 's, are -> 're, will -> 'll, would/had -> 'd). The blank
   * itself never includes the subject, so a student who thinks "I've
   * never been" naturally types "'ve never been" — without this, that's
   * marked wrong even though it's exactly correct.
   */
  function withContractions(answers){
    const subjectMap = { have:"'ve", has:"'s", am:"'m", are:"'re", is:"'s", will:"'ll", would:"'d", had:"'d" };
    const modalMap = { would:"would've", could:"could've", might:"might've", should:"should've", must:"must've" };
    const expanded = [...answers];
    answers.forEach(a => {
      const words = a.split(' ');
      const firstWord = words[0].toLowerCase();
      const rest = a.slice(words[0].length); // keeps the leading space, or ''

      // Pattern A: contract the first word alone, assuming a subject pronoun
      // already precedes it in the visible sentence ("would" -> "'d", so
      // "she" + "'d have shared" reads as "she'd have shared").
      if (subjectMap[firstWord] && rest) expanded.push(subjectMap[firstWord] + rest);

      // Pattern B: modal + have -> modal've ("would've saved"), the far more
      // common spoken contraction — Pattern A alone never produces this since
      // it only ever touches the first word. Also handles a single adverb
      // wedged between the modal and "have" ("would probably have saved" ->
      // "would've probably saved"), which is how it naturally reads once
      // "have" fuses onto the modal instead of staying separate.
      if (modalMap[firstWord]){
        if (words[1] && words[1].toLowerCase() === 'have'){
          const tail = words.slice(2).join(' ');
          expanded.push(`${modalMap[firstWord]}${tail ? ' ' + tail : ''}`);
        } else if (words[2] && words[2].toLowerCase() === 'have'){
          const adverb = words[1];
          const tail = words.slice(3).join(' ');
          expanded.push(`${modalMap[firstWord]} ${adverb}${tail ? ' ' + tail : ''}`);
        }
      }
    });
    return expanded;
  }

  function initGapFill(inputId, checkBtnId, feedbackId, {lessonId, sectionId, correctAnswers, showAnswerHint = false, restore, onAnswered}){
    const input = document.getElementById(inputId);
    const btn = document.getElementById(checkBtnId);
    const fb = document.getElementById(feedbackId);
    if (!input || !btn) return;

    // Curly/smart apostrophes (from autocorrect, mobile keyboards) and a
    // missing apostrophe entirely ("dont" for "don't") were being marked
    // wrong even when every other letter matched a correct answer — this
    // strips all apostrophe variants from both sides before comparing, so
    // typing style/typos never cause a false "incorrect". Trailing sentence
    // punctuation and repeated whitespace are normalized away too.
    function normalizeAnswer(s){
      return s
        .trim()
        .toLowerCase()
        .replace(/[\u2018\u2019\u02BC']/g, '')
        .replace(/[.!?]+$/, '')
        .replace(/\s+/g, ' ');
    }

    function showFeedback(isCorrect){
      // withContractions() adds bare fragments like "'ve sent" so a typed
      // contraction is still marked correct — but shown alone in a hint,
      // with no subject in front of it, that apostrophe-first fragment
      // reads as broken rather than helpful. The full form(s) are always
      // still in this list too, so filtering fragments never empties it.
      const hintAnswers = correctAnswers.filter(a => !a.startsWith("'"));
      if (isCorrect){
        fb.innerHTML = showAnswerHint
          ? `<div class="fb-ok">✓ Correct — "${hintAnswers.join(' OR ')}"</div>`
          : `<div class="fb-ok">✓ Correct!</div>`;
        return;
      }
      // A wrong answer always reveals the correct one(s) now — previously
      // only the first item in a themed set (showAnswerHint: true) did this,
      // and every other item just said "we'll go over this one together"
      // with no indication of what was actually expected. When several
      // answers are genuinely valid, all of them are listed so the person
      // reviewing can see there's real nuance here, not just one fixed
      // answer they happened to miss.
      if (hintAnswers.length > 1){
        const list = hintAnswers.map(a => `"${a}"`).join(' or ');
        fb.innerHTML = `<div class="fb-no">Not quite. A few answers would work here: ${list} — we'll go over this one together.</div>`;
      } else {
        fb.innerHTML = `<div class="fb-no">Not quite. A correct answer would be: "${hintAnswers[0]}".</div>`;
      }
    }

    if (restore){
      input.value = restore.answerGiven ?? '';
      input.disabled = true; btn.disabled = true;
      showFeedback(restore.isCorrect);
      return;
    }

    btn.addEventListener('click', () => {
      const val = normalizeAnswer(input.value);
      const accepted = correctAnswers.map(normalizeAnswer);
      const isCorrect = accepted.includes(val);
      showFeedback(isCorrect);
      input.disabled = true; btn.disabled = true;
      logProgress({ lessonId, sectionId, answerGiven: input.value.trim(), isCorrect });
      if (onAnswered) onAnswered(isCorrect);
    });
  }

  /* ----------------------------------------------------------
     SCORE SUMMARY RENDER
     ---------------------------------------------------------- */
  function renderScoreRing(elId, correct, total){
    const el = document.getElementById(elId);
    if (!el) return;
    const pct = total ? Math.round((correct/total)*100) : 0;
    el.innerHTML = `<div class="score-ring">${pct}%</div>`;
  }

  return { logProgress, getLessonRows, getCurrentRows, getSectionMap, lessonScore, weakSections, exportReport, exportReportPDF,
           speak, speakSmart, initVocab, initMCQ, initGapFill, initErrorSpot, initMatching, withContractions, renderScoreRing, getStudentName,
           shuffleArray, shuffleOptions, ensureGroupVariety, showPopup, hidePopup, resetLocalProgress, syncFromSupabase,
           getGlossary, saveToGlossary, removeFromGlossary, syncGlossaryFromSupabase,
           getGroupId: () => GROUP_ID, isConnected: () => !!supabaseClient };
})();
