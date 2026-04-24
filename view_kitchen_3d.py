#!/usr/bin/env python3
"""
HD-EPIC Digital Twin Viewer
============================
Converts Blender kitchen files (.blend) to GLB and opens an interactive 3D viewer.

Usage:
    python3 view_kitchen_3d.py <path_to_file_or_dir>
    python3 view_kitchen_3d.py P01/kitchen.blend
    python3 view_kitchen_3d.py /path/to/digital-twins/P01/
    python3 view_kitchen_3d.py /path/to/digital-twins/P01/kitchen.glb  # skip export

The script:
  1. If given a .blend file, exports it to .glb via Blender CLI
  2. Generates a self-contained HTML viewer with Three.js
  3. Opens it in the browser
"""

import argparse
import http.server
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import webbrowser
from pathlib import Path


BLENDER_EXPORT_SCRIPT = """\
import bpy, sys

output_path = sys.argv[sys.argv.index("--") + 1]

# The .blend file is already open (passed as the first arg to blender).
# Just export everything in the scene as-is.
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

HTML_VIEWER_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>HD-EPIC Kitchen Viewer — {kitchen_name}</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ background: #1a1a2e; color: #eee; font-family: monospace; }}
  #canvas-container {{ width: 100vw; height: 100vh; position: relative; }}
  #info {{
    position: absolute; top: 12px; left: 12px;
    background: rgba(0,0,0,.6); padding: 10px 14px; border-radius: 6px;
    font-size: 13px; line-height: 1.6;
  }}
  #info h3 {{ color: #7eb8f7; margin-bottom: 4px; }}
  #loading {{
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    font-size: 18px; color: #7eb8f7;
  }}
</style>
</head>
<body>
<div id="canvas-container">
  <div id="loading">Loading kitchen model…</div>
  <div id="info">
    <h3>HD-EPIC Kitchen — {kitchen_name}</h3>
    <div>Drag: rotate &nbsp;|&nbsp; Scroll: zoom &nbsp;|&nbsp; Right-drag: pan</div>
  </div>
</div>

<script type="importmap">
{{
  "imports": {{
    "three": "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"
  }}
}}
</script>

<script type="module">
import * as THREE from 'three';
import {{ OrbitControls }} from 'three/addons/controls/OrbitControls.js';
import {{ GLTFLoader }} from 'three/addons/loaders/GLTFLoader.js';

const container = document.getElementById('canvas-container');
const loading = document.getElementById('loading');

// Renderer
const renderer = new THREE.WebGLRenderer({{ antialias: true }});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
container.appendChild(renderer.domElement);

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.fog = new THREE.Fog(0x1a1a2e, 20, 60);

// Camera
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 200);
camera.position.set(0, 3, 6);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 0.5;
controls.maxDistance = 50;

// Lights
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff5e0, 1.5);
sun.position.set(5, 10, 5);
sun.castShadow = true;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xc8d8ff, 0.4);
fill.position.set(-5, 2, -5);
scene.add(fill);

// Grid helper
const grid = new THREE.GridHelper(20, 40, 0x333355, 0x222244);
scene.add(grid);

// Load model
const loader = new GLTFLoader();
loader.load(
  '{glb_path}',
  (gltf) => {{
    const model = gltf.scene;

    // Center the model
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    model.position.y += size.y / 2;

    // Fit camera
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.position.set(maxDim * 1.2, maxDim * 0.8, maxDim * 1.2);
    controls.target.set(0, 0, 0);
    controls.update();

    // Enable shadows
    model.traverse((node) => {{
      if (node.isMesh) {{
        node.castShadow = true;
        node.receiveShadow = true;
      }}
    }});

    scene.add(model);
    loading.style.display = 'none';

    // Print model info
    let meshCount = 0;
    model.traverse(n => {{ if (n.isMesh) meshCount++; }});
    document.getElementById('info').innerHTML += `<div style="margin-top:6px;color:#aaa">
      Meshes: ${{meshCount}} &nbsp;|&nbsp;
      Size: ${{size.x.toFixed(1)}}×${{size.y.toFixed(1)}}×${{size.z.toFixed(1)}} m
    </div>`;
  }},
  (xhr) => {{
    const pct = Math.round(xhr.loaded / xhr.total * 100);
    loading.textContent = `Loading kitchen model… ${{pct}}%`;
  }},
  (err) => {{
    loading.textContent = 'Error loading model: ' + err.message;
    console.error(err);
  }}
);

// Resize
window.addEventListener('resize', () => {{
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}});

// Animate
function animate() {{
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}}
animate();
</script>
</body>
</html>
"""


def find_blend_files(path: Path) -> list[Path]:
    if path.is_file() and path.suffix in ('.blend', '.glb', '.obj', '.ply'):
        return [path]
    if path.is_dir():
        files = []
        for ext in ('*.blend', '*.glb', '*.obj', '*.ply'):
            files.extend(path.rglob(ext))
        return sorted(files)
    return []


def export_blend_to_glb(blend_path: Path, output_dir: Path, force: bool = False) -> Path:
    glb_path = output_dir / (blend_path.stem + '.glb')
    if glb_path.exists() and not force:
        print(f"[skip] GLB already exists: {glb_path} (use --force to re-export)")
        return glb_path

    # Write the Blender Python script to a temp file
    with tempfile.NamedTemporaryFile(suffix='.py', mode='w', delete=False) as f:
        f.write(BLENDER_EXPORT_SCRIPT)
        script_path = f.name

    print(f"[export] {blend_path.name} → {glb_path.name} (via Blender headless)…")
    cmd = [
        'blender',
        '--background',
        str(blend_path),
        '--python', script_path,
        '--',
        str(glb_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    os.unlink(script_path)

    if result.returncode != 0 or not glb_path.exists():
        print("[error] Blender export failed:")
        print(result.stderr[-2000:])
        sys.exit(1)

    print(f"[ok] Exported: {glb_path} ({glb_path.stat().st_size // 1024} KB)")
    return glb_path


def generate_viewer(glb_path: Path, output_dir: Path) -> Path:
    # The HTML needs the GLB path relative to itself (they're in the same dir)
    glb_rel = glb_path.name
    kitchen_name = glb_path.stem

    html = HTML_VIEWER_TEMPLATE.format(
        kitchen_name=kitchen_name,
        glb_path=glb_rel,
    )
    html_path = output_dir / f"viewer_{kitchen_name}.html"
    html_path.write_text(html)
    print(f"[ok] Viewer: {html_path}")
    return html_path


def main():
    parser = argparse.ArgumentParser(description='HD-EPIC Kitchen 3D Viewer')
    parser.add_argument('input', help='Path to .blend/.glb file or directory')
    parser.add_argument('--out', default=None,
                        help='Output directory (default: same as input)')
    parser.add_argument('--no-browser', action='store_true',
                        help='Generate files but do not open browser')
    parser.add_argument('--force', action='store_true',
                        help='Re-export GLB even if it already exists')
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    files = find_blend_files(input_path)

    if not files:
        print(f"[error] No 3D files found at: {input_path}")
        print("  Supported: .blend .glb .obj .ply")
        sys.exit(1)

    if len(files) > 1:
        print(f"[found] {len(files)} file(s):")
        for i, f in enumerate(files):
            print(f"  [{i}] {f.relative_to(input_path) if input_path.is_dir() else f.name}")
        choice = input("Which one to view? (number, default 0): ").strip() or '0'
        target = files[int(choice)]
    else:
        target = files[0]

    out_dir = Path(args.out).resolve() if args.out else target.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # Export if needed
    if target.suffix == '.blend':
        if not shutil.which('blender'):
            print("[error] 'blender' not found in PATH")
            sys.exit(1)
        glb_path = export_blend_to_glb(target, out_dir, force=args.force)
    else:
        # Already a usable format — copy to out_dir if needed
        glb_path = out_dir / target.name
        if glb_path != target:
            shutil.copy2(target, glb_path)

    # Generate HTML viewer
    html_path = generate_viewer(glb_path, out_dir)

    if not args.no_browser:
        serve_and_open(out_dir, html_path)


def find_free_port() -> int:
    with socket.socket() as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def serve_and_open(serve_dir: Path, html_path: Path):
    port = find_free_port()
    url = f"http://localhost:{port}/{html_path.name}"

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(serve_dir), **kwargs)

        def log_message(self, fmt, *args):
            pass  # suppress request logs

    server = http.server.HTTPServer(('localhost', port), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    print(f"[server] http://localhost:{port}  (serving {serve_dir})")
    print(f"[open]   {url}")
    webbrowser.open(url)

    print("Press Ctrl+C to stop.")
    try:
        thread.join()
    except KeyboardInterrupt:
        print("\n[stop] Server stopped.")
        server.shutdown()


if __name__ == '__main__':
    main()
