// HD-EPIC SLAM viewer — reusable ES module.
//
// Renders the kitchen GLB + camera trajectory + animated objects + movement
// arrows inside a host-provided container. The host drives time by calling
// setTime(t) where t is video-seconds (0 = first sample of the trajectory).
//
// Usage:
//   import { initSlamViewer } from './slam-viewer.js';
//   const slam = await initSlamViewer({ container, data, glbUrl });
//   slam.setTime(videoSeconds);
//   slam.setLayerVisible('movements', false);
//   slam.destroy();
//
// The host page must provide an importmap for 'three' and 'three/addons/'.

import * as THREE from 'three';
import { OrbitControls }              from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }                 from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ── Coordinate transforms: SLAM world (Z-up) → three.js world (Y-up) and
//    Aria device frame → headGroup local frame ───────────────────────────
//
// SLAM world frame (Blender):  X right, Y forward, Z up.
// three.js world frame:        X right, Y up,      -Z forward.
// World basis change: W = R_x(-90°).
//
// Aria device frame (verified empirically against the trajectory: applying
// q_world_device to (1,0,0) yields a vector with the SLAM-world Z component
// near −1, i.e. "down", so the device's +X axis points DOWN):
//   +X = down  (toward the chin)
//   +Y = left  (out the user's left ear, required by right-handedness)
//   +Z = forward
// headGroup local frame (the one the gaze cone, ray and gaze formulae use):
//   +X = right, +Y = forward, +Z = up.
//
// q_three_local = W · q_slam · Q_LOCAL⁻¹
//   Q_LOCAL is the rotation that maps device-frame components to local-frame
//   components: (a,b,c)_device → (-b, c, -a)_local. As a quaternion this is
//   (-0.5, 0.5, 0.5, 0.5). Q_LOCAL⁻¹ is its conjugate.
const _QW  = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // R_x(-90°)
const _QL_INV = new THREE.Quaternion(0.5, -0.5, -0.5, 0.5);            // (Q_LOCAL)⁻¹

function s2t(x, y, z) { return new THREE.Vector3(x, z, -y); }

// R_LOCAL_CPF: combined rotation CPF → headGroup-local frame.
// = R_LOCAL * R_device_cpf, computed from projectaria_tools:
//   R_device_cpf = T_device_cpf[:3,:3] from get_transform_device_cpf().to_matrix()
//   (calibrated from VRS; confirmed consistent across Aria Gen 1 units)
//   R_LOCAL maps Aria device (+X down, +Y left, +Z fwd) to local (+X right, +Y fwd, +Z up):
//     local = (-dev_Y, dev_Z, -dev_X)
// Columns of R_device_cpf = CPF basis vectors in device space:
//   CPF +X (≈ left):  (-0.0319,  0.7934,  0.6079)
//   CPF +Y (≈ up):    (-0.9986,  0.0000, -0.0523)
//   CPF +Z (≈ fwd+R): (-0.0415, -0.6088,  0.7923)  // 37° right of SLAM-left-cam axis
// R_LOCAL * R_device_cpf (R_LOCAL = [[0,-1,0],[0,0,1],[-1,0,0]]):
const _R_LC = [
  [-0.7934,  0.0000,  0.6088],  // row 0 = -R_dc row 1
  [ 0.6079, -0.0523,  0.7923],  // row 1 =  R_dc row 2
  [ 0.0319,  0.9986,  0.0415],  // row 2 = -R_dc row 0
];

// Head yaw correction for the gaze CONE (visual indicator of camera axis).
// The cone follows headGroup which is aligned to the SLAM LEFT-mono-camera axis.
// Tunable live via console (e.g. window.HEAD_YAW_CORRECTION_DEG = -40 to
// rotate the cone toward the binocular center). Default 0 = raw SLAM axis.
// The gaze RAY uses _R_LC (calibration-based) and is unaffected by this.
// −37° = calibrated angle from SLAM-left-camera axis to CPF +Z (binocular centre).
// Derived from arccos(CPF_fwd · device_fwd) in the horizontal plane using VRS calib.
// (−40° was the prior empirical value; −37° matches the VRS R_device_cpf matrix.)
window.HEAD_YAW_CORRECTION_DEG = (typeof window.HEAD_YAW_CORRECTION_DEG === 'number')
  ? window.HEAD_YAW_CORRECTION_DEG
  : -37;
const _HEAD_YAW_AXIS = new THREE.Vector3(0, 0, 1);
const _headYawQ = new THREE.Quaternion();

function slamQuatToThree(qx, qy, qz, qw) {
  const out = _QW.clone()
    .multiply(new THREE.Quaternion(qx, qy, qz, qw))
    .multiply(_QL_INV);
  const corrRad = (window.HEAD_YAW_CORRECTION_DEG || 0) * Math.PI / 180;
  if (corrRad !== 0) {
    _headYawQ.setFromAxisAngle(_HEAD_YAW_AXIS, corrRad);
    out.multiply(_headYawQ);
  }
  return out;
}

function nameToHue(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) % 360) / 360;
}

function stripParticipantPrefix(s) {
  if (!s) return '';
  const i = s.indexOf('_');
  return i >= 0 ? s.slice(i + 1) : s;
}

function bsearch(arr, val) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < val) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const VALID_LAYERS = ['kitchen', 'trajectory', 'head', 'gaze', 'gazeRay', 'objects', 'movements', 'grid'];

/**
 * Mount a SLAM viewer in the given container.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container - DOM element to host the canvas (must have non-zero size)
 * @param {Object}      [opts.data]    - parsed SLAM data blob (use this OR dataUrl)
 * @param {string}      [opts.dataUrl] - URL to fetch the JSON data blob
 * @param {string}      [opts.glbUrl]  - URL to the kitchen GLB (optional; viewer works without)
 * @returns {Promise<SlamViewerHandle>}
 */
export async function initSlamViewer({ container, data, dataUrl, glbUrl } = {}) {
  if (!container) throw new Error('initSlamViewer: container is required');
  if (!data && !dataUrl) throw new Error('initSlamViewer: either data or dataUrl is required');

  if (!data) {
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error(`initSlamViewer: fetch ${dataUrl} → ${res.status}`);
    data = await res.json();
  }

  const traj      = data.trajectory;
  const gaze      = data.gaze || null;
  const objects   = data.objects || [];
  const movements = data.movements || [];
  const N  = traj.t.length;
  const T0 = traj.t[0];
  const T1 = traj.t[N - 1];

  // Anchor for video↔SLAM alignment. When the dataset ships the MP4→VRS
  // mapping CSV (Videos/<P>/<id>_mp4_to_vrs_time_ns.csv), `video_t0_vrs_us`
  // is the VRS timestamp of video frame 0. setTime(tVideoS) then maps to
  // VIDEO_T0_US + tVideoS*1e6 instead of T0 + tVideoS*1e6, which removes the
  // few-seconds drift between SLAM start and video start. Fallback (no
  // anchor): assume video t=0 == SLAM T0 (legacy behaviour).
  const VIDEO_T0_US = (typeof data.video_t0_vrs_us === 'number') ? data.video_t0_vrs_us : T0;
  const DUR_S = (T1 - VIDEO_T0_US) / 1e6;

  // ── Renderer + label renderer ────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  // ── Scene / camera / controls ────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d1c);
  scene.fog = new THREE.FogExp2(0x0d0d1c, 0.01);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 300);
  camera.position.set(2, 4, 8);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 0.3;
  controls.maxDistance = 120;

  // ── Lights ───────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xfff5e0, 1.3);
  sun.position.set(4, 8, 4);
  sun.castShadow = true;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xc8d8ff, 0.3);
  fill.position.set(-5, 3, -5);
  scene.add(fill);

  const grid = new THREE.GridHelper(40, 80, 0x1a1a44, 0x13132e);
  scene.add(grid);

  // ── Trajectory line + start/end markers ──────────────────────────────────
  const positions = new Float32Array(N * 3);
  const colors    = new Float32Array(N * 3);
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < N; i++) {
    const p = s2t(traj.x[i], traj.y[i], traj.z[i]);
    positions[i*3]   = p.x;
    positions[i*3+1] = p.y;
    positions[i*3+2] = p.z;
    cx += p.x; cy += p.y; cz += p.z;
    const col = new THREE.Color().setHSL(0.666 * (1 - i / Math.max(1, N - 1)), 1.0, 0.55);
    colors[i*3]   = col.r;
    colors[i*3+1] = col.g;
    colors[i*3+2] = col.b;
  }
  cx /= N; cy /= N; cz /= N;
  const trajCenter = new THREE.Vector3(cx, cy, cz);

  const trajGeom = new THREE.BufferGeometry();
  trajGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  trajGeom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  const trajLineMat = new THREE.LineBasicMaterial({ vertexColors: true });
  const trajLine = new THREE.Line(trajGeom, trajLineMat);
  scene.add(trajLine);

  const markerGeom = new THREE.SphereGeometry(0.07, 10, 7);
  const markerMat0 = new THREE.MeshBasicMaterial({ color: 0x4488ff });
  const markerMat1 = new THREE.MeshBasicMaterial({ color: 0xff4444 });
  const startMark = new THREE.Mesh(markerGeom, markerMat0);
  const endMark   = new THREE.Mesh(markerGeom, markerMat1);
  startMark.position.copy(s2t(traj.x[0],   traj.y[0],   traj.z[0]));
  endMark.position.copy(  s2t(traj.x[N-1], traj.y[N-1], traj.z[N-1]));
  scene.add(startMark);
  scene.add(endMark);

  // ── Camera head: sphere + cone (gaze direction) + ray ────────────────────
  const SPHERE_R = 0.055;
  const CONE_H = 3.0, CONE_R = 1.4, RAY_LEN = 3.5;

  const headSphereGeom = new THREE.SphereGeometry(SPHERE_R, 12, 8);
  const headSphereMat  = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const headSphere = new THREE.Mesh(headSphereGeom, headSphereMat);

  const gazeConeGeom = new THREE.ConeGeometry(CONE_R, CONE_H, 32);
  const gazeConeMat  = new THREE.MeshBasicMaterial({
    color: 0xffaa22, transparent: true, opacity: 0.18,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const gazeCone = new THREE.Mesh(gazeConeGeom, gazeConeMat);
  gazeCone.rotation.x = Math.PI;
  gazeCone.position.y = CONE_H / 2;

  const gazeRayGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, RAY_LEN, 0),
  ]);
  const gazeRayMat = new THREE.LineBasicMaterial({
    color: 0xffdd88, transparent: true, opacity: 0.7,
  });
  const gazeRay = new THREE.Line(gazeRayGeom, gazeRayMat);

  const headGroup = new THREE.Group();
  headGroup.add(headSphere);
  headGroup.add(gazeCone);
  headGroup.add(gazeRay);
  headGroup.position.copy(s2t(traj.x[0], traj.y[0], traj.z[0]));
  headGroup.quaternion.copy(slamQuatToThree(traj.qx[0], traj.qy[0], traj.qz[0], traj.qw[0]));
  scene.add(headGroup);

  // Track current SLAM-space position for getCurrentPosition()
  let _currentSlamPos = [traj.x[0], traj.y[0], traj.z[0]];

  // ── Per-frame eye gaze ray (from general_eye_gaze.csv via Python) ────────
  //
  // Not parented to headGroup (visibility independent). A sibling group is kept
  // in sync with headGroup pose in setHeadAtSlamTime. Direction is computed in
  // headGroup-local space via _R_LC (CPF → local calibration matrix).
  // Length clamped to [0.15, 3.0] m.
  const eyeGaze   = data.eye_gaze || null;
  let gazeRayDyn      = null;
  let gazeRayGroupDyn = null;     // mirrors headGroup pose so visibility is independent
  let gazeRayDynGeom  = null;
  let gazeRayDynMat   = null;
  let gazeRayDynPos   = null;     // Float32Array(6) — [origin, tip] in local frame
  if (eyeGaze && eyeGaze.t.length > 0) {
    gazeRayDynPos  = new Float32Array(6);
    gazeRayDynGeom = new THREE.BufferGeometry();
    gazeRayDynGeom.setAttribute('position', new THREE.BufferAttribute(gazeRayDynPos, 3));
    gazeRayDynMat  = new THREE.LineBasicMaterial({
      color: 0x88ffaa, transparent: true, opacity: 0.95, depthWrite: false,
    });
    gazeRayDyn = new THREE.Line(gazeRayDynGeom, gazeRayDynMat);
    // Keep the ray decoupled from headGroup so toggling 'head' off doesn't also
    // hide the ray (parent visibility cascades to children in three.js). The
    // sibling group is kept in sync with head pose inside setHeadAtSlamTime.
    gazeRayGroupDyn = new THREE.Group();
    gazeRayGroupDyn.add(gazeRayDyn);
    scene.add(gazeRayGroupDyn);
  }

  // Linearly interpolate the 10 Hz CPF gaze samples to the current SLAM time
  // so the ray (and 2D dot in the integrated viewer) move smoothly between
  // captures instead of snapping every ~100 ms.
  function _gazeAtSlamUs(slam_us) {
    const ts = eyeGaze.t;
    const lo = bsearch(ts, slam_us);
    const i  = Math.min(lo, ts.length - 1);
    if (i === 0 || ts[i] === slam_us) {
      return { yaw: eyeGaze.yaw[i], pitch: eyeGaze.pitch[i], depth: eyeGaze.depth[i] };
    }
    const t0 = ts[i - 1], t1 = ts[i];
    const dt = t1 - t0;
    const a  = dt > 0 ? Math.max(0, Math.min(1, (slam_us - t0) / dt)) : 0;
    return {
      yaw:   eyeGaze.yaw[i - 1]   + a * (eyeGaze.yaw[i]   - eyeGaze.yaw[i - 1]),
      pitch: eyeGaze.pitch[i - 1] + a * (eyeGaze.pitch[i] - eyeGaze.pitch[i - 1]),
      depth: eyeGaze.depth[i - 1] + a * (eyeGaze.depth[i] - eyeGaze.depth[i - 1]),
    };
  }

  function updateGazeRayAtSlamTime(slam_us) {
    if (!gazeRayDyn) return;
    const g = _gazeAtSlamUs(slam_us);
    const depth = Math.max(0.15, Math.min(3.0, g.depth || 1.0));
    // CPF convention: +X left, +Y up, +Z forward.
    //   yaw+  = looking LEFT  (confirmed by vergence: right_yaw > left_yaw)
    //   pitch+ = looking UP   (confirmed: mean pitch ≈ -0.17 = looking down)
    // d_cpf = (sin(yaw)*cos(pitch), sin(pitch), cos(yaw)*cos(pitch))
    // d_local = _R_LC * d_cpf  (precomputed R_LOCAL * R_device_cpf from VRS calib)
    const cp = Math.cos(g.pitch), sp = Math.sin(g.pitch);
    const cy = Math.cos(g.yaw),   sy = Math.sin(g.yaw);
    const dx = sy * cp, dy = sp, dz = cy * cp;
    gazeRayDynPos[3] = (_R_LC[0][0]*dx + _R_LC[0][1]*dy + _R_LC[0][2]*dz) * depth;
    gazeRayDynPos[4] = (_R_LC[1][0]*dx + _R_LC[1][1]*dy + _R_LC[1][2]*dz) * depth;
    gazeRayDynPos[5] = (_R_LC[2][0]*dx + _R_LC[2][1]*dy + _R_LC[2][2]*dz) * depth;
    gazeRayDynGeom.attributes.position.needsUpdate = true;
  }

  // ── Gaze priming spheres ─────────────────────────────────────────────────
  let gazeGroup = null;
  const gazeResources = [];
  if (gaze && gaze.obj_x.length > 0) {
    gazeGroup = new THREE.Group();
    const objGeom  = new THREE.SphereGeometry(0.045, 8, 6);
    const gazeGeom = new THREE.SphereGeometry(0.028, 8, 6);
    const objMat   = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.85 });
    const gazePtMat= new THREE.MeshBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.75 });
    const linkMat  = new THREE.LineBasicMaterial({ color: 0x445566, transparent: true, opacity: 0.4 });
    gazeResources.push(objGeom, gazeGeom, objMat, gazePtMat, linkMat);

    for (let i = 0; i < gaze.obj_x.length; i++) {
      const op = s2t(gaze.obj_x[i],  gaze.obj_y[i],  gaze.obj_z[i]);
      const gp = s2t(gaze.gaze_x[i], gaze.gaze_y[i], gaze.gaze_z[i]);
      const om = new THREE.Mesh(objGeom,  objMat);  om.position.copy(op); gazeGroup.add(om);
      const gm = new THREE.Mesh(gazeGeom, gazePtMat); gm.position.copy(gp); gazeGroup.add(gm);
      const lg = new THREE.BufferGeometry().setFromPoints([op, gp]);
      gazeResources.push(lg);
      gazeGroup.add(new THREE.Line(lg, linkMat));
    }
    scene.add(gazeGroup);
  }

  // ── Animated objects ─────────────────────────────────────────────────────
  const objItems = []; // { sphere, label, kfs }
  let objGroup = null;
  const objResources = [];
  if (objects.length > 0) {
    objGroup = new THREE.Group();
    const objGeom = new THREE.SphereGeometry(0.06, 10, 7);
    const objMat  = new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.9 });
    objResources.push(objGeom, objMat);

    objects.forEach(obj => {
      const sphere = new THREE.Mesh(objGeom, objMat);
      sphere.visible = false;
      objGroup.add(sphere);

      const div = document.createElement('div');
      div.className = 'slam-obj-label';
      div.textContent = obj.name || '';
      const label = new CSS2DObject(div);
      label.visible = false;
      objGroup.add(label);

      objItems.push({ sphere, label, kfs: obj.keyframes });
    });
    scene.add(objGroup);
  }

  function objectPositionAt(kfs, t) {
    if (kfs.length === 0) return null;
    let lo = 0, hi = kfs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kfs[mid][0] < t) lo = mid + 1; else hi = mid;
    }
    const next = lo < kfs.length ? kfs[lo] : null;
    const prev = lo > 0           ? kfs[lo - 1] : null;

    if (prev && next && prev[4] === next[4] && prev[5] === next[5]) {
      const dt = next[0] - prev[0];
      if (dt <= 0) return [prev[1], prev[2], prev[3]];
      const a = (t - prev[0]) / dt;
      return [
        prev[1] + a * (next[1] - prev[1]),
        prev[2] + a * (next[2] - prev[2]),
        prev[3] + a * (next[3] - prev[3]),
      ];
    }
    for (const cand of [prev, next]) {
      if (!cand) continue;
      const [, x, y, z, ts, te] = cand;
      if (t >= ts && t <= te) return [x, y, z];
    }
    return null;
  }

  function updateObjectsAtTime(tVideoS) {
    if (!objGroup || !objGroup.visible) return;
    for (const it of objItems) {
      const pos = objectPositionAt(it.kfs, tVideoS);
      if (pos) {
        const p = s2t(pos[0], pos[1], pos[2]);
        it.sphere.position.copy(p);
        it.label.position.set(p.x, p.y + 0.12, p.z);
        it.sphere.visible = true;
        it.label.visible = true;
      } else {
        it.sphere.visible = false;
        it.label.visible = false;
      }
    }
  }

  // ── Movement arrows ──────────────────────────────────────────────────────
  const movItems = []; // { arrow, label, t_start, t_end }
  let movGroup = null;
  let movPersistent = false;

  if (movements.length > 0) {
    movGroup = new THREE.Group();
    movements.forEach(m => {
      const start = s2t(m.start[0], m.start[1], m.start[2]);
      const end   = s2t(m.end[0],   m.end[1],   m.end[2]);
      const dir   = end.clone().sub(start);
      const len   = dir.length();
      if (len < 1e-4) return;
      dir.normalize();
      const color = new THREE.Color().setHSL(nameToHue(m.name), 0.85, 0.62);
      const headLen = Math.min(0.14, len * 0.28);
      const headWid = Math.min(0.07, len * 0.14);
      const arrow = new THREE.ArrowHelper(dir, start, len, color, headLen, headWid);
      arrow.line.material.transparent = true;
      arrow.line.material.opacity = 0.9;

      const div = document.createElement('div');
      div.className = 'slam-mov-label';
      div.style.color = '#' + color.getHexString();
      div.textContent = `${m.name}: ${stripParticipantPrefix(m.fixture_start)} → ${stripParticipantPrefix(m.fixture_end)}`;
      const label = new CSS2DObject(div);
      label.position.set((start.x + end.x) / 2, Math.max(start.y, end.y) + 0.08, (start.z + end.z) / 2);

      arrow.visible = false;
      label.visible = false;
      movGroup.add(arrow);
      movGroup.add(label);
      movItems.push({ arrow, label, t_start: m.t_start, t_end: m.t_end });
    });
    scene.add(movGroup);
  }

  function updateMovementsAtTime(tVideoS) {
    if (!movGroup || !movGroup.visible) return;
    for (const it of movItems) {
      const active = movPersistent || (tVideoS >= it.t_start && tVideoS <= it.t_end);
      it.arrow.visible = active;
      it.label.visible = active;
    }
  }

  // ── Kitchen GLB (best-effort) ────────────────────────────────────────────
  let kitchenModel = null;
  let kitchenLoaded = false;

  function fitCameraToTrajectory() {
    const dist = 5;
    camera.position.set(trajCenter.x + dist, trajCenter.y + dist * 0.7, trajCenter.z + dist);
    controls.target.copy(trajCenter);
    controls.update();
  }
  fitCameraToTrajectory();

  const gltfPromise = glbUrl ? new Promise((resolve) => {
    new GLTFLoader().load(glbUrl,
      (gltf) => {
        kitchenModel = gltf.scene;
        kitchenModel.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
        scene.add(kitchenModel);
        kitchenLoaded = true;
        resolve(kitchenModel);
      },
      undefined,
      (err) => {
        console.warn('[slam-viewer] GLB load failed:', (err && err.message) || err);
        resolve(null);
      });
  }) : Promise.resolve(null);

  // ── Time setter (drives head + objects + movements) ──────────────────────
  function setHeadAtSlamTime(us) {
    const clamped = Math.max(T0, Math.min(T1, us));
    const idx = bsearch(traj.t, clamped);
    const i   = Math.min(idx, N - 1);

    let alpha = 0;
    if (i > 0) {
      const dt = traj.t[i] - traj.t[i-1];
      if (dt > 0) alpha = Math.min(1, (clamped - traj.t[i-1]) / dt);
    }

    let px, py, pz;
    if (i > 0 && alpha > 0) {
      px = traj.x[i-1] + alpha * (traj.x[i] - traj.x[i-1]);
      py = traj.y[i-1] + alpha * (traj.y[i] - traj.y[i-1]);
      pz = traj.z[i-1] + alpha * (traj.z[i] - traj.z[i-1]);
    } else {
      px = traj.x[i]; py = traj.y[i]; pz = traj.z[i];
    }
    headGroup.position.copy(s2t(px, py, pz));
    _currentSlamPos = [px, py, pz];

    const qi = new THREE.Quaternion(traj.qx[i], traj.qy[i], traj.qz[i], traj.qw[i]);
    let slerpedQ;
    if (i > 0 && alpha > 0) {
      const qi1 = new THREE.Quaternion(traj.qx[i-1], traj.qy[i-1], traj.qz[i-1], traj.qw[i-1]);
      slerpedQ = qi1.clone().slerp(qi, alpha);
    } else {
      slerpedQ = qi;
    }
    headGroup.quaternion.copy(slamQuatToThree(slerpedQ.x, slerpedQ.y, slerpedQ.z, slerpedQ.w));

    // Keep the gaze-ray group glued to the head so its endpoint math (local
    // frame) stays valid even though it is not parented to headGroup.
    if (gazeRayGroupDyn) {
      gazeRayGroupDyn.position.copy(headGroup.position);
      gazeRayGroupDyn.quaternion.copy(headGroup.quaternion);
    }
  }

  function setTime(tVideoS) {
    const slam_us = VIDEO_T0_US + tVideoS * 1e6;
    setHeadAtSlamTime(slam_us);
    updateMovementsAtTime(tVideoS);
    updateObjectsAtTime(tVideoS);
    updateGazeRayAtSlamTime(slam_us);
  }

  setTime(0);

  // ── Resize (driven by ResizeObserver on container) ───────────────────────
  function resize() {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // ── Render loop ──────────────────────────────────────────────────────────
  let _disposed = false;
  let _rafId = null;
  function _animate() {
    if (_disposed) return;
    _rafId = requestAnimationFrame(_animate);
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  _animate();

  // ── Layer toggles ────────────────────────────────────────────────────────
  function setLayerVisible(name, visible) {
    visible = !!visible;
    switch (name) {
      case 'kitchen':    if (kitchenModel) kitchenModel.visible = visible; break;
      case 'trajectory': trajLine.visible = startMark.visible = endMark.visible = visible; break;
      case 'head':       headGroup.visible = visible; break;
      case 'gaze':       if (gazeGroup) gazeGroup.visible = visible; break;
      case 'gazeRay':    if (gazeRayDyn) gazeRayDyn.visible = visible; break;
      case 'objects':    if (objGroup)  objGroup.visible = visible; break;
      case 'movements':  if (movGroup)  movGroup.visible = visible; break;
      case 'grid':       grid.visible = visible; break;
      default: console.warn(`[slam-viewer] Unknown layer: ${name}`);
    }
  }

  function setMovementsPersistent(persistent) {
    movPersistent = !!persistent;
  }

  // ── Info getter ──────────────────────────────────────────────────────────
  function getInfo() {
    return {
      participant:    data.participant,
      video_id:       data.video_id,
      duration_s:     DUR_S,
      n_traj_points:  N,
      n_objects:      objects.length,
      n_movements:    movements.length,
      n_gaze_events:  gaze ? gaze.obj_x.length : 0,
      n_eye_gaze:     eyeGaze ? eyeGaze.t.length : 0,
      kitchenLoaded,
      validLayers:    VALID_LAYERS.slice(),
    };
  }

  function getCurrentPosition() {
    return _currentSlamPos.slice();
  }

  // Per-frame gaze (CPF) at a given video time, or null when no data exists.
  // Returned as plain radians + metres so callers can do their own projection
  // (e.g. the integrated viewer overlays a 2D dot on the MP4 frame). Linearly
  // interpolated between consecutive 10 Hz samples — same as the 3D ray.
  function getGazeAtTime(tVideoS) {
    if (!eyeGaze) return null;
    return _gazeAtSlamUs(VIDEO_T0_US + tVideoS * 1e6);
  }

  // ── Destroy ──────────────────────────────────────────────────────────────
  function disposeMaterial(m) {
    if (!m) return;
    (Array.isArray(m) ? m : [m]).forEach(x => x && x.dispose && x.dispose());
  }

  function destroy() {
    if (_disposed) return;
    _disposed = true;
    if (_rafId) cancelAnimationFrame(_rafId);
    ro.disconnect();
    controls.dispose();

    // Dispose explicit shared resources
    [
      headSphereGeom, headSphereMat, gazeConeGeom, gazeConeMat,
      gazeRayGeom, gazeRayMat,
      gazeRayDynGeom, gazeRayDynMat,
      markerGeom, markerMat0, markerMat1,
      trajGeom, trajLineMat,
      ...gazeResources, ...objResources,
    ].forEach(r => r && r.dispose && r.dispose());

    // Walk movement group: ArrowHelper holds line + cone with their own materials
    if (movGroup) {
      movGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) disposeMaterial(o.material);
      });
    }

    if (kitchenModel) {
      kitchenModel.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) disposeMaterial(o.material);
      });
    }

    while (scene.children.length > 0) scene.remove(scene.children[0]);

    if (renderer.domElement.parentNode)      renderer.domElement.parentNode.removeChild(renderer.domElement);
    if (labelRenderer.domElement.parentNode) labelRenderer.domElement.parentNode.removeChild(labelRenderer.domElement);
    renderer.dispose();
  }

  // Best-effort wait for GLB so callers can show "loading…" state
  await gltfPromise;

  /** @typedef {Object} SlamViewerHandle
   *  @property {(t:number)=>void} setTime
   *  @property {(name:string, visible:boolean)=>void} setLayerVisible
   *  @property {(persistent:boolean)=>void} setMovementsPersistent
   *  @property {()=>void} fitCamera
   *  @property {()=>void} resize
   *  @property {()=>void} destroy
   *  @property {()=>Object} getInfo
   *  @property {()=>number[]} getCurrentPosition
   */
  return {
    setTime,
    setLayerVisible,
    setMovementsPersistent,
    fitCamera: fitCameraToTrajectory,
    resize,
    destroy,
    getInfo,
    getCurrentPosition,
    getGazeAtTime,
  };
}
