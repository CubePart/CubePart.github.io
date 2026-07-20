/* CubePart — interactive part viewer
 * Loads a .glb, treats every direct child of the root as a "part",
 * supports orbit/zoom, explode slider, and per-part hover labels.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/* Pastel palette similar to the paper's part colors. */
const PART_COLORS = [
  0xa0c8e8,  // light blue
  0xf2a7b8,  // pink
  0xa3d9b1,  // green
  0xf2d28b,  // sand
  0xc7a7e3,  // lavender
  0x9fd8d2,  // teal
  0xf5b894,  // peach
  0xf2e29c,  // pale yellow
  0xb4b8e8,  // periwinkle
  0xe8a7d0,  // rose
  0x9bccaf,  // sage
  0xd2c4a2,  // khaki
];

function prettifyName(name) {
  if (!name) return 'part';
  // Strip leading "part_N_" prefix common in our GLB exports
  let n = name.replace(/^part_\d+_/i, '');
  // Underscores -> spaces
  n = n.replace(/_/g, ' ');
  // Trim, then Title Case
  n = n.trim();
  return n.split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

class PartViewer {
  constructor(el) {
    this.el = el;
    this.glb = el.dataset.glb;
    this.canvasHolder = el.querySelector('.pv-canvas');
    this.tooltip = el.querySelector('.pv-tooltip');
    this.legend = el.querySelector('.pv-legend');
    this.slider = el.querySelector('.pv-explode');
    this.resetBtn = el.querySelector('.pv-reset');
    this.loadingEl = el.querySelector('.pv-loading');

    this.parts = [];
    this.partMeta = []; // { mesh, name, baseColor, originalPos, explodeDir }
    this.explodeAmount = 0;
    this.hovered = null;
    this.disposed = false;
    // When false, _tick still runs but skips renderer.render to keep WebGL idle.
    // We flip this from an IntersectionObserver in bootViewers().
    this.visible = true;

    this._init();
  }

  _init() {
    const w = this.canvasHolder.clientWidth;
    const h = this.canvasHolder.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 100);
    this.camera.position.set(2.5, 1.4, 3.0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.canvasHolder.appendChild(this.renderer.domElement);

    this._contextLostHandler = (e) => {
      e.preventDefault();
      if (this.disposed) return;
      this._handleContextLost();
    };
    this.renderer.domElement.addEventListener(
      'webglcontextlost',
      this._contextLostHandler,
      false,
    );

    // Lighting — soft key/fill/back + ambient
    const hemi = new THREE.HemisphereLight(0xffffff, 0xc8c0a8, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(3, 4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff0d8, 0.35);
    fill.position.set(-3, 2, -1);
    this.scene.add(fill);
    const back = new THREE.DirectionalLight(0xe6e6ff, 0.45);
    back.position.set(0, 1, -4);
    this.scene.add(back);
    const amb = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(amb);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 12;
    this.controls.enablePan = false;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this._bindEvents();
    this._loadGLB(this.glb);
    this._tick();
  }

  _bindEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', (e) => this._onPointerMove(e));
    dom.addEventListener('pointerleave', () => this._clearHover());

    if (this.slider) {
      this.slider.addEventListener('input', () => {
        this.explodeAmount = Number(this.slider.value);
        this._applyExplode();
      });
    }
    if (this.resetBtn) {
      this.resetBtn.addEventListener('click', () => {
        if (this.slider) this.slider.value = 0;
        this.explodeAmount = 0;
        this._applyExplode();
        this._resetCamera();
      });
    }

    // Resize handling via ResizeObserver
    this._ro = new ResizeObserver(() => this._onResize());
    this._ro.observe(this.canvasHolder);
  }

  _onResize() {
    if (this.disposed) return;
    const w = this.canvasHolder.clientWidth;
    const h = this.canvasHolder.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async _loadGLB(url) {
    const loader = new GLTFLoader();
    // Register Meshopt decoder so gltfpack -c/-cc compressed files work.
    loader.setMeshoptDecoder(MeshoptDecoder);
    try {
      const gltf = await loader.loadAsync(url);
      if (this.disposed) return;
      this._processGLB(gltf.scene);
      this._buildLegend();
      this._resetCamera(true);
      if (this.loadingEl) this.loadingEl.classList.add('hidden');
    } catch (err) {
      console.error('Failed to load', url, err);
      if (this.loadingEl) {
        this.loadingEl.classList.remove('hidden');
        this.loadingEl.textContent = 'Failed to load 3D model.';
      }
    }
  }

  _processGLB(root) {
    // Normalize: center model around origin and uniform scale
    const bbox = new THREE.Box3().setFromObject(root);
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z);
    const scale = 1.6 / Math.max(maxSize, 1e-3);

    root.position.sub(center);
    const scaleGroup = new THREE.Group();
    scaleGroup.scale.setScalar(scale);
    scaleGroup.add(root);
    this.scene.add(scaleGroup);
    this.modelRoot = scaleGroup;

    // Collect parts: each direct child of the "world"-like root,
    // or every top-level child if the GLB has multiple roots.
    // We pick the first child of root which is the asset's "world" group, then iterate.
    let partRoots = [];
    if (root.children.length === 1 && root.children[0].children.length > 1) {
      partRoots = root.children[0].children.slice();
    } else if (root.children.length > 1) {
      partRoots = root.children.slice();
    } else {
      partRoots = [root];
    }

    const palette = PART_COLORS;
    partRoots.forEach((part, i) => {
      const color = new THREE.Color(palette[i % palette.length]);
      const baseMat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.62,
        metalness: 0.02,
        flatShading: false,
      });
      const meshList = [];
      part.traverse((c) => {
        if (c.isMesh) {
          c.material = baseMat;
          c.geometry.computeVertexNormals?.();
          meshList.push(c);
        }
      });
      if (meshList.length === 0) return;

      // Centroid of this part in scaled world coords
      const partBbox = new THREE.Box3().setFromObject(part);
      const partCenter = partBbox.getCenter(new THREE.Vector3());

      this.partMeta.push({
        node: part,
        meshes: meshList,
        material: baseMat,
        baseColor: color.clone(),
        emissiveBase: new THREE.Color(0x000000),
        name: prettifyName(part.name || `Part ${i + 1}`),
        originalPos: part.position.clone(),
        partCenter,
      });
    });

    // Compute global center for explode direction
    const globalCenter = new THREE.Vector3();
    this.partMeta.forEach((p) => globalCenter.add(p.partCenter));
    globalCenter.multiplyScalar(1 / Math.max(this.partMeta.length, 1));

    this.partMeta.forEach((p) => {
      // direction from global center to part center
      const dir = p.partCenter.clone().sub(globalCenter);
      // Convert back from world-scaled into local of part's parent for translation
      // Since parts share the same parent (root scaled by `scale`), the explode
      // vector in local coords is just dir / scale.
      dir.multiplyScalar(1 / scale);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.001, 0);
      p.explodeDir = dir;
    });
  }

  _buildLegend() {
    if (!this.legend) return;
    this.legend.innerHTML = '';
    this.partMeta.forEach((p, idx) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'pv-chip';
      chip.dataset.idx = idx;
      const hex = '#' + p.baseColor.getHexString();
      chip.innerHTML = `<span class="pv-chip-swatch" style="background:${hex}"></span><span class="pv-chip-label">${p.name}</span>`;
      chip.addEventListener('mouseenter', () => this._setHover(idx));
      chip.addEventListener('mouseleave', () => this._clearHover());
      this.legend.appendChild(chip);
    });
  }

  _applyExplode() {
    const t = this.explodeAmount; // 0..1
    this.partMeta.forEach((p) => {
      const off = p.explodeDir.clone().multiplyScalar(t * 0.6);
      p.node.position.copy(p.originalPos).add(off);
    });
  }

  _resetCamera(initial = false) {
    if (!this.modelRoot) return;
    const bbox = new THREE.Box3().setFromObject(this.modelRoot);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.65;
    const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360) * 1.2;
    const dir = new THREE.Vector3(1.2, 0.7, 1.6).normalize();
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.controls.target.copy(center);
    this.controls.update();
  }

  _onPointerMove(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Build a list of all candidate meshes
    const candidates = [];
    this.partMeta.forEach((p, i) => p.meshes.forEach((m) => {
      m.userData.__partIdx = i;
      candidates.push(m);
    }));
    const hits = this.raycaster.intersectObjects(candidates, false);
    if (hits.length === 0) {
      this._clearHover();
      return;
    }
    const idx = hits[0].object.userData.__partIdx;
    this._setHover(idx, e.clientX, e.clientY);
  }

  _setHover(idx, x, y) {
    const fromMouse = (x != null && y != null);
    if (this.hovered === idx) {
      this.hoverFromMouse = fromMouse;
      this._updateTooltipPos(x, y);
      return;
    }
    this._clearHover();
    this.hovered = idx;
    this.hoverFromMouse = fromMouse;
    const p = this.partMeta[idx];
    if (!p) return;

    // Highlight: brighten color + slight emissive
    p.material.emissive = new THREE.Color(0x222222);
    p.material.color.copy(p.baseColor).multiplyScalar(1.18);
    p.material.needsUpdate = true;

    if (this.tooltip) {
      const hex = '#' + p.baseColor.getHexString();
      this.tooltip.innerHTML =
        `<span class="pv-tooltip-dot" style="background:${hex}"></span>` +
        `<span class="pv-tooltip-text"></span>`;
      this.tooltip.querySelector('.pv-tooltip-text').textContent = p.name;
      this.tooltip.classList.add('visible');
      this._updateTooltipPos(x, y);
    }
    // Also highlight legend chip
    if (this.legend) {
      this.legend.querySelectorAll('.pv-chip').forEach((c) => c.classList.toggle('active', Number(c.dataset.idx) === idx));
    }
  }

  /** Position the tooltip. If x/y are provided, anchor to the cursor;
   *  otherwise project the hovered part's 3D center into screen space. */
  _updateTooltipPos(x, y) {
    if (!this.tooltip) return;
    const rect = this.canvasHolder.getBoundingClientRect();
    let localX, localY;

    if (x != null && y != null) {
      localX = x - rect.left;
      localY = y - rect.top;
    } else if (this.hovered != null) {
      const p = this.partMeta[this.hovered];
      if (!p) return;
      // Recompute the part's world-space center (changes with explode + camera state)
      const bbox = new THREE.Box3().setFromObject(p.node);
      if (bbox.isEmpty()) return;
      const center = bbox.getCenter(new THREE.Vector3());
      const projected = center.clone().project(this.camera);

      // If the part is behind the camera, hide the tooltip.
      if (projected.z > 1) {
        this.tooltip.classList.remove('visible');
        return;
      }
      this.tooltip.classList.add('visible');
      localX = (projected.x * 0.5 + 0.5) * rect.width;
      localY = (-projected.y * 0.5 + 0.5) * rect.height;
    } else {
      return;
    }

    // Tooltip is rendered with translate(-50%, -135%) — clamp so the pill
    // never sticks out of the canvas regardless of which corner we're near.
    const pad = 8;
    const tw = this.tooltip.offsetWidth || 80;
    const th = this.tooltip.offsetHeight || 24;
    localX = Math.max(tw / 2 + pad, Math.min(rect.width - tw / 2 - pad, localX));
    localY = Math.max(th * 1.35 + pad, Math.min(rect.height + th * 0.35 - pad, localY));

    this.tooltip.style.left = `${localX}px`;
    this.tooltip.style.top = `${localY}px`;
  }

  _clearHover() {
    if (this.hovered == null) return;
    const p = this.partMeta[this.hovered];
    if (p) {
      p.material.emissive = new THREE.Color(0x000000);
      p.material.color.copy(p.baseColor);
      p.material.needsUpdate = true;
    }
    this.hovered = null;
    if (this.tooltip) this.tooltip.classList.remove('visible');
    if (this.legend) {
      this.legend.querySelectorAll('.pv-chip').forEach((c) => c.classList.remove('active'));
    }
  }

  _tick() {
    if (this.disposed) return;
    if (this.visible) {
      this.controls.update();
      // Keep the legend-anchored tooltip glued to the part as the camera moves.
      if (this.hovered != null && !this.hoverFromMouse) {
        this._updateTooltipPos();
      }
      this.renderer.render(this.scene, this.camera);
    }
    requestAnimationFrame(() => this._tick());
  }

  _handleContextLost() {
    // Rebuild only if this is still the card's current viewer. This guard is
    // important because context-loss events may arrive after a replacement
    // viewer has already been attached to the same card.
    if (!this.el || this.el._pv !== this) return;
    if (this.loadingEl) {
      this.loadingEl.classList.remove('hidden');
      this.loadingEl.textContent = 'Reloading 3D model\u2026';
    }
    const card = this.el;
    this.dispose(false);
    card._pv = null;
    card.dispatchEvent(new Event('pv-reboot'));
  }

  dispose(forceContextLoss = true) {
    if (this.disposed) return;
    this.disposed = true;
    this._ro?.disconnect();
    this._clearHover();

    // Release GPU geometry/material memory before dropping the context.
    if (this.modelRoot) {
      this.modelRoot.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => m?.dispose?.());
        }
      });
      this.scene?.remove(this.modelRoot);
    }

    this.controls?.dispose?.();
    this.renderer.domElement.removeEventListener(
      'webglcontextlost',
      this._contextLostHandler,
      false,
    );
    this.renderer.dispose();
    if (forceContextLoss) this.renderer.forceContextLoss?.();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    this.partMeta = [];
    this.parts = [];
  }
}

// ----- Lazy boot via IntersectionObserver so we only spin up viewers in view -----
//
// Every viewer owns a WebGL context. Safari enforces a low per-page context
// limit, so viewers exist only while their cards are near the viewport. This
// keeps the live count small on pages containing 20+ cards.

function bootViewers() {
  const cards = document.querySelectorAll('[data-pv]');
  if (cards.length === 0) return;

  function createViewer(card) {
    if (card._pv) return;
    const loading = card.querySelector('.pv-loading');
    if (loading) {
      loading.textContent = 'Loading model\u2026';
      loading.classList.remove('hidden');
    }
    try {
      card._pv = new PartViewer(card);
    } catch (e) {
      card._pv = null;
      if (loading) loading.textContent = '3D viewer unavailable.';
      console.error('viewer init failed', e);
    }
  }

  function destroyViewer(card) {
    if (!card._pv) return;
    card._pv.dispose();
    card._pv = null;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const card = entry.target;
      card._pvInRange = entry.isIntersecting;
      if (entry.isIntersecting) {
        createViewer(card);
      } else {
        destroyViewer(card);
      }
    });
  }, { rootMargin: '300px 0px' });

  cards.forEach((card) => {
    card.addEventListener('pv-reboot', () => {
      if (card._pvInRange && !card._pv) {
        requestAnimationFrame(() => createViewer(card));
      }
    });
    observer.observe(card);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootViewers, { once: true });
} else {
  // A module loaded through the Safari import-map shim can finish after
  // DOMContentLoaded has already fired.
  bootViewers();
}
