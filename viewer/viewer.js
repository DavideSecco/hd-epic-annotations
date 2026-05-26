const vid = document.getElementById('vid');
const bboxCanvas = document.getElementById('bbox-canvas');
const bboxCtx = bboxCanvas.getContext('2d');
const dropHint = document.getElementById('drop-hint');
const timelineTrack = document.getElementById('timeline-track');
const timelineSvg = document.getElementById('timeline-segments');
const cursor = document.getElementById('timeline-cursor');
const progress = document.getElementById('timeline-progress');
const annotList = document.getElementById('annot-list');
const audioHud = document.getElementById('audio-hud');
const activitiesPanel = document.getElementById('activities-panel');
const stepsPanel      = document.getElementById('steps-panel');
const searchInput = document.getElementById('search');
const tStart = document.getElementById('t-start');
const tCur = document.getElementById('t-cur');
const tEnd = document.getElementById('t-end');
const timeMsOverlay = document.getElementById('time-ms-overlay');

// ---- "You are here" position indicator (one per panel) ----
const actPosLine  = Object.assign(document.createElement('li'),  {className: 'pos-line'});
const stepPosLine = Object.assign(document.createElement('li'),  {className: 'pos-line'});
const narrPosLine = Object.assign(document.createElement('div'), {className: 'pos-line'});
const _posLineAfter = new WeakMap();

function _insertPosLine(posLine, items, t, container) {
  let after = null;
  for (const item of items) {
    if (parseFloat(item.dataset.start) <= t) after = item;
    else break;
  }
  if (_posLineAfter.get(posLine) === after) return;
  _posLineAfter.set(posLine, after);
  posLine.remove();
  if (!items.length) return;
  after ? after.after(posLine) : items[0].before(posLine);
  scrollActiveItemToCenter(posLine, container);
}

function _hidePosLine(posLine) {
  if (posLine.parentNode) { posLine.remove(); _posLineAfter.set(posLine, undefined); }
}

// ---- Object mask state ----
let allMaskData  = null;
let allAssocData = null;
let masksByFrame = [];   // [{frame, bbox, label}] for current video, sorted by frame
const MASK_FPS   = 30;
const MASK_TOL   = 15;  // ±15 frames window (~±0.5 s)

// ---- Hand mask state ----
let handMaskData = null;  // {frame_str: {l?: counts_str, r?: counts_str}}
let _framewiseGaze = null; // {frames, px, py: Int16Array keyframes, n} — from framewise_info.jsonl
const HAND_W = 1408, HAND_H = 1408;
let _lastHandFrame = -1;   // frame-skip cache: avoid re-decoding same frame
let _lastBoxFrame  = -2;   // frame-skip cache: avoid redoing the full bbox+hand draw
let _handBufHasContent = false;  // skip drawImage when the offscreen mask is fully cleared
let _maskRafId = null;
// Off-screen compositing for hand masks (reuse buffers to avoid GC and stay fast even
// with dense masks — some frames have >1M foreground pixels).
const _handCanvas = document.createElement('canvas');
_handCanvas.width = HAND_W; _handCanvas.height = HAND_H;
const _handCtx    = _handCanvas.getContext('2d');
const _handImgData = _handCtx.createImageData(HAND_W, HAND_H);
const _handBuf    = _handImgData.data;  // Uint8ClampedArray, same underlying buffer

let allAnnotations = [];
let annotations = [];
let allAudioAnnotations = [];
let audioAnnotations = [];
let stepAnnotations = [];
let mergedAnnotations = [];
let filteredAnnotations = [];
let activeIdx = -1;
let currentVideoId = '';
let youtubeUrls = {};
let howWhyLookup = {};
let allActivityData = {};
let activitySegments = [];
let vqaLookup = {};
let rawRecipesJson = null;
let currentRecipeMeta = null;
let nutritionTimeline = [];
let nutritionRecipeTotals = null;
let _lastNutritionAdded = -1;

let pyodide = null;
let pyodideInitPromise = null;

// ---- Off-main-thread parser (Web Worker) ----
let _worker = null;
let _workerCallbacks = {};
let _workerIdSeq = 0;

function getWorker() {
  if (!_worker) {
    _worker = new Worker('csv-worker.js');
    _worker.onmessage = e => {
      const { id, result, error } = e.data;
      const cb = _workerCallbacks[id];
      if (cb) {
        delete _workerCallbacks[id];
        error ? cb.reject(new Error(error)) : cb.resolve(result);
      }
    };
  }
  return _worker;
}

function parseInWorker(buffer, type) {
  return new Promise((resolve, reject) => {
    const id = ++_workerIdSeq;
    _workerCallbacks[id] = { resolve, reject };
    getWorker().postMessage({ id, buffer, type }, [buffer]);
  });
}

function setStatus(message) {
  document.getElementById('stats').textContent = message;
}

// ---- Utilities ----
function parseTime(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : 0;
  if (!s) return 0;
  s = s.trim();
  // HH:MM:SS.mmm or HH:MM:SS:FF (frames) or seconds as float
  const parts = s.split(':');
  if (parts.length === 3) {
    const h = parseFloat(parts[0]), m = parseFloat(parts[1]), sec = parseFloat(parts[2]);
    return h * 3600 + m * 60 + sec;
  } else if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(s) || 0;
}

function fmtTime(s, showMs = false) {
  const totalMs = Math.max(0, Math.round(Number(s || 0) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const sec = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  if (showMs) {
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
  }

  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function fmtCaptionMeta(start, stop) {
  const safeStart = Math.max(0, Number(start || 0));
  const safeStop = Math.max(safeStart, Number(stop || safeStart));
  const duration = safeStop - safeStart;
  return `${fmtTime(safeStart, true)} → ${fmtTime(safeStop, true)} (+${duration.toFixed(3)}s)`;
}

function updateCaptionSpacers() {
  const spacerSize = Math.max(0, Math.floor(annotList.clientHeight / 2));
  annotList.querySelectorAll('.annot-spacer').forEach(spacer => {
    spacer.style.height = `${spacerSize}px`;
  });
}

function scrollActiveItemToCenter(item, container = annotList) {
  const containerCenter = container.clientHeight / 2;

  // No artificial padding: first/last items sit at the natural edge.
  container.querySelectorAll('.annot-spacer').forEach(s => { s.style.height = '0'; });

  const captionCenter = item.offsetTop + (item.clientHeight / 2);
  let targetScrollTop = captionCenter - containerCenter;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  targetScrollTop = Math.max(0, Math.min(targetScrollTop, maxScroll));

  container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
}

// ---- CSV parser (handles quoted fields) ----
function parseCSV(text) {
  const lines = text.split('\n');
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = [];
    let cur = '', inQ = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') { inQ = !inQ; }
      else if (line[c] === ',' && !inQ) { fields.push(cur); cur = ''; }
      else { cur += line[c]; }
    }
    fields.push(cur);
    const row = {};
    header.forEach((h, j) => row[h] = (fields[j] || '').trim());
    rows.push(row);
  }
  return rows;
}

function detectColumns(rows) {
  if (!rows.length) return {};
  const keys = Object.keys(rows[0]);
  const find = (...candidates) => candidates.find(c => keys.includes(c)) || null;
  return {
    video: find('video_id','videoid'),
    start: find('start_timestamp','start_time','start','narration_timestamp'),
    stop:  find('stop_timestamp','stop_time','end_timestamp','end','stop','end_time'),
    text:  find('narration','description','text','caption'),
    verb:  find('verb','verbs','verb_class'),
    noun:  find('noun','nouns','noun_class'),
    id:    find('narration_id','action_id','id'),
  };
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(v => String(v)).join(', ');
  if (value == null) return '';
  return String(value);
}

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
}

function normalizeRows(rows) {
  return rows.map(row => {
    const out = {};
    Object.keys(row || {}).forEach(k => {
      out[normalizeKey(k)] = row[k];
    });
    return out;
  });
}

function extractVideoId(filename) {
  return String(filename || '').replace(/\.[^.]+$/, '');
}

function updateYoutubeButton() {
  const btn = document.getElementById('yt-btn');
  const url = youtubeUrls[currentVideoId];
  if (url) {
    btn.href = url;
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}

// ---- Collapsible sections ----
const _secState = JSON.parse(localStorage.getItem('hd-epic-sections') || '{}');

function applySectionState(name) {
  const collapsed = !!_secState[name];
  if (name === 'narrations') {
    document.getElementById('narrations-body').classList.toggle('sec-collapsed', collapsed);
  } else if (name === 'activities') {
    document.getElementById('activities-panel').classList.toggle('sec-collapsed', collapsed);
  } else if (name === 'steps') {
    document.getElementById('steps-panel').classList.toggle('sec-collapsed', collapsed);
  } else if (name === 'vqa') {
    document.getElementById('vqa-panel').classList.toggle('sec-collapsed', collapsed);
  } else if (name === 'nutrition') {
    document.getElementById('nutrition-panel').classList.toggle('sec-collapsed', collapsed);
  }
  document.querySelectorAll(`.sec-toggle[data-sec="${name}"]`).forEach(btn => {
    btn.textContent = collapsed ? '▸' : '▾';
    btn.classList.toggle('sec-closed', collapsed);
  });
}

function toggleSection(name) {
  _secState[name] = !_secState[name];
  localStorage.setItem('hd-epic-sections', JSON.stringify(_secState));
  applySectionState(name);
}

// Wire narrations toggle (static in HTML)
document.querySelector('.sec-toggle[data-sec="narrations"]')
  .addEventListener('click', () => toggleSection('narrations'));

// Apply saved states on load
['activities', 'steps', 'narrations', 'nutrition', 'vqa'].forEach(applySectionState);

function refreshStatus() {
  if (!allAnnotations.length && !allAudioAnnotations.length && !rawRecipesJson) {
    setStatus('load HD_EPIC_Narrations (.pkl/.csv), Audio annotations (.csv), and Recipes (.json)');
    return;
  }
  if (!currentVideoId) {
    setStatus(`${allAnnotations.length} narrations, ${allAudioAnnotations.length} audio, ${rawRecipesJson ? 'recipes loaded' : 'no recipes loaded'}`);
    return;
  }
  setStatus(`${filteredAnnotations.length} / ${annotations.length} narrations for ${currentVideoId} (${stepAnnotations.length} macro-phases, ${audioAnnotations.length} audio)`);
}

function clearCurrentAnnotation() {
  // Duplicate top-caption panel removed; keep no-op to preserve flow.
}

// ---- Object mask bbox overlay ----
function buildMaskLookup(videoId) {
  masksByFrame = [];
  if (!allMaskData) return;

  // mask_id → human label from assoc_info
  const maskIdToLabel = {};
  if (allAssocData) {
    for (const obj of Object.values(allAssocData[videoId] || {})) {
      const name = obj.name || '';
      for (const track of obj.tracks || [])
        for (const mid of track.masks || [])
          maskIdToLabel[mid] = name;
    }
  }

  for (const [mid, entry] of Object.entries(allMaskData[videoId] || {})) {
    const fixture = entry.fixture || '';
    const label = maskIdToLabel[mid] ||
      (fixture.includes('_') ? fixture.split('_').slice(1).join('_') : fixture);
    masksByFrame.push({ frame: entry.frame_number, bbox: entry.bbox, label });
  }
  masksByFrame.sort((a, b) => a.frame - b.frame);
}

function parseHmsToS(hms) {
  const [h, m, s] = hms.split(':');
  return +h * 3600 + +m * 60 + parseFloat(s);
}

function buildHowWhyLookup(howJson, whyJson) {
  howWhyLookup = {};
  const add = (entries, type) => {
    for (const entry of Object.values(entries)) {
      const vid = entry.inputs?.['video 1']?.id;
      const startS = parseHmsToS(entry.inputs?.['video 1']?.start_time || '0:0:0');
      const endS   = parseHmsToS(entry.inputs?.['video 1']?.end_time   || '0:0:0');
      const text   = entry.choices?.[entry.correct_idx] ?? '';
      const m = entry.question?.match(/<([^>]+)>/);
      const action = m ? m[1] : '';
      if (!vid || !text) continue;
      (howWhyLookup[vid] ||= []).push({ startS, endS, type, text, action });
    }
  };
  add(howJson, 'how');
  add(whyJson, 'why');
}

function findHowWhy(videoId, startS, endS) {
  const entries = howWhyLookup[videoId];
  if (!entries) return null;
  const matches = entries.filter(e =>
    e.startS <= endS + 1 && e.endS >= startS - 1
  );
  if (!matches.length) return null;
  const how = matches.find(e => e.type === 'how');
  const why = matches.find(e => e.type === 'why');
  return (how || why) ? { how, why } : null;
}

// ---- VQA panel ----
const _VQA_GROUP_ORDER  = ['3d_perception', 'fine_grained', 'gaze', 'ingredient', 'nutrition', 'object_motion', 'recipe'];
const _VQA_GROUP_LABELS = {
  '3d_perception': '3D Perception',
  'fine_grained':  'Fine-Grained',
  'gaze':          'Gaze',
  'ingredient':    'Ingredient',
  'nutrition':     'Nutrition',
  'object_motion': 'Object Motion',
  'recipe':        'Recipe',
};

const VQA_CATEGORIES = {
  // 3D perception (slate)
  '3d_perception_fixture_interaction_counting': { label: 'Fixture Interaction Count', color: '#334155', text: '#cbd5e1', group: '3d_perception' },
  '3d_perception_fixture_location':              { label: 'Fixture Location',          color: '#475569', text: '#e2e8f0', group: '3d_perception' },
  '3d_perception_object_contents_retrieval':     { label: 'Object Contents',           color: '#1e293b', text: '#94a3b8', group: '3d_perception' },
  '3d_perception_object_location':               { label: 'Object Location',           color: '#0f172a', text: '#94a3b8', group: '3d_perception' },
  // Fine-grained (violet/indigo)
  fine_grained_action_recognition:               { label: 'Action Recognition',        color: '#4c1d95', text: '#c4b5fd', group: 'fine_grained' },
  fine_grained_action_localization:              { label: 'Action Localization',        color: '#1e3a8a', text: '#93c5fd', group: 'fine_grained' },
  fine_grained_how_recognition:                  { label: 'How Recognition',           color: '#581c87', text: '#d8b4fe', group: 'fine_grained' },
  fine_grained_why_recognition:                  { label: 'Why Recognition',           color: '#3730a3', text: '#a5b4fc', group: 'fine_grained' },
  // Gaze (cyan / amber)
  gaze_gaze_estimation:                          { label: 'Gaze Estimation',           color: '#0e7490', text: '#67e8f9', group: 'gaze' },
  gaze_interaction_anticipation:                 { label: 'Interaction Anticipation',  color: '#92400e', text: '#fcd34d', group: 'gaze' },
  // Ingredient (green)
  ingredient_exact_ingredient_recognition:       { label: 'Exact Quantity',            color: '#14532d', text: '#86efac', group: 'ingredient' },
  ingredient_ingredient_adding_localization:     { label: 'Adding Localization',       color: '#166534', text: '#bbf7d0', group: 'ingredient' },
  ingredient_ingredient_recognition:             { label: 'Ingredient Recognition',    color: '#15803d', text: '#86efac', group: 'ingredient' },
  ingredient_ingredient_retrieval:               { label: 'Ingredient Retrieval',      color: '#064e3b', text: '#6ee7b7', group: 'ingredient' },
  ingredient_ingredient_weight:                  { label: 'Ingredient Weight',         color: '#065f46', text: '#6ee7b7', group: 'ingredient' },
  ingredient_ingredients_order:                  { label: 'Ingredients Order',         color: '#047857', text: '#a7f3d0', group: 'ingredient' },
  // Nutrition (red)
  nutrition_image_nutrition_estimation:          { label: 'Image Estimation',          color: '#991b1b', text: '#fecaca', group: 'nutrition' },
  nutrition_nutrition_change:                    { label: 'Nutrition Change',          color: '#7f1d1d', text: '#fca5a5', group: 'nutrition' },
  nutrition_video_nutrition_estimation:          { label: 'Video Estimation',          color: '#b91c1c', text: '#fee2e2', group: 'nutrition' },
  // Object motion (orange)
  object_motion_object_movement_counting:        { label: 'Movement Count',            color: '#9a3412', text: '#fdba74', group: 'object_motion' },
  object_motion_object_movement_itinerary:       { label: 'Movement Itinerary',        color: '#c2410c', text: '#fed7aa', group: 'object_motion' },
  object_motion_stationary_object_localization:  { label: 'Stationary Localization',   color: '#ea580c', text: '#ffedd5', group: 'object_motion' },
  // Recipe (pink/magenta)
  recipe_following_activity_recognition:         { label: 'Activity Recognition',      color: '#9d174d', text: '#fbcfe8', group: 'recipe' },
  recipe_multi_recipe_recognition:               { label: 'Multi-Recipe Recognition',  color: '#831843', text: '#f9a8d4', group: 'recipe' },
  recipe_multi_step_localization:                { label: 'Multi-Step Localization',   color: '#be185d', text: '#fce7f3', group: 'recipe' },
  recipe_prep_localization:                      { label: 'Prep Localization',         color: '#db2777', text: '#fce7f3', group: 'recipe' },
  recipe_recipe_recognition:                     { label: 'Recipe Recognition',        color: '#a21caf', text: '#f5d0fe', group: 'recipe' },
  recipe_rough_step_localization:                { label: 'Rough Step Localization',   color: '#86198f', text: '#f0abfc', group: 'recipe' },
  recipe_step_localization:                      { label: 'Step Localization',         color: '#c026d3', text: '#f5d0fe', group: 'recipe' },
  recipe_step_recognition:                       { label: 'Step Recognition',          color: '#701a75', text: '#e9d5ff', group: 'recipe' },
};

function buildVqaLookup(entries, category) {
  for (const entry of Object.values(entries)) {
    const inputs = entry.inputs || {};
    // Index under video 1 (primary). For multi-video questions, indexing under all videos
    // causes duplicates (e.g. recipe_recipe_recognition has 9 videos per entry).
    const primary = inputs['video 1'];
    if (!primary?.id) continue;
    const startS = parseHmsToS(primary.start_time || '0:0:0');
    const endS   = parseHmsToS(primary.end_time   || '0:0:0');
    (vqaLookup[primary.id] ||= []).push({
      startS, endS, category,
      question: entry.question || '',
      choices:  entry.choices  || [],
      correct:  entry.correct_idx ?? -1,
    });
  }
}

function cleanVqaText(s) {
  if (typeof s !== 'string') return s;
  // Localization choice pattern: "video N from <TIME T1 ...> to <TIME T2 ...>" or "From <TIME T1> to <TIME T2>"
  s = s.replace(/(?:video \d+ from |[Ff]rom )<TIME ([0-9:.]+)[^>]*> to <TIME ([0-9:.]+)[^>]*>/g,
    (_, t1, t2) => `<button class="vqa-time-btn" data-t="${parseHmsToS(t1)}">${t1}</button> → <button class="vqa-time-btn" data-t="${parseHmsToS(t2)}">${t2}</button>`);
  // Paired "<TIME T1 ...> to <TIME T2 ...>" (used in recipe/object choices)
  s = s.replace(/<TIME ([0-9:.]+)[^>]*> to <TIME ([0-9:.]+)[^>]*>/g,
    (_, t1, t2) => `<button class="vqa-time-btn" data-t="${parseHmsToS(t1)}">${t1}</button> → <button class="vqa-time-btn" data-t="${parseHmsToS(t2)}">${t2}</button>`);
  // Single TIME tags → clickable seek button
  s = s.replace(/<TIME ([0-9:.]+)[^>]*>/g,
    (_, t) => `<button class="vqa-time-btn" data-t="${parseHmsToS(t)}">${t}</button>`);
  // BBOX → short label
  s = s.replace(/<BBOX [^>]+>/g, '<span class="vqa-bbox">[bbox]</span>');
  // Action tags like <hit spatula> — only letters and spaces, no attributes (must run AFTER button/span insertions to avoid false matches on HTML)
  s = s.replace(/<([a-z][a-z ]*)>/g, '<span class="vqa-action">$1</span>');
  // Fix article: "in the video 1" / "in video 1" → "in this video" (avoids double "the")
  s = s.replace(/\bin (the )?video 1\b/g, 'in this video');
  s = s.replace(/\bvideo 1\b/g, 'this video');
  return s;
}

const vqaPanel = document.getElementById('vqa-panel');
let _vqaSorted = [];
const _vqaHiddenStored = localStorage.getItem('vqaHiddenCats');
const _vqaHidden = new Set(
  _vqaHiddenStored === null
    ? Object.keys(VQA_CATEGORIES)
    : JSON.parse(_vqaHiddenStored)
);

function applyVqaFilter() {
  vqaPanel.querySelectorAll('.vqa-count-chip').forEach(chip => {
    if (_vqaHidden.has(chip.dataset.cat)) chip.setAttribute('data-off', '');
    else chip.removeAttribute('data-off');
  });
  vqaPanel.querySelectorAll('.vqa-card').forEach(card => {
    card.classList.toggle('vqa-cat-hidden', _vqaHidden.has(card.dataset.cat));
  });
}

function toggleVqaCategory(cat) {
  if (_vqaHidden.has(cat)) _vqaHidden.delete(cat);
  else _vqaHidden.add(cat);
  localStorage.setItem('vqaHiddenCats', JSON.stringify([..._vqaHidden]));
  applyVqaFilter();
}

function renderVqaList(videoId) {
  _vqaSorted = [];
  const entries = vqaLookup[videoId];
  if (!entries || !entries.length) {
    vqaPanel.innerHTML = '';
    vqaPanel.classList.remove('has-questions');
    return;
  }
  _vqaSorted = [...entries].sort((a, b) => a.startS - b.startS);

  const counts = {};
  for (const e of _vqaSorted) counts[e.category] = (counts[e.category] || 0) + 1;

  const grouped = {};
  for (const [cat, n] of Object.entries(counts)) {
    const g = (VQA_CATEGORIES[cat] || {}).group || 'other';
    (grouped[g] ||= []).push([cat, n]);
  }
  _VQA_GROUP_ORDER.forEach(g => grouped[g]?.sort((a, b) => b[1] - a[1]));

  let countChips = '';
  let firstGroup = true;
  for (const g of _VQA_GROUP_ORDER) {
    if (!grouped[g]?.length) continue;
    countChips += `<div class="vqa-group-row"><span class="vqa-group-hdr">${_VQA_GROUP_LABELS[g]}</span><div class="vqa-group-chips">`;
    firstGroup = false;
    countChips += grouped[g].map(([cat, n]) => {
      const c = VQA_CATEGORIES[cat] || { label: cat, color: '#374151', text: '#9ca3af' };
      return `<span class="vqa-count-chip" data-cat="${cat}" title="Click to toggle" style="background:${c.color};color:${c.text}">${c.label}: ${n}</span>`;
    }).join('') + `</div></div>`;
  }

  const collapsed = !!_secState['vqa'];
  const cards = _vqaSorted.map((e, i) => {
    const cat = VQA_CATEGORIES[e.category] || { label: e.category, color: '#374151', text: '#9ca3af' };
    const dur = (e.endS - e.startS).toFixed(3);
    const noTime = e.startS === 0 && e.endS === 0;
    const windowHtml = noTime
      ? '<span class="vqa-window vqa-fullvideo">full video</span>'
      : `<span class="vqa-window"><button class="vqa-time-btn" data-t="${e.startS}">${fmtTime(e.startS, true)}</button> → <button class="vqa-time-btn" data-t="${e.endS}">${fmtTime(e.endS, true)}</button> <span class="vqa-dur">+${dur}s</span></span>`;
    const choicesHtml = e.choices.map((c, j) => {
      const text = Array.isArray(c)
        ? c.map((x, k) => `<span class="vqa-ord-item">${k+1}. ${cleanVqaText(x)}</span>`).join('')
        : cleanVqaText(c);
      return `<div class="vqa-choice${j === e.correct ? ' correct' : ''}">${j === e.correct ? '✓ ' : `<span class="vqa-idx">${String.fromCharCode(65+j)}</span> `}${text}</div>`;
    }).join('');
    return `<div class="vqa-card${noTime ? ' vqa-fullvideo-card' : ''}" data-idx="${i}" data-cat="${e.category}" data-start="${e.startS}" data-end="${e.endS}">
      <div class="vqa-card-meta">
        <span class="vqa-badge" style="background:${cat.color};color:${cat.text}">${cat.label}</span>
        ${windowHtml}
      </div>
      <div class="vqa-q">${cleanVqaText(e.question)}</div>
      <div class="vqa-choices">${choicesHtml}</div>
    </div>`;
  }).join('');

  vqaPanel.innerHTML =
    `<div class="sec-header-row"><span class="sec-label">VQA · ${_vqaSorted.length} question${_vqaSorted.length > 1 ? 's' : ''}</span><button class="sec-toggle" data-sec="vqa">${collapsed ? '▸' : '▾'}</button></div>` +
    `<div class="sec-body"><div class="vqa-counts">${countChips}</div>${cards}</div>`;
  vqaPanel.classList.add('has-questions');
  vqaPanel.classList.toggle('sec-collapsed', collapsed);
  vqaPanel.querySelector('.sec-toggle').addEventListener('click', () => toggleSection('vqa'));

  vqaPanel.querySelectorAll('.vqa-count-chip').forEach(chip => {
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleVqaCategory(chip.dataset.cat);
    });
  });

  vqaPanel.querySelectorAll('.vqa-card').forEach(card => {
    card.addEventListener('click', () => {
      const s = parseFloat(card.dataset.start);
      if (vid.duration) vid.currentTime = s;
    });
  });

  vqaPanel.querySelectorAll('.vqa-time-btn').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const t = parseFloat(btn.dataset.t);
      if (!isNaN(t) && vid.duration) vid.currentTime = t;
    });
  });

  applyVqaFilter();
}

function renderVqaPanel(t) {
  if (!_vqaSorted.length || _secState['vqa']) return;
  let activeCard = null;
  vqaPanel.querySelectorAll('.vqa-card').forEach((card, i) => {
    const e = _vqaSorted[i];
    const noTime = e.startS === 0 && e.endS === 0;
    const isActive = !noTime && e.startS <= t && e.endS >= t;
    card.classList.toggle('vqa-active', isActive);
    if (isActive && !_vqaHidden.has(e.category)) activeCard = card;
  });
  if (activeCard) activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function syncBboxCanvas() {
  const wRect = videoWrap.getBoundingClientRect();
  bboxCanvas.width  = Math.round(wRect.width);
  bboxCanvas.height = Math.round(wRect.height);
  _lastBoxFrame = -2;  // invalidate cache: geometry changed, force a fresh draw
}

// ---- COCO RLE decoder ----
function decodeRLECounts(s) {
  const cnts = [];
  let i = 0;
  while (i < s.length) {
    let x = 0, k = 0, more = true;
    while (more) {
      const c = s.charCodeAt(i++) - 48;
      more = !!(c & 32);
      x |= (c & 31) << (5 * k++);
      if (!more && (c & 16)) x |= (-1 << (5 * k));
    }
    if (cnts.length > 2) x += cnts[cnts.length - 2];
    cnts.push(x);
  }
  return cnts;
}

// Write COCO RLE foreground pixels into a reused Uint8ClampedArray (RGBA, row-major).
// COCO masks are column-major: flat index i → col = i÷H, row = i%H.
function applyRLEToBuffer(cnts, H, W, r, g, b, a, buf) {
  let col = 0, row = 0;
  for (let ci = 0; ci < cnts.length; ci++) {
    let run = cnts[ci];
    if (ci & 1) {
      // foreground — write pixel colour for each run pixel
      while (run-- > 0) {
        const px = (row * W + col) * 4;
        buf[px] = r; buf[px + 1] = g; buf[px + 2] = b; buf[px + 3] = a;
        if (++row >= H) { row = 0; col++; }
      }
    } else if (run > 0) {
      // background — skip in O(1), no loop
      row += run;
      col += Math.floor(row / H);
      row %= H;
    }
  }
}

function renderHandMasks(currentTime, offX, offY, vidW, vidH) {
  if (!handMaskData || !vid.videoWidth) return;
  const frameNum = Math.round(currentTime * MASK_FPS);

  if (frameNum !== _lastHandFrame) {
    _lastHandFrame = frameNum;
    // Search within ±MASK_TOL frames for the closest available frame
    let best = null;
    for (let df = 0; df <= MASK_TOL; df++) {
      const kp = String(frameNum + df), km = String(frameNum - df);
      if (handMaskData[kp]) { best = handMaskData[kp]; break; }
      if (df > 0 && handMaskData[km]) { best = handMaskData[km]; break; }
    }
    _handBuf.fill(0);
    if (best) {
      if (best.l) applyRLEToBuffer(decodeRLECounts(best.l), HAND_H, HAND_W, 80, 160, 255, 160, _handBuf);
      if (best.r) applyRLEToBuffer(decodeRLECounts(best.r), HAND_H, HAND_W, 255, 80,  80,  160, _handBuf);
    }
    _handCtx.putImageData(_handImgData, 0, 0);
    _handBufHasContent = !!best && !!(best.l || best.r);
  }

  // Skip the 1.98MP scaled blit when the offscreen mask is entirely transparent.
  if (_handBufHasContent) bboxCtx.drawImage(_handCanvas, offX, offY, vidW, vidH);
}

function renderMaskBoxes(currentTime) {
  if (!vid.videoWidth) { bboxCtx.clearRect(0, 0, bboxCanvas.width, bboxCanvas.height); return; }

  // Frame-skip: the rAF loop fires at ~60 Hz but the video runs at 30 fps and
  // the masks/bbox are quantised at MASK_FPS. If the underlying frame number
  // hasn't moved, redoing clearRect + drawImage + the masksByFrame scan is
  // pure waste on the main thread — and Firefox feels it as playback stutter.
  const currentFrame = Math.round(currentTime * MASK_FPS);
  if (currentFrame === _lastBoxFrame) return;
  _lastBoxFrame = currentFrame;

  bboxCtx.clearRect(0, 0, bboxCanvas.width, bboxCanvas.height);

  const vRect = vid.getBoundingClientRect();
  const wRect = videoWrap.getBoundingClientRect();
  const offX   = vRect.left - wRect.left;
  const offY   = vRect.top  - wRect.top;
  const scaleX = vRect.width  / vid.videoWidth;
  const scaleY = vRect.height / vid.videoHeight;

  renderHandMasks(currentTime, offX, offY, vRect.width, vRect.height);

  if (!masksByFrame.length) return;
  bboxCtx.lineWidth = 2;
  bboxCtx.font = 'bold 11px monospace';

  for (const { frame, bbox, label } of masksByFrame) {
    if (Math.abs(frame - currentFrame) > MASK_TOL) continue;
    const [x1, y1, x2, y2] = bbox;
    const rx = offX + x1 * scaleX, ry = offY + y1 * scaleY;
    const rw = (x2 - x1) * scaleX,  rh = (y2 - y1) * scaleY;

    bboxCtx.strokeStyle = '#44ff88';
    bboxCtx.strokeRect(rx, ry, rw, rh);

    const tw = bboxCtx.measureText(label).width;
    bboxCtx.fillStyle = 'rgba(0,0,0,.6)';
    bboxCtx.fillRect(rx, ry - 16, tw + 8, 16);
    bboxCtx.fillStyle = '#44ff88';
    bboxCtx.fillText(label, rx + 4, ry - 3);
  }
}

async function loadHandMasks(videoId) {
  if (!videoId) { handMaskData = null; return; }
  const targetId = videoId;
  try {
    const url = `../hand-masks/${encodeURIComponent(videoId)}.json`;
    const res = await fetch(url);
    if (!res.ok) { handMaskData = null; return; }  // 404 = not extracted yet
    // Parse directly via browser's native JSON parser — avoids worker structured-clone
    // overhead (~13 MB object round-trip would freeze the main thread for 1-2 s).
    handMaskData = await res.json();
    if (currentVideoId === targetId) renderMaskBoxes(vid.currentTime || 0);
  } catch (e) {
    handMaskData = null;
  }
}

// Loads per-frame gaze pixel coords from HD-EPIC Intermediate Data.
// Preferred over CPF projection — no calibration math, no aspect-ratio issues.
// Falls back gracefully (leaves _framewiseGaze null) if file not found.
async function loadFramewiseGaze(videoId) {
  _framewiseGaze = null;
  const _gazeBtn = document.getElementById('gaze-btn');
  if (_gazeBtn) _gazeBtn.style.display = 'none';
  if (!videoId) return;
  const participant = videoId.split('-')[0];
  const url = `../HD-EPIC%20Intermediate%20Data/${participant}/${encodeURIComponent(videoId)}/framewise_info.jsonl`;
  let res;
  try { res = await fetch(url); } catch { return; }
  if (!res.ok) return;
  try {
    const buf = await res.arrayBuffer();
    const parsed = await parseInWorker(buf, 'jsonl_gaze');
    _framewiseGaze = {
      frames: new Int16Array(parsed.frames),  // frame index at each gaze keyframe
      px:     new Int16Array(parsed.px),
      py:     new Int16Array(parsed.py),
      n:      parsed.n,
    };
    if (_gazeBtn) {
      _gazeBtn.style.display = '';
      _gazeBtn.classList.toggle('active', _gazeDotEnabled);
    }
  } catch { /* silently fall back to CPF projection */ }
}

function applyVideoFilter() {
  if (!currentVideoId) {
    annotations = [];
    audioAnnotations = [];
    stepAnnotations = [];
    currentRecipeMeta = null;
    mergedAnnotations = [];
    filteredAnnotations = [];
    activeIdx = -1;
    nutritionTimeline = [];
    nutritionRecipeTotals = null;
    renderList(filteredAnnotations);
    renderActivitiesPanel();
    renderStepsPanel();
    renderNutritionPanel();
    renderAudioHud(0);
    buildTimeline();
    clearCurrentAnnotation();
    refreshStatus();
    return;
  }

  const targetId = currentVideoId.toLowerCase();
  annotations = allAnnotations
    .filter(a => String(a.video_id || '').toLowerCase() === targetId)
    .sort((a,b) => a.start - b.start);

  audioAnnotations = allAudioAnnotations
    .filter(a => String(a.video_id || '').toLowerCase() === targetId)
    .sort((a,b) => a.start - b.start);

  if (rawRecipesJson) {
    extractStepsForVideo(currentVideoId);
    extractNutritionTimeline(currentVideoId);
  } else {
    stepAnnotations = [];
    currentRecipeMeta = null;
    nutritionTimeline = [];
    nutritionRecipeTotals = null;
  }

  mergedAnnotations = [
    ...stepAnnotations.map((a, idx) => ({ ...a, mergedId: `s-${idx}` })),
    ...annotations.map((a, idx) => ({ ...a, type: 'narration', mergedId: `n-${idx}` })),
    ...audioAnnotations.map((a, idx) => ({ ...a, type: 'audio', mergedId: `a-${idx}` })),
  ].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const typeOrder = { step: 0, narration: 1, audio: 2 };
    if (a.type !== b.type) return typeOrder[a.type] - typeOrder[b.type];
    return 0;
  });

  filteredAnnotations = annotations;
  activeIdx = -1;
  buildMaskLookup(currentVideoId);
  loadHandMasks(currentVideoId);  // async, non-blocking
  renderList(filteredAnnotations);
  renderActivitiesPanel();
  renderStepsPanel();
  renderNutritionPanel();
  renderAudioHud(vid.currentTime || 0);
  renderMaskBoxes(vid.currentTime || 0);
  highlightActiveActivity(vid.currentTime || 0);
  highlightActiveStep(vid.currentTime || 0);
  buildTimeline();
  clearCurrentAnnotation();
  refreshStatus();
}

async function ensurePyodide() {
  if (pyodide) return pyodide;
  if (!pyodideInitPromise) {
    pyodideInitPromise = (async () => {
      setStatus('initializing Pyodide...');
      if (!window.loadPyodide) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('failed to load Pyodide from CDN'));
          document.head.appendChild(script);
        });
      }
      pyodide = await window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
      await pyodide.loadPackage('pandas');
      return pyodide;
    })();
  }
  return pyodideInitPromise;
}

async function parsePklRows(arrayBuffer) {
  const runtime = await ensurePyodide();
  runtime.globals.set('pkl_bytes', new Uint8Array(arrayBuffer));
  const jsonText = await runtime.runPythonAsync(`
import json
import pickle

try:
    import pandas as pd
except Exception:
    pd = None

def _norm(v):
    if hasattr(v, 'item'):
        try:
            v = v.item()
        except Exception:
            pass
    if isinstance(v, (bytes, bytearray)):
        try:
            return v.decode('utf-8')
        except Exception:
            return str(v)
    if isinstance(v, (list, tuple, set)):
        return [_norm(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _norm(val) for k, val in v.items()}
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)

obj = pickle.loads(bytes(pkl_bytes.to_py()))

if hasattr(obj, 'to_dict'):
    try:
        records = obj.to_dict(orient='records')
    except Exception:
        records = obj.to_dict()
        if isinstance(records, dict):
            keys = list(records.keys())
            length = len(records[keys[0]]) if keys else 0
            records = [{k: records[k][i] for k in keys} for i in range(length)]
elif isinstance(obj, list):
    records = obj
elif isinstance(obj, dict):
    records = [obj]
else:
    records = []

cleaned = []
for row in records:
    if isinstance(row, dict):
        cleaned.append({str(k): _norm(v) for k, v in row.items()})

json.dumps(cleaned, ensure_ascii=False)
`);
  return JSON.parse(jsonText);
}

async function parseCsvRows(arrayBuffer) {
  return parseInWorker(arrayBuffer, 'csv');
}

function resetAnnotationsOnError(message) {
  allAnnotations = [];
  applyVideoFilter();
  setStatus(`narrations error: ${message}`);
}

function resetAudioOnError(message) {
  allAudioAnnotations = [];
  applyVideoFilter();
  setStatus(`audio error: ${message}`);
}

function resetStepsOnError(message) {
  rawRecipesJson = null;
  stepAnnotations = [];
  currentRecipeMeta = null;
  document.getElementById('step-name').textContent = 'no recipes loaded';
  applyVideoFilter();
  setStatus(`recipes error: ${message}`);
}

async function loadAnnotationsFile(file) {
  document.getElementById('csv-name').textContent = file.name;

  const lowerName = file.name.toLowerCase();
  const isCsv = lowerName.endsWith('.csv') || file.type === 'text/csv';

  setStatus(isCsv ? 'reading CSV...' : 'reading PKL...');

  const rows = isCsv
    ? await parseCsvRows(await file.arrayBuffer())
    : await parsePklRows(await file.arrayBuffer());

  processRows(rows);
  if (!currentVideoId) setStatus(`${allAnnotations.length} narrations loaded`);
}

function detectAudioColumns(rows) {
  if (!rows.length) return {};
  const keys = Object.keys(rows[0]);
  const find = (...candidates) => candidates.find(c => keys.includes(c)) || null;
  return {
    video: find('video_id','videoid'),
    start: find('start_timestamp','start_time','start'),
    stop: find('stop_timestamp','stop_time','end_timestamp','end','stop','end_time'),
    audioClass: find('audio_class','audio','sound_class','sound','class'),
  };
}

async function loadAudioFile(file) {
  document.getElementById('audio-name').textContent = file.name;
  setStatus('reading audio CSV...');
  const rows = await parseCsvRows(await file.arrayBuffer());
  processAudioRows(rows);
}

async function loadRecipesFile(file) {
  document.getElementById('step-name').textContent = file.name;
  setStatus('reading recipes JSON...');
  let parsed;
  try {
    parsed = await parseInWorker(await file.arrayBuffer(), 'json');
  } catch (_err) {
    throw new Error('invalid JSON format');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid recipes payload: expected root object');
  }
  rawRecipesJson = parsed;
  applyVideoFilter();
}

function processRows(rows) {
  const normalizedRows = normalizeRows(rows || []);
  const cols = detectColumns(normalizedRows);

  if (!cols.video || !cols.start || !cols.text) {
    throw new Error('missing required fields: expected video_id, narration, start_timestamp');
  }

  allAnnotations = normalizedRows.map(r => ({
    video_id: String(r[cols.video] || '').trim(),
    start: parseTime(r[cols.start] || 0),
    stop: parseTime(r[cols.stop] || r[cols.start] || 0),
    text: String(r[cols.text] || '(no text)'),
    verb: cols.verb ? normalizeTags(r[cols.verb]) : '',
    noun: cols.noun ? normalizeTags(r[cols.noun]) : '',
    id: cols.id ? String(r[cols.id] || '') : '',
  })).filter(a => a.video_id && (a.text !== '(no text)' || a.start > 0));

  applyVideoFilter();
}

function processAudioRows(rows) {
  const normalizedRows = normalizeRows(rows || []);
  const cols = detectAudioColumns(normalizedRows);

  if (!cols.video || !cols.start || !cols.audioClass) {
    throw new Error('missing required audio fields: expected video_id, audio_class, start_timestamp');
  }

  allAudioAnnotations = normalizedRows.map(r => ({
    video_id: String(r[cols.video] || '').trim(),
    start: parseTime(r[cols.start] || 0),
    stop: parseTime(r[cols.stop] || r[cols.start] || 0),
    audio_class: String(r[cols.audioClass] || '(unknown audio)'),
  })).filter(a => a.video_id && (a.audio_class !== '(unknown audio)' || a.start > 0));

  applyVideoFilter();
}

function extractStepsForVideo(videoId) {
  const targetVideoId = String(videoId || '').trim();
  const tempSteps = [];
  let matchedRecipeMeta = null;

  Object.keys(rawRecipesJson || {}).forEach(recipeId => {
    const recipe = rawRecipesJson[recipeId];
    if (!recipe || typeof recipe !== 'object') return;

    const captures = Array.isArray(recipe.captures) ? recipe.captures : [];
    captures.forEach(capture => {
      if (!capture || typeof capture !== 'object') return;
      const videos = Array.isArray(capture.videos) ? capture.videos : [];
      if (!videos.includes(targetVideoId)) return;
      if (!matchedRecipeMeta) {
        const name = String(recipe.name || recipe.title || recipeId).trim() || recipeId;
        const source = String(recipe.source || recipe.url || '').trim();
        const steps = (recipe.steps && typeof recipe.steps === 'object' && !Array.isArray(recipe.steps)) ? recipe.steps : {};
        matchedRecipeMeta = { name, source, steps };
      }

      const stepsMap = (recipe.steps && typeof recipe.steps === 'object') ? recipe.steps : {};
      const stepTimes = (capture.step_times && typeof capture.step_times === 'object') ? capture.step_times : {};
      const prepTimes = (capture.prep_times && typeof capture.prep_times === 'object') ? capture.prep_times : {};

      Object.keys(stepTimes).forEach(stepId => {
        const events = Array.isArray(stepTimes[stepId]) ? stepTimes[stepId] : [];
        events.forEach(item => {
          if (!item || item.video !== targetVideoId) return;
          const description = String(stepsMap[stepId] || stepId || '(step)').trim();
          tempSteps.push({
            start: parseTime(item.start || 0),
            stop: parseTime(item.end || item.start || 0),
            text: description,
            type: 'step',
          });
        });
      });

      Object.keys(prepTimes).forEach(stepId => {
        const events = Array.isArray(prepTimes[stepId]) ? prepTimes[stepId] : [];
        events.forEach(item => {
          if (!item || item.video !== targetVideoId) return;
          const description = String(stepsMap[stepId] || stepId || '(prep)').trim();
          tempSteps.push({
            start: parseTime(item.start || 0),
            stop: parseTime(item.end || item.start || 0),
            text: description,
            type: 'prep',
          });
        });
      });
    });
  });

  tempSteps.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.type !== b.type) return a.type === 'step' ? -1 : 1;
    return 0;
  });
  stepAnnotations = tempSteps;
  currentRecipeMeta = matchedRecipeMeta;
}

function _seekBtnHtml(t) {
  return `<button class="seek-btn" data-t="${t}">${fmtTime(t, true)}</button>`;
}

function _wireSeekers(el) {
  el.querySelectorAll('.seek-btn').forEach(btn =>
    btn.addEventListener('click', ev => { ev.stopPropagation(); if (vid.duration) vid.currentTime = parseFloat(btn.dataset.t); })
  );
}

function renderActivitiesPanel() {
  const collapsed = !!_secState['activities'];
  const recipeInline = currentRecipeMeta
    ? `<span class="act-recipe-info-inline">${currentRecipeMeta.name}${currentRecipeMeta.source ? ` · <a href="${currentRecipeMeta.source}" target="_blank" rel="noopener noreferrer">link</a>` : ''}</span>`
    : '';
  const listHtml = activitySegments.length
    ? `<ol>${activitySegments.map(a => {
        const endS = isNaN(a.end) ? vid.duration : a.end;
        const dur  = isFinite(endS) ? (endS - a.start).toFixed(1) : null;
        const endPart = isFinite(endS) ? `→ ${_seekBtnHtml(endS)} <span class="recipe-item-dur">+${dur}s</span>` : '';
        return `<li class="timeline-item" data-start="${a.start}" data-end="${a.end}"><div class="recipe-item-time">${_seekBtnHtml(a.start)} ${endPart}</div><span class="act-label">${a.label}</span></li>`;
      }).join('')}</ol>`
    : '<div class="recipe-empty">No activity data for this video</div>';
  activitiesPanel.innerHTML =
    `<div class="sec-header-row"><span class="sec-label">Activities</span>${recipeInline}<button class="sec-toggle" data-sec="activities">${collapsed ? '▸' : '▾'}</button></div>` +
    `<div class="sec-body">${listHtml}</div>`;
  activitiesPanel.classList.toggle('sec-collapsed', collapsed);
  activitiesPanel.querySelector('.sec-toggle').addEventListener('click', () => toggleSection('activities'));
  _wireSeekers(activitiesPanel);
  _hidePosLine(actPosLine);
}

function renderStepsPanel() {
  const collapsed = !!_secState['steps'];
  const listHtml = stepAnnotations.length
    ? `<ol>${stepAnnotations.map(s => {
        const dur = (s.stop - s.start).toFixed(1);
        const badge = s.type === 'prep' ? '<span class="step-type-badge">prep</span>' : '<span class="step-type-badge step-badge-step">step</span>';
        return `<li class="timeline-item" data-start="${s.start}" data-end="${s.stop}"><div class="recipe-item-time">${badge}${_seekBtnHtml(s.start)} → ${_seekBtnHtml(s.stop)} <span class="recipe-item-dur">+${dur}s</span></div><span class="step-text">${s.text}</span></li>`;
      }).join('')}</ol>`
    : '<div class="recipe-empty">No steps for this video</div>';
  stepsPanel.innerHTML =
    `<div class="sec-header-row"><span class="sec-label">Steps</span><button class="sec-toggle" data-sec="steps">${collapsed ? '▸' : '▾'}</button></div>` +
    `<div class="sec-body">${listHtml}</div>`;
  stepsPanel.classList.toggle('sec-collapsed', collapsed);
  stepsPanel.querySelector('.sec-toggle').addEventListener('click', () => toggleSection('steps'));
  _wireSeekers(stepsPanel);
  _hidePosLine(stepPosLine);
}

function highlightActiveActivity(t) {
  let active = null;
  activitiesPanel.querySelectorAll('.timeline-item').forEach(item => {
    const s = parseFloat(item.dataset.start), e = parseFloat(item.dataset.end);
    const isActive = s <= t && (isNaN(e) || e > t);
    item.classList.toggle('active', isActive);
    if (isActive) active = item;
  });
  if (active) {
    _hidePosLine(actPosLine);
    scrollActiveItemToCenter(active, activitiesPanel);
  } else {
    _insertPosLine(actPosLine, [...activitiesPanel.querySelectorAll('.timeline-item')], t, activitiesPanel);
  }
}

function highlightActiveStep(t) {
  let active = null;
  stepsPanel.querySelectorAll('.timeline-item').forEach(item => {
    const s = parseFloat(item.dataset.start), e = parseFloat(item.dataset.end);
    const isActive = s <= t && e > t;
    item.classList.toggle('active', isActive);
    if (isActive) active = item;
  });
  if (active) {
    _hidePosLine(stepPosLine);
    scrollActiveItemToCenter(active, stepsPanel);
  } else {
    _insertPosLine(stepPosLine, [...stepsPanel.querySelectorAll('.timeline-item')], t, stepsPanel);
  }
}

// ---- Nutritional tracker ----
const nutritionPanel = document.getElementById('nutrition-panel');

function extractNutritionTimeline(videoId) {
  nutritionTimeline = [];
  nutritionRecipeTotals = null;
  if (!rawRecipesJson || !videoId) return;

  let totCal = 0, totCarbs = 0, totFat = 0, totProt = 0, hasAny = false;

  Object.values(rawRecipesJson).forEach(recipe => {
    (recipe.captures || []).forEach(cap => {
      if (!(cap.videos || []).includes(videoId)) return;
      Object.values(cap.ingredients || {}).forEach(ing => {
        const name = String(ing.name || '').trim();
        const amount = (ing.amount != null && ing.amount !== 'N/A') ? ing.amount : null;
        const unit = String(ing.amount_unit || '').trim();
        const cal = parseFloat(ing.calories);
        const carbs = parseFloat(ing.carbs);
        const fat = parseFloat(ing.fat);
        const protein = parseFloat(ing.protein);
        const hasNut = !isNaN(cal);

        // Use add.start as primary timestamp; fall back to weigh.start if add is missing
        const addEvts   = (ing.add   || []).filter(e => e.video === videoId);
        const weighEvts = (ing.weigh || []).filter(e => e.video === videoId);
        let addTime = null;
        if (addEvts.length)   addTime = parseFloat(addEvts[0].start);
        else if (weighEvts.length) addTime = parseFloat(weighEvts[0].start);

        nutritionTimeline.push({ name, amount, unit,
          cal: hasNut ? cal : null, carbs: hasNut ? carbs : null,
          fat: hasNut ? fat : null, protein: hasNut ? protein : null,
          addTime,
          fromWeigh: !addEvts.length && !!weighEvts.length });

        if (hasNut) {
          totCal += cal; totCarbs += carbs; totFat += fat; totProt += protein;
          hasAny = true;
        }
      });
    });
  });

  nutritionTimeline.sort((a, b) => {
    if (a.addTime === null && b.addTime === null) return 0;
    if (a.addTime === null) return 1;
    if (b.addTime === null) return -1;
    return a.addTime - b.addTime;
  });

  if (hasAny) nutritionRecipeTotals = { cal: totCal, carbs: totCarbs, fat: totFat, protein: totProt };
}

function renderNutritionPanel() {
  _lastNutritionAdded = -1;
  if (!nutritionTimeline.length) {
    nutritionPanel.innerHTML = '';
    nutritionPanel.classList.remove('has-nutrition');
    return;
  }

  const tot = nutritionRecipeTotals;
  const collapsed = !!_secState['nutrition'];
  const totCalStr = tot ? Math.round(tot.cal) + ' kcal' : 'N/A';
  const hasTimestamps = nutritionTimeline.some(i => i.addTime !== null);

  const ingsHtml = nutritionTimeline.map((ing, i) => {
    const calStr = ing.cal !== null ? Math.round(ing.cal) + ' kcal' : 'N/A';
    const amtStr = ing.amount !== null ? ` ${ing.amount}${ing.unit ? ' ' + ing.unit : ''}` : '';
    return `<div class="nut-ing" data-idx="${i}">` +
      `<span class="nut-ing-check">○</span>` +
      `<span class="nut-ing-name">${ing.name}${amtStr}</span>` +
      `<span class="nut-ing-cal">${calStr}</span>` +
      `<span class="nut-ing-time"></span>` +
      `</div>`;
  }).join('');

  const pStr = tot ? Math.round(tot.protein) : 'N/A';
  const cStr = tot ? Math.round(tot.carbs)   : 'N/A';
  const fStr = tot ? Math.round(tot.fat)     : 'N/A';

  const trackerHtml = tot
    ? `<div class="nut-cal-row">` +
        `<span class="nut-flame">🔥</span>` +
        `<span class="nut-cal-num" id="nut-cal-cur">0</span>` +
        `<span class="nut-cal-unit">kcal</span>` +
        `<div class="nut-cal-bar-wrap"><div class="nut-cal-bar" id="nut-cal-bar" style="width:0%"></div></div>` +
        `<span class="nut-cal-total">/ ${Math.round(tot.cal)}</span>` +
      `</div>` +
      `<div class="nut-macros">` +
        `<div class="nut-macro"><span class="nut-m-lbl nut-m-lbl-p">Protein</span>` +
          `<div class="nut-m-bar-wrap"><div class="nut-m-bar nut-m-prot" id="nut-m-prot" style="width:0%"></div></div>` +
          `<span class="nut-m-val" id="nut-m-prot-val">0 / ${pStr}g</span></div>` +
        `<div class="nut-macro"><span class="nut-m-lbl nut-m-lbl-c">Carbs</span>` +
          `<div class="nut-m-bar-wrap"><div class="nut-m-bar nut-m-carb" id="nut-m-carb" style="width:0%"></div></div>` +
          `<span class="nut-m-val" id="nut-m-carb-val">0 / ${cStr}g</span></div>` +
        `<div class="nut-macro"><span class="nut-m-lbl nut-m-lbl-f">Fat</span>` +
          `<div class="nut-m-bar-wrap"><div class="nut-m-bar nut-m-fat" id="nut-m-fat" style="width:0%"></div></div>` +
          `<span class="nut-m-val" id="nut-m-fat-val">0 / ${fStr}g</span></div>` +
      `</div>` +
      (!hasTimestamps ? `<div class="nut-no-ts">No timestamps for this recording — showing recipe totals only</div>` : '')
    : `<div class="nut-no-data">No calorie data for this recipe</div>`;

  nutritionPanel.innerHTML =
    `<div class="sec-header-row"><span class="sec-label">Nutrition · ${totCalStr} total</span>` +
      `<button class="sec-toggle" data-sec="nutrition">${collapsed ? '▸' : '▾'}</button></div>` +
    `<div class="sec-body">` +
      trackerHtml +
      `<div class="nut-ing-header">` +
        `<span class="nut-ing-check"></span>` +
        `<span class="nut-ing-name">Ingredient</span>` +
        `<span class="nut-ing-cal">Calories</span>` +
        `<span class="nut-ing-time">${hasTimestamps ? 'Added at' : ''}</span>` +
      `</div>` +
      `<div class="nut-ing-list" id="nut-ing-list">${ingsHtml}</div>` +
    `</div>`;
  nutritionPanel.classList.add('has-nutrition');
  nutritionPanel.classList.toggle('sec-collapsed', collapsed);
  nutritionPanel.querySelector('.sec-toggle').addEventListener('click', () => toggleSection('nutrition'));
}

function renderNutritionTracker(t) {
  if (!nutritionTimeline.length || _secState['nutrition']) return;

  let addedCount = 0, sumCal = 0, sumCarbs = 0, sumFat = 0, sumProt = 0;
  for (const ing of nutritionTimeline) {
    if (ing.addTime !== null && ing.addTime <= t) {
      addedCount++;
      if (ing.cal !== null) { sumCal += ing.cal; sumCarbs += ing.carbs; sumFat += ing.fat; sumProt += ing.protein; }
    }
  }
  if (addedCount === _lastNutritionAdded) return;
  _lastNutritionAdded = addedCount;

  const tot = nutritionRecipeTotals;

  const calBar = document.getElementById('nut-cal-bar');
  const calCur = document.getElementById('nut-cal-cur');
  if (calBar) calBar.style.width = (tot && tot.cal > 0 ? Math.min(100, (sumCal / tot.cal) * 100) : 0) + '%';
  if (calCur) calCur.textContent = Math.round(sumCal);

  if (tot) {
    const pb = document.getElementById('nut-m-prot'); if (pb) pb.style.width = Math.min(100, (sumProt / (tot.protein || 1)) * 100) + '%';
    const cb = document.getElementById('nut-m-carb'); if (cb) cb.style.width = Math.min(100, (sumCarbs / (tot.carbs  || 1)) * 100) + '%';
    const fb = document.getElementById('nut-m-fat');  if (fb) fb.style.width = Math.min(100, (sumFat   / (tot.fat    || 1)) * 100) + '%';
    const pv = document.getElementById('nut-m-prot-val'); if (pv) pv.textContent = `${Math.round(sumProt)} / ${Math.round(tot.protein)}g`;
    const cv = document.getElementById('nut-m-carb-val'); if (cv) cv.textContent = `${Math.round(sumCarbs)} / ${Math.round(tot.carbs)}g`;
    const fv = document.getElementById('nut-m-fat-val');  if (fv) fv.textContent = `${Math.round(sumFat)} / ${Math.round(tot.fat)}g`;
  }

  const ingList = document.getElementById('nut-ing-list');
  if (!ingList) return;
  ingList.querySelectorAll('.nut-ing').forEach((row, i) => {
    const ing = nutritionTimeline[i];
    const added = ing.addTime !== null && ing.addTime <= t;
    row.classList.toggle('nut-added', added);
    row.querySelector('.nut-ing-check').textContent = added ? '✓' : '○';
    const timeEl = row.querySelector('.nut-ing-time');
    if (timeEl) timeEl.textContent = added ? fmtTime(ing.addTime) : '';
  });
}

function getActiveStepAt(currentTime) {
  if (!stepAnnotations.length) return null;
  let activeStep = null;
  for (let i = 0; i < stepAnnotations.length; i++) {
    const step = stepAnnotations[i];
    if (step.start <= currentTime && step.stop >= currentTime) {
      if (step.type === 'prep') return step;
      if (!activeStep) activeStep = step;
    }
  }
  return activeStep;
}

function getActivityAt(t) {
  return activitySegments.find(a => a.start <= t && (isNaN(a.end) || a.end >= t)) || null;
}


let _audioHudActiveIds = '';

function renderAudioHud(currentTime) {
  if (!audioAnnotations.length) {
    if (audioHud.firstChild) audioHud.innerHTML = '';
    _audioHudActiveIds = '';
    return;
  }

  const activeAudio = audioAnnotations.filter(a => a.start <= currentTime && a.stop >= currentTime);
  const ids = activeAudio.map(a => a.start + '|' + a.stop).join(',');

  if (ids !== _audioHudActiveIds) {
    // Active set changed — rebuild DOM once
    _audioHudActiveIds = ids;
    audioHud.innerHTML = '';
    activeAudio.forEach(a => {
      const box = document.createElement('div');
      box.className = 'audio-box';
      const bar = document.createElement('div');
      bar.className = 'audio-progress-bar';
      const txt = document.createElement('div');
      txt.className = 'audio-box-text';
      box.appendChild(bar);
      box.appendChild(txt);
      audioHud.appendChild(box);
    });
  }

  // Update progress + text in-place (no DOM rebuild)
  const boxes = audioHud.children;
  activeAudio.forEach((a, i) => {
    const total = Math.max(0.001, Number(a.stop || 0) - Number(a.start || 0));
    const elapsed = Math.max(0, Math.min(total, currentTime - a.start));
    boxes[i].children[0].style.width = `${Math.min(100, (elapsed / total) * 100).toFixed(1)}%`;
    boxes[i].children[1].textContent = `${a.audio_class} (${elapsed.toFixed(1)}s / ${total.toFixed(1)}s)`;
  });
}

// ---- Load video ----
document.getElementById('video-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  vid.src = URL.createObjectURL(file);
  document.getElementById('video-name').textContent = file.name;
  currentVideoId = extractVideoId(file.name);
  activitySegments = allActivityData[currentVideoId] || [];
  updateYoutubeButton();
  renderVqaList(currentVideoId);
  dropHint.style.display = 'none';
  vid.style.display = 'block';
  applyVideoFilter();
  initSlamForVideo(currentVideoId);
  loadFramewiseGaze(currentVideoId);
});

// Drag & drop on video area
const videoWrap = document.getElementById('video-wrap');
videoWrap.addEventListener('dragover', e => { e.preventDefault(); });
videoWrap.addEventListener('drop', e => {
  e.preventDefault();
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('video/'));
  if (file) {
    vid.src = URL.createObjectURL(file);
    document.getElementById('video-name').textContent = file.name;
    currentVideoId = extractVideoId(file.name);
    activitySegments = allActivityData[currentVideoId] || [];
    updateYoutubeButton();
    renderVqaList(currentVideoId);
    dropHint.style.display = 'none';
    vid.style.display = 'block';
    applyVideoFilter();
    initSlamForVideo(currentVideoId);
    loadFramewiseGaze(currentVideoId);
  }
});

// ---- Load global annotations (.pkl/.csv) ----
document.getElementById('annotations-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await loadAnnotationsFile(file);
  } catch (err) {
    resetAnnotationsOnError(err.message || 'unable to parse annotations file');
  }
});

document.getElementById('audio-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await loadAudioFile(file);
  } catch (err) {
    resetAudioOnError(err.message || 'unable to parse audio annotations file');
  }
});

document.getElementById('recipes-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await loadRecipesFile(file);
  } catch (err) {
    resetStepsOnError(err.message || 'unable to parse recipes JSON file');
  }
});

// ---- Timeline ----
function buildTimeline() {
  timelineSvg.innerHTML = '';
  if (!mergedAnnotations.length) {
    cursor.style.left = '0%';
    progress.style.width = '0%';
    return;
  }

  const maxStop = mergedAnnotations.reduce((maxVal, a) => Math.max(maxVal, a.stop || 0), 0);
  const dur = vid.duration || maxStop || 1;
  timelineSvg.setAttribute('viewBox', `0 0 1000 38`);

  // Activity lane (top, thin, purple)
  activitySegments.forEach(a => {
    const x = (a.start / dur) * 1000;
    const end = isNaN(a.end) ? dur : a.end;
    const w = Math.max(2, ((end - a.start) / dur) * 1000);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = a.label;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x); rect.setAttribute('y', 0);
    rect.setAttribute('width', w); rect.setAttribute('height', 6);
    rect.setAttribute('fill', '#9333ea'); rect.setAttribute('opacity', '0.7');
    rect.setAttribute('rx', '1');
    g.appendChild(title);
    g.appendChild(rect);
    timelineSvg.appendChild(g);
  });

  const sortedForTopLane = [
    ...mergedAnnotations.filter(a => a.type === 'step'),
    ...mergedAnnotations.filter(a => a.type === 'prep'),
    ...mergedAnnotations.filter(a => a.type === 'narration'),
    ...mergedAnnotations.filter(a => a.type === 'audio'),
  ];

  sortedForTopLane.forEach(a => {
    const x = (a.start / dur) * 1000;
    const w = Math.max(2, ((a.stop - a.start) / dur) * 1000);
    const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
    const y = (a.type === 'step' || a.type === 'prep') ? 8 : (a.type === 'narration' ? 19 : 29);
    const fill = a.type === 'step' ? '#3b82f6'
      : (a.type === 'prep' ? '#0ea5e9' : (a.type === 'narration' ? '#2a5' : '#f5a623'));
    const opacity = (a.type === 'step' || a.type === 'prep') ? '0.75' : '0.58';
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', 8);
    rect.setAttribute('fill', fill);
    rect.setAttribute('opacity', opacity);
    rect.setAttribute('rx', '1');
    timelineSvg.appendChild(rect);
  });
}

vid.addEventListener('loadedmetadata', () => {
  tEnd.textContent = fmtTime(vid.duration, true);
  syncBboxCanvas();
  buildTimeline();
  renderActivitiesPanel();  // re-render so open-ended activities get the real end time
});

vid.addEventListener('timeupdate', () => {
  const t = vid.currentTime, dur = vid.duration || 1;
  const pct = (t / dur) * 100;
  cursor.style.left = pct + '%';
  progress.style.width = pct + '%';
  renderAudioHud(t);
  if (!_maskRafId) {
    tCur.textContent = fmtTime(t, true);
    timeMsOverlay.textContent = fmtTime(t, true);
    renderMaskBoxes(t);  // only when rAF loop is not running (paused/seek)
  }
  highlightActiveActivity(t);
  highlightActiveStep(t);
  renderNutritionTracker(t);
  renderVqaPanel(t);
  highlightActive(t);
  if (currentSlam && !_maskRafId) currentSlam.setTime(t);  // rAF handles playback
});

// Drive overlay rendering aligned with video frames.
//
// `requestVideoFrameCallback` fires once per *decoded video frame* (so 30 Hz
// for 30 fps content), with a `metadata.mediaTime` matching the frame the
// browser is about to present. This is strictly better than rAF, which fires
// at the display refresh rate (~60 Hz on most monitors) and forces ~50%
// redundant ticks where the video frame number hasn't moved. On Firefox the
// difference is large enough to be the cause of perceived stutter: fewer
// main-thread runs = less paint invalidation = smoother video.
const _HAS_VFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// Returns the bounding rect of the actual image inside the <video> element,
// accounting for object-fit:contain letterbox/pillarbox bands.
function _getVideoImageRect() {
  const vRect = vid.getBoundingClientRect();
  const wRect = videoWrap.getBoundingClientRect();
  const baseL = vRect.left - wRect.left;
  const baseT = vRect.top  - wRect.top;
  if (!vid.videoWidth || !vid.videoHeight) {
    return { left: baseL, top: baseT, width: vRect.width, height: vRect.height };
  }
  const scale = Math.min(vRect.width / vid.videoWidth, vRect.height / vid.videoHeight);
  const imgW  = vid.videoWidth  * scale;
  const imgH  = vid.videoHeight * scale;
  return {
    left:   baseL + (vRect.width  - imgW) / 2,
    top:    baseT + (vRect.height - imgH) / 2,
    width:  imgW,
    height: imgH,
  };
}

// 2D gaze dot — projects CPF gaze direction onto the Aria RGB video frame.
//
// Calibration data from projectaria_tools (VRS P01-20240204-095114):
//   R_CAM_CPF = R_device_camera.T * R_device_cpf
//   fx = 607.21 px (fisheye equidistant model — FISHEYE624)
//   principal point: cx=713.21, cy=704.35  in 1408×1408 raw sensor
//
// The Aria RGB sensor is mounted rotated 90° CW in the glasses frame.
// Verified via rgb.project() ground truth: yaw+ (left) → raw v↑, pitch+ (up) → raw u↓.
// Display NDC from raw (u, v):  ndcX = 0.5 - v/W,  ndcY = u/W - 0.5
const _gazeDot = document.getElementById('gaze-dot');
const _R_CAM_CPF = [
  [ 0.0114, -0.9912, -0.1317],
  [ 0.9997,  0.0094,  0.0173],
  [-0.0160, -0.1319,  0.9912],
];
const _GAZE_FX = 607.21;
const _GAZE_CX = 713.21;
const _GAZE_CY = 704.35;
const _GAZE_W  = 1408;
const GAZE_ENABLED_KEY = 'hdepic.gazeEnabled';
let _gazeDotEnabled = localStorage.getItem(GAZE_ENABLED_KEY) !== '0';

function _updateGazeDot(tVideoS) {
  if (!_gazeDot) return;
  if (!_gazeDotEnabled || !vid.videoWidth) {
    if (!_gazeDot.hidden) _gazeDot.hidden = true;
    return;
  }

  // ── NEW PATH: framewise keyframe lookup + linear interpolation ───────────
  // Gaze tracker fires ~5 Hz; we interpolate between keyframes to get smooth
  // 30 fps motion instead of a dot that teleports every ~6 frames.
  if (_framewiseGaze) {
    const fi = Math.round(tVideoS * 30);
    const fw = _framewiseGaze;
    // Binary search: largest i such that fw.frames[i] <= fi
    let lo = 0, hi = fw.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fw.frames[mid] <= fi) lo = mid; else hi = mid - 1;
    }
    if (fi < fw.frames[0]) { if (!_gazeDot.hidden) _gazeDot.hidden = true; return; }
    let px, py;
    if (lo < fw.n - 1) {
      const t = (fi - fw.frames[lo]) / (fw.frames[lo + 1] - fw.frames[lo]);
      px = fw.px[lo] + t * (fw.px[lo + 1] - fw.px[lo]);
      py = fw.py[lo] + t * (fw.py[lo + 1] - fw.py[lo]);
    } else {
      px = fw.px[lo]; py = fw.py[lo];
    }
    const r = _getVideoImageRect();
    const dotX = r.left + (px / 1408) * r.width;
    const dotY = r.top  + (py / 1408) * r.height;
    _gazeDot.style.transform = `translate(${dotX.toFixed(1)}px, ${dotY.toFixed(1)}px)`;
    if (_gazeDot.hidden) _gazeDot.hidden = false;
    return;
  }

  // ── OLD PATH: CPF yaw/pitch → fisheye projection (fallback if no framewise data) ──
  if (!currentSlam || !currentSlam.getGazeAtTime) {
    if (!_gazeDot.hidden) _gazeDot.hidden = true;
    return;
  }
  const g = currentSlam.getGazeAtTime(tVideoS);
  if (!g) { if (!_gazeDot.hidden) _gazeDot.hidden = true; return; }

  // d_cpf: gaze direction in CPF (+X left, +Y up, +Z forward)
  const cp = Math.cos(g.pitch), sp = Math.sin(g.pitch);
  const cyw = Math.cos(g.yaw),  syw = Math.sin(g.yaw);
  const dx = syw * cp, dy = sp, dz = cyw * cp;

  // d_cam = R_CAM_CPF * d_cpf
  const cx = _R_CAM_CPF[0][0]*dx + _R_CAM_CPF[0][1]*dy + _R_CAM_CPF[0][2]*dz;
  const cy = _R_CAM_CPF[1][0]*dx + _R_CAM_CPF[1][1]*dy + _R_CAM_CPF[1][2]*dz;
  const cz = _R_CAM_CPF[2][0]*dx + _R_CAM_CPF[2][1]*dy + _R_CAM_CPF[2][2]*dz;
  if (cz <= 0) { if (!_gazeDot.hidden) _gazeDot.hidden = true; return; }

  // Equidistant fisheye: r_px = f * atan2(r_xy, cz)
  const r_xy = Math.sqrt(cx*cx + cy*cy);
  const r_px = _GAZE_FX * Math.atan2(r_xy, cz);
  const u = _GAZE_CX + (r_xy > 1e-9 ? r_px * cx / r_xy : 0);
  const v = _GAZE_CY + (r_xy > 1e-9 ? r_px * cy / r_xy : 0);

  // 90° CW sensor rotation → display NDC
  const ndcX = 0.5 - v / _GAZE_W;
  const ndcY = u / _GAZE_W - 0.5;

  const vRect = vid.getBoundingClientRect();
  const wRect = videoWrap.getBoundingClientRect();
  const dotX = (vRect.left - wRect.left) + vRect.width  * (0.5 + ndcX);
  const dotY = (vRect.top  - wRect.top ) + vRect.height * (0.5 + ndcY);
  _gazeDot.style.transform = `translate(${dotX.toFixed(1)}px, ${dotY.toFixed(1)}px)`;
  if (_gazeDot.hidden) _gazeDot.hidden = false;
}

function _frameTick(_now, meta) {
  const t = meta ? meta.mediaTime : vid.currentTime;
  renderMaskBoxes(t);
  if (currentSlam) currentSlam.setTime(t);
  _updateGazeDot(t);
  tCur.textContent = fmtTime(t, true);
  timeMsOverlay.textContent = fmtTime(t, true);
  _maskRafId = _HAS_VFC
    ? vid.requestVideoFrameCallback(_frameTick)
    : requestAnimationFrame(_frameTick);
}
function _startMaskRaf() {
  if (_maskRafId) return;
  _maskRafId = _HAS_VFC
    ? vid.requestVideoFrameCallback(_frameTick)
    : requestAnimationFrame(_frameTick);
}
function _stopMaskRaf() {
  if (!_maskRafId) return;
  if (_HAS_VFC) vid.cancelVideoFrameCallback(_maskRafId);
  else          cancelAnimationFrame(_maskRafId);
  _maskRafId = null;
}
vid.addEventListener('play',   _startMaskRaf);
vid.addEventListener('pause',  () => { _stopMaskRaf(); renderMaskBoxes(vid.currentTime); });
vid.addEventListener('ended',  _stopMaskRaf);
vid.addEventListener('seeked', () => { if (!_maskRafId) renderMaskBoxes(vid.currentTime); });

// Seek on timeline click
timelineTrack.addEventListener('click', e => {
  const rect = timelineTrack.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  if (vid.duration) vid.currentTime = pct * vid.duration;
});

// ---- Active annotation ----
function highlightActive(t) {
  let idx = -1;
  for (let i = 0; i < annotations.length; i++) {
    if (annotations[i].start <= t && annotations[i].stop > t) { idx = i; break; }
  }

  // pos-line: visible only in genuine gaps (no active annotation)
  if (idx === -1) {
    _insertPosLine(narrPosLine, [...annotList.querySelectorAll('.annot-item')], t, annotList);
  } else {
    _hidePosLine(narrPosLine);
  }

  // Dedup on truly-active index only — no fallback loop so gaps always clear .active
  if (idx === activeIdx) return;
  activeIdx = idx;

  const prev = annotList.querySelector('.active');
  if (prev) prev.classList.remove('active');

  if (idx === -1) {
    clearCurrentAnnotation();
    return;
  }

  const a = annotations[idx];

  const filtIdx = filteredAnnotations.indexOf(a);
  if (filtIdx !== -1) {
    const item = annotList.querySelector(`.annot-item[data-annot-index="${filtIdx}"]`);
    if (item) {
      item.classList.add('active');
      scrollActiveItemToCenter(item);
    }
  }
}

// ---- Annotation list ----
function renderList(annots) {
  annotList.innerHTML = '';

  const topSpacer = document.createElement('div');
  topSpacer.className = 'annot-spacer';
  annotList.appendChild(topSpacer);

  annots.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'annot-item';
    el.dataset.annotIndex = String(i);
    el.dataset.start = String(Math.max(0, Number(a.start || 0)));

    const hw = (a.type === 'narration' && currentVideoId)
      ? findHowWhy(currentVideoId, a.start, a.stop ?? a.start + 1)
      : null;
    const tStart = Math.max(0, Number(a.start || 0));
    const tStop  = Math.max(tStart, Number(a.stop  || tStart));
    const dur    = (tStop - tStart).toFixed(1);
    el.innerHTML = `
      <div class="annot-meta">
        <button class="seek-btn" data-t="${tStart}">${fmtTime(tStart, true)}</button>
        →
        <button class="seek-btn" data-t="${tStop}">${fmtTime(tStop, true)}</button>
        <span class="annot-dur">+${dur}s</span>
        ${a.verb ? `<span class="tag-v">${a.verb}</span>` : ''}${a.noun ? `<span class="tag-n">${a.noun}</span>` : ''}
      </div>
      <div class="annot-text">${a.text}</div>
      ${hw ? `<div class="annot-howwhy">${hw.how ? `<span class="tag-how" title="how">↳ ${hw.how.text}</span>` : ''}${hw.why ? `<span class="tag-why" title="why">✦ ${hw.why.text}</span>` : ''}</div>` : ''}
    `;
    el.querySelectorAll('.seek-btn').forEach(btn =>
      btn.addEventListener('click', ev => { ev.stopPropagation(); if (vid.duration) vid.currentTime = parseFloat(btn.dataset.t); })
    );
    el.addEventListener('click', () => {
      if (vid.duration) vid.currentTime = a.start;
    });
    annotList.appendChild(el);
  });

  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'annot-spacer';
  annotList.appendChild(bottomSpacer);

  updateCaptionSpacers();

  if (annotations.length && vid.currentTime >= 0) highlightActive(vid.currentTime);
}

// ---- Search ----
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    filteredAnnotations = annotations;
  } else {
    const matchedSteps = stepAnnotations.filter(s => String(s.text || '').toLowerCase().includes(q));
    filteredAnnotations = annotations.filter(a => String(a.text || '').toLowerCase().includes(q)
      || String(a.verb || '').toLowerCase().includes(q)
      || String(a.noun || '').toLowerCase().includes(q)
      || matchedSteps.some(s => a.start <= s.stop && a.stop >= s.start));
  }
  renderList(filteredAnnotations);
  refreshStatus();
});

window.addEventListener('resize', () => { updateCaptionSpacers(); syncBboxCanvas(); });

// ---- Resize handles ----
// Drag handles between panels. Each handle adjusts one neighbor via a CSS
// variable (--rsz-h or --rsz-w) on the target panel, so the collapse CSS
// rules that reset `flex: 0 0 auto` still work. Persisted to localStorage.
function makeResizable({ handle, target, dir, min = 60, sign = 1, key, onResize }) {
  if (!handle || !target) return;
  const cssVar = dir === 'h' ? '--rsz-w' : '--rsz-h';
  const sizeProp = dir === 'h' ? 'offsetWidth' : 'offsetHeight';

  if (key) {
    const saved = localStorage.getItem(key);
    if (saved && !isNaN(parseFloat(saved))) {
      target.style.setProperty(cssVar, parseFloat(saved) + 'px');
    }
  }

  let startPos = 0, startSize = 0;
  function onMove(e) {
    const pos = dir === 'h' ? e.clientX : e.clientY;
    const delta = (pos - startPos) * sign;
    const newSize = Math.max(min, startSize + delta);
    target.style.setProperty(cssVar, newSize + 'px');
    if (key) localStorage.setItem(key, String(newSize));
    if (onResize) onResize();
  }
  function onUp() {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startPos = dir === 'h' ? e.clientX : e.clientY;
    startSize = target[sizeProp];
    document.body.style.cursor = dir === 'h' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

(function wireResizers() {
  const slamResize = () => { if (currentSlam) currentSlam.resize(); syncBboxCanvas(); };
  // A: video|annot horizontal — drag right grows video-panel
  makeResizable({
    handle: document.getElementById('rsz-video-annot'),
    target: document.getElementById('video-panel'),
    dir: 'h', sign: 1, min: 240, key: 'rsz_video_annot',
    onResize: slamResize,
  });
  // B: video-wrap|slam-host vertical — drag DOWN shrinks slam-host
  makeResizable({
    handle: document.getElementById('rsz-video-slam'),
    target: document.getElementById('slam-host'),
    dir: 'v', sign: -1, min: 80, key: 'rsz_video_slam',
    onResize: slamResize,
  });
  // C: activities|steps — drag DOWN grows activities (narrations flex:1 shrinks)
  makeResizable({
    handle: document.getElementById('rsz-act-step'),
    target: document.getElementById('activities-panel'),
    dir: 'v', sign: 1, min: 40, key: 'rsz_act_step',
  });
  // D: steps|narrations — drag DOWN grows steps (narrations flex:1 shrinks)
  makeResizable({
    handle: document.getElementById('rsz-step-nar'),
    target: document.getElementById('steps-panel'),
    dir: 'v', sign: 1, min: 40, key: 'rsz_step_nar',
  });
  // E: narrations|nutrition — drag DOWN shrinks nutrition
  makeResizable({
    handle: document.getElementById('rsz-nar-nut'),
    target: document.getElementById('nutrition-panel'),
    dir: 'v', sign: -1, min: 40, key: 'rsz_nar_nut',
  });
  // E: nutrition|vqa — drag DOWN shrinks vqa
  makeResizable({
    handle: document.getElementById('rsz-nut-vqa'),
    target: document.getElementById('vqa-panel'),
    dir: 'v', sign: -1, min: 40, key: 'rsz_nut_vqa',
  });
})();

// ---- Auto-load defaults ----
// These paths are relative to the server root (one level up from viewer/).
const AUTO_PATHS = {
  annotations: '../narrations-and-action-segments/unofficial_narrations_converted_from_pkl.csv',
  audio:       '../audio-annotations/HD_EPIC_Sounds.csv',
  recipes:     '../high-level/complete_recipes.json',
  masks:       '../scene-and-object-movements/mask_info.json',
  assoc:       '../scene-and-object-movements/assoc_info.json',
  youtube:     '../youtube-links/HD_EPIC_YouTube_URLs.csv',
  how:         '../vqa-benchmark/fine_grained_how_recognition.json',
  why:         '../vqa-benchmark/fine_grained_why_recognition.json',
};

async function fetchAsFileLike(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return {
    name,
    arrayBuffer: () => Promise.resolve(buf),
    text: () => Promise.resolve(new TextDecoder().decode(buf)),
  };
}

async function autoLoadDefaults() {
  setStatus('auto-loading data files…');
  const results = await Promise.allSettled([
    fetchAsFileLike(AUTO_PATHS.annotations, 'unofficial_narrations_converted_from_pkl.csv'),
    fetchAsFileLike(AUTO_PATHS.audio,       'HD_EPIC_Sounds.csv'),
    fetchAsFileLike(AUTO_PATHS.recipes,     'complete_recipes.json'),
  ]);

  const [annoRes, audioRes, recipesRes] = results;

  if (annoRes.status === 'fulfilled') {
    try {
      await loadAnnotationsFile(annoRes.value);
      document.getElementById('csv-name').textContent = 'narrations (auto)';
    } catch (err) {
      resetAnnotationsOnError('auto-load narrations: ' + (err.message || err));
    }
  } else {
    console.warn('auto-load narrations failed:', annoRes.reason);
  }

  if (audioRes.status === 'fulfilled') {
    try {
      await loadAudioFile(audioRes.value);
      document.getElementById('audio-name').textContent = 'audio (auto)';
    } catch (err) {
      resetAudioOnError('auto-load audio: ' + (err.message || err));
    }
  } else {
    console.warn('auto-load audio failed:', audioRes.reason);
  }

  if (recipesRes.status === 'fulfilled') {
    try {
      await loadRecipesFile(recipesRes.value);
      document.getElementById('step-name').textContent = 'recipes (auto)';
    } catch (err) {
      resetStepsOnError('auto-load recipes: ' + (err.message || err));
    }
  } else {
    console.warn('auto-load recipes failed:', recipesRes.reason);
  }

  // Load mask and assoc data (used for 2D bbox overlay on video)
  try {
    const maskFile = await fetchAsFileLike(AUTO_PATHS.masks, 'mask_info.json');
    allMaskData = await parseInWorker(await maskFile.arrayBuffer(), 'json');
  } catch (err) {
    console.warn('auto-load mask_info failed:', err);
  }
  try {
    const assocFile = await fetchAsFileLike(AUTO_PATHS.assoc, 'assoc_info.json');
    allAssocData = await parseInWorker(await assocFile.arrayBuffer(), 'json');
  } catch (err) {
    console.warn('auto-load assoc_info failed:', err);
  }
  if (currentVideoId) buildMaskLookup(currentVideoId);

  try {
    const res = await fetch(AUTO_PATHS.youtube);
    if (res.ok) {
      const text = await res.text();
      const lines = text.trim().split('\n');
      for (let i = 1; i < lines.length; i++) {
        const comma = lines[i].indexOf(',');
        if (comma < 0) continue;
        const id = lines[i].slice(0, comma).trim();
        const url = lines[i].slice(comma + 1).split(',')[0].trim();
        if (id && url) youtubeUrls[id] = url;
      }
    }
  } catch (err) {
    console.warn('auto-load youtube URLs failed:', err);
  }

  try {
    const participants = ['P01','P02','P03','P04','P05','P06','P07','P08','P09'];
    const actResponses = await Promise.allSettled(
      participants.map(p => fetch(`../high-level/activities/${p}_recipe_timestamps.csv`).then(r => r.ok ? r.text() : null))
    );
    actResponses.forEach(res => {
      if (res.status !== 'fulfilled' || !res.value) return;
      parseCSV(res.value).forEach(r => {
        const vid2 = r.video_id?.trim();
        const label = r.high_level_activity_label?.trim();
        const start = parseFloat(r.start_time);
        const end   = parseFloat(r.end_time);
        if (!vid2 || !label) return;
        (allActivityData[vid2] ||= []).push({ label, start, end });
      });
    });
    if (currentVideoId) {
      activitySegments = allActivityData[currentVideoId] || [];
      buildTimeline();
      renderActivitiesPanel();
    }
  } catch (err) {
    console.warn('auto-load activity timestamps failed:', err);
  }

  try {
    const [howRes, whyRes] = await Promise.all([
      fetch(AUTO_PATHS.how),
      fetch(AUTO_PATHS.why),
    ]);
    if (howRes.ok && whyRes.ok) {
      buildHowWhyLookup(await howRes.json(), await whyRes.json());
    }
  } catch (err) {
    console.warn('auto-load how/why failed:', err);
  }

  try {
    const vqaFiles = Object.keys(VQA_CATEGORIES).map(cat => [cat, `../vqa-benchmark/${cat}.json`]);
    await Promise.allSettled(vqaFiles.map(async ([cat, path]) => {
      const res = await fetch(path);
      if (!res.ok) return;
      const data = await parseInWorker(await res.arrayBuffer(), 'json');
      buildVqaLookup(data, cat);
    }));
    if (currentVideoId) renderVqaList(currentVideoId);
  } catch (err) {
    console.warn('auto-load VQA failed:', err);
  }

  setStatus('data ready — drop a video to begin');
}

// ---- SLAM 3D panel ----
// Drives a shared scene (viewer/slam-viewer.js) synced with the video. Falls
// back to a placeholder when no `output/slam_<video_id>.json` exists.
let currentSlam       = null;
let _slamInitVersion  = 0;
let _slamModulePromise = null;
const _slamHost        = document.getElementById('slam-host');
const _slamPlaceholder = document.getElementById('slam-placeholder');
const _slamToggleBtn   = document.getElementById('slam-toggle');
const _slamLayersPanel = document.getElementById('slam-layers');

const SLAM_ENABLED_KEY = 'hdepic.slamEnabled';
const slamInitiallyOn  = localStorage.getItem(SLAM_ENABLED_KEY) !== '0';
document.body.classList.toggle('no-slam', !slamInitiallyOn);
_slamToggleBtn.classList.toggle('active', slamInitiallyOn);

// Gaze-dot toggle button — shown only when framewise_info.jsonl is loaded.
// Controls _gazeDotEnabled independently of the SLAM 3D ray (#L-gaze-ray).
{
  const _gazeBtn = document.getElementById('gaze-btn');
  if (_gazeBtn) {
    _gazeBtn.addEventListener('click', () => {
      _gazeDotEnabled = !_gazeDotEnabled;
      localStorage.setItem(GAZE_ENABLED_KEY, _gazeDotEnabled ? '1' : '0');
      _gazeBtn.classList.toggle('active', _gazeDotEnabled);
    });
  }
}

// Maps DOM checkbox ids in #slam-layers to module layer names. mov-persist is
// a special case wired to setMovementsPersistent instead of setLayerVisible.
const _SLAM_LAYER_MAP = [
  ['L-kitchen',   'kitchen'],
  ['L-traj',      'trajectory'],
  ['L-gaze',      'gaze'],
  ['L-gaze-ray',  'gazeRay'],
  ['L-head',      'head'],
  ['L-objects',   'objects'],
  ['L-movements', 'movements'],
  ['L-grid',      'grid'],
];

function _applySlamLayersToCurrent() {
  if (!currentSlam) return;
  for (const [id, layer] of _SLAM_LAYER_MAP) {
    const cb = document.getElementById(id);
    if (cb) currentSlam.setLayerVisible(layer, cb.checked);
  }
  const persist = document.getElementById('L-mov-persist');
  if (persist) currentSlam.setMovementsPersistent(persist.checked);
  // #L-gaze-ray now controls only the 3D ray in slam-viewer.js; the 2D dot
  // is controlled independently by #gaze-btn in the topbar.
}

// Wire the change events once at boot. They no-op when no slam is mounted yet.
for (const [id, layer] of _SLAM_LAYER_MAP) {
  const cb = document.getElementById(id);
  if (cb) cb.addEventListener('change', e => {
    if (currentSlam) currentSlam.setLayerVisible(layer, e.target.checked);
  });
}
{
  const persist = document.getElementById('L-mov-persist');
  if (persist) persist.addEventListener('change', e => currentSlam && currentSlam.setMovementsPersistent(e.target.checked));
}

function loadSlamModule() {
  if (!_slamModulePromise) {
    _slamModulePromise = import('./slam-viewer.js').then(m => m.initSlamViewer);
  }
  return _slamModulePromise;
}

function showSlamPlaceholder(msg) {
  if (_slamPlaceholder) {
    _slamPlaceholder.textContent = msg;
    _slamPlaceholder.style.display = '';
  }
  if (_slamLayersPanel) _slamLayersPanel.hidden = true;
  if (_gazeDot) _gazeDot.hidden = true;
}

function hideSlamPlaceholder() {
  if (_slamPlaceholder) _slamPlaceholder.style.display = 'none';
  if (_slamLayersPanel) _slamLayersPanel.hidden = false;
}

async function initSlamForVideo(videoId) {
  const myVersion = ++_slamInitVersion;
  if (currentSlam) {
    currentSlam.destroy();
    currentSlam = null;
  }
  if (!videoId) {
    showSlamPlaceholder('Load a video to see the SLAM 3D scene');
    return;
  }
  showSlamPlaceholder(`Loading 3D scene for ${videoId}…`);

  // Probe data file first so 404 doesn't leak a half-mounted scene.
  // Cache-buster on the JSON: SLAM exports are regenerated frequently during
  // development, and Firefox/Chromium happily serve stale copies even after a
  // hard reload of the HTML — leading to "module ignores new fields" bugs.
  // The browser will still cache the GLB (which we want, it's big).
  const dataUrl = `../output/slam_${videoId}.json?v=${Date.now()}`;
  let dataRes;
  try {
    dataRes = await fetch(dataUrl);
  } catch (e) {
    if (myVersion === _slamInitVersion) showSlamPlaceholder(`No SLAM data for ${videoId}`);
    return;
  }
  if (!dataRes.ok) {
    if (myVersion === _slamInitVersion) showSlamPlaceholder(`No SLAM data for ${videoId}`);
    return;
  }

  const participant = videoId.split('-')[0];
  const glbUrl = `../output/${participant}_final.glb`;

  let initSlamViewer;
  try {
    initSlamViewer = await loadSlamModule();
  } catch (e) {
    if (myVersion === _slamInitVersion) showSlamPlaceholder('Failed to load 3D module');
    console.warn('[slam] module load failed:', e);
    return;
  }
  if (myVersion !== _slamInitVersion) return;  // raced — newer call took over

  let slam;
  try {
    slam = await initSlamViewer({
      container: _slamHost,
      dataUrl,
      glbUrl,
    });
  } catch (e) {
    if (myVersion === _slamInitVersion) showSlamPlaceholder('Failed to init 3D scene');
    console.warn('[slam] init failed:', e);
    return;
  }
  if (myVersion !== _slamInitVersion) {
    slam.destroy();  // a newer init won the race
    return;
  }
  currentSlam = slam;
  hideSlamPlaceholder();
  _applySlamLayersToCurrent();  // reapply checkbox state to the freshly mounted scene
  currentSlam.setTime(vid.currentTime || 0);
}

_slamToggleBtn.addEventListener('click', () => {
  const wasOff = document.body.classList.toggle('no-slam');
  const nowOn  = !wasOff;
  _slamToggleBtn.classList.toggle('active', nowOn);
  localStorage.setItem(SLAM_ENABLED_KEY, nowOn ? '1' : '0');
  if (nowOn && currentSlam) {
    // The host became visible again; force a resize + time refresh.
    currentSlam.resize();
    currentSlam.setTime(vid.currentTime || 0);
  }
});

// hide video initially
vid.style.display = 'none';
renderActivitiesPanel();
renderStepsPanel();
renderNutritionPanel();
autoLoadDefaults();
