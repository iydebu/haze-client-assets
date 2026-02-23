#!/usr/bin/env node
/**
 * Haze Store Manager — Zero-dependency web dashboard for managing haze-client-assets.
 * Run: node store-manager.js
 * Opens: http://localhost:3456
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3456;
const ROOT = __dirname;
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');

// ─── Folder scanning config ───────────────────────────────────────────────────
const SKIN_FOLDERS = {
	ar: 'AR',
	awp: 'AWP',
	shotgun: 'Shotgun',
	smg: 'SMG',
};
const SPECIAL_FOLDER = 'Special';
const MODEL_FOLDERS = {
	ar: 'Models/AR',
	awp: 'Models/AWP',
	smg: 'Models/SMG',
	shotgun: 'Models/Shotgun',
};
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const MODEL_EXTS = ['.glb'];
const PREVIEW_FOLDER = 'Previews';
const DEFAULT_MODELS_FOLDER = 'DefaultModels';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readManifest() {
	try {
		return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
	} catch {
		return { version: 3, updated: new Date().toISOString(), previewBaseUrl: '', assets: [] };
	}
}

function writeManifest(manifest) {
	fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

function regenerateManifestFile() {
	const items = scanAll();
	const manifest = readManifest();
	manifest.version = 3;
	manifest.updated = new Date().toISOString();
	manifest.previewBaseUrl = manifest.previewBaseUrl || 'https://raw.githubusercontent.com/iydebu/haze-client-assets/main/';
	manifest.assets = items;
	writeManifest(manifest);
	return items;
}

function scanFolder(folderRelative, extensions) {
	const abs = path.join(ROOT, folderRelative);
	if (!fs.existsSync(abs)) return [];
	return fs.readdirSync(abs)
		.filter(f => extensions.includes(path.extname(f).toLowerCase()))
		.map(f => ({
			file: folderRelative + '/' + f,
			name: path.basename(f, path.extname(f)),
			size: fs.statSync(path.join(abs, f)).size,
		}));
}

function scanAll() {
	const items = [];

	// Skins
	for (const [weapon, folder] of Object.entries(SKIN_FOLDERS)) {
		for (const f of scanFolder(folder, IMAGE_EXTS)) {
			const previewFile = PREVIEW_FOLDER + '/skin-' + weapon + '-' + f.name.toLowerCase() + '.webp';
			const hasPreview = fs.existsSync(path.join(ROOT, previewFile));
			items.push({
				id: 'skin-' + weapon + '-' + f.name.toLowerCase(),
				type: 'skin',
				weapon,
				name: f.name + ' ' + weapon.toUpperCase(),
				description: f.name + '-themed ' + weapon.toUpperCase() + ' skin',
				file: f.file,
				preview: hasPreview ? previewFile : f.file,
				size: f.size,
				required: false,
			});
		}
	}

	// Special
	for (const f of scanFolder(SPECIAL_FOLDER, IMAGE_EXTS)) {
		const previewFile = PREVIEW_FOLDER + '/special-' + f.name.toLowerCase() + '.webp';
		const hasPreview = fs.existsSync(path.join(ROOT, previewFile));
		items.push({
			id: 'special-' + f.name.toLowerCase(),
			type: 'special',
			name: f.name,
			description: f.name + ' special skin for all weapons',
			file: f.file,
			preview: hasPreview ? previewFile : f.file,
			size: f.size,
			required: false,
		});
	}

	// Models
	for (const [weapon, folder] of Object.entries(MODEL_FOLDERS)) {
		for (const f of scanFolder(folder, MODEL_EXTS)) {
			const folderAbs = path.join(ROOT, folder);

			// Find companion texture ({name}_tex.{ext})
			var texture = null;
			for (const ext of IMAGE_EXTS) {
				const candidate = path.join(folderAbs, f.name + '_tex' + ext);
				if (fs.existsSync(candidate)) {
					texture = folder + '/' + f.name + '_tex' + ext;
					break;
				}
			}

			// Find preview in Previews/ folder
			const previewFile = PREVIEW_FOLDER + '/model-' + weapon + '-' + f.name.toLowerCase() + '.webp';
			const hasPreview = fs.existsSync(path.join(ROOT, previewFile));

			// Legacy fallback: companion image in model folder
			var legacyPreview = null;
			if (!hasPreview) {
				for (const ext of IMAGE_EXTS) {
					const candidate = path.join(folderAbs, f.name + ext);
					if (fs.existsSync(candidate)) {
						legacyPreview = folder + '/' + f.name + ext;
						break;
					}
				}
			}

			items.push({
				id: 'model-' + weapon + '-' + f.name.toLowerCase(),
				type: 'model',
				weapon,
				name: f.name,
				description: 'Custom ' + f.name + ' weapon model',
				file: f.file,
				texture: texture,
				preview: hasPreview ? previewFile : legacyPreview,
				size: f.size,
				required: false,
			});
		}
	}

	return items;
}

function getMimeType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	const map = {
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.webp': 'image/webp',
		'.glb': 'model/gltf-binary',
		'.json': 'application/json',
		'.js': 'text/javascript',
		'.html': 'text/html',
		'.css': 'text/css',
	};
	return map[ext] || 'application/octet-stream';
}

function parseBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', c => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function parseMultipart(buf, boundary) {
	const parts = [];
	const sep = Buffer.from('--' + boundary);
	let start = 0;
	while (true) {
		const idx = buf.indexOf(sep, start);
		if (idx === -1) break;
		if (start > 0) {
			const chunk = buf.slice(start, idx);
			const headerEnd = chunk.indexOf('\r\n\r\n');
			if (headerEnd !== -1) {
				const headers = chunk.slice(0, headerEnd).toString();
				const body = chunk.slice(headerEnd + 4, chunk.length - 2);
				const nameMatch = headers.match(/name="([^"]+)"/);
				const fileMatch = headers.match(/filename="([^"]+)"/);
				parts.push({
					name: nameMatch ? nameMatch[1] : '',
					filename: fileMatch ? fileMatch[1] : null,
					data: body,
				});
			}
		}
		start = idx + sep.length + 2;
		if (buf.slice(idx + sep.length, idx + sep.length + 2).toString() === '--') break;
	}
	return parts;
}

function json(res, data, status = 200) {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
	res.end(JSON.stringify(data));
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function getDashboardHTML() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Haze Store Manager</title>
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
}}
</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e1a;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px}
h1{color:#00ff88;margin-bottom:6px;font-size:24px}
.subtitle{color:rgba(255,255,255,0.4);font-size:13px;margin-bottom:24px}
.toolbar{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;align-items:center}
.toolbar button{background:linear-gradient(145deg,#1a2240,#12182b);border:1px solid rgba(0,255,136,0.2);color:#00ff88;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;transition:all 0.2s}
.toolbar button:hover{background:linear-gradient(145deg,#1e2850,#161d30);border-color:#00ff88}
.toolbar button.danger{color:#ff6b8a;border-color:rgba(255,107,138,0.2)}
.toolbar button.danger:hover{border-color:#ff6b8a}
.filters{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.filters button{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);padding:6px 14px;border-radius:20px;cursor:pointer;font-size:12px;transition:all 0.2s}
.filters button.active{background:rgba(0,255,136,0.15);border-color:#00ff88;color:#00ff88}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.card{background:linear-gradient(145deg,#12182b,#0a0e1a);border:1px solid rgba(255,255,255,0.08);border-radius:10px;overflow:hidden;transition:all 0.2s;position:relative}
.card:hover{border-color:rgba(0,255,136,0.3);transform:translateY(-2px)}
.card-preview{width:100%;aspect-ratio:4/3;background:#080b14;display:flex;align-items:center;justify-content:center;overflow:hidden}
.card-preview img{width:100%;height:100%;object-fit:cover}
.card-preview .placeholder{font-size:40px;opacity:0.3}
.card-info{padding:10px 12px}
.card-name{font-size:13px;font-weight:600;color:#fff;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-meta{font-size:11px;color:rgba(255,255,255,0.4);display:flex;justify-content:space-between;align-items:center}
.card-type{background:rgba(0,255,136,0.1);color:#00ff88;padding:2px 8px;border-radius:10px;font-size:10px;text-transform:uppercase}
.card-type.model{background:rgba(138,107,255,0.1);color:#8a6bff}
.card-type.special{background:rgba(255,200,50,0.1);color:#ffc832}
.card-delete{position:absolute;top:6px;right:6px;background:rgba(255,50,50,0.8);border:none;color:#fff;width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:12px;display:none;align-items:center;justify-content:center;line-height:1}
.card:hover .card-delete{display:flex}
.status{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px;display:none}
.status.success{display:block;background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.2);color:#00ff88}
.status.error{display:block;background:rgba(255,107,138,0.1);border:1px solid rgba(255,107,138,0.2);color:#ff6b8a}
.drop-zone{border:2px dashed rgba(0,255,136,0.2);border-radius:10px;padding:40px;text-align:center;color:rgba(255,255,255,0.3);margin-bottom:20px;transition:all 0.2s;display:none}
.drop-zone.visible{display:block}
.drop-zone.dragover{border-color:#00ff88;background:rgba(0,255,136,0.05);color:#00ff88}
.stats{display:flex;gap:20px;margin-bottom:20px}
.stat{background:linear-gradient(145deg,#12182b,#0a0e1a);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 16px;flex:1}
.stat-value{font-size:22px;font-weight:700;color:#00ff88}
.stat-label{font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px}
.upload-section{display:none;margin-bottom:20px;background:linear-gradient(145deg,#12182b,#0a0e1a);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px}
.upload-section.visible{display:block}
.upload-section h3{color:#00ff88;margin-bottom:12px;font-size:14px}
.upload-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.upload-row select,.upload-row input[type=file]{background:#080b14;border:1px solid rgba(255,255,255,0.1);color:#e0e0e0;padding:8px 12px;border-radius:6px;font-size:13px}
.upload-row select{min-width:140px}
.upload-row label{font-size:12px;color:rgba(255,255,255,0.5)}
.upload-tabs{display:flex;gap:4px;margin-bottom:16px}
.upload-tab{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.5);padding:8px 20px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px;transition:all 0.2s}
.upload-tab.active{background:rgba(0,255,136,0.1);border-color:rgba(0,255,136,0.3);color:#00ff88}
.tab-content{display:none}
.tab-content.active{display:block}
.preview-area{position:relative;width:400px;height:300px;background:#080b14;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;margin-top:8px}
.preview-area canvas{display:block}
.loading-overlay{position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(8,11,20,0.85);display:none;align-items:center;justify-content:center;color:rgba(255,255,255,0.5);font-size:13px}
.loading-overlay.visible{display:flex}
.webgl-warning{background:rgba(255,200,50,0.1);border:1px solid rgba(255,200,50,0.3);color:#ffc832;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px}
.upload-btn{background:linear-gradient(145deg,#1a2240,#12182b);border:1px solid rgba(0,255,136,0.2);color:#00ff88;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;transition:all 0.2s}
.upload-btn:hover{background:linear-gradient(145deg,#1e2850,#161d30);border-color:#00ff88}
.upload-btn:disabled{opacity:0.4;cursor:not-allowed}
.viewer-modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:1000;display:none;align-items:center;justify-content:center}
.viewer-modal.visible{display:flex}
.viewer-content{background:#0a0e1a;border:1px solid rgba(255,255,255,0.1);border-radius:12px;max-width:90vw;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;min-width:500px}
.viewer-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.08)}
.viewer-header span{color:#fff;font-size:14px;font-weight:600}
.viewer-close{background:none;border:none;color:rgba(255,255,255,0.5);font-size:24px;cursor:pointer;padding:0 4px;line-height:1}
.viewer-close:hover{color:#ff6b8a}
#viewerCanvas{display:block;width:100%;background:#080b14}
.viewer-footer{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-top:1px solid rgba(255,255,255,0.08)}
.viewer-info{color:rgba(255,255,255,0.4);font-size:12px}
.view3d-link{color:#00ff88;font-size:12px;cursor:pointer;margin-top:6px;display:none;text-decoration:underline}
.view3d-link:hover{color:#33ffaa}
.gen-progress{color:rgba(255,255,255,0.5);font-size:12px;margin-left:8px}
</style>
</head>
<body>

<h1>Haze Store Manager</h1>
<p class="subtitle">Manage skins, models, and special assets for haze-client-assets</p>

<div class="stats" id="stats"></div>
<div id="webglWarning" class="webgl-warning" style="display:none">
  &#9888; WebGL not available. 3D previews disabled &mdash; uploads still work without preview generation.
</div>
<div class="status" id="status"></div>

<div class="toolbar">
  <button onclick="toggleUpload()">+ Add Asset</button>
  <button onclick="regenerateManifest()">Save Manifest</button>
  <button onclick="gitPush()" class="danger">Push to Git</button>
  <button onclick="loadAssets()">Refresh</button>
  <button onclick="generateAllPreviews()">Generate All Previews</button>
</div>

<div class="upload-section" id="uploadSection">
  <h3>Upload New Asset</h3>
  <div class="upload-tabs">
    <button class="upload-tab active" onclick="switchTab('skin')">Skin</button>
    <button class="upload-tab" onclick="switchTab('model')">Model</button>
    <button class="upload-tab" onclick="switchTab('special')">Special</button>
  </div>

  <!-- Skin Tab -->
  <div class="tab-content active" id="tab-skin">
    <div class="upload-row">
      <label>Weapon:</label>
      <select id="skinWeapon">
        <option value="ar">AR</option>
        <option value="awp">AWP</option>
        <option value="shotgun">Shotgun</option>
        <option value="smg">SMG</option>
      </select>
      <label>Texture:</label>
      <input type="file" id="skinFile" accept=".png,.jpg,.jpeg,.webp">
      <button class="upload-btn" id="skinUploadBtn" onclick="uploadSkin()" disabled>Upload Skin</button>
    </div>
    <div class="preview-area">
      <canvas id="skinCanvas" width="400" height="300"></canvas>
      <div class="loading-overlay" id="skinLoading">Rendering 3D preview...</div>
    </div>
    <div class="view3d-link" id="skinView3d" onclick="viewUploadedSkin3D()">View in 3D &rarr;</div>
  </div>

  <!-- Model Tab -->
  <div class="tab-content" id="tab-model">
    <div class="upload-row">
      <label>Weapon:</label>
      <select id="modelWeapon">
        <option value="ar">AR</option>
        <option value="awp">AWP</option>
        <option value="shotgun">Shotgun</option>
        <option value="smg">SMG</option>
      </select>
      <label>Model (.glb):</label>
      <input type="file" id="modelFile" accept=".glb">
      <label>Texture:</label>
      <input type="file" id="modelTexture" accept=".png,.jpg,.jpeg,.webp">
      <button class="upload-btn" id="modelUploadBtn" onclick="uploadModel()" disabled>Upload Model</button>
    </div>
    <div class="preview-area">
      <canvas id="modelCanvas" width="400" height="300"></canvas>
      <div class="loading-overlay" id="modelLoading">Rendering 3D preview...</div>
    </div>
    <div class="view3d-link" id="modelView3d" onclick="viewUploadedModel3D()">View in 3D &rarr;</div>
  </div>

  <!-- Special Tab -->
  <div class="tab-content" id="tab-special">
    <div class="upload-row">
      <label>Image:</label>
      <input type="file" id="specialFile" accept=".png,.jpg,.jpeg,.webp">
      <button class="upload-btn" id="specialUploadBtn" onclick="uploadSpecial()" disabled>Upload Special</button>
    </div>
    <div class="preview-area">
      <canvas id="specialCanvas" width="400" height="300"></canvas>
      <div class="loading-overlay" id="specialLoading">Processing preview...</div>
    </div>
  </div>
</div>

<div class="drop-zone visible" id="dropZone">
  Drop skin textures here (uses weapon selected in Skin tab)
</div>

<div class="filters" id="filters"></div>
<div class="grid" id="grid"></div>

<div id="viewerModal" class="viewer-modal">
  <div class="viewer-content">
    <div class="viewer-header">
      <span id="viewerTitle">3D Viewer</span>
      <button class="viewer-close" onclick="closeViewer()">&times;</button>
    </div>
    <canvas id="viewerCanvas" width="800" height="600"></canvas>
    <div class="viewer-footer">
      <span id="viewerInfo" class="viewer-info">Drag to rotate &middot; Scroll to zoom</span>
      <button class="upload-btn" id="genPreviewBtn" onclick="generatePreview()">Generate Preview</button>
    </div>
  </div>
</div>

<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ─── WebGL Detection ──────────────────────────────────────────────────────────
var hasWebGL = false;
try {
  var tc = document.createElement('canvas');
  hasWebGL = !!(tc.getContext('webgl2') || tc.getContext('webgl'));
} catch(e) {}
if (!hasWebGL) document.getElementById('webglWarning').style.display = 'block';

// ─── Gradient Background Helper ──────────────────────────────────────────────
function createGradientBackground() {
  var c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  var ctx = c.getContext('2d');
  var grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#1a2240');
  grad.addColorStop(0.5, '#12182b');
  grad.addColorStop(1, '#0a0e1a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  var tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── PreviewRenderer ─────────────────────────────────────────────────────────
class PreviewRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas, alpha: true, antialias: true, preserveDrawingBuffer: true
    });
    this.renderer.setSize(400, 300);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  async render(glbSource, textureSource) {
    var scene = new THREE.Scene();
    scene.background = createGradientBackground();
    var camera = new THREE.PerspectiveCamera(45, 400 / 300, 0.1, 100);

    // Lights: strong for dark background — ambient 1.0, key 1.5, fill 0.8, rim 0.5
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    var dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 5, 5);
    scene.add(dirLight);
    var fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
    fillLight.position.set(-3, 2, -3);
    scene.add(fillLight);
    var rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
    rimLight.position.set(0, 3, -5);
    scene.add(rimLight);

    // Load GLB
    var loader = new GLTFLoader();
    var gltf;
    if (glbSource instanceof ArrayBuffer) {
      gltf = await new Promise(function(resolve, reject) {
        loader.parse(glbSource, '', resolve, reject);
      });
    } else {
      gltf = await loader.loadAsync(glbSource);
    }
    var model = gltf.scene;

    // Apply texture if provided
    if (textureSource) {
      var texLoader = new THREE.TextureLoader();
      var texture;
      if (textureSource instanceof Blob || textureSource instanceof File) {
        var blobUrl = URL.createObjectURL(textureSource);
        texture = await texLoader.loadAsync(blobUrl);
        URL.revokeObjectURL(blobUrl);
      } else {
        texture = await texLoader.loadAsync(textureSource);
      }
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      model.traverse(function(child) {
        if (child.isMesh) {
          child.material = new THREE.MeshStandardMaterial({ map: texture });
        }
      });
    }

    // Rotate model ~30 degrees on Y axis
    model.rotation.y = Math.PI / 6;
    scene.add(model);

    // Auto-fit camera to bounding box
    var box = new THREE.Box3().setFromObject(model);
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z);
    var fov = camera.fov * (Math.PI / 180);
    var dist = maxDim / (2 * Math.tan(fov / 2)) * 1.1;
    camera.position.set(center.x + dist, center.y + dist * 0.15, center.z + dist * 0.1);
    camera.lookAt(center);

    // Render
    this.renderer.render(scene, camera);

    // Cleanup scene
    scene.traverse(function(child) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });

    // Export as WebP 400x300 @ 75%
    var self = this;
    return new Promise(function(resolve) {
      self.canvas.toBlob(function(blob) { resolve(blob); }, 'image/webp', 0.75);
    });
  }

  dispose() {
    this.renderer.dispose();
  }
}

// ─── InteractiveViewer ──────────────────────────────────────────────────────
class InteractiveViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas, alpha: true, antialias: true, preserveDrawingBuffer: true
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = createGradientBackground();
    this.camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 100);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;

    // Lighting: strong for dark background — ambient 1.0, key 1.5, fill 0.8, rim 0.5
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    var dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 5, 5);
    this.scene.add(dirLight);
    var fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
    fillLight.position.set(-3, 2, -3);
    this.scene.add(fillLight);
    var rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
    rimLight.position.set(0, 3, -5);
    this.scene.add(rimLight);

    this.model = null;
    this.animId = null;
    this.modelCenter = new THREE.Vector3();
    this.modelDist = 1;
  }

  async load(glbSource, textureSource) {
    // Clear previous model
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse(function(child) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (child.material.map) child.material.map.dispose();
          child.material.dispose();
        }
      });
      this.model = null;
    }

    // Load GLB
    var loader = new GLTFLoader();
    var gltf;
    if (glbSource instanceof ArrayBuffer) {
      gltf = await new Promise(function(resolve, reject) {
        loader.parse(glbSource, '', resolve, reject);
      });
    } else {
      gltf = await loader.loadAsync(glbSource);
    }
    var model = gltf.scene;

    // Apply texture if provided
    if (textureSource) {
      var texLoader = new THREE.TextureLoader();
      var texture;
      if (textureSource instanceof Blob || textureSource instanceof File) {
        var blobUrl = URL.createObjectURL(textureSource);
        texture = await texLoader.loadAsync(blobUrl);
        URL.revokeObjectURL(blobUrl);
      } else {
        texture = await texLoader.loadAsync(textureSource);
      }
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      model.traverse(function(child) {
        if (child.isMesh) {
          child.material = new THREE.MeshStandardMaterial({ map: texture });
        }
      });
    }

    // Rotate model ~30 degrees on Y axis
    model.rotation.y = Math.PI / 6;
    this.scene.add(model);
    this.model = model;

    // Auto-fit camera to bounding box
    var box = new THREE.Box3().setFromObject(model);
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z);
    var fov = this.camera.fov * (Math.PI / 180);
    var dist = maxDim / (2 * Math.tan(fov / 2)) * 1.1;

    this.modelCenter = center.clone();
    this.modelDist = dist;

    this.camera.position.set(center.x + dist, center.y + dist * 0.15, center.z + dist * 0.1);
    this.camera.lookAt(center);
    this.controls.target.copy(center);
    this.controls.update();

    // Start animation loop
    this.startLoop();
  }

  startLoop() {
    if (this.animId) return;
    var self = this;
    function animate() {
      self.animId = requestAnimationFrame(animate);
      self.controls.update();
      self.renderer.render(self.scene, self.camera);
    }
    animate();
  }

  async capturePreview() {
    // Create OFFSCREEN 400x300 canvas + separate renderer
    var offCanvas = document.createElement('canvas');
    offCanvas.width = 400;
    offCanvas.height = 300;
    var offRenderer = new THREE.WebGLRenderer({
      canvas: offCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true
    });
    offRenderer.setSize(400, 300);
    offRenderer.setPixelRatio(1);
    offRenderer.outputColorSpace = THREE.SRGBColorSpace;

    // Clone scene for offscreen render (reuse same scene, just different camera)
    var offCamera = new THREE.PerspectiveCamera(45, 400 / 300, 0.1, 100);
    // FIXED STANDARD ANGLE — ignoring current orbit position
    var center = this.modelCenter;
    var dist = this.modelDist;
    offCamera.position.set(center.x + dist, center.y + dist * 0.15, center.z + dist * 0.1);
    offCamera.lookAt(center);

    // Render single frame
    offRenderer.render(this.scene, offCamera);

    // Export as WebP 400x300 @ 75%
    var blob = await new Promise(function(resolve) {
      offCanvas.toBlob(function(b) { resolve(b); }, 'image/webp', 0.75);
    });

    // Dispose offscreen renderer
    offRenderer.dispose();
    return blob;
  }

  resize(width, height) {
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  stop() {
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  dispose() {
    this.stop();
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse(function(child) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (child.material.map) child.material.map.dispose();
          child.material.dispose();
        }
      });
    }
    this.controls.dispose();
    this.renderer.dispose();
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
var allAssets = [];
var activeFilter = 'all';
var skinPreviewBlob = null;
var modelPreviewBlob = null;
var specialPreviewBlob = null;
var skinRenderer = null;
var modelRenderer = null;
var interactiveViewer = null;
var currentViewerAsset = null;

if (hasWebGL) {
  skinRenderer = new PreviewRenderer(document.getElementById('skinCanvas'));
  modelRenderer = new PreviewRenderer(document.getElementById('modelCanvas'));
}

// ─── API Helper ───────────────────────────────────────────────────────────────
async function api(url, opts) {
  var res = await fetch(url, opts);
  return res.json();
}

function showStatus(msg, type) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
  setTimeout(function() { el.className = 'status'; }, 4000);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ─── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.upload-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
  var tabs = document.querySelectorAll('.upload-tab');
  var tabMap = { skin: 0, model: 1, special: 2 };
  if (tabMap[tab] !== undefined) tabs[tabMap[tab]].classList.add('active');
  var content = document.getElementById('tab-' + tab);
  if (content) content.classList.add('active');
}

function toggleUpload() {
  document.getElementById('uploadSection').classList.toggle('visible');
}

// ─── Asset Loading ────────────────────────────────────────────────────────────
async function loadAssets() {
  var data = await api('/api/assets');
  allAssets = data.assets || [];
  renderStats(data);
  renderFilters();
  renderGrid();
}

function renderStats(manifest) {
  var skins = allAssets.filter(function(a) { return a.type === 'skin'; }).length;
  var models = allAssets.filter(function(a) { return a.type === 'model'; }).length;
  var special = allAssets.filter(function(a) { return a.type === 'special'; }).length;
  var totalSize = allAssets.reduce(function(s, a) { return s + (a.size || 0); }, 0);
  document.getElementById('stats').innerHTML = [
    { v: allAssets.length, l: 'Total Assets' },
    { v: skins, l: 'Skins' },
    { v: models, l: 'Models' },
    { v: special, l: 'Special' },
    { v: formatSize(totalSize), l: 'Total Size' },
    { v: 'v' + (manifest.version || '?'), l: 'Manifest Version' },
  ].map(function(s) {
    return '<div class="stat"><div class="stat-value">' + s.v + '</div><div class="stat-label">' + s.l + '</div></div>';
  }).join('');
}

function renderFilters() {
  var types = ['all'];
  allAssets.forEach(function(a) { if (types.indexOf(a.type) === -1) types.push(a.type); });
  var weapons = [];
  allAssets.forEach(function(a) { if (a.weapon && weapons.indexOf(a.weapon) === -1) weapons.push(a.weapon); });
  var filters = types.concat(weapons.map(function(w) { return 'weapon:' + w; }));
  document.getElementById('filters').innerHTML = filters.map(function(f) {
    var label = f.indexOf('weapon:') === 0 ? f.split(':')[1].toUpperCase() : f.charAt(0).toUpperCase() + f.slice(1);
    return '<button class="' + (activeFilter === f ? 'active' : '') + '" data-filter="' + f + '">' + label + '</button>';
  }).join('');
}

// Use event delegation for filters
document.getElementById('filters').addEventListener('click', function(e) {
  var btn = e.target.closest('button');
  if (btn && btn.dataset.filter) {
    activeFilter = btn.dataset.filter;
    renderFilters();
    renderGrid();
  }
});

function renderGrid() {
  var items = allAssets;
  if (activeFilter !== 'all') {
    if (activeFilter.indexOf('weapon:') === 0) {
      var w = activeFilter.split(':')[1];
      items = items.filter(function(a) { return a.weapon === w; });
    } else {
      items = items.filter(function(a) { return a.type === activeFilter; });
    }
  }
  document.getElementById('grid').innerHTML = items.map(function(a) {
    var previewSrc = a.preview ? '/file/' + a.preview : '';
    var typeClass = a.type === 'model' ? 'model' : a.type === 'special' ? 'special' : '';
    var safeFile = a.file.replace(/"/g, '&quot;');
    return '<div class="card">' +
      '<button class="card-delete" data-file="' + safeFile + '" title="Delete">&times;</button>' +
      '<div class="card-preview">' +
        (previewSrc
          ? '<img src="' + previewSrc + '" onerror="this.outerHTML=\\'<span class=placeholder>&#x1f4e6;</span>\\'">'
          : '<span class="placeholder">&#x1f4e6;</span>') +
      '</div>' +
      '<div class="card-info">' +
        '<div class="card-name" title="' + (a.description || a.name) + '">' + a.name + '</div>' +
        '<div class="card-meta">' +
          '<span class="card-type ' + typeClass + '">' + a.type + (a.weapon ? ' / ' + a.weapon : '') + '</span>' +
          '<span>' + formatSize(a.size) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Use event delegation for delete buttons + card click → viewer
document.getElementById('grid').addEventListener('click', function(e) {
  // Delete handler
  var btn = e.target.closest('.card-delete');
  if (btn && btn.dataset.file) {
    deleteAsset(btn.dataset.file);
    return;
  }
  // Card click → open viewer for skin/model
  var card = e.target.closest('.card');
  if (card) {
    var delBtn = card.querySelector('.card-delete');
    if (delBtn && delBtn.dataset.file) {
      var file = delBtn.dataset.file;
      var asset = allAssets.find(function(a) { return a.file === file; });
      if (asset && (asset.type === 'skin' || asset.type === 'model')) {
        openViewer(asset);
      }
    }
  }
});

// ─── Manifest & Git ──────────────────────────────────────────────────────────
async function regenerateManifest() {
  var data = await api('/api/regenerate', { method: 'POST' });
  if (data.success) {
    showStatus('Manifest regenerated — ' + data.count + ' assets found', 'success');
    loadAssets();
  } else {
    showStatus('Failed: ' + (data.error || 'unknown'), 'error');
  }
}

async function gitPush() {
  if (!confirm('This will commit and push all changes. Continue?')) return;
  var data = await api('/api/git-push', { method: 'POST' });
  if (data.success) {
    showStatus('Pushed to git: ' + data.message, 'success');
  } else {
    showStatus('Git error: ' + (data.error || 'unknown'), 'error');
  }
}

async function deleteAsset(filePath) {
  if (!confirm('Delete ' + filePath + '?')) return;
  var data = await api('/api/asset?file=' + encodeURIComponent(filePath), { method: 'DELETE' });
  if (data.success) {
    showStatus('Deleted: ' + filePath, 'success');
    loadAssets();
  } else {
    showStatus('Delete failed: ' + (data.error || 'unknown'), 'error');
  }
}

// ─── Skin Upload Flow ────────────────────────────────────────────────────────
document.getElementById('skinFile').addEventListener('change', async function() {
  skinPreviewBlob = null;
  document.getElementById('skinUploadBtn').disabled = true;
  if (!this.files.length) return;

  if (hasWebGL) {
    var weapon = document.getElementById('skinWeapon').value;
    var loading = document.getElementById('skinLoading');
    loading.classList.add('visible');
    try {
      skinPreviewBlob = await skinRenderer.render(
        '/file/DefaultModels/' + weapon + '.glb',
        this.files[0]
      );
    } catch(e) {
      console.error('Skin preview render failed:', e);
      skinPreviewBlob = null;
    }
    loading.classList.remove('visible');
  }
  document.getElementById('skinUploadBtn').disabled = false;
  // Show "View in 3D" link
  if (hasWebGL) document.getElementById('skinView3d').style.display = 'block';
});

// Re-render skin preview when weapon changes
document.getElementById('skinWeapon').addEventListener('change', function() {
  var fileInput = document.getElementById('skinFile');
  if (fileInput.files.length > 0) {
    fileInput.dispatchEvent(new Event('change'));
  }
});

async function uploadSkin() {
  var weapon = document.getElementById('skinWeapon').value;
  var fileInput = document.getElementById('skinFile');
  if (!fileInput.files.length) return showStatus('Select a skin texture first', 'error');

  var form = new FormData();
  form.append('weapon', weapon);
  form.append('file', fileInput.files[0]);
  if (skinPreviewBlob) form.append('preview', skinPreviewBlob, 'preview.webp');

  var data = await fetch('/api/upload-skin', { method: 'POST', body: form }).then(function(r) { return r.json(); });
  if (data.success) {
    showStatus('Skin uploaded: ' + data.file, 'success');
    fileInput.value = '';
    skinPreviewBlob = null;
    document.getElementById('skinUploadBtn').disabled = true;
    var ctx = document.getElementById('skinCanvas').getContext('2d');
    ctx.clearRect(0, 0, 400, 300);
    loadAssets();
  } else {
    showStatus('Upload failed: ' + (data.error || 'unknown'), 'error');
  }
}

// ─── Model Upload Flow ───────────────────────────────────────────────────────
async function tryModelPreview() {
  var modelInput = document.getElementById('modelFile');
  var textureInput = document.getElementById('modelTexture');
  modelPreviewBlob = null;
  document.getElementById('modelUploadBtn').disabled = true;

  if (!modelInput.files.length || !textureInput.files.length) return;
  document.getElementById('modelUploadBtn').disabled = false;
  // Show "View in 3D" link
  if (hasWebGL) document.getElementById('modelView3d').style.display = 'block';

  if (hasWebGL) {
    var loading = document.getElementById('modelLoading');
    loading.classList.add('visible');
    try {
      var glbBuf = await modelInput.files[0].arrayBuffer();
      modelPreviewBlob = await modelRenderer.render(glbBuf, textureInput.files[0]);
    } catch(e) {
      console.error('Model preview render failed:', e);
      modelPreviewBlob = null;
    }
    loading.classList.remove('visible');
  }
}

document.getElementById('modelFile').addEventListener('change', tryModelPreview);
document.getElementById('modelTexture').addEventListener('change', tryModelPreview);

async function uploadModel() {
  var weapon = document.getElementById('modelWeapon').value;
  var modelInput = document.getElementById('modelFile');
  var textureInput = document.getElementById('modelTexture');
  if (!modelInput.files.length) return showStatus('Select a .glb model file', 'error');
  if (!textureInput.files.length) return showStatus('Select a texture file', 'error');

  var form = new FormData();
  form.append('weapon', weapon);
  form.append('model', modelInput.files[0]);
  form.append('texture', textureInput.files[0]);
  if (modelPreviewBlob) form.append('preview', modelPreviewBlob, 'preview.webp');

  var data = await fetch('/api/upload-model', { method: 'POST', body: form }).then(function(r) { return r.json(); });
  if (data.success) {
    showStatus('Model uploaded: ' + data.file, 'success');
    modelInput.value = '';
    textureInput.value = '';
    modelPreviewBlob = null;
    document.getElementById('modelUploadBtn').disabled = true;
    var ctx = document.getElementById('modelCanvas').getContext('2d');
    ctx.clearRect(0, 0, 400, 300);
    loadAssets();
  } else {
    showStatus('Upload failed: ' + (data.error || 'unknown'), 'error');
  }
}

// ─── Special Upload Flow ─────────────────────────────────────────────────────
document.getElementById('specialFile').addEventListener('change', async function() {
  specialPreviewBlob = null;
  document.getElementById('specialUploadBtn').disabled = true;
  if (!this.files.length) return;

  // 2D canvas: scale image to 400x300 WebP
  var loading = document.getElementById('specialLoading');
  loading.classList.add('visible');
  try {
    var img = new Image();
    var url = URL.createObjectURL(this.files[0]);
    await new Promise(function(resolve, reject) {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    URL.revokeObjectURL(url);

    var canvas = document.getElementById('specialCanvas');
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 400, 300);
    // Draw scaled to fit 400x300 maintaining aspect ratio
    var scale = Math.min(400 / img.width, 300 / img.height);
    var w = img.width * scale;
    var h = img.height * scale;
    ctx.drawImage(img, (400 - w) / 2, (300 - h) / 2, w, h);

    specialPreviewBlob = await new Promise(function(resolve) {
      canvas.toBlob(function(blob) { resolve(blob); }, 'image/webp', 0.75);
    });
  } catch(e) {
    console.error('Special preview failed:', e);
    specialPreviewBlob = null;
  }
  loading.classList.remove('visible');
  document.getElementById('specialUploadBtn').disabled = false;
});

async function uploadSpecial() {
  var fileInput = document.getElementById('specialFile');
  if (!fileInput.files.length) return showStatus('Select an image file', 'error');

  var form = new FormData();
  form.append('file', fileInput.files[0]);
  if (specialPreviewBlob) form.append('preview', specialPreviewBlob, 'preview.webp');

  var data = await fetch('/api/upload-special', { method: 'POST', body: form }).then(function(r) { return r.json(); });
  if (data.success) {
    showStatus('Special uploaded: ' + data.file, 'success');
    fileInput.value = '';
    specialPreviewBlob = null;
    document.getElementById('specialUploadBtn').disabled = true;
    var ctx = document.getElementById('specialCanvas').getContext('2d');
    ctx.clearRect(0, 0, 400, 300);
    loadAssets();
  } else {
    showStatus('Upload failed: ' + (data.error || 'unknown'), 'error');
  }
}

// ─── Drag and Drop (Skin flow) ───────────────────────────────────────────────
var dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover', function(e) { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', function() { dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', async function(e) {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  var weapon = document.getElementById('skinWeapon').value;

  for (var i = 0; i < e.dataTransfer.files.length; i++) {
    var file = e.dataTransfer.files[i];
    var form = new FormData();
    form.append('weapon', weapon);
    form.append('file', file);

    // Generate 3D preview if WebGL available
    if (hasWebGL) {
      try {
        var blob = await skinRenderer.render(
          '/file/DefaultModels/' + weapon + '.glb',
          file
        );
        if (blob) form.append('preview', blob, 'preview.webp');
      } catch(err) {
        console.error('Drop preview failed:', err);
      }
    }

    await fetch('/api/upload-skin', { method: 'POST', body: form }).then(function(r) { return r.json(); });
  }
  showStatus('Dropped ' + e.dataTransfer.files.length + ' skin(s)', 'success');
  loadAssets();
});

// ─── Interactive Viewer Functions ──────────────────────────────────────────────
function openViewer(asset) {
  if (!hasWebGL) return;
  currentViewerAsset = asset;

  var modal = document.getElementById('viewerModal');
  modal.classList.add('visible');
  document.getElementById('viewerTitle').textContent = asset.name || '3D Viewer';

  // Create viewer if not exists
  if (!interactiveViewer) {
    interactiveViewer = new InteractiveViewer(document.getElementById('viewerCanvas'));
  }

  // Resize canvas to modal dimensions
  var content = modal.querySelector('.viewer-content');
  var w = Math.min(window.innerWidth * 0.85, 900);
  var h = Math.min(window.innerHeight * 0.7, 600);
  interactiveViewer.resize(w, h);

  // Determine GLB + texture sources
  var glb, tex;
  if (asset.type === 'skin') {
    glb = '/file/DefaultModels/' + asset.weapon + '.glb';
    tex = '/file/' + asset.file;
  } else if (asset.type === 'model') {
    glb = '/file/' + asset.file;
    tex = asset.texture ? '/file/' + asset.texture : null;
  }

  document.getElementById('genPreviewBtn').disabled = false;
  interactiveViewer.load(glb, tex).catch(function(e) {
    console.error('Viewer load failed:', e);
    document.getElementById('viewerInfo').textContent = 'Failed to load model';
  });
}

function closeViewer() {
  if (interactiveViewer) interactiveViewer.stop();
  document.getElementById('viewerModal').classList.remove('visible');
  currentViewerAsset = null;
}

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('viewerModal').classList.contains('visible')) {
    closeViewer();
  }
});

// Close modal on backdrop click
document.getElementById('viewerModal').addEventListener('click', function(e) {
  if (e.target === this) closeViewer();
});

async function generatePreview() {
  if (!interactiveViewer || !currentViewerAsset) return;
  var btn = document.getElementById('genPreviewBtn');
  var info = document.getElementById('viewerInfo');
  btn.disabled = true;
  btn.textContent = 'Generating...';
  info.textContent = 'Capturing preview from standard angle...';

  try {
    var blob = await interactiveViewer.capturePreview();

    // Determine name for save
    var asset = currentViewerAsset;
    var name = asset.file.split('/').pop();
    name = name.replace(/\.[^.]+$/, '').toLowerCase();

    var form = new FormData();
    form.append('type', asset.type);
    form.append('weapon', asset.weapon || '');
    form.append('name', name);
    form.append('preview', blob, 'preview.webp');

    var data = await fetch('/api/save-preview', { method: 'POST', body: form }).then(function(r) { return r.json(); });
    if (data.success) {
      info.textContent = 'Preview saved!';
      showStatus('Preview generated for ' + asset.name, 'success');

      // If this was called from upload flow, store the blob
      if (asset._uploadSkin) skinPreviewBlob = blob;
      if (asset._uploadModel) modelPreviewBlob = blob;

      loadAssets();
    } else {
      info.textContent = 'Failed: ' + (data.error || 'unknown');
    }
  } catch(e) {
    console.error('Preview generation failed:', e);
    info.textContent = 'Error generating preview';
  }
  btn.disabled = false;
  btn.textContent = 'Generate Preview';
}

async function generateAllPreviews() {
  if (!hasWebGL) return showStatus('WebGL not available', 'error');
  var skins = allAssets.filter(function(a) { return a.type === 'skin'; });
  var models = allAssets.filter(function(a) { return a.type === 'model'; });
  var total = skins.length + models.length;
  if (total === 0) return showStatus('No skins or models to generate previews for', 'error');
  if (!confirm('Generate previews for ' + skins.length + ' skins and ' + models.length + ' models?')) return;

  // Create temporary offscreen viewer
  var tempCanvas = document.createElement('canvas');
  tempCanvas.width = 800;
  tempCanvas.height = 600;
  var tempViewer = new InteractiveViewer(tempCanvas);
  var done = 0;

  showStatus('Generating previews... 0/' + total, 'success');

  try {
    // Process skins
    for (var i = 0; i < skins.length; i++) {
      var skin = skins[i];
      var glb = '/file/DefaultModels/' + skin.weapon + '.glb';
      var tex = '/file/' + skin.file;
      await tempViewer.load(glb, tex);
      var blob = await tempViewer.capturePreview();
      tempViewer.stop();

      var name = skin.file.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
      var form = new FormData();
      form.append('type', 'skin');
      form.append('weapon', skin.weapon);
      form.append('name', name);
      form.append('preview', blob, 'preview.webp');
      await fetch('/api/save-preview', { method: 'POST', body: form });

      done++;
      showStatus('Generating previews... ' + done + '/' + total, 'success');
    }

    // Process models
    for (var j = 0; j < models.length; j++) {
      var model = models[j];
      var mGlb = '/file/' + model.file;
      var mTex = model.texture ? '/file/' + model.texture : null;
      await tempViewer.load(mGlb, mTex);
      var mBlob = await tempViewer.capturePreview();
      tempViewer.stop();

      var mName = model.file.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
      var mForm = new FormData();
      mForm.append('type', 'model');
      mForm.append('weapon', model.weapon);
      mForm.append('name', mName);
      mForm.append('preview', mBlob, 'preview.webp');
      await fetch('/api/save-preview', { method: 'POST', body: mForm });

      done++;
      showStatus('Generating previews... ' + done + '/' + total, 'success');
    }

    tempViewer.dispose();
    showStatus('All ' + total + ' previews generated!', 'success');
    loadAssets();
  } catch(e) {
    console.error('Batch preview failed:', e);
    tempViewer.dispose();
    showStatus('Preview generation failed at ' + done + '/' + total + ': ' + e.message, 'error');
  }
}

// ─── Upload Tab 3D View Functions ───────────────────────────────────────────
function viewUploadedSkin3D() {
  var fileInput = document.getElementById('skinFile');
  if (!fileInput.files.length || !hasWebGL) return;
  var weapon = document.getElementById('skinWeapon').value;
  openViewer({
    type: 'skin',
    weapon: weapon,
    name: fileInput.files[0].name,
    file: 'DefaultModels/' + weapon + '.glb',
    _uploadSkin: true,
    _skinTexture: fileInput.files[0]
  });
  // Override: load with local file instead of URL
  var glb = '/file/DefaultModels/' + weapon + '.glb';
  interactiveViewer.load(glb, fileInput.files[0]);
}

function viewUploadedModel3D() {
  var modelInput = document.getElementById('modelFile');
  var textureInput = document.getElementById('modelTexture');
  if (!modelInput.files.length || !hasWebGL) return;
  openViewer({
    type: 'model',
    weapon: document.getElementById('modelWeapon').value,
    name: modelInput.files[0].name,
    file: modelInput.files[0].name,
    _uploadModel: true
  });
  // Override: load with local ArrayBuffer + file
  modelInput.files[0].arrayBuffer().then(function(buf) {
    var tex = textureInput.files.length ? textureInput.files[0] : null;
    interactiveViewer.load(buf, tex);
  });
}

// ─── Expose to window for onclick handlers ───────────────────────────────────
window.toggleUpload = toggleUpload;
window.regenerateManifest = regenerateManifest;
window.gitPush = gitPush;
window.loadAssets = loadAssets;
window.deleteAsset = deleteAsset;
window.switchTab = switchTab;
window.uploadSkin = uploadSkin;
window.uploadModel = uploadModel;
window.uploadSpecial = uploadSpecial;
window.closeViewer = closeViewer;
window.generatePreview = generatePreview;
window.generateAllPreviews = generateAllPreviews;
window.viewUploadedSkin3D = viewUploadedSkin3D;
window.viewUploadedModel3D = viewUploadedModel3D;

// Init
loadAssets();
<\/script>
</body>
</html>`;
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const pathname = url.pathname;

	// CORS
	if (req.method === 'OPTIONS') {
		res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
		return res.end();
	}

	try {
		// ── Dashboard ──
		if (pathname === '/' && req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			return res.end(getDashboardHTML());
		}

		// ── API: Current manifest ──
		if (pathname === '/api/assets' && req.method === 'GET') {
			return json(res, readManifest());
		}

		// ── API: Scan folders ──
		if (pathname === '/api/scan' && req.method === 'GET') {
			const items = scanAll();
			return json(res, { count: items.length, items });
		}

		// ── API: Regenerate manifest ──
		if (pathname === '/api/regenerate' && req.method === 'POST') {
			const items = regenerateManifestFile();
			return json(res, { success: true, count: items.length });
		}

		// ── API: Upload (legacy — simple file upload) ──
		if (pathname === '/api/upload' && req.method === 'POST') {
			const contentType = req.headers['content-type'] || '';
			const boundaryMatch = contentType.match(/boundary=(.+)/);
			if (!boundaryMatch) return json(res, { success: false, error: 'No boundary' }, 400);

			const body = await parseBody(req);
			const parts = parseMultipart(body, boundaryMatch[1]);
			const categoryPart = parts.find(p => p.name === 'category');
			const filePart = parts.find(p => p.name === 'file' && p.filename);

			if (!categoryPart || !filePart) return json(res, { success: false, error: 'Missing fields' }, 400);

			const category = categoryPart.data.toString().trim();
			const destDir = path.join(ROOT, category);
			if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

			const destPath = path.join(destDir, filePart.filename);
			fs.writeFileSync(destPath, filePart.data);

			return json(res, { success: true, file: category + '/' + filePart.filename });
		}

		// ── API: Upload Skin (with 3D preview) ──
		if (pathname === '/api/upload-skin' && req.method === 'POST') {
			const contentType = req.headers['content-type'] || '';
			const boundaryMatch = contentType.match(/boundary=(.+)/);
			if (!boundaryMatch) return json(res, { success: false, error: 'No boundary' }, 400);

			const body = await parseBody(req);
			const parts = parseMultipart(body, boundaryMatch[1]);
			const weaponPart = parts.find(p => p.name === 'weapon');
			const filePart = parts.find(p => p.name === 'file' && p.filename);
			const previewPart = parts.find(p => p.name === 'preview');

			if (!weaponPart || !filePart) return json(res, { success: false, error: 'Missing weapon or file' }, 400);

			const weapon = weaponPart.data.toString().trim();
			const skinFolder = SKIN_FOLDERS[weapon];
			if (!skinFolder) return json(res, { success: false, error: 'Invalid weapon: ' + weapon }, 400);

			const destDir = path.join(ROOT, skinFolder);
			if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

			const skinName = path.basename(filePart.filename, path.extname(filePart.filename));
			fs.writeFileSync(path.join(destDir, filePart.filename), filePart.data);

			// Save preview
			if (previewPart && previewPart.data.length > 0) {
				const previewDir = path.join(ROOT, PREVIEW_FOLDER);
				if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
				fs.writeFileSync(
					path.join(previewDir, 'skin-' + weapon + '-' + skinName.toLowerCase() + '.webp'),
					previewPart.data
				);
			}

			regenerateManifestFile();
			return json(res, { success: true, file: skinFolder + '/' + filePart.filename });
		}

		// ── API: Upload Model (GLB + texture + preview) ──
		if (pathname === '/api/upload-model' && req.method === 'POST') {
			const contentType = req.headers['content-type'] || '';
			const boundaryMatch = contentType.match(/boundary=(.+)/);
			if (!boundaryMatch) return json(res, { success: false, error: 'No boundary' }, 400);

			const body = await parseBody(req);
			const parts = parseMultipart(body, boundaryMatch[1]);
			const weaponPart = parts.find(p => p.name === 'weapon');
			const modelPart = parts.find(p => p.name === 'model' && p.filename);
			const texturePart = parts.find(p => p.name === 'texture' && p.filename);
			const previewPart = parts.find(p => p.name === 'preview');

			if (!weaponPart || !modelPart) return json(res, { success: false, error: 'Missing weapon or model file' }, 400);

			const weapon = weaponPart.data.toString().trim();
			const modelFolder = MODEL_FOLDERS[weapon];
			if (!modelFolder) return json(res, { success: false, error: 'Invalid weapon: ' + weapon }, 400);

			const destDir = path.join(ROOT, modelFolder);
			if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

			// Save GLB model
			const modelName = path.basename(modelPart.filename, path.extname(modelPart.filename));
			fs.writeFileSync(path.join(destDir, modelPart.filename), modelPart.data);

			// Save texture as {modelName}_tex.{ext}
			if (texturePart) {
				const texExt = path.extname(texturePart.filename);
				const texName = modelName + '_tex' + texExt;
				fs.writeFileSync(path.join(destDir, texName), texturePart.data);
			}

			// Save preview
			if (previewPart && previewPart.data.length > 0) {
				const previewDir = path.join(ROOT, PREVIEW_FOLDER);
				if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
				fs.writeFileSync(
					path.join(previewDir, 'model-' + weapon + '-' + modelName.toLowerCase() + '.webp'),
					previewPart.data
				);
			}

			regenerateManifestFile();
			return json(res, { success: true, file: modelFolder + '/' + modelPart.filename });
		}

		// ── API: Save Preview (for existing or uploaded assets) ──
		if (pathname === '/api/save-preview' && req.method === 'POST') {
			const contentType = req.headers['content-type'] || '';
			const boundaryMatch = contentType.match(/boundary=(.+)/);
			if (!boundaryMatch) return json(res, { success: false, error: 'No boundary' }, 400);

			const body = await parseBody(req);
			const parts = parseMultipart(body, boundaryMatch[1]);
			const typePart = parts.find(p => p.name === 'type');
			const weaponPart = parts.find(p => p.name === 'weapon');
			const namePart = parts.find(p => p.name === 'name');
			const previewPart = parts.find(p => p.name === 'preview');

			if (!typePart || !namePart || !previewPart) return json(res, { success: false, error: 'Missing type, name, or preview' }, 400);

			const assetType = typePart.data.toString().trim();
			const weapon = weaponPart ? weaponPart.data.toString().trim() : '';
			const name = namePart.data.toString().trim();

			// Determine preview filename
			let previewName;
			if (assetType === 'skin') {
				previewName = 'skin-' + weapon + '-' + name + '.webp';
			} else if (assetType === 'model') {
				previewName = 'model-' + weapon + '-' + name + '.webp';
			} else {
				return json(res, { success: false, error: 'Invalid type: ' + assetType }, 400);
			}

			const previewDir = path.join(ROOT, PREVIEW_FOLDER);
			if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
			fs.writeFileSync(path.join(previewDir, previewName), previewPart.data);

			regenerateManifestFile();
			return json(res, { success: true, preview: PREVIEW_FOLDER + '/' + previewName });
		}

		// ── API: Upload Special (original + compressed preview) ──
		if (pathname === '/api/upload-special' && req.method === 'POST') {
			const contentType = req.headers['content-type'] || '';
			const boundaryMatch = contentType.match(/boundary=(.+)/);
			if (!boundaryMatch) return json(res, { success: false, error: 'No boundary' }, 400);

			const body = await parseBody(req);
			const parts = parseMultipart(body, boundaryMatch[1]);
			const filePart = parts.find(p => p.name === 'file' && p.filename);
			const previewPart = parts.find(p => p.name === 'preview');

			if (!filePart) return json(res, { success: false, error: 'Missing file' }, 400);

			const destDir = path.join(ROOT, SPECIAL_FOLDER);
			if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

			const specialName = path.basename(filePart.filename, path.extname(filePart.filename));
			fs.writeFileSync(path.join(destDir, filePart.filename), filePart.data);

			// Save compressed preview
			if (previewPart && previewPart.data.length > 0) {
				const previewDir = path.join(ROOT, PREVIEW_FOLDER);
				if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
				fs.writeFileSync(
					path.join(previewDir, 'special-' + specialName.toLowerCase() + '.webp'),
					previewPart.data
				);
			}

			regenerateManifestFile();
			return json(res, { success: true, file: SPECIAL_FOLDER + '/' + filePart.filename });
		}

		// ── API: Delete asset (with companion cleanup) ──
		if (pathname === '/api/asset' && req.method === 'DELETE') {
			const file = url.searchParams.get('file');
			if (!file) return json(res, { success: false, error: 'No file specified' }, 400);

			const absPath = path.join(ROOT, file);
			if (!absPath.startsWith(ROOT)) return json(res, { success: false, error: 'Invalid path' }, 403);
			if (!fs.existsSync(absPath)) return json(res, { success: false, error: 'File not found' }, 404);

			const ext = path.extname(file).toLowerCase();
			const baseName = path.basename(file, path.extname(file));
			const dirName = path.dirname(file);

			// Delete companion texture for models ({name}_tex.{ext})
			if (ext === '.glb') {
				for (const texExt of IMAGE_EXTS) {
					const texPath = path.join(ROOT, dirName, baseName + '_tex' + texExt);
					if (fs.existsSync(texPath)) {
						fs.unlinkSync(texPath);
					}
				}
			}

			// Delete matching preview from Previews/ folder
			let previewName = null;
			if (file.startsWith('Models/')) {
				// Models/AR/AK.glb → model-ar-ak.webp
				const parts = file.split('/');
				if (parts.length >= 3) {
					const weapon = parts[1].toLowerCase();
					previewName = 'model-' + weapon + '-' + baseName.toLowerCase() + '.webp';
				}
			} else if (file.startsWith(SPECIAL_FOLDER + '/')) {
				previewName = 'special-' + baseName.toLowerCase() + '.webp';
			} else {
				// Skin — derive weapon from folder
				for (const [weapon, folder] of Object.entries(SKIN_FOLDERS)) {
					if (file.startsWith(folder + '/')) {
						previewName = 'skin-' + weapon + '-' + baseName.toLowerCase() + '.webp';
						break;
					}
				}
			}
			if (previewName) {
				const previewPath = path.join(ROOT, PREVIEW_FOLDER, previewName);
				if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
			}

			fs.unlinkSync(absPath);
			regenerateManifestFile();
			return json(res, { success: true });
		}

		// ── API: Git push ──
		if (pathname === '/api/git-push' && req.method === 'POST') {
			try {
				execSync('git add .', { cwd: ROOT });
				const msg = 'Update store assets — ' + new Date().toISOString().slice(0, 10);
				execSync(`git commit -m "${msg}"`, { cwd: ROOT });
				execSync('git push', { cwd: ROOT });
				return json(res, { success: true, message: msg });
			} catch (err) {
				return json(res, { success: false, error: err.message });
			}
		}

		// ── Serve files ──
		if (pathname.startsWith('/file/') && req.method === 'GET') {
			const relPath = decodeURIComponent(pathname.slice(6));
			const absPath = path.join(ROOT, relPath);
			if (!absPath.startsWith(ROOT) || !fs.existsSync(absPath)) {
				res.writeHead(404);
				return res.end('Not found');
			}
			const stat = fs.statSync(absPath);
			res.writeHead(200, {
				'Content-Type': getMimeType(absPath),
				'Content-Length': stat.size,
				'Cache-Control': 'max-age=300',
			});
			fs.createReadStream(absPath).pipe(res);
			return;
		}

		// 404
		res.writeHead(404);
		res.end('Not found');

	} catch (err) {
		console.error('[Store Manager] Error:', err);
		json(res, { error: err.message }, 500);
	}
});

server.listen(PORT, () => {
	console.log(`\n  Haze Store Manager running at http://localhost:${PORT}\n`);

	// Ensure Previews and DefaultModels folders exist
	const previewDir = path.join(ROOT, PREVIEW_FOLDER);
	const defaultModelsDir = path.join(ROOT, DEFAULT_MODELS_FOLDER);
	if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
	if (!fs.existsSync(defaultModelsDir)) fs.mkdirSync(defaultModelsDir, { recursive: true });

	// Auto-open browser
	const openCmd = process.platform === 'win32' ? 'start'
		: process.platform === 'darwin' ? 'open'
		: 'xdg-open';
	try {
		execSync(`${openCmd} http://localhost:${PORT}`, { stdio: 'ignore' });
	} catch { /* silent */ }
});
