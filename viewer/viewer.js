const vid = document.getElementById('vid');
const dropHint = document.getElementById('drop-hint');
const timelineTrack = document.getElementById('timeline-track');
const timelineSvg = document.getElementById('timeline-segments');
const cursor = document.getElementById('timeline-cursor');
const progress = document.getElementById('timeline-progress');
const annotList = document.getElementById('annot-list');
const recipeOverview = document.getElementById('recipe-overview');
const audioHud = document.getElementById('audio-hud');
const stepContext = document.getElementById('step-context');
const searchInput = document.getElementById('search');
const tStart = document.getElementById('t-start');
const tCur = document.getElementById('t-cur');
const tEnd = document.getElementById('t-end');

let allAnnotations = [];
let annotations = [];
let allAudioAnnotations = [];
let audioAnnotations = [];
let stepAnnotations = [];
let mergedAnnotations = [];
let filteredAnnotations = [];
let activeIdx = -1;
let currentVideoId = '';
let rawRecipesJson = null;
let currentRecipeMeta = null;

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

function scrollActiveItemToCenter(item) {
  const container = annotList;
  const containerCenter = container.clientHeight / 2;

  // Let first/last captions center correctly without fixed offsets.
  const spacerSize = Math.max(0, containerCenter - (item.clientHeight / 2));
  container.querySelectorAll('.annot-spacer').forEach(spacer => {
    spacer.style.height = `${spacerSize}px`;
  });

  const captionCenter = item.offsetTop + (item.clientHeight / 2);
  let targetScrollTop = captionCenter - containerCenter;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  targetScrollTop = Math.max(0, Math.min(targetScrollTop, maxScroll));

  container.scrollTo({
    top: targetScrollTop,
    behavior: 'smooth'
  });
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

function applyVideoFilter() {
  if (!currentVideoId) {
    annotations = [];
    audioAnnotations = [];
    stepAnnotations = [];
    currentRecipeMeta = null;
    mergedAnnotations = [];
    filteredAnnotations = [];
    activeIdx = -1;
    renderList(filteredAnnotations);
    renderRecipeOverview(null);
    renderAudioHud(0);
    updateStepContext(0);
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
  } else {
    stepAnnotations = [];
    currentRecipeMeta = null;
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
  renderList(filteredAnnotations);
  renderRecipeOverview(currentRecipeMeta);
  renderAudioHud(vid.currentTime || 0);
  updateStepContext(vid.currentTime || 0);
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

function renderRecipeOverview(meta) {
  if (!meta) {
    recipeOverview.innerHTML = '<div class="recipe-empty">Nessuna ricetta associata</div>';
    return;
  }

  const safeName = String(meta.name || 'Ricetta').trim();
  const safeSource = String(meta.source || '').trim();
  const stepValues = Object.values(meta.steps || {}).map(v => String(v || '').trim()).filter(Boolean);
  const listHtml = stepValues.length
    ? `<ol>${stepValues.map(step => `<li>${step}</li>`).join('')}</ol>`
    : '<div class="recipe-empty">Nessuno step disponibile</div>';
  const sourceHtml = safeSource
    ? `<div class="recipe-source">Sorgente: <a href="${safeSource}" target="_blank" rel="noopener noreferrer">Link Ricetta originale</a></div>`
    : '<div class="recipe-source">Sorgente non disponibile</div>';

  recipeOverview.innerHTML = `
    <h2>${safeName}</h2>
    ${sourceHtml}
    ${listHtml}
  `;
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

let _lastStepContextText = null;

function updateStepContext(currentTime) {
  const activeStep = getActiveStepAt(currentTime);
  let label, color;
  if (!activeStep) {
    label = 'Nessuna macro-fase attiva'; color = '#3b82f6';
  } else if (activeStep.type === 'prep') {
    label = `Prep: ${activeStep.text}`; color = '#0ea5e9';
  } else {
    label = `Fase: ${activeStep.text}`; color = '#3b82f6';
  }
  if (label === _lastStepContextText) return;
  _lastStepContextText = label;
  stepContext.textContent = label;
  stepContext.style.borderBottomColor = color;
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
  dropHint.style.display = 'none';
  vid.style.display = 'block';
  applyVideoFilter();
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
    dropHint.style.display = 'none';
    vid.style.display = 'block';
    applyVideoFilter();
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
  timelineSvg.setAttribute('viewBox', `0 0 1000 30`);

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
    const y = (a.type === 'step' || a.type === 'prep') ? 0 : (a.type === 'narration' ? 11 : 22);
    const h = (a.type === 'step' || a.type === 'prep') ? 8 : 8;
    const fill = a.type === 'step' ? '#3b82f6'
      : (a.type === 'prep' ? '#0ea5e9' : (a.type === 'narration' ? '#2a5' : '#f5a623'));
    const opacity = (a.type === 'step' || a.type === 'prep') ? '0.75' : '0.58';
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
    rect.setAttribute('fill', fill);
    rect.setAttribute('opacity', opacity);
    rect.setAttribute('rx', '1');
    timelineSvg.appendChild(rect);
  });
}

vid.addEventListener('loadedmetadata', () => {
  tEnd.textContent = fmtTime(vid.duration);
  buildTimeline();
});

vid.addEventListener('timeupdate', () => {
  const t = vid.currentTime, dur = vid.duration || 1;
  const pct = (t / dur) * 100;
  cursor.style.left = pct + '%';
  progress.style.width = pct + '%';
  tCur.textContent = fmtTime(t);
  renderAudioHud(t);
  updateStepContext(t);
  highlightActive(t);
});

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
    if (annotations[i].start <= t && annotations[i].stop >= t) { idx = i; break; }
  }

  if (idx === -1) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (annotations[i].start <= t) { idx = i; break; }
    }
  }

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

    el.innerHTML = `
      <div class="annot-time">${fmtCaptionMeta(a.start, a.stop)}</div>
      <div class="annot-text">${a.text}</div>
      ${(a.verb || a.noun) ? `<div class="annot-tags">${a.verb ? `<span class="tag-v">${a.verb}</span>` : ''}${a.noun ? `<span class="tag-n">${a.noun}</span>` : ''}</div>` : ''}
    `;
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

window.addEventListener('resize', updateCaptionSpacers);

// ---- Auto-load defaults ----
// These paths are relative to the server root (one level up from viewer/).
const AUTO_PATHS = {
  annotations: '../narrations-and-action-segments/unofficial_narrations_converted_from_pkl.csv',
  audio:       '../audio-annotations/HD_EPIC_Sounds.csv',
  recipes:     '../high-level/complete_recipes.json',
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

  setStatus('data ready — drop a video to begin');
}

// hide video initially
vid.style.display = 'none';
renderRecipeOverview(null);
autoLoadDefaults();
