# Piano: integrazione viewer SLAM 3D nel viewer HTML

> Creato: 30 aprile 2026
> Stato: pianificato — non iniziato
> Stima complessiva: 3 sessioni di lavoro (~6-8 ore)

---

## 1. Obiettivo

Far convivere nel **viewer principale** (`viewer/index.html`, lanciato da `serve_viewer.py`) il pannello 3D SLAM oggi standalone in `view_slam_3d.py`. Il video MP4 sulla sinistra deve guidare la testa-camera, le sfere oggetto e le frecce nello scene 3D.

### Cosa NON facciamo (per evitare scope creep)
- ❌ Non aggiungiamo features nuove al viewer SLAM (gaze ray frame-by-frame, point cloud semidense, ecc.) — solo integrazione.
- ❌ Non risolviamo l'allineamento temporale fine in questo piano (vedi §7 caveat di CLAUDE.md). Si fa **dopo** averlo visto sul video integrato.
- ❌ Non riscriviamo `view_slam_3d.py` da zero. Resta funzionante come tool standalone.
- ❌ Non supportiamo browser ≠ Chromium. Firefox già notoriamente problematico col video.

---

## 2. Stato attuale (snapshot)

### `viewer/index.html` (77 righe)
- Layout: `#topbar` + `#main` con flex-row → `#video-panel` (50%) | `#annot-panel` (50%)
- `#video-panel` contiene `<video id="vid">`, `<canvas id="bbox-canvas">` (overlay mani+bbox), `#audio-hud`, `#timeline-wrap`
- `#annot-panel` contiene narrations, recipe, nutrition, VQA panels

### `viewer/viewer.js` (1560 righe)
- Stato globale `currentVideoId` (riga 46) impostato da `extractVideoId()` quando si carica un video
- **Tick centrale**: `vid.addEventListener('timeupdate')` riga 1272 → chiama tutti i renderer dipendenti dal tempo
- **Loading pattern**: `autoLoadDefaults()` riga 1424 carica tutti i JSON al boot via Web Worker (`csv-worker.js`)
- **rAF parallelo** per le hand mask durante playback (~30 Hz vs 4 Hz di `timeupdate`)

### `view_slam_3d.py` (HTML template ~640 righe + Python helpers)
- Carica trajectory CSV (HPC) + gaze priming + mask_info → genera HTML standalone con DATA blob `<script type="application/json">`
- Three.js scene con: traiettoria, head+gaze cone, gaze priming, sfere oggetti animate, frecce
- Timeline propria (slider, play/pause, speed) + setHeadAtTime() + animate() loop
- Già commentato per integrazione: «*In the integrated viewer, receive this from outside instead of parsing here*»

### `serve_viewer.py`
- Serve l'intera repo root su `localhost:PORT`. Apre `localhost:PORT/viewer/`.
- Path relativi `../output/PXX_final.glb` accessibili dal viewer.

---

## 3. Decisioni di design

### D1. Approccio embed: **modulo JS condiviso** (non iframe, non inline)
Estraiamo la logica three.js in `viewer/slam-viewer.js` come modulo ES con API:
```js
import { initSlamViewer } from './slam-viewer.js';
const slam = await initSlamViewer({
  container: document.getElementById('slam-host'),
  glbUrl:    '../output/P01_final.glb',
  dataUrl:   '../output/slam_P01-20240202-110250.json',
});
slam.setTime(videoTimeSeconds);   // chiamato dal tick del video
slam.destroy();                    // quando si cambia video
slam.setLayerVisible('movements', false);
```
**Motivo**: stato condiviso col viewer, no overhead cross-frame, performante. Costa il refactor di `view_slam_3d.py` (rimane standalone ma usando lo stesso modulo).

### D2. Pre-export dei dati SLAM (offline)
I CSV SLAM sono sull'HPC (~50-100 MB/sessione). Non li scarichiamo runtime. Pre-generiamo:
- `output/PXX_final.glb` (già esiste per P01)
- `output/slam_<video_id>.json` — stessa struttura del DATA blob attuale, ~10-200 KB

Aggiungiamo a `view_slam_3d.py` un flag `--export-only` che salta la generazione HTML e produce solo i due file. Poi `--all-videos-of P01` per il batch participant.

### D3. Layout: **split verticale dentro `#video-panel`**
Sopra: video. Sotto: scene 3D (ridimensionabile o toggleabile).
- Pro: video e 3D contemporanei, è il punto di tutto.
- Pro: non tocchiamo `#annot-panel`.
- Contro: schermi piccoli ridotti. Mitigazione: toggle "hide 3D" che restituisce 100% al video.

### D4. Sincronizzazione tempo
Master = `vid.currentTime` (secondi video). Nel tick `timeupdate` (e nel rAF di mask quando attivo) chiamiamo `slam.setTime(t)`. Conversione interna: `tracking_us = T0 + t * 1e6` (offset=0 per ora — fix successivo).

### D5. Cambio video
Quando `currentVideoId` cambia:
1. `slam.destroy()` (cleanup three.js, geometrie, listener)
2. Se esiste `output/slam_<new_id>.json` → reinit. Altrimenti mostra placeholder "No SLAM data for this video"
3. Se cambia anche participant → re-fetch del GLB; altrimenti riusa il GLB già caricato (cache in memoria)

### D6. Performance
- Single rAF master in `viewer.js` che orchestra tutto (mask + slam + bbox). Niente rAF doppi.
- Toggle "Disable 3D" per chi ha hardware modesto, persistito in localStorage.
- Init lazy: lo scene three.js si crea solo quando il pannello è effettivamente visibile.

---

## 4. Fasi di implementazione (sessioni separate)

### **Fase 1 — Pre-export & infrastruttura dati** (1 sessione, ~2 ore) — ✅ FATTO 30 aprile

**Scope**: produrre i file `slam_<video_id>.json` e GLB on-demand, senza toccare ancora il viewer HTML.

**Task**:
1. ✅ Refactor `view_slam_3d.py`:
   - `build_data_json()` esteso con parametro opzionale `glb_name` → il blob include `glb` quando serve al consumer JS.
   - Flag `--export-only` aggiunto: salva `output/slam_<video_id>.json` (compatto, ~20 KB sul test) e GLB, poi exit.
2. ✅ Flag `--all-videos` aggiunto (richiede `--participant`, implica `--export-only`). Funzione `run_batch_export()` itera tutti gli MP4 del participant in `Videos/PXX/`, mappa session=indice ordinato; salta sessioni senza SLAM CSV.
3. ✅ Smoke test: build sintetico di un trajectory CSV minimo + load di gaze/objects/movements reali → verifica che il JSON ha tutti i campi attesi (`participant, video_id, glb, duration_s, trajectory, gaze (64 events), objects (34), movements (50)`). Standalone HTML flow non regredito.

**Deliverable**:
- ✅ `view_slam_3d.py` con due nuovi flag e funzione `run_batch_export`
- ⏳ `output/slam_*.json` da generare con HPC montato (`python3 view_slam_3d.py --participant P01 --all-videos`)
- ✅ Documentazione comandi in CLAUDE.md §8

**Done quando**:
- [x] `python3 view_slam_3d.py --participant P01 --session 0 --export-only` flow validato (verificato in test sintetico; richiede HPC per il run reale)
- [x] `view_slam_3d.py` standalone continua a funzionare senza regressioni

---

### **Fase 2 — Modulo `slam-viewer.js` riusabile** (1 sessione, ~3 ore)

**Scope**: estrarre la logica three.js in un modulo ES importabile, isolato, testabile a parte.

**Task**:
1. Crea `viewer/slam-viewer.js` esportando `initSlamViewer({container, glbUrl, dataUrl, options})`.
   - All'interno: tutta la logica oggi nel `<script type="module">` di `view_slam_3d.py` (s2t, slamQuatToThree, setHeadAtTime, objectPositionAt, updateMovementVisibility…)
   - API ritornata: `{ setTime(t_video_s), destroy(), setLayerVisible(name, bool), getCameraControls() }`
   - Tutto lo stato è scoped nella closure, niente global pollution.
2. Crea `viewer/slam-viewer.css` con i selettori specifici (`.obj-label`, `.mov-label`, `#slam-info-panel`, `#slam-layer-panel`).
3. Test isolato: piccola pagina `viewer/slam-test.html` che monta solo il modulo con dati hardcoded. Verifica che funzioni senza il viewer principale.
4. Aggiorna `view_slam_3d.py` per generare un HTML che importa il modulo invece di duplicare il codice (così il refactor si valida sull'uso standalone esistente).

**Deliverable**:
- `viewer/slam-viewer.js` (~600-800 righe stimate)
- `viewer/slam-viewer.css`
- `viewer/slam-test.html` (smoke test)
- `view_slam_3d.py` aggiornato per usare il modulo

**Done quando**:
- [ ] `slam-test.html` carica e mostra la scena 3D correttamente
- [ ] `view_slam_3d.py --participant P01 --session 0` continua a funzionare e mostra lo stesso risultato di prima
- [ ] Nessun warning console, nessun memory leak su destroy/reinit

---

### **Fase 3 — Integrazione nel viewer principale** (1 sessione, ~2-3 ore)

**Scope**: incorporare il pannello SLAM in `viewer/index.html`, sincronizzato col video.

**Task**:
1. **HTML**: aggiungi in `#video-panel` un `<div id="slam-host">` sotto il video (e sopra `#timeline-wrap` o in fondo, da decidere visivamente).
2. **CSS**: split verticale `#video-panel` → video (60%?) + slam (40%?) flex-direction:column. Toggle `body.no-slam` che nasconde il pannello e restituisce flex:1 al video.
3. **JS in `viewer.js`**:
   - Importa `initSlamViewer` da `./slam-viewer.js`
   - Stato globale `currentSlam` (handle del modulo o null)
   - Funzione `(re)initSlam(videoId)`: distrugge il precedente, fetcha JSON e GLB se esistono, inizializza
   - Chiamata da: dentro `extractVideoId` flow + `autoLoadDefaults`
   - Nel tick `timeupdate`: `if (currentSlam) currentSlam.setTime(vid.currentTime)`
   - Nel rAF di mask (riga 1287): stessa chiamata per smoothness durante playback
   - Toggle button "3D on/off" nella topbar, persistito in localStorage
4. Gestione errori: se il JSON SLAM manca per quel video_id, mostra placeholder dentro `#slam-host` invece di rompere.
5. Smoke test: load video P01-20240202-110250, verifica che la testa-camera segua il video, che le sfere si muovano coerentemente.

**Deliverable**:
- `viewer/index.html` con `#slam-host`
- `viewer/style.css` con split layout
- `viewer/viewer.js` con sync logic
- README/CLAUDE.md aggiornato

**Done quando**:
- [ ] Caricato un video con dati SLAM, il pannello 3D appare e si sincronizza col playback
- [ ] Cambiando video, lo scene si re-inizializza correttamente (no leak, no crash)
- [ ] Caricando un video senza dati SLAM, il pannello mostra placeholder invece di rompersi
- [ ] Toggle "3D on/off" funziona e persiste tra reload
- [ ] Performance accettabile su Chromium (no stutter del video)

---

## 5. Rischi e mitigazioni

| # | Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|---|
| R1 | Stutter video con three.js attivo | Medio | Alto | Single rAF master, toggle off, profiling con DevTools Performance |
| R2 | GLB grosso lento da fetchare | Basso | Medio | Pre-export tutti i GLB participant, caching in-memory in slam-viewer.js |
| R3 | Disallineamento temporale visibile | Alto | Medio | È un caveat noto. Si risolve in un fix successivo col CSV `mp4_to_vrs_time_ns`. |
| R4 | Modulo ES `import` non funziona file:// | Basso | Alto | Usiamo già `serve_viewer.py` (HTTP), il problema non si presenta. Documentiamolo. |
| R5 | Refactor di `view_slam_3d.py` rompe lo standalone | Medio | Basso | Mantenere il standalone come consumer del modulo nuovo: se funziona standalone, funziona ovunque. |
| R6 | Three.js + OrbitControls cattura eventi mouse anche fuori dal pannello | Basso | Medio | Limitare `controls.domElement` al `#slam-host`, non al `window` |

---

## 6. TODO post-MVP (esplicitamente rimandati)

Non da fare in queste 3 sessioni, ma da tenere in mente:

- **Allineamento temporale fine** via `Videos/PXX/{video_id}_mp4_to_vrs_time_ns.csv` (30 min, dopo aver visto il sfasamento)
- **Smoothing oggetti via hand tracking** (`wrist_and_palm_poses.csv`)
- **Eye gaze per-frame ray** sovrapposto alla scena 3D
- **Point cloud semidense** come layer aggiuntivo (`semidense_points.csv.gz`)
- **Multi-session per partecipante**: oggi fissiamo `--session 0`. Un partecipante ha N session = N video. Potrebbe servire un selettore.
- **Caching server-side** dei JSON SLAM (oggi vengono ri-fetchati ad ogni cambio video)

---

## 7. Convenzioni e file toccati per fase

| Fase | File creati | File modificati |
|---|---|---|
| 1 | `output/slam_*.json` | `view_slam_3d.py` |
| 2 | `viewer/slam-viewer.js`, `viewer/slam-viewer.css`, `viewer/slam-test.html` | `view_slam_3d.py` |
| 3 | — | `viewer/index.html`, `viewer/style.css`, `viewer/viewer.js`, `CLAUDE.md` |

---

## 8. Domande aperte (da risolvere prima/durante)

- **Q1**: Il GLB `output/P01_final.glb` esistente è OK? Geometria-only senza materiali (vedi note tecniche in CLAUDE.md §3). Per ora **sì basta**, materiali vengono dopo.
- **Q2**: Layout finale del pannello SLAM — quanto alto di default? Suggerisco 40% del `#video-panel` ma da rivedere visivamente.
- **Q3**: Quali video rendere "SLAM-enabled"? Tutti i 156? Solo P01 per la prima demo? **Decisione**: solo P01 per fase 1, espansione a tutti dopo aver validato il flow.
- **Q4**: Vogliamo il cono di visione + gaze ray anche nel viewer integrato, o sono troppo "noise" sopra il video? Da decidere visivamente in fase 3.
