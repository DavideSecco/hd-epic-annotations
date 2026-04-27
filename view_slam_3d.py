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

/* object labels (CSS2DRenderer) */
.obj-label {
  color: #aaffcc;
  font-size: 10px;
  font-family: monospace;
  background: rgba(0,0,0,.55);
  padding: 1px 5px;
  border-radius: 3px;
  pointer-events: none;
  white-space: nowrap;
  user-select: none;
}
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
  </div>

  <div id="layer-panel">
    <h4>Layers</h4>
    <label class="layer-toggle"><input type="checkbox" id="tog-kitchen" checked> Kitchen model</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-traj"    checked> Trajectory</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-gaze"    checked> Gaze priming</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-head"    checked> Camera head</label>
    <label class="layer-toggle"><input type="checkbox" id="tog-objects" checked> Objects</label>
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
import * as THREE from 'three';
import { OrbitControls }                    from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }                       from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject }       from 'three/addons/renderers/CSS2DRenderer.js';

// ════════════════════════════════════════════════════════════════════════════════
// DATA
// In the integrated viewer, receive this from outside instead of parsing here.
// ════════════════════════════════════════════════════════════════════════════════
const DATA    = JSON.parse(document.getElementById('slam-data').textContent);
const traj    = DATA.trajectory;   // { t[], x[], y[], z[], qx[], qy[], qz[], qw[] }
const gaze    = DATA.gaze || null; // { obj_x[], obj_y[], obj_z[], gaze_x[], gaze_y[], gaze_z[] }
const objects = DATA.objects || []; // [{ x, y, z, label, fixture }, ...]
const N     = traj.t.length;
const T0    = traj.t[0];
const T1    = traj.t[N - 1];
const DUR_US = T1 - T0;
const DUR_S  = DUR_US / 1e6;

// ════════════════════════════════════════════════════════════════════════════════
// COORDINATE TRANSFORM
//
// SLAM world space = Blender convention: Z up, Y forward, X right.
// Three.js (and GLB exported by Blender): Y up, -Z forward, X right.
// Blender's GLTF exporter auto-converts the mesh, so the kitchen GLB is
// already in Y-up space. We apply the same transform to SLAM point data:
//
//   three.x =  slam.x
//   three.y =  slam.z   (Blender Z → Three.js Y)
//   three.z = -slam.y   (Blender Y → Three.js -Z)
//
// Verification: SLAM gravity = (0, 0, -9.81) → (0, -9.81, 0) in Three.js,
// which correctly points in -Y (downward). ✓
// ════════════════════════════════════════════════════════════════════════════════
function s2t(x, y, z) { return new THREE.Vector3(x, z, -y); }

// ════════════════════════════════════════════════════════════════════════════════
// QUATERNION TRANSFORM: SLAM → Three.js
//
// Same coordinate change as s2t, applied to orientation quaternions.
// Q_ALIGN = rotation by -90° around X (the matrix that converts SLAM Z-up to
// Three.js Y-up): q_three = Q_ALIGN * q_slam * Q_ALIGN^{-1}
//
// After applying slamQuatToThree to headGroup.quaternion, the headGroup's local
// axes in Three.js world correspond to Aria device axes:
//   local +X  = device right
//   local +Y  = device forward (camera optical axis = +Z in Aria device frame)
//   local +Z  = device up (toward top of glasses)
//
// Consequence: ConeGeometry (tip at +Y by default) = gaze direction. No rotation needed.
//
// Verification: gravity in SLAM = (0,0,-9.81). Transformed: s2t(0,0,-9.81) = (0,-9.81,0).
// With Q_ALIGN on a quaternion aligned with gravity-down: local +Y → Three.js -Y. ✓
// ════════════════════════════════════════════════════════════════════════════════
const _QA  = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // −90° around X
const _QAI = new THREE.Quaternion( Math.SQRT1_2, 0, 0, Math.SQRT1_2); // +90° around X

function slamQuatToThree(qx, qy, qz, qw) {
  return _QA.clone()
    .multiply(new THREE.Quaternion(qx, qy, qz, qw))
    .multiply(_QAI);
}

// ════════════════════════════════════════════════════════════════════════════════
// RENDERER + SCENE
// ════════════════════════════════════════════════════════════════════════════════
const container  = document.getElementById('slam-viewer');
const loadingEl  = document.getElementById('loading');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0d1c);
scene.fog = new THREE.FogExp2(0x0d0d1c, 0.01);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 300);
camera.position.set(2, 4, 8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.3;
controls.maxDistance = 120;

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xfff5e0, 1.3);
sun.position.set(4, 8, 4); sun.castShadow = true;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xc8d8ff, 0.3);
fill.position.set(-5, 3, -5);
scene.add(fill);

const grid = new THREE.GridHelper(40, 80, 0x1a1a44, 0x13132e);
scene.add(grid);

// ════════════════════════════════════════════════════════════════════════════════
// TRAJECTORY LINE (gradient blue → red over time)
// ════════════════════════════════════════════════════════════════════════════════
const positions = new Float32Array(N * 3);
const colors    = new Float32Array(N * 3);
let cx = 0, cy = 0, cz = 0;

for (let i = 0; i < N; i++) {
  const p = s2t(traj.x[i], traj.y[i], traj.z[i]);
  positions[i*3]   = p.x;
  positions[i*3+1] = p.y;
  positions[i*3+2] = p.z;
  cx += p.x; cy += p.y; cz += p.z;

  // HSL: hue 0.66 (blue) at t=0 → hue 0.00 (red) at t=1
  const col = new THREE.Color().setHSL(0.666 * (1 - i / (N - 1)), 1.0, 0.55);
  colors[i*3]   = col.r;
  colors[i*3+1] = col.g;
  colors[i*3+2] = col.b;
}
cx /= N; cy /= N; cz /= N;
const trajCenter = new THREE.Vector3(cx, cy, cz);

const trajGeom = new THREE.BufferGeometry();
trajGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
trajGeom.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
const trajLine = new THREE.Line(trajGeom, new THREE.LineBasicMaterial({ vertexColors: true }));
scene.add(trajLine);

// Start / end markers
const markerMat0 = new THREE.MeshBasicMaterial({ color: 0x4488ff });
const markerMat1 = new THREE.MeshBasicMaterial({ color: 0xff4444 });
const markerGeom = new THREE.SphereGeometry(0.07, 10, 7);
const startMark  = new THREE.Mesh(markerGeom, markerMat0);
const endMark    = new THREE.Mesh(markerGeom, markerMat1);
startMark.position.copy(s2t(traj.x[0],   traj.y[0],   traj.z[0]));
endMark.position.copy(  s2t(traj.x[N-1], traj.y[N-1], traj.z[N-1]));
scene.add(startMark); scene.add(endMark);

// ════════════════════════════════════════════════════════════════════════════════
// CAMERA HEAD MARKER (animated, quaternion-oriented)
//
// All child geometries are in headGroup local space. After applying
// slamQuatToThree(), local +Y = Aria camera forward (gaze direction).
//
//  [sphere]  white  — head position
//  [cone]    amber  — gaze cone, tip points in local +Y (= camera forward)
//  [ray]     cyan   — gaze ray line extending 2 m forward along local +Y
// ════════════════════════════════════════════════════════════════════════════════
const SPHERE_R  = 0.055;
// Vision cone: apex at head, opens forward along local +Y (= gaze direction).
// CONE_H ≈ viewing distance, CONE_R gives ~25° half-angle FOV at that distance.
const CONE_H    = 1.2;
const CONE_R    = 0.55;
const RAY_LEN   = 1.4;  // centre-axis ray, slightly longer than cone

const headSphere = new THREE.Mesh(
  new THREE.SphereGeometry(SPHERE_R, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xffffff })
);

// Vision cone:
//   ConeGeometry default → tip at local +Y, base at local -Y.
//   rotation.x = π  → flips it: tip now toward headGroup -Y (behind head),
//                      base now toward headGroup +Y (forward = gaze).
//   position.y = CONE_H/2 → shifts it forward so tip lands at head centre (y=0)
//                            and base rim is at y = CONE_H.
const gazeCone = new THREE.Mesh(
  new THREE.ConeGeometry(CONE_R, CONE_H, 32),
  new THREE.MeshBasicMaterial({
    color: 0xffaa22,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
);
gazeCone.rotation.x = Math.PI;
gazeCone.position.y = CONE_H / 2;

// Centre-axis ray: thin line along the gaze direction for precision
const gazeRayGeom = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, RAY_LEN, 0),
]);
const gazeRay = new THREE.Line(
  gazeRayGeom,
  new THREE.LineBasicMaterial({ color: 0xffdd88, transparent: true, opacity: 0.7 })
);

const headGroup = new THREE.Group();
headGroup.add(headSphere);
headGroup.add(gazeCone);
headGroup.add(gazeRay);
headGroup.position.copy(s2t(traj.x[0], traj.y[0], traj.z[0]));
headGroup.quaternion.copy(slamQuatToThree(traj.qx[0], traj.qy[0], traj.qz[0], traj.qw[0]));
scene.add(headGroup);

// ════════════════════════════════════════════════════════════════════════════════
// GAZE PRIMING POINTS
// Yellow spheres  = object 3D location
// Cyan spheres    = gaze point (where person was looking)
// Thin lines connect them
// ════════════════════════════════════════════════════════════════════════════════
let gazeGroup = null;
if (gaze && gaze.obj_x.length > 0) {
  gazeGroup = new THREE.Group();
  const M = gaze.obj_x.length;

  const objGeom  = new THREE.SphereGeometry(0.045, 8, 6);
  const gazeGeom = new THREE.SphereGeometry(0.028, 8, 6);
  const objMat   = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.85 });
  const gazeMat  = new THREE.MeshBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.75 });
  const linkMat  = new THREE.LineBasicMaterial({ color: 0x445566, transparent: true, opacity: 0.4 });

  for (let i = 0; i < M; i++) {
    const op = s2t(gaze.obj_x[i],  gaze.obj_y[i],  gaze.obj_z[i]);
    const gp = s2t(gaze.gaze_x[i], gaze.gaze_y[i], gaze.gaze_z[i]);

    const om = new THREE.Mesh(objGeom,  objMat);  om.position.copy(op); gazeGroup.add(om);
    const gm = new THREE.Mesh(gazeGeom, gazeMat); gm.position.copy(gp); gazeGroup.add(gm);
    const lg = new THREE.BufferGeometry().setFromPoints([op, gp]);
    gazeGroup.add(new THREE.Line(lg, linkMat));
  }
  scene.add(gazeGroup);
}

// ════════════════════════════════════════════════════════════════════════════════
// OBJECT MASK POSITIONS
// Green spheres at the median 3D location of each manipulated object (fixture).
// Labels via CSS2DRenderer so they scale correctly in 3D space.
// ════════════════════════════════════════════════════════════════════════════════
let objGroup = null;
if (objects.length > 0) {
  objGroup = new THREE.Group();
  const objGeom = new THREE.SphereGeometry(0.06, 10, 7);
  const objMat  = new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.9 });

  objects.forEach(obj => {
    const pos = s2t(obj.x, obj.y, obj.z);

    const sphere = new THREE.Mesh(objGeom, objMat);
    sphere.position.copy(pos);
    objGroup.add(sphere);

    const div = document.createElement('div');
    div.className = 'obj-label';
    div.textContent = obj.label || obj.fixture;
    const label = new CSS2DObject(div);
    label.position.set(pos.x, pos.y + 0.12, pos.z);
    objGroup.add(label);
  });

  scene.add(objGroup);
  console.log(`[objects] ${objects.length} fixtures rendered`);
}

// ════════════════════════════════════════════════════════════════════════════════
// KITCHEN MODEL (GLB)
// Loaded without re-centering so world coordinates match SLAM data directly.
// ════════════════════════════════════════════════════════════════════════════════
let kitchenModel = null;

function fitCameraToTrajectory() {
  const dist = 5;
  camera.position.set(trajCenter.x + dist, trajCenter.y + dist * 0.7, trajCenter.z + dist);
  controls.target.copy(trajCenter);
  controls.update();
}

new GLTFLoader().load(
  '___GLB_PATH___',
  (gltf) => {
    kitchenModel = gltf.scene;
    kitchenModel.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
    scene.add(kitchenModel);
    loadingEl.style.display = 'none';
    fitCameraToTrajectory();
  },
  (xhr) => {
    const pct = xhr.total ? Math.round(xhr.loaded / xhr.total * 100) : '…';
    loadingEl.textContent = `Loading kitchen model… ${pct}%`;
  },
  (err) => {
    console.warn('[kitchen] Load failed:', err.message);
    loadingEl.textContent = '⚠ Kitchen model not found — showing trajectory only';
    loadingEl.style.color = '#fa8';
    setTimeout(() => { loadingEl.style.display = 'none'; }, 4000);
    fitCameraToTrajectory();
  }
);

// ════════════════════════════════════════════════════════════════════════════════
// INFO PANEL — static fields
// ════════════════════════════════════════════════════════════════════════════════
document.getElementById('vid-display').textContent = DATA.video_id || '—';
document.getElementById('dur-display').textContent = DUR_S.toFixed(1) + 's  (' + N.toLocaleString() + ' pts)';

// ════════════════════════════════════════════════════════════════════════════════
// PLAYBACK
// ════════════════════════════════════════════════════════════════════════════════
let playing      = false;
let currentUs    = T0;
let speedFactor  = 1.0;
let lastFrameMs  = null;

const playBtn    = document.getElementById('play-btn');
const timeSlider = document.getElementById('timeline');
const timeDisp   = document.getElementById('time-display');

function fmt(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

function bsearch(arr, val) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; arr[mid] < val ? lo = mid + 1 : hi = mid; }
  return lo;
}

function setHeadAtTime(us) {
  const clamped = Math.max(T0, Math.min(T1, us));
  const idx = bsearch(traj.t, clamped);
  const i   = Math.min(idx, N - 1);

  // Interpolation factor between sample i-1 and i
  let alpha = 0;
  if (i > 0) {
    const dt = traj.t[i] - traj.t[i-1];
    if (dt > 0) alpha = Math.min(1, (clamped - traj.t[i-1]) / dt);
  }

  // ── Position: linear interpolation ────────────────────────────────────────
  let px, py, pz;
  if (i > 0 && alpha > 0) {
    px = traj.x[i-1] + alpha * (traj.x[i] - traj.x[i-1]);
    py = traj.y[i-1] + alpha * (traj.y[i] - traj.y[i-1]);
    pz = traj.z[i-1] + alpha * (traj.z[i] - traj.z[i-1]);
  } else {
    px = traj.x[i]; py = traj.y[i]; pz = traj.z[i];
  }
  headGroup.position.copy(s2t(px, py, pz));

  // ── Orientation: SLERP between adjacent SLAM quaternions, then convert ─────
  // The SLAM quaternion (qx_world_device etc.) expresses the Aria device frame
  // in SLAM world space. slamQuatToThree() converts it to Three.js convention
  // so that headGroup's local +Y = camera forward (gaze direction).
  const qi = new THREE.Quaternion(traj.qx[i], traj.qy[i], traj.qz[i], traj.qw[i]);
  let slerpedQ;
  if (i > 0 && alpha > 0) {
    const qi1 = new THREE.Quaternion(traj.qx[i-1], traj.qy[i-1], traj.qz[i-1], traj.qw[i-1]);
    slerpedQ = qi1.clone().slerp(qi, alpha);
  } else {
    slerpedQ = qi;
  }
  headGroup.quaternion.copy(slamQuatToThree(slerpedQ.x, slerpedQ.y, slerpedQ.z, slerpedQ.w));

  // ── UI ────────────────────────────────────────────────────────────────────
  const elapsedS = (clamped - T0) / 1e6;
  timeSlider.value = Math.round((clamped - T0) / DUR_US * 10000);
  timeDisp.textContent = `${fmt(elapsedS)} / ${fmt(DUR_S)}`;
  document.getElementById('pos-display').textContent =
    `${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}`;
}

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
  currentUs = T0 + (timeSlider.value / 10000) * DUR_US;
  setHeadAtTime(currentUs);
});

document.getElementById('speed-select').addEventListener('change', (e) => {
  speedFactor = parseFloat(e.target.value);
});

document.getElementById('reset-cam').addEventListener('click', fitCameraToTrajectory);

// Layer toggles
document.getElementById('tog-kitchen').addEventListener('change', (e) => { if (kitchenModel) kitchenModel.visible = e.target.checked; });
document.getElementById('tog-traj')   .addEventListener('change', (e) => { trajLine.visible = e.target.checked; startMark.visible = e.target.checked; endMark.visible = e.target.checked; });
document.getElementById('tog-gaze')   .addEventListener('change', (e) => { if (gazeGroup) gazeGroup.visible = e.target.checked; });
document.getElementById('tog-head')   .addEventListener('change', (e) => { headGroup.visible = e.target.checked; });
document.getElementById('tog-objects').addEventListener('change', (e) => { if (objGroup) objGroup.visible = e.target.checked; });
document.getElementById('tog-grid')   .addEventListener('change', (e) => { grid.visible = e.target.checked; });

// ════════════════════════════════════════════════════════════════════════════════
// RENDER LOOP
// ════════════════════════════════════════════════════════════════════════════════
function animate(nowMs) {
  requestAnimationFrame(animate);

  if (playing) {
    if (lastFrameMs !== null) {
      currentUs += (nowMs - lastFrameMs) * 1000 * speedFactor; // ms → µs
      if (currentUs > T1) currentUs = T0; // loop
    }
    lastFrameMs = nowMs;
    setHeadAtTime(currentUs);
  }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// Initial state
setHeadAtTime(T0);
animate(0);
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
        for side in ('start', 'end'):
            entry = ev.get(side, {})
            loc   = entry.get('3d_location')
            stats = entry.get('prime_stats', {})
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


def load_object_masks(mask_path: Path, assoc_path: Path | None, video_id: str) -> list[dict]:
    """Return one entry per unique fixture with median 3D position and human-readable label."""
    with open(mask_path) as f:
        mask_data = json.load(f)

    masks_for_video = mask_data.get(video_id, {})
    if not masks_for_video:
        print(f"[objects] No mask data for {video_id}")
        return []

    # Build mask_id → object name from assoc_info (optional)
    mask_to_name: dict[str, str] = {}
    if assoc_path and assoc_path.exists():
        with open(assoc_path) as f:
            assoc_data = json.load(f)
        for obj in assoc_data.get(video_id, {}).values():
            name = obj.get('name', '')
            for track in obj.get('tracks', []):
                for mask_id in track.get('masks', []):
                    mask_to_name[mask_id] = name

    # Group positions by fixture; remember best label per fixture
    from collections import defaultdict
    positions: dict[str, list] = defaultdict(list)
    labels: dict[str, str] = {}

    for mask_id, entry in masks_for_video.items():
        loc = entry.get('3d_location')
        fixture = entry.get('fixture', '')
        if loc is None or not fixture:
            continue
        positions[fixture].append(loc)
        if fixture not in labels:
            name = mask_to_name.get(mask_id, '')
            # Fallback: strip participant prefix from fixture name (P01_mug.001 → mug.001)
            labels[fixture] = name or ('_'.join(fixture.split('_')[1:]) if '_' in fixture else fixture)

    # Median position per fixture
    result = []
    for fixture, pts in positions.items():
        xs = sorted(p[0] for p in pts)
        ys = sorted(p[1] for p in pts)
        zs = sorted(p[2] for p in pts)
        n = len(xs)
        result.append({
            'x': round(xs[n // 2], 4),
            'y': round(ys[n // 2], 4),
            'z': round(zs[n // 2], 4),
            'label':   labels[fixture],
            'fixture': fixture,
        })

    print(f"[objects] {len(result)} unique fixtures for {video_id}")
    return result


def _r(arr, d=4):
    return [round(v, d) for v in arr]


def build_data_json(participant: str, video_id: str, traj: dict,
                    gaze: dict | None, objects: list[dict]) -> str:
    blob = {
        "participant": participant,
        "video_id":    video_id,
        "duration_s":  round(traj["duration_s"], 2),
        "trajectory": {
            "t":  traj["t"],
            "x":  _r(traj["x"]), "y": _r(traj["y"]), "z": _r(traj["z"]),
            "qx": _r(traj["qx"], 5), "qy": _r(traj["qy"], 5),
            "qz": _r(traj["qz"], 5), "qw": _r(traj["qw"], 5),
        },
    }
    if gaze:
        blob["gaze"] = {
            "obj_x":  _r(gaze["obj_x"]),  "obj_y":  _r(gaze["obj_y"]),  "obj_z":  _r(gaze["obj_z"]),
            "gaze_x": _r(gaze["gaze_x"]), "gaze_y": _r(gaze["gaze_y"]), "gaze_z": _r(gaze["gaze_z"]),
        }
    if objects:
        blob["objects"] = objects
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
    html = HTML_TEMPLATE
    html = html.replace('___TITLE___',     title)
    html = html.replace('___DATA_JSON___', data_json)
    html = html.replace('___GLB_PATH___',  glb_filename)
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
    args = ap.parse_args()

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
    objects = (load_object_masks(mask_path, assoc_path, video_id)
               if (mask_path.exists() and video_id) else [])

    data_json = build_data_json(participant or '?', video_id or '', traj, gaze, objects)
    size_kb = len(data_json.encode()) // 1024
    print(f"[data] JSON blob: {size_kb} KB")

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
