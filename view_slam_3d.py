#!/usr/bin/env python3
"""
HD-EPIC SLAM Trajectory Viewer
================================
Visualizes the SLAM camera trajectory overlaid on the kitchen digital twin.

Usage:
    # Auto-discover everything from participant + session index
    python3 view_slam_3d.py --participant P01 --session 0

    # Explicit paths
    python3 view_slam_3d.py \\
        --glb output/P01_final.glb \\
        --slam /mnt/bocconi_hpc_video_datasets/HD-EPIC/SLAM-and-Gaze/P01/SLAM/multi/0/slam/closed_loop_trajectory.csv \\
        --video-id P01-20240202-110250

Integration path:
    The generated HTML is structured for easy embedding in the main viewer:
    - Data lives in <script type="application/json" id="slam-data"> → swap with fetch()
    - Three.js scene is inside <div id="slam-viewer"> → drop into any container
    - No global state; all references are scoped to the module
"""

import argparse
import csv
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import webbrowser
from pathlib import Path

HPC_ROOT = Path("/mnt/bocconi_hpc_video_datasets/HD-EPIC")
REPO_ROOT = Path(__file__).parent

# Shared three.js scene module: same file used by viewer/slam-test.html and (in
# Fase 3) by the main viewer. Inlined into the standalone HTML so file:// works.
SLAM_VIEWER_JS_PATH  = REPO_ROOT / 'viewer' / 'slam-viewer.js'
SLAM_VIEWER_CSS_PATH = REPO_ROOT / 'viewer' / 'slam-viewer.css'

BLENDER_EXPORT_SCRIPT = """\
import bpy, sys
output_path = sys.argv[sys.argv.index("--") + 1]
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_texcoords=True,
    export_normals=True,
)
print(f"[export] Saved to {output_path}")
"""

# ── HTML template ──────────────────────────────────────────────────────────────
# Placeholders: ___TITLE___ ___DATA_JSON___ ___GLB_PATH___
# Using simple str.replace() so JS template literals and {} braces are not affected.

HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>___TITLE___</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0f0f1e; color: #e0e0f0; font-family: monospace; overflow: hidden; }

/* ── slam-viewer is the self-contained block to embed in the main viewer ── */
#slam-viewer { width: 100vw; height: 100vh; position: relative; }

#info-panel {
  position: absolute; top: 12px; left: 12px;
  background: rgba(0,0,16,.75); backdrop-filter: blur(6px);
  padding: 10px 16px; border-radius: 8px; font-size: 13px; line-height: 1.9;
  min-width: 230px; border: 1px solid rgba(100,150,255,.2);
  pointer-events: none;
}
#info-panel h3 { color: #7eb8f7; margin-bottom: 4px; font-size: 14px; }
.stat { color: #99a; }
.val  { color: #eef; }

#layer-panel {
  position: absolute; top: 12px; right: 12px;
  background: rgba(0,0,16,.75); backdrop-filter: blur(6px);
  padding: 10px 16px; border-radius: 8px; font-size: 13px; line-height: 2.2;
  border: 1px solid rgba(100,150,255,.2);
}
#layer-panel h4 { color: #7eb8f7; margin-bottom: 2px; }
.layer-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.layer-toggle input { accent-color: #7eb8f7; }

#controls {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
  background: rgba(0,0,16,.82); backdrop-filter: blur(6px);
  padding: 9px 20px; border-radius: 12px; border: 1px solid rgba(100,150,255,.2);
  display: flex; align-items: center; gap: 14px; font-size: 13px;
}
#play-btn {
  background: #1e3f66; border: 1px solid #5a9fd4; color: #7eb8f7;
  border-radius: 6px; width: 36px; height: 30px; font-size: 16px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
#play-btn:hover { background: #2a5580; }
#timeline { flex: 1; accent-color: #7eb8f7; min-width: 220px; cursor: pointer; }
#time-display { color: #99a; white-space: nowrap; min-width: 100px; text-align: right; }
#speed-select {
  background: #151530; color: #aac; border: 1px solid #334;
  border-radius: 4px; padding: 2px 6px; font-family: monospace; font-size: 12px; cursor: pointer;
}
#reset-cam {
  background: #151530; border: 1px solid #334; color: #99b;
  border-radius: 6px; padding: 3px 12px; cursor: pointer; font-family: monospace; font-size: 12px;
}
#reset-cam:hover { background: #202050; }

#loading {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  font-size: 18px; color: #7eb8f7; pointer-events: none;
}

/* legend dots */
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }

/* layer-panel sub-toggle (indented) */
.sub-toggle { margin-left: 22px; opacity: .8; font-size: 12px; }

/* ── Injected from viewer/slam-viewer.css at generation time ── */
___SLAM_VIEWER_CSS___
</style>
</head>
<body>

<!-- DATA BLOB ─────────────────────────────────────────────────────────────────
     In the integrated viewer, replace this element with a fetch() call and
     pass the parsed object to initSlamViewer(data, container, glbUrl).
     ─────────────────────────────────────────────────────────────────────── -->
<script type="application/json" id="slam-data">___DATA_JSON___</script>

<div id="slam-viewer">
  <div id="loading">Loading kitchen model…</div>

  <div id="info-panel">
    <h3>___TITLE___</h3>
    <div><span class="stat">Video: </span><span class="val" id="vid-display">—</span></div>
    <div><span class="stat">Duration: </span><span class="val" id="dur-display">—</span></div>
    <div><span class="stat">Position (m): </span><span class="val" id="pos-display">—</span></div>
    <div style="margin-top:6px">
      <span class="dot" style="background:#4488ff"></span><span class="stat">start </span>
      <span class="dot" style="background:#ff4444" style="margin-left:8px"></span><span class="stat">end</span>
    </div>
    <div style="margin-top:4px">
      <span class="dot" style="background:#ffcc00"></span><span class="stat">gaze obj </span>
      <span class="dot" style="background:#00ccff"></span><span class="stat">gaze point</span>
    </div>
    <div>
      <span class="dot" style="background:#44ff88"></span><span class="stat">mask objects</span>
    </div>
    <div>
      <span style="display:inline-block;width:14px;height:2px;background:#ff8844;margin-right:5px;vertical-align:middle"></span><span class="stat">object movement</span>
    </div>
  </div>

  <div id="layer-panel">
    <h4>Layers</h4>
    <label class="layer-toggle"><input type="checkbox" id="tog-kitchen" checked> Kitchen model</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-traj"    checked> Trajectory</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-gaze"    checked> Gaze priming</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-head"    checked> Camera head</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-objects" checked> Objects</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-movements" checked> Movements</label>
    <label class="layer-toggle sub-toggle"><input type="checkbox" id="tog-mov-persist"> all at once</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-grid"    checked> Grid</label>
  </div>

  <div id="controls">
    <button id="play-btn" title="Play / Pause (Space)">▶</button>
    <input type="range" id="timeline" min="0" max="10000" value="0" step="1">
    <span id="time-display">0:00 / 0:00</span>
    <select id="speed-select">
      <option value="0.25">0.25×</option>
      <option value="0.5">0.5×</option>
      <option value="1" selected>1×</option>
      <option value="2">2×</option>
      <option value="5">5×</option>
      <option value="10">10×</option>
    </select>
    <button id="reset-cam">⟳ View</button>
  </div>
</div>

<script type="importmap">
{
  "imports": {
    "three":          "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
    "three/addons/":  "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"
  }
}
</script>

<script type="module">
// ════════════════════════════════════════════════════════════════════════════════
// Inlined module source (viewer/slam-viewer.js) — single source of truth.
// `view_slam_3d.py` injects the file contents at generation time. The standalone
// HTML therefore stays self-contained (file:// works) while sharing the exact
// same scene logic used by the integrated viewer.
// ════════════════════════════════════════════════════════════════════════════════
___SLAM_VIEWER_JS___

// ════════════════════════════════════════════════════════════════════════════════
// Bootstrap (standalone-only UI: info panel, timeline, play/pause, speed,
// reset-cam, layer toggles, spacebar). The module owns the render loop, the
// resize observer and all three.js state — this bootstrap only drives time
// and wires DOM controls to its API.
// ════════════════════════════════════════════════════════════════════════════════
const DATA      = JSON.parse(document.getElementById('slam-data').textContent);
const container = document.getElementById('slam-viewer');
const loadingEl = document.getElementById('loading');

const slam = await initSlamViewer({
  container,
  data:   DATA,
  glbUrl: '___GLB_PATH___',
});

// Hide loading overlay; warn if kitchen GLB never made it in.
const info = slam.getInfo();
if (!info.kitchenLoaded) {
  loadingEl.textContent = '⚠ Kitchen model not found — showing trajectory only';
  loadingEl.style.color = '#fa8';
  setTimeout(() => { loadingEl.style.display = 'none'; }, 4000);
} else {
  loadingEl.style.display = 'none';
}

// ── Info panel (static fields) ────────────────────────────────────────────────
const DUR_S = info.duration_s;
document.getElementById('vid-display').textContent = DATA.video_id || '—';
document.getElementById('dur-display').textContent =
  DUR_S.toFixed(1) + 's  (' + info.n_traj_points.toLocaleString() + ' pts)';

// ── Playback state ────────────────────────────────────────────────────────────
let playing     = false;
let currentS    = 0;
let speedFactor = 1.0;
let lastFrameMs = null;

const playBtn    = document.getElementById('play-btn');
const timeSlider = document.getElementById('timeline');
const timeDisp   = document.getElementById('time-display');
const posDisp    = document.getElementById('pos-display');

function fmt(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

function applyTime(s) {
  currentS = Math.max(0, Math.min(DUR_S, s));
  slam.setTime(currentS);
  const p = slam.getCurrentPosition();
  posDisp.textContent = `${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)}`;
  timeSlider.value = Math.round(DUR_S > 0 ? (currentS / DUR_S) * 10000 : 0);
  timeDisp.textContent = `${fmt(currentS)} / ${fmt(DUR_S)}`;
}
applyTime(0);

// ── Control wiring ────────────────────────────────────────────────────────────
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? '⏸' : '▶';
  if (playing) lastFrameMs = null;
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    playBtn.click();
  }
});

timeSlider.addEventListener('input', () => {
  applyTime((timeSlider.value / 10000) * DUR_S);
});

document.getElementById('speed-select').addEventListener('change', (e) => {
  speedFactor = parseFloat(e.target.value);
});

document.getElementById('reset-cam').addEventListener('click', () => slam.fitCamera());

// ── Layer toggles ─────────────────────────────────────────────────────────────
const wireLayer = (id, layer) => {
  document.getElementById(id).addEventListener('change',
    (e) => slam.setLayerVisible(layer, e.target.checked));
};
wireLayer('tog-kitchen',   'kitchen');
wireLayer('tog-traj',      'trajectory');
wireLayer('tog-gaze',      'gaze');
wireLayer('tog-head',      'head');
wireLayer('tog-objects',   'objects');
wireLayer('tog-movements', 'movements');
wireLayer('tog-grid',      'grid');
document.getElementById('tog-mov-persist').addEventListener('change',
  (e) => slam.setMovementsPersistent(e.target.checked));

// ── Playback loop (drives setTime; module renders on its own rAF) ─────────────
function tick(nowMs) {
  requestAnimationFrame(tick);
  if (!playing) { lastFrameMs = null; return; }
  if (lastFrameMs !== null) {
    const dt = (nowMs - lastFrameMs) / 1000 * speedFactor;
    let next = currentS + dt;
    if (next > DUR_S) next = 0;  // loop
    applyTime(next);
  }
  lastFrameMs = nowMs;
}
requestAnimationFrame(tick);
</script>
</body>
</html>
"""


# ── Python helpers ─────────────────────────────────────────────────────────────

def load_trajectory(csv_path: Path, subsample: int = 200) -> dict:
    """Read SLAM trajectory CSV. subsample=N keeps 1 row every N rows."""
    t, x, y, z, qx, qy, qz, qw = [], [], [], [], [], [], [], []
    with open(csv_path, newline='') as f:
        for i, row in enumerate(csv.DictReader(f)):
            if i % subsample != 0:
                continue
            try:
                t.append(int(row['tracking_timestamp_us']))
                x.append(float(row['tx_world_device']))
                y.append(float(row['ty_world_device']))
                z.append(float(row['tz_world_device']))
                qx.append(float(row['qx_world_device']))
                qy.append(float(row['qy_world_device']))
                qz.append(float(row['qz_world_device']))
                qw.append(float(row['qw_world_device']))
            except (ValueError, KeyError):
                continue

    dur = (t[-1] - t[0]) / 1e6 if len(t) > 1 else 0.0
    print(f"[slam] {len(t)} points  ({dur:.1f}s)  subsample={subsample}")
    return dict(t=t, x=x, y=y, z=z, qx=qx, qy=qy, qz=qz, qw=qw, duration_s=dur)


def load_gaze_priming(json_path: Path, video_id: str) -> dict | None:
    """Extract priming events for one video from priming_info.json."""
    with open(json_path) as f:
        data = json.load(f)

    events = data.get(video_id)
    if not events:
        print(f"[gaze] No priming events found for {video_id}")
        return None

    obj_x, obj_y, obj_z, gaze_x, gaze_y, gaze_z = [], [], [], [], [], []
    for ev in events.values():
        if not isinstance(ev, dict):
            continue
        for side in ('start', 'end'):
            entry = ev.get(side)
            # Some events ship a non-dict (string, null) for a missing side.
            if not isinstance(entry, dict):
                continue
            loc   = entry.get('3d_location')
            stats = entry.get('prime_stats') or {}
            fp    = stats.get('frame_primed', -1)
            gp    = stats.get('gaze_point')
            if loc is None or fp < 0:
                continue
            obj_x.append(loc[0]); obj_y.append(loc[1]); obj_z.append(loc[2])
            if gp:
                gaze_x.append(gp[0]); gaze_y.append(gp[1]); gaze_z.append(gp[2])
            else:
                gaze_x.append(loc[0]); gaze_y.append(loc[1]); gaze_z.append(loc[2])

    print(f"[gaze] {len(obj_x)} valid priming events for {video_id}")
    return dict(obj_x=obj_x, obj_y=obj_y, obj_z=obj_z,
                gaze_x=gaze_x, gaze_y=gaze_y, gaze_z=gaze_z)


def load_object_trajectories(mask_path: Path, assoc_path: Path, video_id: str,
                              fps: float = 30.0) -> list[dict]:
    """One entry per object with a time-ordered list of 3D keyframes.

    Each keyframe = [t_video_seconds, x, y, z], derived from a mask's
    `frame_number` and `3d_location`. The viewer animates each object's
    sphere by interpolating between consecutive keyframes within the same
    track's time_segment.
    """
    if not assoc_path.exists():
        return []
    with open(mask_path) as f:
        mask_data = json.load(f)
    with open(assoc_path) as f:
        assoc_data = json.load(f)

    masks = mask_data.get(video_id, {})
    objects = assoc_data.get(video_id, {})
    if not masks or not objects:
        print(f"[objects] No data for {video_id}")
        return []

    result = []
    for obj in objects.values():
        name = obj.get('name', '')
        # Collect [t, x, y, z, t_seg_start, t_seg_end] so the viewer can tell
        # whether two consecutive keyframes belong to the same track.
        keyframes = []
        for track in obj.get('tracks', []):
            t_seg = track.get('time_segment', [0, 0])
            ts, te = float(t_seg[0]), float(t_seg[1])
            for mid in track.get('masks', []):
                m = masks.get(mid)
                if not m:
                    continue
                loc = m.get('3d_location')
                fr  = m.get('frame_number')
                if loc is None or fr is None:
                    continue
                t = fr / fps
                keyframes.append([
                    round(t, 3),
                    round(loc[0], 4), round(loc[1], 4), round(loc[2], 4),
                    round(ts, 2), round(te, 2),
                ])
        if not keyframes:
            continue
        keyframes.sort(key=lambda k: k[0])
        result.append({'name': name, 'keyframes': keyframes})

    print(f"[objects] {len(result)} animated objects for {video_id}")
    return result


def load_object_movements(mask_path: Path, assoc_path: Path, video_id: str,
                          min_distance: float = 0.05) -> list[dict]:
    """One movement per object track: 3D start → 3D end with timing.

    Skips tracks shorter than `min_distance` metres (likely re-detections of
    a stationary object).
    """
    if not assoc_path.exists():
        return []
    with open(mask_path) as f:
        mask_data = json.load(f)
    with open(assoc_path) as f:
        assoc_data = json.load(f)

    masks = mask_data.get(video_id, {})
    objects = assoc_data.get(video_id, {})
    if not masks or not objects:
        print(f"[movements] No movement data for {video_id}")
        return []

    movements = []
    for obj in objects.values():
        name = obj.get('name', '')
        for track in obj.get('tracks', []):
            mask_ids = track.get('masks', [])
            if len(mask_ids) < 2:
                continue
            t_seg = track.get('time_segment', [0, 0])
            start_mask = masks.get(mask_ids[0])
            end_mask   = masks.get(mask_ids[-1])
            if not start_mask or not end_mask:
                continue
            sl = start_mask.get('3d_location')
            el = end_mask.get('3d_location')
            if not sl or not el:
                continue
            dx, dy, dz = el[0] - sl[0], el[1] - sl[1], el[2] - sl[2]
            if (dx*dx + dy*dy + dz*dz) ** 0.5 < min_distance:
                continue
            movements.append({
                'name': name,
                'start': [round(v, 4) for v in sl],
                'end':   [round(v, 4) for v in el],
                'fixture_start': start_mask.get('fixture', ''),
                'fixture_end':   end_mask.get('fixture', ''),
                't_start': round(float(t_seg[0]), 2),
                't_end':   round(float(t_seg[1]), 2),
            })

    print(f"[movements] {len(movements)} movements for {video_id}")
    return movements


def _r(arr, d=4):
    return [round(v, d) for v in arr]


def load_video_t0_vrs_us(video_id: str) -> int | None:
    """Return the VRS device time (in microseconds) of the first MP4 frame.

    Reads `Videos/<participant>/<video_id>_mp4_to_vrs_time_ns.csv` from the HPC
    mount. The first data row's `vrs_device_time_ns` gives video t=0 in the same
    VRS clock used by SLAM's `tracking_timestamp_us`. Returns None if the file
    is unavailable (offline workflow). Without this anchor the viewer falls back
    to assuming video_t=0 == SLAM_T0, which drifts by a couple of seconds.
    """
    if not video_id:
        return None
    participant = video_id.split('-')[0]
    csv_path = HPC_ROOT / 'Videos' / participant / f'{video_id}_mp4_to_vrs_time_ns.csv'
    if not csv_path.exists():
        return None
    try:
        with open(csv_path, newline='') as f:
            reader = csv.DictReader(f)
            row = next(reader, None)
        if not row or 'vrs_device_time_ns' not in row:
            return None
        return int(row['vrs_device_time_ns']) // 1000  # ns → µs
    except (StopIteration, ValueError, KeyError):
        return None


def build_data_json(participant: str, video_id: str, traj: dict,
                    gaze: dict | None, objects: list[dict],
                    movements: list[dict], glb_name: str | None = None,
                    video_t0_vrs_us: int | None = None) -> str:
    blob = {
        "participant": participant,
        "video_id":    video_id,
        "duration_s":  round(traj["duration_s"], 2),
    }
    if glb_name:
        blob["glb"] = glb_name
    if video_t0_vrs_us is not None:
        blob["video_t0_vrs_us"] = video_t0_vrs_us
    blob["trajectory"] = {
        "t":  traj["t"],
        "x":  _r(traj["x"]), "y": _r(traj["y"]), "z": _r(traj["z"]),
        "qx": _r(traj["qx"], 5), "qy": _r(traj["qy"], 5),
        "qz": _r(traj["qz"], 5), "qw": _r(traj["qw"], 5),
    }
    if gaze:
        blob["gaze"] = {
            "obj_x":  _r(gaze["obj_x"]),  "obj_y":  _r(gaze["obj_y"]),  "obj_z":  _r(gaze["obj_z"]),
            "gaze_x": _r(gaze["gaze_x"]), "gaze_y": _r(gaze["gaze_y"]), "gaze_z": _r(gaze["gaze_z"]),
        }
    if objects:
        blob["objects"] = objects
    if movements:
        blob["movements"] = movements
    return json.dumps(blob, separators=(',', ':'))


def export_blend_to_glb(blend_path: Path, glb_path: Path, force: bool = False) -> Path:
    if glb_path.exists() and not force:
        print(f"[skip] GLB already exists: {glb_path}  (use --force to re-export)")
        return glb_path
    if not shutil.which('blender'):
        sys.exit("[error] 'blender' not found in PATH — install or add to PATH")

    with tempfile.NamedTemporaryFile(suffix='.py', mode='w', delete=False) as f:
        f.write(BLENDER_EXPORT_SCRIPT)
        script = f.name

    print(f"[export] {blend_path.name} → {glb_path.name}  (Blender headless)…")
    res = subprocess.run(
        ['blender', '--background', str(blend_path), '--python', script, '--', str(glb_path)],
        capture_output=True, text=True,
    )
    os.unlink(script)
    if res.returncode != 0 or not glb_path.exists():
        print(res.stderr[-2000:])
        sys.exit("[error] Blender export failed")
    print(f"[ok] {glb_path.name}  ({glb_path.stat().st_size // 1024} KB)")
    return glb_path


def generate_html(glb_filename: str, title: str, data_json: str) -> str:
    if not SLAM_VIEWER_JS_PATH.exists():
        sys.exit(f"[error] Missing shared module: {SLAM_VIEWER_JS_PATH}")
    if not SLAM_VIEWER_CSS_PATH.exists():
        sys.exit(f"[error] Missing shared CSS: {SLAM_VIEWER_CSS_PATH}")
    slam_js  = SLAM_VIEWER_JS_PATH.read_text()
    slam_css = SLAM_VIEWER_CSS_PATH.read_text()

    html = HTML_TEMPLATE
    html = html.replace('___SLAM_VIEWER_CSS___', slam_css)
    html = html.replace('___SLAM_VIEWER_JS___',  slam_js)
    html = html.replace('___TITLE___',           title)
    html = html.replace('___DATA_JSON___',       data_json)
    html = html.replace('___GLB_PATH___',        glb_filename)
    return html


def find_free_port() -> int:
    with socket.socket() as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def serve_and_open(serve_dir: Path, html_path: Path):
    port = find_free_port()
    url  = f"http://localhost:{port}/{html_path.name}"

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(serve_dir), **kw)
        def log_message(self, *_):
            pass

    srv = http.server.HTTPServer(('localhost', port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[server] http://localhost:{port}  (serving {serve_dir})")
    print(f"[open]   {url}")
    webbrowser.open(url)
    print("Press Ctrl+C to stop.")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\n[stop]")
        srv.shutdown()


# ── Batch export ───────────────────────────────────────────────────────────────

def run_batch_export(args):
    """Export slam_<video_id>.json for every session of args.participant.

    Resolves the GLB once (export from .blend if needed) and then iterates over
    all video MP4s in the participant's Videos/ folder, mapping session index
    to video by sorted filename (same convention used in single-session main).
    Skips sessions whose SLAM CSV does not exist.
    """
    participant = args.participant
    out_dir = (REPO_ROOT / args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Resolve GLB (once) ─────────────────────────────────────────────────────
    if args.glb:
        glb_path = Path(args.glb).resolve()
        if not glb_path.exists():
            sys.exit(f"[error] GLB not found: {glb_path}")
    else:
        blend_path = HPC_ROOT / 'Digital-Twin' / 'blenders' / f'{participant}_final.blend'
        if not blend_path.exists():
            sys.exit(f"[error] Blend not found on HPC: {blend_path}")
        glb_path = out_dir / f'{participant}_final.glb'
        export_blend_to_glb(blend_path, glb_path, args.force)

    glb_in_out = out_dir / glb_path.name
    if glb_path.resolve() != glb_in_out.resolve():
        shutil.copy2(glb_path, glb_in_out)

    # ── Discover sessions = videos for this participant ────────────────────────
    vid_dir = HPC_ROOT / 'Videos' / participant
    if not vid_dir.exists():
        sys.exit(f"[error] Videos directory not found: {vid_dir}")
    mp4s = sorted(vid_dir.glob('*.mp4'))
    if not mp4s:
        sys.exit(f"[error] No MP4 files in {vid_dir}")
    print(f"[batch] {len(mp4s)} candidate sessions for {participant}")

    gaze_path  = REPO_ROOT / 'eye-gaze-priming' / 'priming_info.json'
    mask_path  = REPO_ROOT / 'scene-and-object-movements' / 'mask_info.json'
    assoc_path = REPO_ROOT / 'scene-and-object-movements' / 'assoc_info.json'

    ok, skipped = 0, 0
    for sess, mp4 in enumerate(mp4s):
        video_id = mp4.stem
        slam_path = (HPC_ROOT / 'SLAM-and-Gaze' / participant
                     / 'SLAM' / 'multi' / str(sess) / 'slam'
                     / 'closed_loop_trajectory.csv')
        if not slam_path.exists():
            print(f"[skip] s{sess} {video_id}: no SLAM CSV")
            skipped += 1
            continue

        print(f"\n[batch {sess+1}/{len(mp4s)}] {video_id}")
        traj = load_trajectory(slam_path, args.subsample)
        gaze = load_gaze_priming(gaze_path, video_id) if gaze_path.exists() else None
        objects = (load_object_trajectories(mask_path, assoc_path, video_id)
                   if mask_path.exists() else [])
        movements = (load_object_movements(mask_path, assoc_path, video_id)
                     if mask_path.exists() else [])
        video_t0 = load_video_t0_vrs_us(video_id)
        if video_t0 is not None:
            offset_s = (traj["t"][0] - video_t0) / 1e6
            print(f"[align] video_t0 = {video_t0/1e6:.3f}s VRS  →  SLAM T0 ahead by {offset_s:+.3f}s")
        else:
            print(f"[align] no mp4_to_vrs CSV — video↔SLAM alignment will fall back to legacy")

        data_json = build_data_json(participant, video_id, traj, gaze, objects, movements,
                                    glb_name=glb_in_out.name,
                                    video_t0_vrs_us=video_t0)
        json_path = out_dir / f"slam_{video_id}.json"
        json_path.write_text(data_json, encoding='utf-8')
        print(f"[ok] {json_path.name} ({json_path.stat().st_size // 1024} KB)")
        ok += 1

    print(f"\n[batch done] {ok} exported, {skipped} skipped (out of {len(mp4s)})")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description='HD-EPIC SLAM Trajectory Viewer',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument('--participant', '-p', metavar='PXX',
                    help='Participant ID, e.g. P01 (auto-discovers paths)')
    ap.add_argument('--session', '-s', type=int, default=0, metavar='N',
                    help='SLAM session index (default: 0 = first recording)')
    ap.add_argument('--video-id', metavar='ID',
                    help='Video ID for gaze lookup, e.g. P01-20240202-110250 '
                         '(auto-inferred from session index if --participant given)')
    ap.add_argument('--glb',   metavar='FILE', help='Kitchen .glb file')
    ap.add_argument('--blend', metavar='FILE', help='Kitchen .blend (will be exported to GLB)')
    ap.add_argument('--slam',  metavar='FILE', help='closed_loop_trajectory.csv')
    ap.add_argument('--gaze',  metavar='FILE',
                    help='priming_info.json (default: eye-gaze-priming/priming_info.json)')
    ap.add_argument('--subsample', type=int, default=200, metavar='N',
                    help='Keep 1 trajectory row every N (default: 200 ≈ 2000 pts/session)')
    ap.add_argument('--out', default='output', metavar='DIR',
                    help='Output directory for GLB + HTML (default: ./output)')
    ap.add_argument('--force', action='store_true', help='Re-export GLB even if it exists')
    ap.add_argument('--no-browser', action='store_true', help='Generate files, do not open browser')
    ap.add_argument('--export-only', action='store_true',
                    help='Save output/slam_<video_id>.json + GLB and exit (no HTML, no server). '
                         'Use this to feed the integrated viewer.')
    ap.add_argument('--all-videos', action='store_true',
                    help='Export JSON for every session of --participant (implies --export-only)')
    args = ap.parse_args()

    if args.all_videos:
        if not args.participant:
            sys.exit("[error] --all-videos requires --participant")
        run_batch_export(args)
        return

    out_dir = (REPO_ROOT / args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    participant = args.participant

    # ── Resolve GLB ────────────────────────────────────────────────────────────
    if args.glb:
        glb_path = Path(args.glb).resolve()
        if not glb_path.exists():
            sys.exit(f"[error] GLB not found: {glb_path}")
        if participant is None:
            participant = glb_path.stem.split('_')[0].upper()

    elif args.blend:
        blend_path = Path(args.blend).resolve()
        glb_path = out_dir / (blend_path.stem + '.glb')
        export_blend_to_glb(blend_path, glb_path, args.force)
        if participant is None:
            participant = blend_path.stem.split('_')[0].upper()

    elif participant:
        blend_path = HPC_ROOT / 'Digital-Twin' / 'blenders' / f'{participant}_final.blend'
        if not blend_path.exists():
            sys.exit(f"[error] Blend not found on HPC: {blend_path}")
        glb_path = out_dir / f'{participant}_final.glb'
        export_blend_to_glb(blend_path, glb_path, args.force)

    else:
        sys.exit("[error] Provide --participant, --glb, or --blend")

    # ── Copy GLB to out_dir if needed ──────────────────────────────────────────
    glb_in_out = out_dir / glb_path.name
    if glb_path.resolve() != glb_in_out.resolve():
        shutil.copy2(glb_path, glb_in_out)

    # ── Resolve SLAM CSV ───────────────────────────────────────────────────────
    if args.slam:
        slam_path = Path(args.slam).resolve()
    elif participant:
        slam_path = (HPC_ROOT / 'SLAM-and-Gaze' / participant
                     / 'SLAM' / 'multi' / str(args.session) / 'slam'
                     / 'closed_loop_trajectory.csv')
    else:
        sys.exit("[error] Provide --slam or --participant")

    if not slam_path.exists():
        sys.exit(f"[error] SLAM file not found: {slam_path}")

    # ── Resolve video ID (needed for gaze lookup) ──────────────────────────────
    video_id = args.video_id
    if video_id is None and participant:
        vid_dir = HPC_ROOT / 'Videos' / participant
        if vid_dir.exists():
            mp4s = sorted(vid_dir.glob('*.mp4'))
            if args.session < len(mp4s):
                video_id = mp4s[args.session].stem
                print(f"[info] video_id={video_id} (session {args.session})")
            else:
                print(f"[warn] session {args.session} out of range ({len(mp4s)} videos for {participant})")

    # ── Resolve gaze priming ────────────────────────────────────────────────────
    gaze_path = None
    if args.gaze:
        gaze_path = Path(args.gaze).resolve()
    else:
        default = REPO_ROOT / 'eye-gaze-priming' / 'priming_info.json'
        if default.exists():
            gaze_path = default

    # ── Load data ──────────────────────────────────────────────────────────────
    traj = load_trajectory(slam_path, args.subsample)
    gaze = (load_gaze_priming(gaze_path, video_id)
            if (gaze_path and video_id) else None)
    if gaze is None:
        print("[gaze] Skipping gaze priming (no path or video_id)")

    mask_path  = REPO_ROOT / 'scene-and-object-movements' / 'mask_info.json'
    assoc_path = REPO_ROOT / 'scene-and-object-movements' / 'assoc_info.json'
    objects = (load_object_trajectories(mask_path, assoc_path, video_id)
               if (mask_path.exists() and video_id) else [])
    movements = (load_object_movements(mask_path, assoc_path, video_id)
                 if (mask_path.exists() and video_id) else [])
    video_t0 = load_video_t0_vrs_us(video_id) if video_id else None
    if video_t0 is not None:
        offset_s = (traj["t"][0] - video_t0) / 1e6
        print(f"[align] video_t0 = {video_t0/1e6:.3f}s VRS  →  SLAM T0 ahead by {offset_s:+.3f}s")

    data_json = build_data_json(participant or '?', video_id or '', traj, gaze, objects, movements,
                                glb_name=glb_in_out.name,
                                video_t0_vrs_us=video_t0)
    size_kb = len(data_json.encode()) // 1024
    print(f"[data] JSON blob: {size_kb} KB")

    # ── Export-only path: save slam_<video_id>.json and exit ───────────────────
    if args.export_only:
        if not video_id:
            sys.exit("[error] --export-only requires a resolvable video_id (use --participant + --session or --video-id)")
        json_path = out_dir / f"slam_{video_id}.json"
        json_path.write_text(data_json, encoding='utf-8')
        print(f"[ok] JSON: {json_path}  ({json_path.stat().st_size // 1024} KB)")
        return

    # ── Generate HTML ──────────────────────────────────────────────────────────
    title = f"HD-EPIC SLAM — {participant}  session {args.session}"
    html  = generate_html(glb_in_out.name, title, data_json)
    html_name = f"slam_{participant}_s{args.session}.html"
    html_path = out_dir / html_name
    html_path.write_text(html, encoding='utf-8')
    print(f"[ok] HTML: {html_path}  ({html_path.stat().st_size // 1024} KB)")

    if not args.no_browser:
        serve_and_open(out_dir, html_path)


if __name__ == '__main__':
    main()
