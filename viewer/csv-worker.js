// Runs CSV and JSON parsing off the main thread.
// Protocol: main sends { id, buffer: ArrayBuffer, type: 'csv' | 'json' }
//           worker replies { id, result } or { id, error }

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

self.onmessage = function (e) {
  const { id, buffer, type } = e.data;
  try {
    const text = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
    const result = type === 'json' ? JSON.parse(text) : parseCSV(text);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
