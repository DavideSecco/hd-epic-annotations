# HD-EPIC Annotation Viewer — Contesto sessione di lavoro
> Aggiornato: 21 maggio 2026.

---

## 1. Cos'è il progetto

Stiamo costruendo un **viewer interattivo** per esplorare il dataset HD-EPIC (egocentric cooking video dataset, CVPR 2025). Il viewer principale è:

```
/mnt/Volume/Mega/PHD/Bocconi/code/hd-epic-annotations/HD_EPIC_VQA_Annotation-Viewer.html
```

### Cosa fa già il viewer
- Carica video (drag & drop o button)
- Carica narrations (`.pkl` o `.csv`) → lista sincronizzata con il video
- Carica audio annotations (`.csv`) → HUD overlay sul video
- Carica recipes (`.json`) → pannello ricetta + macro-fasi sulla timeline
- Timeline con corsie colorate per step/narration/audio
- Search sulle narrations
- Scroll auto-centrato sull'annotazione attiva

---

## 2. Dataset HPC — montato in read-only

Il dataset completo HD-EPIC è montato in **sola lettura** su:
```
/mnt/bocconi_hpc_video_datasets/HD-EPIC/
```
**Non si può scrivere nulla sull'HPC.** File esportati (GLB ecc.) vanno nel repo locale.

### Struttura top-level
```
/mnt/bocconi_hpc_video_datasets/HD-EPIC/
├── data/                   (md5.txt, frames.txt)
├── Videos/P01..P09/        (MP4 + timing CSVs per-video)
├── Digital-Twin/
│   └── blenders/           (P01..P09 .blend — tutti presenti! Vedi §3)
├── SLAM-and-Gaze/P01..P09/ (53–124 GB ciascuno — tutti già presenti!)
│   ├── GAZE_HAND/mps_{VIDEO_ID}_vrs/
│   │   ├── eye_gaze/general_eye_gaze.csv
│   │   └── hand_tracking/wrist_and_palm_poses.csv
│   └── SLAM/multi/{N}/slam/
│       ├── closed_loop_trajectory.csv   ← camera pose world-space
│       ├── open_loop_trajectory.csv
│       ├── semidense_observations.csv.gz
│       └── semidense_points.csv.gz
├── Hands-Masks/            (contours zip, ~2 GB)
├── hd-epic-annotations/    (copia remota delle annotazioni)
└── VRS/P01..P05/           (raw VRS files)
```

### File 3D — Digital Twin (read-only su HPC)
```
/mnt/bocconi_hpc_video_datasets/HD-EPIC/Digital-Twin/blenders/
├── P01_final.blend   (24 MB)    ├── P05_final.blend  (305 MB)
├── P02_final.blend  (128 MB)    ├── P06_final.blend  (191 MB)
├── P03_final.blend  (168 MB)    ├── P07_final.blend  (173 MB)
├── P04_final.blend  (200 MB)    ├── P08_final.blend  (170 MB)
                                 └── P09_final.blend  (166 MB)
```
I GLB esportati da Blender vanno salvati nel repo locale (scrivibile).

### SLAM data — formato CSV
**`closed_loop_trajectory.csv`** — camera pose in world-space:
```
graph_uid, tracking_timestamp_us, utc_timestamp_ns,
tx_world_device, ty_world_device, tz_world_device,
qx_world_device, qy_world_device, qz_world_device, qw_world_device,
device_linear_velocity_{x,y,z}_device, angular_velocity_{x,y,z}_device,
gravity_{x,y,z}_world, quality_score, ...
```

**`general_eye_gaze.csv`** — gaze per frame:
```
tracking_timestamp_us,
left_yaw_rads_cpf, right_yaw_rads_cpf, pitch_rads_cpf, depth_m,
tx_left_eye_cpf, ty_left_eye_cpf, tz_left_eye_cpf, ...
```

**`wrist_and_palm_poses.csv`** — mani in device-space:
```
tracking_timestamp_us, left_tracking_confidence,
tx_left_wrist_device, ty/tz, tx_left_palm_device, ty/tz, (same for right)
```

**Allineamento temporale:** `tracking_timestamp_us` (µs) × 1000 = ns → mappato al video tramite
`Videos/P0X/{VIDEO_ID}_mp4_to_vrs_time_ns.csv`

---

## 3. Script viewer 3D

### `view_kitchen_3d.py` — Solo cucina 3D (non toccare)
Visualizza la cucina da un `.blend` o `.glb`. Script di visualizzazione statica, lasciarlo com'è.

```bash
python3 view_kitchen_3d.py /mnt/bocconi_hpc_video_datasets/HD-EPIC/Digital-Twin/blenders/P01_final.blend --force
```

### `view_slam_3d.py` — SLAM trajectory + gaze (nuovo, 24 aprile)
Visualizza la traiettoria della camera SLAM sovrapposta alla cucina 3D, con:
- **Traiettoria** come linea colorata (blu→rosso = tempo)
- **Marcatori** start (blu) / end (rosso)
- **Camera head**: sfera bianca + **cono di visione** semi-trasparente (apex alla testa, si apre nella direzione sguardo, 1.2m × 0.55m raggio) + linea asse ottico
- **Orientazione reale** dal quaternione SLAM (`qx_world_device` ecc.) con SLERP tra campioni
- **Gaze priming**: sfere gialle (oggetto) + sfere ciano (punto fissazione)
- Playback con timeline, speed 0.25×–10×, layer toggles, Space per play/pause

```bash
# Uso tipico — auto-scopre tutto da participant + session
python3 view_slam_3d.py --participant P01 --session 0

# Con path espliciti
python3 view_slam_3d.py \
    --glb output/P01_final.glb \
    --slam /mnt/bocconi_hpc_video_datasets/HD-EPIC/SLAM-and-Gaze/P01/SLAM/multi/0/slam/closed_loop_trajectory.csv \
    --video-id P01-20240202-110250

# Opzioni utili
--subsample 200   # default: 1 punto ogni 200 righe ≈ 2000 punti per sessione
--force           # ri-esporta il GLB anche se esiste già
--no-browser      # genera solo i file senza aprire il browser
```

Output in `./output/`: `P01_final.glb` + `slam_P01_s0.html` (~154 KB)

### Dettagli tecnici degli script 3D
- **Bug già risolti** nel Blender export: rimosso `export_colors=True`, rimosso `bpy.ops.object.delete()`
- **Coordinate transform** SLAM→Three.js: `(x, y, z) → (x, z, -y)` (Blender Z-up → Three.js Y-up)
- **Quaternion transform**: `q_three = Q_ALIGN * q_slam * Q_ALIGN⁻¹` dove `Q_ALIGN` = rotazione −90° attorno a X
- **Asse gaze**: dopo il transform, l'asse locale **+Y** del headGroup = direzione forward camera Aria (device +Z)
- I materiali non si esportano (Blender usa nodi procedurali non GLTF-compatibili) → geometria grigia, struttura visibile
- GLB P01: 42 mesh, 85 KB (corretto, il 24-MB del .blend è tutto materiali/dati interni Blender)

### Struttura per integrazione nel viewer HTML
L'HTML generato da `view_slam_3d.py` è già strutturato per l'embedding:
- `<script type="application/json" id="slam-data">` → rimpiazzare con `fetch()` nella versione integrata
- `<div id="slam-viewer">` → copiare come pannello nel viewer principale
- Nessuno stato globale, tutto scoped nel `<script type="module">`

---

## 4. Mappa dati disponibili in locale

### Nel repository (`/mnt/Volume/Mega/PHD/Bocconi/code/hd-epic-annotations/`)

| Cartella/File | Contenuto | Note |
|---|---|---|
| `narrations-and-action-segments/HD_EPIC_Narrations.pkl` | 59.454 azioni (narration, verb, noun, **hands**) | Già nel viewer. Campo `hands` NON mostrato |
| `audio-annotations/HD_EPIC_Sounds.csv` | 50.968 eventi audio, 44 classi | Già nel viewer |
| `high-level/complete_recipes.json` | 69 ricette + calorie/macro + timestamp | Già nel viewer (parziale) |
| `high-level/activities/P0X_recipe_timestamps.csv` | recipe_id + attività + start/end per video | **NON nel viewer** |
| `scene-and-object-movements/assoc_info.json` | 8.382 oggetti con movimenti temporali | **NON nel viewer** |
| `scene-and-object-movements/mask_info.json` | frame + 3d_location + bbox 2D + fixture | **NON nel viewer** |
| `eye-gaze-priming/priming_info.json` | 19.400 eventi gaze: 3d_location, gaze_point, dist_to_cam | **NON nel viewer** |
| `vqa-benchmark/*.json` | ~15.000 domande VQA con start/end time | — |
| `youtube-links/HD_EPIC_YouTube_URLs.csv` | URL YouTube per ogni video_id | — |

### Sull'HPC (read-only, `/mnt/bocconi_hpc_video_datasets/HD-EPIC/`)

| Dato | Disponibile |
|---|---|
| Video MP4 (P01–P09) | ✅ |
| Digital Twin .blend (P01–P09) | ✅ (read-only — export GLB in locale) |
| SLAM closed_loop_trajectory (P01–P09) | ✅ |
| Eye gaze CSV (P01–P09) | ✅ |
| Hand tracking CSV (P01–P09) | ✅ |
| Hands-Masks contours | ✅ (~2 GB) |
| Semidense point clouds | ✅ (.csv.gz) |

---

## 5. Piano di implementazione — priorità

| # | Feature | Sforzo | Dati necessari | Disponibile? |
|---|---|---|---|---|
| 1 | **"Hands" badge** su ogni narration (L/R/both) | Minimo | Campo `hands` già nel CSV | ✅ |
| 2 | **Auto-detect ricetta** dal video ID caricato | Piccolo | `high-level/activities/P0X_recipe_timestamps.csv` | ✅ **FATTO** |
| 3 | **YouTube link** auto (bottone "Open on YouTube") | Minimo | `youtube-links/HD_EPIC_YouTube_URLs.csv` | ✅ **FATTO** |
| 4 | **Object movements** in timeline + lista | Medio | `scene-and-object-movements/assoc_info.json` | ✅ |
| 5 | **"How/Why" clauses** su ogni narration | Medio | `fine_grained_how/why_recognition.json` | ✅ **FATTO** |
| 6 | **Nutritional live tracker** (calorie nel tempo) | Medio | `complete_recipes.json` | ✅ **FATTO** |
| 7 | **VQA panel** — domande al timestamp corrente | Medio | tutti i VQA JSON | ✅ **FATTO** |
| 8 | **Digital Twin 3D** integrato nel viewer HTML | Alto | `.glb` da esportare da HPC, salvare in locale | ✅ |
| 9 | **Gaze points 3D** sovrapposti alla cucina | Alto | `priming_info.json` | ✅ |
| 10 | **Camera trajectory** (testa persona) nella cucina | Alto | `SLAM/multi/*/slam/closed_loop_trajectory.csv` (HPC) | ✅ HPC |
| 11 | **Gaze ray animato** frame-by-frame | Molto alto | `general_eye_gaze.csv` + SLAM + timing CSV (HPC) | ✅ HPC |

---

## 6. Dettagli tecnici utili

### Struttura ID video
Formato: `P{participant}-{YYYYMMDD}-{HHMMSS}` — es. `P01-20240202-110250`  
Il viewer estrae il video_id dal nome del file video caricato (senza estensione).

### Struttura assoc_info.json (object movements)
```json
{
  "P01-20240202-110250": {
    "association_id": {
      "name": "mug",
      "tracks": [
        { "track_id": "...", "time_segment": [353.4, 357.0], "masks": ["mask_id1", ...] }
      ]
    }
  }
}
```

### Struttura priming_info.json (gaze)
```json
{
  "P01-20240202-110250": {
    "0": {
      "start": {
        "frame": 283,
        "3d_location": [-0.11, -3.13, -0.03],
        "prime_stats": { "frame_primed": 177, "gaze_point": [-0.12, -3.12, -0.10], "dist_to_cam": 2.32 }
      }
    }
  }
}
```
`frame_primed = -1` → no priming; `frame_primed = -2` → oggetto fuori schermo

### Fixture naming convention
I fixture (es. `P01_counter.008`) corrispondono direttamente agli oggetti nel `.blend` del partecipante → chiave per linkare dati 2D/3D al modello.

### Coordinate 3D (sistema condiviso)
Blender, priming_info, mask_info e SLAM usano lo **stesso world-space**:
- X: [-5, +2] m, Y: [-6, +3] m, Z: [-4, +1] m (tipico)

### Note architetturali
- Il viewer HTML usa **Pyodide** (Python in WASM) per leggere i `.pkl`
- Il viewer 3D usa **Three.js via CDN**
- Il sistema di coordinate 3D è **consistente** tra tutti i dati → overlay diretto possibile

---

## 7. Stato lavori al 30 aprile 2026

### Fatto (21 maggio 2026)

- **HD-EPIC Intermediate Data** (`HD-EPIC Intermediate Data/`, 2.2 GB): cartella con `device_calibration.json` + `framewise_info.jsonl` per ogni video. Il `.jsonl` contiene per ogni frame MP4: `frame_index`, `gaze_centre_in_pixels [px,py]` in 1408×1408 space, `gaze_direction_in_world [dx,dy,dz]` in world-space SLAM, `T_world_device`. Copertura: 99.6% dei frame.

- **2D gaze dot — nuovo approccio** (`viewer.js` + `csv-worker.js`): sostituisce la proiezione CPF→fisheye con lookup diretto da `framewise_info.jsonl`. `loadFramewiseGaze(videoId)` carica il file in background via web worker (`jsonl_gaze` type). Worker estrae solo i keyframe dove `gaze_timestamp_ns` cambia (~5 Hz reale nel file), restituisce `{frames, px, py: Int16Array, n}` via zero-copy transfer. `_updateGazeDot` interpola linearmente tra keyframe → smooth 30 fps.
  - `_getVideoImageRect()`: calcola area immagine reale nel video element (fix letterbox/pillarbox)
  - Bottone "👁 Gaze" in topbar: appare quando i dati sono caricati, controlla il dot indipendentemente da SLAM. Stato persistito in `localStorage` (`hdepic.gazeEnabled`). Default on.
  - Fallback: se il file non esiste (P08, video senza intermediate data), usa vecchio percorso CPF→fisheye (se SLAM caricato)
  - URL: `../HD-EPIC%20Intermediate%20Data/{participant}/{videoId}/framewise_info.jsonl`

- **3D cone orientation fix** (`slam-viewer.js`): `HEAD_YAW_CORRECTION_DEG` default ripristinato a **−37°** (era rimasto a 0° dalla sessione 20 maggio). Il cono segue headGroup = asse SLAM-left-camera; CPF +Z è 37° a DESTRA → correzione −37° ruota il cono verso dove guarda effettivamente la persona. Valore calibrato: `arccos(CPF_fwd · device_fwd) = arccos(0.7923) ≈ 37.6°`. Il gaze RAY usa `_R_LC` ed è già corretto indipendentemente.

- **Nota gaze sampling**: il file intermediate ha ~5.1 Hz gaze unici (non 10 Hz come il `general_eye_gaze.csv` raw). Causa: deduplicazione su `gaze_timestamp_ns` nel dataset. L'interpolazione lineare tra keyframe compensa visivamente.

- **Cone size** (`slam-viewer.js`): aumentato 2.5× per essere visibile nella cucina — `CONE_H = 3.0m`, `CONE_R = 1.4m`, `RAY_LEN = 3.5m` (era 1.2/0.55/1.4).

### ⚠️ IN PAUSA (21 maggio 2026) — Gaze ancora non corretto, da riprendere

Stato al momento della pausa: **"non va ancora, ci sono probabilmente altri errori"**. Le due cose implementate (2D dot framewise + correzione −37° cono) migliorano ma non risolvono completamente.

#### Cosa sappiamo funziona
- Bottone "👁 Gaze" appare in topbar → dati caricati correttamente da `framewise_info.jsonl`
- Posizione del dot sul video: **più corretta** rispetto alla proiezione fisheye precedente (l'utente ha confermato "l'utente guarda meglio dove deve guardare")
- Orientazione cono 3D: **corretta** dopo −37° (l'utente ha confermato)
- Cono 3D: **dimensioni aumentate**, ora più visibile nella cucina

#### Problemi ancora aperti (non ancora risolti)

**1. 2D dot — aspect ratio potenzialmente ancora problematico**
- `_getVideoImageRect()` è implementata e usa `Math.min(vRect.w/vw, vRect.h/vh)` (logica `contain`)
- La CSS attuale usa `object-fit: cover` + `aspect-ratio: 1/1` → video element sempre quadrato, video 1408×1408 → nessuna banda nera → `_getVideoImageRect()` ≡ `getBoundingClientRect()` in pratica
- MA: non è stato verificato visivamente se il dot è esattamente sulla pupilla/sguardo dell'utente nel video
- **Cosa fare per verificare**: confrontare la posizione del dot con un momento nel video in cui si sa dove la persona sta guardando (es. guardare un oggetto specifico, poi vedere dove cade il dot)

**2. Campionamento / interpolazione 2D dot**
- Gaze unici nel file: ~5.1 Hz (non 30 Hz come i frame video)
- L'interpolazione lineare tra keyframe è implementata, ma potrebbe comunque apparire "a scatti" se i movimenti sono veloci
- **Confronto da fare**: caricare il video + osservare il dot durante un movimento oculare rapido

**3. 3D gaze ray (linea dinamica in slam-viewer.js) — ancora basato su CPF yaw/pitch**
- Il gaze RAY dinamico usa ancora `eye_gaze` (yaw/pitch da `general_eye_gaze.csv`) serializzato nel JSON SLAM
- `framewise_info.jsonl` ha `gaze_direction_in_world` che è già in world-space SLAM → conversione molto più semplice
- **Da fare**: aggiornare `view_slam_3d.py` per caricare da `framewise_info.jsonl` invece di `general_eye_gaze.csv`, e aggiornare `slam-viewer.js` per accettare direzioni world-space invece di CPF yaw/pitch

**4. "ci siano altri errori" — cosa potrebbe essere sbagliato**
Possibili cause non ancora investigate:
- Il `Math.round(tVideoS * 30)` per il frame index assume FPS=30 esatto. Aria RGB è 30 fps nominal ma potrebbe avere drift. Usare `frame_index` dal CSV timing sarebbe più preciso.
- L'interpolazione lineare tra keyframe è in spazio pixel (2D), non in spazio angolare. Per movimenti oculari veloci potrebbe sovrastimare la velocità intermedia.
- Il `gaze_centre_in_pixels` potrebbe essere in coordinate del sensore RAW (non ruotato), non dell'MP4 display. Il README dice "Gaze point in the MP4 frame" → dovrebbe essere già corretto, ma da verificare.

#### File e funzioni coinvolte
| Componente | File | Funzione/Var | Note |
|---|---|---|---|
| 2D dot load | `viewer/viewer.js` | `loadFramewiseGaze()` | Carica jsonl, keyframe only |
| 2D dot render | `viewer/viewer.js` | `_updateGazeDot()` | Binary search + lerp |
| Aspect ratio | `viewer/viewer.js` | `_getVideoImageRect()` | Min-scale formula |
| Toggle | `viewer/index.html` + `viewer.js` | `#gaze-btn` + `GAZE_ENABLED_KEY` | Topbar, verde=on |
| Worker | `viewer/csv-worker.js` | `parseJSONLGaze()` | Keyframes only via gaze_timestamp |
| Cono 3D | `viewer/slam-viewer.js` | `CONE_H/R/RAY_LEN` | 3.0/1.4/3.5 m |
| Correzione cono | `viewer/slam-viewer.js` | `HEAD_YAW_CORRECTION_DEG` | Default −37° |
| Gaze RAY 3D | `viewer/slam-viewer.js` | `updateGazeRayAtSlamTime()` | Ancora CPF-based, da aggiornare |
| Dati framewise | `HD-EPIC Intermediate Data/{P}/{video_id}/framewise_info.jsonl` | — | ~5.9 MB/video, 2038 keyframe/video |

### Fatto (20 maggio 2026)

- **VQA panel espanso a 30 categorie** (`viewer.js`): `VQA_CATEGORIES` ha ora una entry per ogni file JSON in `vqa-benchmark/`. Chip-counter sticky in cima al pannello, toggleable, tutti off per default (stato in `localStorage`). `cleanVqaText()` mostra i timestamp `<TIME ...>` direttamente (utile per `action_localization`). Vedi struttura in §7 "Fatto 18 maggio" sotto.

- **Resize handles** tra tutti i pannelli: `makeResizable({handle, target, dir, sign, min, key, onResize})` in `viewer.js`. CSS variable `--rsz-h/w` su inline style, compatibile con collapse (`flex: 0 0 auto` ha specificità maggiore). Maniglie: `rsz-video-annot`, `rsz-video-slam`, `rsz-nar-rec`, `rsz-rec-nut`, `rsz-nut-vqa`. Nascoste via `:has()` quando i pannelli condizionali sono assenti.

- **Gaze 3D ray** (`slam-viewer.js`) — **fix con calibrazione reale**:
  - Sostituito il mapping manuale CPF→local con la matrice `_R_LC = R_LOCAL * R_device_cpf` ricavata dal VRS tramite `projectaria_tools`.
  - `HEAD_YAW_CORRECTION_DEG` default cambiato da −40° a 0° (la correzione empirica era necessaria solo perché mancava la calibrazione). Il valore −40° compensava il reale offset fisico di ~37° tra il frame SLAM left-camera e il CPF binoculare.
  - Dettagli matrici in §9.

- **Gaze 2D dot** (`viewer.js`) — **fix con calibrazione reale + fisheye**:
  - Sostituita la proiezione pinhole HFOV=80° con proiezione fisheye equidistante reale: `r = f·atan2(r_xy, cz)`, f=607.21 px.
  - Usata la matrice `_R_CAM_CPF = R_camera_device.T * R_device_cpf` per trasformare la direzione CPF nel frame della camera RGB.
  - Scoperta la **rotazione 90° CW del sensore Aria RGB**: verificata con `rgb.project()` su 5 direzioni di riferimento. La mappatura da raw sensor (u,v) a NDC display è `ndcX = 0.5 - v/W`, `ndcY = u/W - 0.5` (non la usuale `u/W - 0.5`, `v/H - 0.5`).
  - Vedi §9 per tutti i valori numerici e il comando di verifica.

- **Subsample eye gaze** portato a 10 Hz (subsample=10 in `view_slam_3d.py`, era 50). JSON risultante ~2.7 MB con ~3964 campioni per sessione P01.

- **Problema noto residuo — aspect ratio**: il 2D dot proietta correttamente SE il `<video>` mostra l'immagine 1408×1408 a schermo intero nel suo box senza bande nere. Con `object-fit: contain` su video non-quadrato (o video element non quadrato), `vRect.width/height` include le bande → il dot viene proiettato sbagliato. Fix: calcolare le dimensioni reali dell'immagine nel video element:
  ```javascript
  function getVideoImageRect() {
    const scale = Math.min(vid.clientWidth/vid.videoWidth, vid.clientHeight/vid.videoHeight);
    const iw = vid.videoWidth*scale, ih = vid.videoHeight*scale;
    return { left:(vid.clientWidth-iw)/2, top:(vid.clientHeight-ih)/2, width:iw, height:ih };
  }
  ```
  Usare questa funzione al posto di `vid.getBoundingClientRect()` nel calcolo di `dotX/dotY`.

### Fatto (18 maggio 2026)

- **Fase 2 — modulo `slam-viewer.js` estratto** ([PLAN_slam_integration.md](PLAN_slam_integration.md)): la logica three.js è ora un modulo ES condiviso (`viewer/slam-viewer.js`, 543 righe). API: `initSlamViewer({container, data|dataUrl, glbUrl}) → {setTime, setLayerVisible, setMovementsPersistent, fitCamera, resize, destroy, getInfo, getCurrentPosition}`. CSS namespaced in `viewer/slam-viewer.css` (`.slam-obj-label`, `.slam-mov-label`).
  - `view_slam_3d.py` inline-inietta modulo+CSS al momento della generazione → l'HTML standalone resta self-contained (file:// funziona). File ridotto da 1305 a 820 righe.
  - Smoke test isolato in `viewer/slam-test.html` (raggiungibile via `python3 serve_viewer.py` → `/viewer/slam-test.html`).

- **Fase 3 — integrazione nel viewer principale**: il pannello SLAM vive ora dentro `viewer/index.html` sotto il video, sincronizzato col playback.
  - `#video-panel` diventa flex-column: `#video-wrap` + nuovo `#slam-host` (32vh, min 240px) + `#timeline-wrap`. Toggle "3D" in topbar con stato persistito in `localStorage`.
  - In `viewer.js`: `initSlamForVideo(videoId)` fa `import('./slam-viewer.js')` dinamicamente, probe `../output/slam_<id>.json` (placeholder elegante su 404), monta il modulo. Race-safe via `_slamInitVersion`.
  - Sync: `slam.setTime(vid.currentTime)` chiamato dal listener `timeupdate` (paused/seek) e dal `_maskRafTick` (playback, ~30 Hz). Importmap CDN (jsdelivr) in `<head>` per `three` e `three/addons/`.

- **Fix allineamento temporale video ↔ SLAM** (caveat risolto): `Videos/PXX/{video_id}_mp4_to_vrs_time_ns.csv` letto da `load_video_t0_vrs_us()` in `view_slam_3d.py`. Il `vrs_device_time_ns` della prima riga (= video frame 0 nel clock VRS) viene serializzato nel JSON come `video_t0_vrs_us`. `slam-viewer.js` ora calcola `setTime(tVideoS) → VIDEO_T0_US + tVideoS*1e6` invece di `T0 + tVideoS*1e6`. Per P01-20240202-110250 il drift era +1.500s. Fallback automatico al comportamento legacy se il campo manca nel JSON.

- **Ottimizzazioni overlay rendering** in `viewer.js`:
  - **`requestVideoFrameCallback`** sostituisce `requestAnimationFrame` per il loop bbox/hand-mask: firing ora 30 Hz allineato al decoder video invece di 60 Hz del display refresh (zero invocazioni redundant). Fallback a rAF per browser legacy.
  - **Frame-skip cache su `renderMaskBoxes`**: `_lastBoxFrame` evita di rifare `clearRect` + `drawImage` + scan `masksByFrame` quando il frame video non è cambiato. Invalidato su resize via `syncBboxCanvas`.
  - **Skip `drawImage` quando hand-mask vuoto**: `_handBufHasContent` evita la blit di 1408×1408 ImageData quando nessuna mano è presente nel frame.

### Firefox stutter — known issue (non risolto, usare Chromium)

Sul viewer principale Firefox 150 (Linux) **mostra micro-stutter video durante il playback**, anche con video Aria H.264 che girano perfettamente fluidi in Firefox da soli (drag&drop del solo MP4 in una tab vuota → fluido; stesso file caricato nel viewer → stuttering visibile). Su Chromium tutto fluido out-of-the-box. Sessione di debug del 18 maggio:

- **Profile Firefox Profiler**: main thread tranquillo (CPU ~5%, picchi modesti), Compositor track con blocchi blu regolari, Renderer attivo. Niente jank evidente nelle metriche.
- **3D toggle off**: stuttering invariato → SLAM rAF non è il colpevole.
- **Overlay nascosti via console** (`#bbox-canvas` + `#audio-hud` `display:none`): stuttering invariato → compositing degli overlay non è la causa.
- **3D toggle off + overlay nascosti** insieme: stuttering invariato → né overlay né SLAM.
- **CSS compositor hints rimossi via console** (`will-change`, `transform: translateZ(0)`, `contain: paint`): nessun cambiamento → quegli hint non aiutavano (rimossi dal codice).
- **rAF → `requestVideoFrameCallback` switch**: nessun cambiamento visibile, ma è un miglioramento oggettivo del codice → tenuto.

Ipotesi residue non testate: decoder Firefox (VA-API su Linux non sempre stabile per H.264), interazione con altre tab pesanti aperte in parallelo (Google Docs, Office365 visti nello stesso profile), oppure compositing video con sibling assoluti che Firefox tratta in pipeline meno efficiente di Chromium indipendentemente da `will-change`.

**Decisione**: il viewer è marcato Chromium-only nella practice. Firefox resta supportato a livello funzionale (tutto funziona, anche se con stuttering durante playback). Non ulteriori indagini per ora.

### Fatto (30 aprile)
- **Object trajectories animate nel viewer SLAM 3D** (`view_slam_3d.py`): ogni oggetto in `assoc_info.json` è una sfera verde che si muove seguendo le sue mask in `mask_info.json`.
  - Funzione Python `load_object_trajectories()` (sostituisce `load_object_masks()`): produce `[{name, keyframes: [[t, x, y, z, t_seg_s, t_seg_e], ...]}, ...]`. `t = frame_number / 30` (FPS Aria).
  - JS: `objectPositionAt(kfs, t)` con binary search → interpolazione lineare quando i due keyframe consecutivi appartengono allo **stesso track** (matching `t_seg_start`/`t_seg_end`); altrimenti snap al kf più vicino se `t` è dentro il suo `time_segment`; altrimenti sfera nascosta.
  - 34 oggetti per `P01-20240202-110250` (vs 19 fixture statici prima), 124 keyframes totali, media 3.6/oggetto.
  - Esempio: `juicer bowl` si muove smooth da `counter.008` (357.5s) a `counter.004` (389.6s).
  - **Bug concettuale risolto**: prima le sfere erano una per fixture (counter, cupboard) con label arbitrario di un oggetto sopra di esso → statiche per definizione e label fuorvianti.

- **Frecce movimento oggetti nel viewer SLAM 3D** (`view_slam_3d.py`): un `THREE.ArrowHelper` per ogni track in `assoc_info.json`.
  - Funzione Python `load_object_movements()`: per ogni track produce `{name, start[3], end[3], fixture_start, fixture_end, t_start, t_end}`. Filtra movimenti < 5cm (re-detection di oggetti fermi).
  - JS: colore dedotto dal nome via hash FNV-1a → HSL → `Color.setHSL()`. Label CSS2D `"{name}: {fixture_start} → {fixture_end}"` (prefisso `P01_` rimosso).
  - Default: filtro temporale attivo (visibili solo le frecce del `time_segment` corrente). Toggle `all at once` per mostrarle tutte.
  - 50 frecce per `P01-20240202-110250`, distanza media 48 cm (max 1.81 m).

#### Caveat noto sull'allineamento temporale
Il `frame_number` delle mask e il `time_segment` dei track sono in **tempo video**. Il playback usa `tracking_timestamp_us` (tempo SLAM/VRS). Attualmente assumo `elapsed_slam_s ≈ video_s`, ma l'offset reale tra inizio recording video e inizio sessione SLAM può essere di alcuni secondi. **Fix da fare**: usare `Videos/PXX/{video_id}_mp4_to_vrs_time_ns.csv` per mappare `tracking_timestamp_us` → `video_frame` con precisione sub-frame. Effetto attuale: oggetti e frecce appaiono leggermente sfasati rispetto alla traiettoria SLAM.

#### Limitazioni intrinseche dei dati
- Solo ~3.6 mask per oggetto in media → tra una mask e l'altra l'interpolazione è lineare nel mondo, ma fisicamente l'oggetto segue un arco (in mano). Migliorabile in futuro usando `wrist_and_palm_poses.csv` (HPC) per agganciare l'oggetto al palmo durante il volo.
- Le `3d_location` sono inferite (depth + SLAM), rumorose specie per oggetti `mid-air` o piccoli.

### Fatto (29 aprile)
- **Nutritional live tracker** (#6): pannello `#nutrition-panel` tra recipe e VQA. Funzioni: `extractNutritionTimeline()`, `renderNutritionPanel()`, `renderNutritionTracker(t)`. Globals: `nutritionTimeline`, `nutritionRecipeTotals`, `_lastNutritionAdded`.
  - Mostra: barra calorie arancione (corrente / totale ricetta), 3 mini-barre macro (Protein/Carbs/Fat), lista ingredienti con ✓ tick al momento dell'aggiunta
  - Timestamp: usa `add.start` come primario, `weigh.start` come fallback se `add` è vuoto → copertura ~90/142 video
  - Gestisce `cal=N/A`: messaggio "No calorie data for this recipe" invece di barre vuote
  - Gestisce assenza timestamp: messaggio "No timestamps for this recording — showing recipe totals only"
  - Colonne nella lista: Ingredient · Calories · Added at (con header row `.nut-ing-header`)
  - Collassabile con localStorage come le altre sezioni
  - **Copertura dati**: 85 video hanno sia calorie sia timestamp `add`; 5 aggiuntivi hanno solo `weigh`; 28 video non hanno né calorie né timestamp (es. P01-20240204-152537 — Vermicelli Rice)
  - **Video ideale per testare**: `P01-20240202-161354.mp4` (Cacio e Pepe) → pasta 445 kcal appare a ~313s

### Fatto (28 aprile)
- **YouTube link**: bottone `<a id="yt-btn">` nella topbar, hidden di default, appare appena il video_id è nel CSV. Caricamento in `autoLoadDefaults`. Path: `viewer/index.html` + `viewer/viewer.js` (`youtubeUrls`, `updateYoutubeButton()`).
- **How/Why clauses**: pills arancioni/viola su narrations con dati VQA. Lookup `howWhyLookup` indicizzato per video_id. Funzioni: `buildHowWhyLookup()`, `findHowWhy()`. Stile in `viewer/style.css` (`.tag-how`, `.tag-why`). Note: dati sparsi (500+500 entry su 156 video, ~5/video), match ±1s.
- **Activity segments** (#2): 9 CSV `P0X_recipe_timestamps.csv` caricati in parallelo in `autoLoadDefaults`. Corsia viola in cima alla timeline. `step-context` mostra "Attività · Fase". Funzioni: `getActivityAt()`, globals `allActivityData`, `activitySegments`.

### Fatto (24 aprile)
- Rinominato `CONTEXT_DOMANI.md` → `CLAUDE.md`
- Creato `view_slam_3d.py`: viewer SLAM con traiettoria + gaze cone quaternionico ✅
- Cono di visione semi-trasparente (apex alla testa, base aperta 1.2m avanti) ✅
- Orientazione dal quaternione SLAM con SLERP, funziona correttamente ✅
- **Refactoring viewer HTML** in tre file separati + server con auto-load:
  - `viewer/index.html` — shell HTML (link a style.css e viewer.js)
  - `viewer/style.css` — tutto il CSS estratto
  - `viewer/viewer.js` — tutta la logica JS + `autoLoadDefaults()` + Web Worker + fix rendering
  - `viewer/csv-worker.js` — Web Worker per parsing CSV/JSON off-main-thread
  - `serve_viewer.py` — server HTTP locale che serve la repo root e apre `http://localhost:PORT/viewer/`
  - **Come usare**: `python3 serve_viewer.py` → tutto carica da solo, basta droppare il video
  - **Browser**: usare **Chrome** (Firefox ha problemi di stutter video con DOM mutations sull'audio HUD — problema noto di compositing)

### Note tecniche viewer split
- **CSV/JSON parsing**: avviene in un Web Worker (`csv-worker.js`) → il main thread non viene mai bloccato anche con il CSV narrations da 21 MB
- **renderAudioHud**: ottimizzato per non ricostruire il DOM ogni tick — ricostruisce solo quando cambia il set di eventi attivi, aggiorna width/testo in-place. Necessario perché Firefox non isola il `<video>` su GPU layer separato quando ci sono DOM mutations sull'overlay.
- **Pyodide**: caricato lazy (solo se si carica un .pkl manualmente) — NON includere `<script src="pyodide.js">` nell'head di index.html

### Viewer aggiornato — file di riferimento
- **Vecchio viewer monolitico** (da non modificare): `HD_EPIC_VQA_Annotation-Viewer.html`
- **Nuovo viewer split** (da usare e sviluppare): `viewer/index.html` via `python3 serve_viewer.py`

### Cosa c'è già nel viewer HTML (`viewer/index.html`)
- Carica narrations (pkl/csv), audio annotations (csv), recipes (json) → **automaticamente all'avvio**
- Ricetta: auto-match al video_id, step sulla timeline, step attivo evidenziato, pannello ricetta
- Audio: HUD overlay sul video (ottimizzato, no DOM churn)
- Timeline multitrack: step / narration / audio
- Search narrations
- **Bbox 2D oggetti** sul video (canvas overlay verde): carica `mask_info.json` + `assoc_info.json` automaticamente, mostra rettangolo + etichetta per ogni oggetto rilevato al frame corrente (±15 frame = ±0.5s, FPS=30, risoluzione Aria 1408×1408)
- **YouTube link**: bottone "▶ YouTube" nella topbar, visibile solo se il video_id ha un URL nel CSV. Si popola automaticamente all'avvio, appare appena si carica il video.
- **How/Why clauses**: pills arancioni (↳ how) e viola (✦ why) sotto ogni narration che ha un'entry nei JSON VQA `fine_grained_how/why_recognition.json`. Match per video_id + overlap temporale (±1s). Copertura sparsa (~500 entry how + 500 why su 156 video).
- **Activity segments**: tutti i 9 CSV `high-level/activities/P0X_recipe_timestamps.csv` caricati in parallelo all'avvio → `allActivityData`. Corsia viola in cima alla timeline (sopra step/narration/audio). Label corrente mostrata in `step-context` come "Attività · Fase". Gestisce `end_time = "end"` come ∞. Implementazione: `getActivityAt()`, `allActivityData`, `activitySegments`.
- **Nutritional live tracker**: pannello `#nutrition-panel` (tra recipe e VQA). Barra calorie + 3 mini-barre macro (Protein/Carbs/Fat) + lista ingredienti con ✓ tick. Timestamp `add` primario, `weigh` fallback. Gestisce ricette senza calorie e senza timestamp con messaggi informativi.
- **Pannello SLAM 3D integrato** (`#slam-host` sotto il video, 32vh): scena three.js sincronizzata col playback. Importa `./slam-viewer.js` dinamicamente; carica `../output/slam_<video_id>.json` + `../output/<P>_final.glb`. Su 404 mostra placeholder "No SLAM data for {video_id}". Toggle "3D" in topbar (stato in `localStorage`). Sync via `setTime(vid.currentTime)` in `timeupdate` e nel mask rAF loop. Vedi `initSlamForVideo()` in `viewer.js`.

### Note tecniche bbox overlay
- FPS assunto 30 (Aria glasses), finestra ±15 frame
- Coordinate bbox in spazio pixel originale (1408×1408) → scalate al display via `vid.getBoundingClientRect()`
- Canvas `#bbox-canvas` sovrapposto al video con z-index:2 (sotto audio HUD)
- Etichette: da `assoc_info.json` (nome oggetto) con fallback al nome fixture senza prefisso partecipante

### Hand mask overlay (completato 27 aprile 2026) — ✅ FUNZIONA

#### Architettura attuale
- **Pre-estrazione offline**: `python3 extract_hand_masks.py P01-20240204-152537` → genera `hand-masks/{video_id}.json` (~12 MB)
  - Formato: `{"frame": {"l": "coco_rle_string", "r": "coco_rle_string"}, ...}` (solo frame non vuoti, chiavi corte)
  - Il file per P01-20240204-152537 è già estratto in `hand-masks/`
- **Auto-load**: `loadHandMasks(videoId)` usa `res.json()` diretto (NON parseInWorker)
- **Rendering**: `applyRLEToBuffer()` → `_handImgData` (buffer 1408×1408×4 riusato) → `putImageData` → `drawImage` su `bboxCtx`
- **Sync**: loop `requestAnimationFrame` durante il playback (non `timeupdate` che è solo ~4 Hz); frame-skip cache (`_lastHandFrame`) evita re-decode RLE se il frame video non cambia

#### Bug risolti (storia)
1. **Video freeze da structured clone**: `parseInWorker` mandava 12.7 MB via structured clone → blocco 1-2s. **Fix**: `res.json()` diretto.
2. **Freeze da canvas API**: `ctx.rect()` su 1M pixel foreground per frame → freeze totale. **Fix**: approccio ImageData (~9ms/frame su frame densi).
3. **Bande verticali invece di sagome**: decoder COCO RLE (`decodeRLECounts`) aveva `more = true` dopo la sign-extension → consumava il primo byte del count successivo, corrompendo tutti i run-length. **Fix**: rimosso `more = true` (una riga).
4. **Mask non sincronizzata col video**: `timeupdate` scatta ~4 Hz, video a 30 FPS → mask "salta" ogni ~8 frame. **Fix**: rAF loop durante playback.

#### TODO (bloccato da permessi di scrittura — da fare quando disponibili)
**Estrazione on-the-fly**: eliminare il pre-processing offline. Il viewer dovrebbe leggere direttamente da `contours_preds.zip` senza creare file intermedi. Richiede un endpoint API in `serve_viewer.py` (es. `GET /hand-masks/{video_id}/{frame}` o `/hand-masks/{video_id}`) che legge il zip HPC al volo e restituisce il JSON compatto. Attualmente bloccato: permessi di scrittura non disponibili per salvare i JSON estratti in `hand-masks/`.

### Cosa c'è già nel viewer 3D SLAM (`view_slam_3d.py`)
- Traiettoria SLAM + cono di visione quaternionico
- Gaze priming (sfere giallo/ciano)
- **Sfere verdi animate** per oggetti manipolati nel video: una sfera per oggetto in `assoc_info.json`, posizione interpolata tra le mask in `mask_info.json` (vedi §7 "Fatto 30 aprile"). Hidden quando `t` è fuori da tutti i `time_segment` dell'oggetto.
- **Frecce di movimento** colorate per oggetto: una `ArrowHelper` per ogni track con label `"{name}: {fixture_start} → {fixture_end}"`. Default: filtro temporale; toggle `all at once` per overview completa.
- Layer toggle per ogni layer

### Visualizzazioni 3D aggiuntive fattibili (ispirate al paper CVPR 2025)

Il paper HD-EPIC mostra una figura "Digital twin: Scene & Object Movements" con 4 layer sovrapposti nella stessa scena 3D. Tutti i dati necessari sono disponibili:

| Layer | Dati | Implementazione |
|---|---|---|
| **Point cloud** | `semidense_points.csv.gz` (HPC, 46 MB gzip) — colonne `px_world, py_world, pz_world` in world space | `THREE.Points` subsampliato, stesso transform SLAM `(x,y,z)→(x,z,-y)` |
| **Surface mesh** | GLB da `.blend` | ✅ già presente |
| **Frecce movimento oggetti** | `assoc_info.json` + `mask_info.json` | ✅ **FATTO** (30 aprile) — `THREE.ArrowHelper` tra `3d_location` prima/ultima mask di ogni track, colorate per nome, filtrate per `time_segment` |
| **Sagome 3D oggetti** | "37K object masks lifted to 3D" — **non in nostra copia locale** | ❌ non disponibile |

#### Come costruire le frecce di movimento

```python
# Per ogni oggetto in assoc_info[video_id]:
#   Per ogni track dell'oggetto:
#     start_loc = mask_info[video_id][track.masks[0]]['3d_location']
#     end_loc   = mask_info[video_id][track.masks[-1]]['3d_location']
#     fixture_start = mask_info[video_id][track.masks[0]]['fixture']
#     fixture_end   = mask_info[video_id][track.masks[-1]]['fixture']
#   → ArrowHelper da start_loc a end_loc, colorato per oggetto
#   → Label: "{obj.name}: {fixture_start} → {fixture_end}"
#   → Filtrabile per time_segment (mostra solo se nel range temporale corrente)
```

Esempio reale (P01-20240202-110250, "juicer bowl"):
- `mask_info[masks[0]]` → fixture `P01_counter.008`, 3d `[-1.64, -2.85, -0.44]`
- `mask_info[masks[-1]]` → fixture `P01_counter.004`, 3d `[-0.16, -3.88, -0.52]`

- **VQA panel** (#7): panel `#vqa-panel` tra step-context e search. Carica **tutti i 30 file JSON** della vqa-benchmark (~28 MB totali; i grandi sono `fine_grained_action_recognition` 14 MB e `fine_grained_action_localization` 9 MB; gli altri 28 file <1MB ciascuno) — tutti parsati in Web Worker quindi non bloccano il main thread. `VQA_CATEGORIES` mappa ogni nome-file (= category) a `{label, color, text}` raggruppato per famiglia (slate=3D, viola/indigo=fine-grained, cyan/amber=gaze, verde=ingredient, rosso=nutrition, arancio=object motion, rosa/magenta=recipe). `vqaFiles` è derivato automaticamente da `Object.keys(VQA_CATEGORIES)` → aggiungere una categoria = una sola riga. Lookup `vqaLookup` per video_id. `renderVqaList()` mostra una riga di chip-counter **sticky** in cima al pannello (`vqa-counts`, sotto l'header sticky a top:0) con il numero di domande per categoria nel video corrente, ordinato per frequenza. I chip sono **toggleable**: click per nascondere/mostrare la categoria; stato persistito in `localStorage` (chiave `vqaHiddenCats`); **default al primo avvio: tutte off** → l'utente sceglie cosa attivare. `renderVqaPanel(t)` nel tick `timeupdate` evidenzia la card attiva (skippa quelle nascoste per lo scroll auto). Risposta corretta evidenziata in verde (✓). `cleanVqaText()` preserva l'orario dei tag `<TIME ...>` (necessario per `Action localization`/`Step when` dove le choices sono timestamp candidati), sostituisce `<BBOX>` con `[object]`.

- **Resize handles tra i pannelli**: 5 maniglie draggabili tra i pannelli principali, gestite da `makeResizable({handle, target, dir, sign, min, key, onResize})` in `viewer.js`. Ogni handle modifica una CSS variable (`--rsz-w` per orizzontali, `--rsz-h` per verticali) sul pannello-target inline → il `flex: 0 0 var(--rsz-h, default)` reagisce, mentre il collapse (`flex: 0 0 auto`) continua a sovrascriverlo perché ha specificità maggiore. Dimensione salvata in `localStorage` (chiavi `rsz_*`). Maniglie:
  - `rsz-video-annot` (h-h): video-panel ↔ annot-panel — drag dx = video più largo
  - `rsz-video-slam` (h-v): video-wrap ↔ slam-host — drag giù = slam più piccolo; al drag chiama `currentSlam.resize()` per ridimensionare il canvas Three.js
  - `rsz-nar-rec` (h-v): narrations ↔ recipe — drag giù = recipe più piccolo
  - `rsz-rec-nut` (h-v): recipe ↔ nutrition — drag giù = nutrition più piccolo
  - `rsz-nut-vqa` (h-v): nutrition ↔ vqa — drag giù = vqa più piccolo
  Le maniglie su pannelli condizionali (nutrition/vqa) sono nascoste via CSS `:has()` quando il pannello non ha la classe `.has-nutrition`/`.has-questions`. Quella video-slam è nascosta quando `body.no-slam`.

### Cosa NON c'è ancora
- **Hand mask on-the-fly** — attualmente richiede pre-estrazione offline (`extract_hand_masks.py`); bloccato da permessi di scrittura su HPC (vedi TODO in §7)
- **Hands badge** su ogni narration — poco informativo
- **Object movements in timeline** — `assoc_info.json` ha segmenti temporali; 34 oggetti per video, ogni oggetto con 1+ track `[start, end]`
- **Nutritional live tracker** — ✅ **FATTO** (29 aprile, vedi §7)
- **Frecce movimento oggetti nel viewer SLAM 3D** — ✅ **FATTO** (30 aprile, vedi §7)
- **Integrazione viewer SLAM nel viewer HTML come pannello** — ✅ **FATTO** (18 maggio, vedi §7)
- **Allineamento temporale preciso video ↔ SLAM** — ✅ **FATTO** (18 maggio, vedi §7)
- **Object trajectory smoothing tramite hand tracking** — invece di interpolare lineare nel mondo tra due mask, agganciare l'oggetto al palmo (`wrist_and_palm_poses.csv` HPC) durante il volo. Migliora la fedeltà al video reale, dove gli oggetti seguono archi non rette.
- **Eye gaze per-frame** nel viewer SLAM integrato — ⚠️ **IMPLEMENTATO CON CALIBRAZIONE REALE, MA CON BUG NOTO DI ASPECT RATIO**: vedi §7 "Fatto 20 maggio" e §9 per tutti i dettagli. Il 3D ray e il 2D dot usano ora le matrici di calibrazione estratte dal VRS tramite `projectaria_tools`. Il problema residuo è che il dot assume che il `<video>` mostri l'immagine senza bande nere (letterbox/pillarbox); se il video element ha aspect ratio diversa da 1:1 il dot è proiettato male. Fix documentato in §9.
- **P08 SLAM data** — 12 sessioni con dati ancora compressi in `SLAM-and-Gaze/P08/SLAM/multi/*.zip` (le directory estratte `multi/0/`, `multi/1/`, ... sono vuote). HPC read-only quindi non scompattabili lì. Per averli nel viewer integrato: leggere on-the-fly dal `.zip` con `zipfile` in `load_trajectory()`, oppure estrarre selettivamente i `closed_loop_trajectory.csv` (~760 MB totali) in una cartella locale e aggiungere un fallback path. Tutti gli altri partecipanti coperti (141 JSON su 156, 90%).

## 9. Calibrazione gaze Aria — dati di riferimento (20 maggio 2026)

### Come ricavare i dati (richiede env `thesis310` + `projectaria_tools`)

```python
from projectaria_tools.core import data_provider
import numpy as np

provider = data_provider.create_vrs_data_provider(
    '/mnt/bocconi_hpc_video_datasets/HD-EPIC/VRS/P01/P01-20240204-095114_anonymized.vrs')
calib = provider.get_device_calibration()
rgb = calib.get_camera_calib('camera-rgb')

# R_device_cpf
print(calib.get_transform_device_cpf().to_matrix())
# RGB intrinsics
print('focal_lengths:', rgb.get_focal_lengths())    # → [607.21, 607.21]
print('principal_point:', rgb.get_principal_point()) # → [713.21, 704.35]
print('image_size:', rgb.get_image_size())           # → [1408, 1408]
# T_device_camera
print(rgb.get_transform_device_camera().to_matrix())
```

### Valori ricavati da P01-20240204-095114

**T_device_cpf** (CPF → device):
```
R_device_cpf = [[-0.0319, -0.9986, -0.0415],
                [ 0.7934,  0.0000, -0.6088],
                [ 0.6079, -0.0523,  0.7923]]
```
CPF +Z (forward gaze) = (-0.04, -0.61, 0.79) in device → ~37° verso destra dell'asse SLAM left-camera. Spiega perché HEAD_YAW_CORRECTION era −40°.

**RGB camera** — modello FISHEYE624, 1408×1408:
- `focal_length = 607.21 px` (fisheye equidistant, NON pinhole)
- `principal_point = (713.21, 704.35) px`

**T_device_camera** (RGB cam → device):
```
R_device_camera = [[ 0.9950, -0.0419,  0.0911],
                   [ 0.0893,  0.7828, -0.6159],
                   [-0.0455,  0.6209,  0.7826]]
```

### Matrici precompute usate nel codice JS

**`_R_LC`** in `slam-viewer.js` — CPF → headGroup local frame (Three.js):
```
_R_LC = [[-0.7934,  0.0000,  0.6088],   # = -R_device_cpf row 1
         [ 0.6079, -0.0523,  0.7923],   # =  R_device_cpf row 2
         [ 0.0319,  0.9986,  0.0415]]   # = -R_device_cpf row 0
```
Derive: `R_LOCAL = [[0,-1,0],[0,0,1],[-1,0,0]]` (device→local: local=(-dev_Y, dev_Z, -dev_X)), poi `_R_LC = R_LOCAL * R_device_cpf`.

**`_R_CAM_CPF`** in `viewer.js` — CPF → camera raw sensor frame:
```
_R_CAM_CPF = [[ 0.0114, -0.9912, -0.1317],
              [ 0.9997,  0.0094,  0.0173],
              [-0.0160, -0.1319,  0.9912]]
```
Derive: `_R_CAM_CPF = R_device_camera.T * R_device_cpf`.

### Rotazione 90° CW del sensore Aria RGB — verifica ground truth

Comando di verifica (usare env `thesis310`):
```python
python3 -c "
import numpy as np
from projectaria_tools.core import data_provider
provider = data_provider.create_vrs_data_provider(
    '/mnt/bocconi_hpc_video_datasets/HD-EPIC/VRS/P01/P01-20240204-095114_anonymized.vrs')
calib = provider.get_device_calibration()
rgb = calib.get_camera_calib('camera-rgb')
R = rgb.get_transform_device_camera().to_matrix()[:3,:3].T @ calib.get_transform_device_cpf().to_matrix()[:3,:3]
for name, d in [
    ('forward',    [0,0,1]), ('left yaw+0.3', [np.sin(0.3),0,np.cos(0.3)]),
    ('right yaw-0.3', [-np.sin(0.3),0,np.cos(0.3)]),
    ('up pitch+0.3',  [0,np.sin(0.3),np.cos(0.3)]),
    ('down pitch-0.3',[0,-np.sin(0.3),np.cos(0.3)]),
]:
    px = rgb.project(R @ np.array(d,float))
    print(f'{name:20s} -> ({px[0]:.1f}, {px[1]:.1f})')
" 2>/dev/null
```

Risultati attesi (P01, verificati 20 maggio 2026):
```
forward              -> (632.4, 714.8)   # leggermente off-center
left   yaw+0.3       -> (634.2, 905.4)   # v AUMENTA → yaw+ = v-axis display
right  yaw-0.3       -> (630.6, 526.0)   # v diminuisce
up     pitch+0.3     -> (434.6, 717.0)   # u DIMINUISCE → pitch+ = -u-axis display
down   pitch-0.3     -> (816.3, 712.7)   # u aumenta
```

Trasformazione raw sensor (u,v) → NDC display:
```
ndcX = 0.5 - v / 1408   (v raw = asse orizzontale display, flippato)
ndcY = u / 1408 - 0.5   (u raw = asse verticale display)
```

### Convenzione CPF (verificata)
- **+X = LEFT** del portatore (vergenza: right_yaw > left_yaw per target frontale)
- **+Y = UP**
- **+Z = FORWARD**
- Formula direzione: `d_cpf = (sin(yaw)*cos(p), sin(p), cos(yaw)*cos(p))`
- `yaw+` = guardare a SINISTRA, `pitch+` = guardare in ALTO
- Media pitch ≈ −0.17 rad (persona guarda il bancone → leggermente in basso)

### Aria device frame (derivato da gravity nel CSV SLAM)
- `+X = DOWN` (verso il mento)
- `+Y = LEFT` (uscendo dall'orecchio sinistro)
- `+Z = FORWARD` (asse ottico SLAM left camera)

---

## 8. Comandi utili

```bash
# Viewer annotazioni — nuovo (auto-load + split)
python3 serve_viewer.py            # apre http://localhost:PORT/viewer/
python3 serve_viewer.py --port 8080

# Hand mask overlay — estrarre JSON per un video (da fare una volta per video)
python3 extract_hand_masks.py P01-20240204-152537
python3 extract_hand_masks.py all   # tutti i 156 video (~2 GB, ~30 min)

# SLAM viewer — comando principale (genera HTML standalone, apre browser)
python3 view_slam_3d.py --participant P01 --session 0

# Export JSON dati SLAM per integrazione nel viewer principale (no HTML, no browser)
python3 view_slam_3d.py --participant P01 --session 0 --export-only
# → output/slam_<video_id>.json + output/PXX_final.glb

# Batch: tutte le session di un partecipante (implica --export-only)
python3 view_slam_3d.py --participant P01 --all-videos
# Iterazione su tutti i video del participant; salta quelli senza SLAM CSV.

# Batch totale: tutti i partecipanti P01-P09 (~30-50 min, primo run esporta i GLB via Blender)
for p in P01 P02 P03 P04 P05 P06 P07 P08 P09; do
  python3 view_slam_3d.py --participant "$p" --all-videos
done 2>&1 | tee /tmp/slam_batch.log
grep '\[align\]' /tmp/slam_batch.log   # spot-check offset video↔SLAM per ogni sessione

# Altre sessioni / partecipanti
python3 view_slam_3d.py --participant P02 --session 0
python3 view_slam_3d.py --participant P01 --session 5

# Solo cucina 3D (script separato, non toccare)
python3 view_kitchen_3d.py /mnt/bocconi_hpc_video_datasets/HD-EPIC/Digital-Twin/blenders/P01_final.blend --force

# Ispezionare assoc_info velocemente
python3 -c "import json; d=json.load(open('scene-and-object-movements/assoc_info.json')); print(list(d['P01-20240202-110250'].items())[:2])"

# Contare sessioni SLAM per P01 (→ 56)
ls /mnt/bocconi_hpc_video_datasets/HD-EPIC/SLAM-and-Gaze/P01/SLAM/multi/ | wc -l

# Preview camera trajectory
head -3 /mnt/bocconi_hpc_video_datasets/HD-EPIC/SLAM-and-Gaze/P01/SLAM/multi/0/slam/closed_loop_trajectory.csv
```
