# HD-EPIC Annotation Viewer — Contesto sessione di lavoro
> Aggiornato: 24 aprile 2026 (in uni, dataset HPC montato in read-only).

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
| 2 | **Auto-detect ricetta** dal video ID caricato | Piccolo | `high-level/activities/P0X_recipe_timestamps.csv` | ✅ |
| 3 | **YouTube link** auto (bottone "Open on YouTube") | Minimo | `youtube-links/HD_EPIC_YouTube_URLs.csv` | ✅ |
| 4 | **Object movements** in timeline + lista | Medio | `scene-and-object-movements/assoc_info.json` | ✅ |
| 5 | **"How/Why" clauses** su ogni narration | Medio | `fine_grained_how/why_recognition.json` | ✅ |
| 6 | **Nutritional live tracker** (calorie nel tempo) | Medio | `complete_recipes.json` | ✅ |
| 7 | **VQA panel** — domande al timestamp corrente | Medio | tutti i VQA JSON | ✅ |
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

## 7. Stato lavori al 24 aprile 2026

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

### Note tecniche bbox overlay
- FPS assunto 30 (Aria glasses), finestra ±15 frame
- Coordinate bbox in spazio pixel originale (1408×1408) → scalate al display via `vid.getBoundingClientRect()`
- Canvas `#bbox-canvas` sovrapposto al video con z-index:2 (sotto audio HUD)
- Etichette: da `assoc_info.json` (nome oggetto) con fallback al nome fixture senza prefisso partecipante

### Hand mask overlay (aggiunto 27 aprile 2026) — **WIP, rendering errato**

#### Cosa è stato fatto
- **Script di estrazione**: `python3 extract_hand_masks.py P01-20240204-152537` → genera `hand-masks/{video_id}.json` (~12 MB)
  - Formato: `{"frame": {"l": "coco_rle_string", "r": "coco_rle_string"}, ...}` (solo frame non vuoti, chiavi corte)
  - Il file per P01-20240204-152537 è già estratto in `hand-masks/`
- **Auto-load**: `loadHandMasks(videoId)` usa `res.json()` diretto (NON parseInWorker — vedere sotto)
- **Rendering**: `applyRLEToBuffer()` → `_handImgData` (buffer 1408×1408×4 riusato) → `putImageData` → `drawImage` su `bboxCtx`

#### Bug risolti durante lo sviluppo
1. **Video freeze da structured clone**: primo tentativo usava `parseInWorker` che mandava il JSON parsato (12.7 MB, 10.963 chiavi) dal worker al main thread via structured clone → blocco di 1-2s. **Fix**: `res.json()` diretto.
2. **Freeze da canvas API**: secondo tentativo usava `ctx.rect()` per ogni pixel foreground — alcuni frame hanno **1 milione** di pixel foreground (maschere piene, non contorni come si credeva). 1M chiamate `rect()` per frame → freeze totale. **Fix**: approccio ImageData (buffer in RAM, 9ms/frame su frame densi).

#### Stato attuale: funziona senza freeze, ma il rendering è ERRATO
- Il video non si blocca più
- Vengono visualizzate **bande verticali** più o meno dense (blu/rosse), non sagome di mani
- **Causa probabile**: bug nel decoder COCO RLE o nella mappatura colonna-maggiore → riga-maggiore per ImageData
  - Il decoder `decodeRLECounts()` produce valori negativi per alcuni run (confermato, gestito con `while (run-- > 0)`)
  - La mappatura pixel: `col-major index i → col = i÷H, row = i%H` → `buf[(row*W + col)*4]`
  - Le bande verticali suggeriscono che la dimensione usata per H e W potrebbe essere invertita, oppure che la struttura dati del JSON ha un problema di ordinamento
- **Da investigare nella prossima sessione**:
  1. Verificare con pycocotools che il decoder JS produca la stessa maschera
  2. Controllare se H e W sono nell'ordine giusto (`size = [H, W] = [1408, 1408]` — in questo caso sono uguali, ma la formula `col = flat_idx ÷ H` va verificata)
  3. Eventualmente: usare pycocotools in Python per pre-decodificare un frame campione e confrontare pixel per pixel

### Cosa c'è già nel viewer 3D SLAM (`view_slam_3d.py`)
- Traiettoria SLAM + cono di visione quaternionico
- Gaze priming (sfere giallo/ciano)
- **Sfere verdi** per oggetti manipolati nel video (da `mask_info.json`, posizione mediana 3D, etichetta CSS2D)
- Layer toggle per ogni layer

### Cosa NON c'è ancora
- **Hand mask overlay "piena"** — i dati in `contours_preds.zip` sono contorni (pochi pixel), non maschere piene. Per maschere piene bisognerebbe flood-fill in JS (non implementato)
- **Hands badge** su ogni narration — poco informativo
- **Ingredienti con timestamp** (add/weigh)
- **Nutritional live tracker** — calorie accumulate nel tempo
- **Object movements in timeline** — `assoc_info.json` ha segmenti temporali
- **How/Why clauses** su ogni narration — dai JSON VQA
- **VQA panel** — domande attive al timestamp corrente
- **Integrazione viewer SLAM** nel viewer HTML come pannello
- **Eye gaze per-frame** nel viewer SLAM (da `general_eye_gaze.csv`, richiede allineamento temporale)

## 8. Comandi utili

```bash
# Viewer annotazioni — nuovo (auto-load + split)
python3 serve_viewer.py            # apre http://localhost:PORT/viewer/
python3 serve_viewer.py --port 8080

# Hand mask overlay — estrarre JSON per un video (da fare una volta per video)
python3 extract_hand_masks.py P01-20240204-152537
python3 extract_hand_masks.py all   # tutti i 156 video (~2 GB, ~30 min)

# SLAM viewer — comando principale
python3 view_slam_3d.py --participant P01 --session 0

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
