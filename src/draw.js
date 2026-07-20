// Floor annotations for teaching diagrams: lines, arrows, circles, and text
// drawn flat on the dance floor (topbar Draw mode; scriptable through
// app.addDrawLine / addDrawArrow / addDrawCircle / addDrawText). Each
// annotation is an Object3D in `group` carrying its parameters in
// userData.annotation; a rubber-band preview of the shape being authored
// lives in `previewGroup` so committed drawings never mix with it.
import * as THREE from 'three';

const DRAW_COLOR = 0xffd27f; // chalk amber, readable on the dark wood
const DRAW_Y = 0.008;        // above the hull/trail lines (0.004/0.006)
const LINE_W = 0.02;         // stroke width in metres
const HEAD_W = 0.075;        // arrow head width
const HEAD_L = 0.1;          // arrow head length
const TEXT_H = 0.16;         // world height of a text line in metres

function disposeObject(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    o.material.map?.dispose();
    o.material.dispose();
  });
}

export class Drawings {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'drawings';
    this.previewGroup = new THREE.Group();
    this.previewGroup.name = 'drawing-preview';
  }

  // Chalk material: no depth write and a slight polygon offset so strokes never
  // z-fight the floor (they also sit DRAW_Y above it), double-sided so grazing
  // camera angles can't cull them.
  #material({ preview = false, mat = {} } = {}) {
    return new THREE.MeshBasicMaterial({
      color: DRAW_COLOR,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: preview ? 0.45 : 0.95,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      ...mat,
    });
  }

  // Flat rectangle from a to b (XZ floor points), lying on the floor.
  #stroke(a, b, width, material) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const geo = new THREE.PlaneGeometry(Math.max(len, 1e-4), width);
    geo.rotateX(-Math.PI / 2); // long axis along +x, lying in the floor plane
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set((a.x + b.x) / 2, DRAW_Y, (a.z + b.z) / 2);
    mesh.rotation.y = Math.atan2(-dz, dx);
    return mesh;
  }

  #commit(obj, annotation, preview) {
    obj.userData.annotation = annotation;
    obj.traverse((o) => { o.renderOrder = 2; }); // over the balance hull/trail lines
    if (preview) {
      this.clearPreview();
      this.previewGroup.add(obj);
    } else {
      this.group.add(obj);
    }
    return obj;
  }

  addLine(a, b, { preview = false } = {}) {
    const g = new THREE.Group();
    g.add(this.#stroke(a, b, LINE_W, this.#material({ preview })));
    return this.#commit(g, { type: 'line', a: [a.x, a.z], b: [b.x, b.z] }, preview);
  }

  addArrow(a, b, { preview = false } = {}) {
    const mat = this.#material({ preview });
    const g = new THREE.Group();
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    const len = dir.length();
    const headL = Math.min(HEAD_L, Math.max(len * 0.5, 1e-3));
    if (len > 1e-6) dir.divideScalar(len);
    const shaftEnd = new THREE.Vector3(b.x, 0, b.z).addScaledVector(dir, -headL);
    g.add(this.#stroke(a, shaftEnd, LINE_W, mat));
    // Flat triangular head, tip at b, aimed along a→b.
    const w = HEAD_W * (headL / HEAD_L);
    const head = new THREE.BufferGeometry();
    head.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      -headL, 0, -w / 2,
      -headL, 0, w / 2,
    ], 3));
    head.computeVertexNormals();
    const headMesh = new THREE.Mesh(head, mat);
    headMesh.position.set(b.x, DRAW_Y, b.z);
    headMesh.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
    g.add(headMesh);
    return this.#commit(g, { type: 'arrow', a: [a.x, a.z], b: [b.x, b.z] }, preview);
  }

  addCircle(center, radius, { preview = false } = {}) {
    const r = Math.max(radius, 0.02);
    const geo = new THREE.RingGeometry(Math.max(r - LINE_W / 2, 0.005), r + LINE_W / 2, 64);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.#material({ preview }));
    mesh.position.set(center.x, DRAW_Y, center.z);
    return this.#commit(mesh, { type: 'circle', center: [center.x, center.z], radius: r }, preview);
  }

  // Text lies flat on the floor; `yaw` orients it (0 = readable looking along
  // -z). The caller usually derives yaw from the camera so the label reads
  // right-way-up from the current viewpoint.
  addText(pos, text, yaw = 0, { preview = false } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = '600 64px "Segoe UI", system-ui, sans-serif';
    ctx.font = font;
    const pad = 16;
    canvas.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + pad * 2);
    canvas.height = 64 + pad * 2;
    ctx.font = font; // resizing the canvas resets its 2d state
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(20, 12, 4, 0.85)'; // dark halo so it reads on light planks
    ctx.strokeText(text, pad, canvas.height / 2);
    ctx.fillStyle = '#ffd27f';
    ctx.fillText(text, pad, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const geo = new THREE.PlaneGeometry(TEXT_H * canvas.width / canvas.height, TEXT_H);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.#material({ preview, mat: { map: tex, color: 0xffffff, opacity: 1 } }));
    mesh.position.set(pos.x, DRAW_Y, pos.z);
    mesh.rotation.y = yaw;
    return this.#commit(mesh, { type: 'text', pos: [pos.x, pos.z], text, yaw }, preview);
  }

  // Rubber-band preview while the second click is still pending.
  showPreview(tool, a, b) {
    if (tool === 'line') this.addLine(a, b, { preview: true });
    else if (tool === 'arrow') this.addArrow(a, b, { preview: true });
    else if (tool === 'circle') this.addCircle(a, a.distanceTo(b), { preview: true });
  }

  clearPreview() {
    for (const o of [...this.previewGroup.children]) {
      this.previewGroup.remove(o);
      disposeObject(o);
    }
  }

  removeLast() {
    const o = this.group.children[this.group.children.length - 1];
    if (!o) return false;
    this.group.remove(o);
    disposeObject(o);
    return true;
  }

  clear() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      disposeObject(o);
    }
  }

  list() {
    return this.group.children.map((o) => o.userData.annotation);
  }

  get count() {
    return this.group.children.length;
  }
}
