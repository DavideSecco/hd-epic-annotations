// Runs CSV and JSON parsing off the main thread.
// Protocol: main sends { id, buffer: ArrayBuffer, type: 'csv' | 'json' | 'jsonl_gaze' }
//           worker replies { id, result } or { id, error }
//           for jsonl_gaze, result = { frames, px, py: ArrayBuffer (Int16), n: count }
//           all three ArrayBuffers are transferred (zero-copy)

function parseCSV(text) {
  const lines = text.split('\n');
  const header = lines[0].split(',').map(h =>
    h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  );
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
    header.forEach((h, j) => { row[h] = (fields[j] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

// Parses framewise_info.jsonl — extracts gaze keyframes for linear interpolation.
// Only records entries where gaze_timestamp_ns changes (effective ~5 Hz in Aria),
// which the viewer then interpolates to 30 fps for smooth motion.
// Returns { frames, px, py, n } — all Int16Array buffers, n = keyframe count.
function parseJSONLGaze(text) {
  const kf_frame = [], kf_px = [], kf_py = [];
  let prevGazeTs = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (d.gaze_centre_in_pixels && d.gaze_timestamp_ns !== prevGazeTs) {
      kf_frame.push(d.frame_index);
      kf_px.push(d.gaze_centre_in_pixels[0]);
      kf_py.push(d.gaze_centre_in_pixels[1]);
      prevGazeTs = d.gaze_timestamp_ns;
    }
  }
  const frames = new Int16Array(kf_frame);
  const px     = new Int16Array(kf_px);
  const py     = new Int16Array(kf_py);
  return { frames: frames.buffer, px: px.buffer, py: py.buffer, n: kf_frame.length };
}

self.onmessage = function (e) {
  const { id, buffer, type } = e.data;
  try {
    const text = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
    if (type === 'jsonl_gaze') {
      const result = parseJSONLGaze(text);
      self.postMessage({ id, result }, [result.frames, result.px, result.py]);
    } else {
      const result = type === 'json' ? JSON.parse(text) : parseCSV(text);
      self.postMessage({ id, result });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
