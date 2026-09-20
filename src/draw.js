// Floor annotations for teaching diagrams: lines, arrows, circles, and text
// drawn flat on the dance floor (topbar Draw mode; scriptable through
// app.addDrawLine / addDrawArrow / addDrawCircle / addDrawText). Each
// annotation is an Object3D in `group` carrying its parameters in
// userData.annotation; a rubber-band preview of the shape being authored
// lives in `previewGroup` so committed drawings never mix with it.
//
// The annotation IS the drawing: every shape is rebuilt from that record by
// #build, so changing a colour, a stroke width or an endpoint is the same
// operation — edit the record, rebuild. That is what lets a committed shape be
// restyled and re-shaped after the fact (`restyle` / `moveHandle`) instead of
// being redrawn from scratch, and it keeps the authored parameters and the
// geometry from ever disagreeing.
//
// A line or arrow END can instead be ANCHORED TO A JOINT (`aAt`/`bAt` =
// { fig, joint }), which is what makes the floor plane stop being the only
// place a teacher can draw: a line from the standing hip to the free shoulder
// says something about the dancer, and it has to ride the dancer to go on
// saying it. An anchored shape leaves the floor and is built as real 3D
// geometry (a tube, with a cone for an arrow head) whose transform is
// refreshed each frame by updateAnchored — cheap, because the mesh is a unit
// cylinder that is only re-placed, never rebuilt.
import * as THREE from 'three';

const DRAW_COLOR = '#ffd27f'; // chalk amber, readable on the dark wood
const DRAW_Y = 0.008;        // above the hull/trail lines (0.004/0.006)
const LINE_W = 0.02;         // default stroke width in metres
const HEAD_W = 0.075;        // arrow head width at the default stroke width
const HEAD_L = 0.1;          // arrow head length at the default stroke width
const TEXT_H = 0.16;         // world height of a text line at the default width

// The stroke width the toolbar offers, in metres: thin enough to annotate a
// single foot, fat enough to read from the back of a room.
export const DRAW_WIDTH_RANGE = { min: 0.006, max: 0.06, step: 0.002 };
export const DEFAULT_DRAW_STYLE = { color: DRAW_COLOR, width: LINE_W };

// Endpoint handles: a small ball at each movable point of the SELECTED
// annotation, drawn through everything so it can always be grabbed (a handle
// buried under the shape it edits is no handle at all). SOLID, and a ball
// rather than a disc, for two reasons the geometry has to answer: the ray is
// cast at whatever the cursor is over and a ring is a hole, so aiming at the
// middle of one — exactly where a user aims — misses it entirely; and an
// anchored end floats in space, where a disc lying in the floor plane is seen
// edge-on and disappears.
const HANDLE_R = 0.04;
const HANDLE_COLOR = 0xffffff;

// A shape that has left the floor is drawn THROUGH the dancers (depth test off,
// late render order), like the COG indicator's in-front mode. A line joining
// two joints is about the relationship between them, so burying it in the torso
// on the way past defeats the annotation; the anchors themselves are the depth
// cue. Shared by the tube and its arrow head.
const ANCHORED_RENDER_ORDER = 6;

// One unit-cylinder, reused by every 3D stroke: a tube from (0,0,0) to (0,1,0)
// of radius 1, so a stroke is a scale + a rotation + a position, and moving with
// the dancer costs no geometry work at all.
const UNIT_TUBE = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false);
UNIT_TUBE.translate(0, 0.5, 0);
const UNIT_CONE = new THREE.ConeGeometry(1, 1, 14, 1);
UNIT_CONE.translate(0, -0.5, 0); // tip at the origin, base back along -y
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

// Lay a unit tube/cone mesh along a → b (both THREE.Vector3).
function placeAlong(mesh, a, b, radius, { fromEnd = false, length = null } = {}) {
  _dir.subVectors(b, a);
  const len = Math.max(_dir.length(), 1e-5);
  _dir.divideScalar(len);
  mesh.quaternion.setFromUnitVectors(_up, _dir);
  const span = length ?? len;
  mesh.scale.set(radius, span, radius);
  mesh.position.copy(fromEnd ? b : a);
  mesh.updateMatrixWorld(true);
  return len;
}

function disposeObject(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    // UNIT_TUBE / UNIT_CONE are shared by every 3D stroke ever built — disposing
    // one with the shape that happened to use it would strip the buffers out
    // from under all the others.
    if (o.geometry !== UNIT_TUBE && o.geometry !== UNIT_CONE) o.geometry.dispose();
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
    // The selected annotation's endpoint handles. Their own group so they are
    // never mistaken for scene content (list(), removeLast(), clear()).
    this.handleGroup = new THREE.Group();
    this.handleGroup.name = 'drawing-handles';
    // The look the NEXT shape is authored in (the Draw toolbar's swatch and
    // width slider write here).
    this.style = { ...DEFAULT_DRAW_STYLE };
    this.selected = null;
    // The dancers an anchored end may ride, by index (0 = leader). Stored as
    // indices in the annotation so a sequence/JSON round trip survives.
    this.figures = [];
  }

  setFigures(figures) {
    this.figures = figures || [];
  }

  // ------------------------------------------------------------- anchors
  // An end is either a floor point (`a: [x, z]`, the original and still the
  // default) or a joint of a dancer (`aAt: { fig, joint }`). This is the ONE
  // place that choice is resolved, so authoring, rebuilding, the per-frame
  // refresh and the handles can never disagree about where an end is.
  //
  // The joint is read through `surfacePos`, not `worldPos`: the question a
  // drawn line asks is "where is this dancer physically", which is the node the
  // visible body is welded to — the two differ by up to ~18 cm on a flexed arm
  // (see the two-frames rule in CLAUDE.md).
  endWorld(ann, which, out = new THREE.Vector3()) {
    const at = which === 'a' ? ann.aAt : ann.bAt;
    const fig = at && this.figures[at.fig];
    if (fig && fig.nodes?.[at.joint]) return fig.surfacePos(at.joint, out);
    const p = which === 'a' ? ann.a : ann.b;
    // An anchor whose dancer is hidden or gone falls back to the floor point
    // kept beside it, so the line stays drawable instead of collapsing.
    return out.set(p[0], DRAW_Y, p[1]);
  }

  // Does this shape leave the floor? Only an anchored end does that today.
  static anchored(ann) {
    return !!(ann && (ann.aAt || ann.bAt));
  }

  get anchoredCount() {
    return this.group.children.filter((o) => Drawings.anchored(o.userData.annotation)).length;
  }

  setStyle({ color, width } = {}) {
    if (color) this.style.color = color;
    if (Number.isFinite(width)) this.style.width = width;
    return this.style;
  }

  // Chalk material: no depth write and a slight polygon offset so strokes never
  // z-fight the floor (they also sit DRAW_Y above it), double-sided so grazing
  // camera angles can't cull them.
  #material({ preview = false, color = DRAW_COLOR, mat = {} } = {}) {
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
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

  // ------------------------------------------------------------- annotations
  // Fill in whatever the caller left out, so every stored record is complete
  // and a drawing saved before colour/width existed still rebuilds.
  #styled(ann, { color, width } = {}) {
    return {
      ...ann,
      color: color ?? ann.color ?? this.style.color,
      width: width ?? ann.width ?? this.style.width,
    };
  }

  // The one place an annotation becomes geometry. Callers never build meshes
  // themselves — that is what keeps a rebuild identical to the first draw.
  #build(ann, preview) {
    const { color } = ann;
    const w = ann.width ?? LINE_W;
    // An anchored line/arrow is real 3D geometry, laid out by #placeAnchored
    // (which also runs every frame). Built once as unit meshes: the dancer
    // moving only ever changes a transform.
    if ((ann.type === 'line' || ann.type === 'arrow') && Drawings.anchored(ann)) {
      const g = new THREE.Group();
      const mat = this.#material({
        preview, color,
        mat: { depthTest: false, side: THREE.FrontSide, polygonOffset: false },
      });
      g.add(new THREE.Mesh(UNIT_TUBE, mat));
      if (ann.type === 'arrow') g.add(new THREE.Mesh(UNIT_CONE, mat));
      g.userData.anchored = true;
      this.#placeAnchored(g, ann);
      return g;
    }
    if (ann.type === 'line') {
      const g = new THREE.Group();
      const a = { x: ann.a[0], z: ann.a[1] };
      const b = { x: ann.b[0], z: ann.b[1] };
      g.add(this.#stroke(a, b, w, this.#material({ preview, color })));
      return g;
    }
    if (ann.type === 'arrow') {
      const mat = this.#material({ preview, color });
      const g = new THREE.Group();
      const a = { x: ann.a[0], z: ann.a[1] };
      const b = { x: ann.b[0], z: ann.b[1] };
      const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
      const len = dir.length();
      // The head scales with the stroke, or a fat line grows a pinhead and a
      // hairline sprouts a spearhead.
      const scale = w / LINE_W;
      const headL = Math.min(HEAD_L * scale, Math.max(len * 0.5, 1e-3));
      if (len > 1e-6) dir.divideScalar(len);
      const shaftEnd = new THREE.Vector3(b.x, 0, b.z).addScaledVector(dir, -headL);
      g.add(this.#stroke(a, shaftEnd, w, mat));
      // Flat triangular head, tip at b, aimed along a→b.
      const hw = HEAD_W * (headL / HEAD_L);
      const head = new THREE.BufferGeometry();
      head.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0,
        -headL, 0, -hw / 2,
        -headL, 0, hw / 2,
      ], 3));
      head.computeVertexNormals();
      const headMesh = new THREE.Mesh(head, mat);
      headMesh.position.set(b.x, DRAW_Y, b.z);
      headMesh.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
      g.add(headMesh);
      return g;
    }
    if (ann.type === 'circle') {
      const r = Math.max(ann.radius, 0.02);
      const geo = new THREE.RingGeometry(Math.max(r - w / 2, 0.005), r + w / 2, 64);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.#material({ preview, color }));
      mesh.position.set(ann.center[0], DRAW_Y, ann.center[1]);
      return mesh;
    }
    // Text lies flat on the floor; `yaw` orients it (0 = readable looking along
    // -z). The caller usually derives yaw from the camera so the label reads
    // right-way-up from the current viewpoint. Its size follows the stroke
    // width, so one slider sets the weight of the whole diagram.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = '600 64px "Segoe UI", system-ui, sans-serif';
    ctx.font = font;
    const pad = 16;
    canvas.width = Math.max(2, Math.ceil(ctx.measureText(ann.text).width) + pad * 2);
    canvas.height = 64 + pad * 2;
    ctx.font = font; // resizing the canvas resets its 2d state
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(20, 12, 4, 0.85)'; // dark halo so it reads on light planks
    ctx.strokeText(ann.text, pad, canvas.height / 2);
    ctx.fillStyle = color;
    ctx.fillText(ann.text, pad, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const h = TEXT_H * (w / LINE_W);
    const geo = new THREE.PlaneGeometry(h * canvas.width / canvas.height, h);
    geo.rotateX(-Math.PI / 2);
    // The glyphs carry the colour (baked into the canvas), so the material
    // must not tint them a second time.
    const mesh = new THREE.Mesh(geo, this.#material({ preview, mat: { map: tex, color: 0xffffff, opacity: preview ? 0.45 : 1 } }));
    mesh.position.set(ann.pos[0], DRAW_Y, ann.pos[1]);
    mesh.rotation.y = ann.yaw;
    return mesh;
  }

  // Lay an anchored shape's unit meshes between its two live end points. Called
  // at build time and again every frame the dancers move — nothing here
  // allocates, so it is safe in the render loop.
  #placeAnchored(obj, ann) {
    const r = (ann.width ?? LINE_W) / 2;
    this.endWorld(ann, 'a', _pa);
    this.endWorld(ann, 'b', _pb);
    const [tube, head] = obj.children;
    if (ann.type === 'arrow') {
      const len = _pa.distanceTo(_pb);
      // The head scales with the stroke and is capped on a short arrow, exactly
      // as the flat one is — a fat line must not grow a pinhead.
      const headL = Math.min(HEAD_L * (r * 2 / LINE_W), Math.max(len * 0.5, 1e-3));
      placeAlong(tube, _pa, _pb, r, { length: Math.max(len - headL, 1e-4) });
      if (head) {
        placeAlong(head, _pa, _pb, HEAD_W * (headL / HEAD_L) / 2, { fromEnd: true, length: headL });
      }
    } else {
      placeAlong(tube, _pa, _pb, r);
    }
    obj.updateMatrixWorld(true);
  }

  // Re-place every anchored shape against the dancers' current pose. main.js
  // calls this from the render loop; it no-ops when nothing is anchored.
  updateAnchored() {
    for (const o of this.group.children) {
      const ann = o.userData.annotation;
      if (Drawings.anchored(ann)) this.#placeAnchored(o, ann);
    }
    for (const o of this.previewGroup.children) {
      const ann = o.userData.annotation;
      if (Drawings.anchored(ann)) this.#placeAnchored(o, ann);
    }
    // The handles ride along, but by moving the meshes — rebuilding them every
    // frame would churn geometry for a drag that is already in flight.
    if (this.selected && Drawings.anchored(this.selected.userData.annotation)) this.#syncHandles();
  }

  #commit(obj, annotation, preview) {
    obj.userData.annotation = annotation;
    // Floor strokes sit just over the hull/trail lines; a shape that has left
    // the floor draws through the dancers instead (see ANCHORED_RENDER_ORDER).
    const order = obj.userData.anchored ? ANCHORED_RENDER_ORDER : 2;
    obj.traverse((o) => { o.renderOrder = order; });
    // Raycasting reads matrixWorld, which three otherwise only refreshes at
    // render time — and rendering here is on demand. Without this a shape (or,
    // via #replace, a rebuilt one) is unpickable until a frame happens to go
    // out, so the first hover or click after it appears silently misses.
    obj.updateMatrixWorld(true);
    if (preview) {
      this.clearPreview();
      this.previewGroup.add(obj);
    } else {
      this.group.add(obj);
    }
    return obj;
  }

  // An end passed to addLine/addArrow is either a floor point ({x, z}) or a
  // joint anchor ({ fig, joint }). Both forms produce the SAME record shape —
  // the floor pair is always filled in, so an anchor that later loses its
  // dancer still has somewhere to fall back to and detaching needs no special
  // case. `fig` accepts an index or 'leader'/'follower'.
  #end(p, ann, key) {
    if (p && p.joint) {
      const fig = typeof p.fig === 'string'
        ? (p.fig === 'follower' ? 1 : 0)
        : (p.fig ?? 0);
      ann[`${key}At`] = { fig, joint: p.joint };
      const w = this.figures[fig]?.surfacePos?.(p.joint, new THREE.Vector3());
      ann[key] = w ? [w.x, w.z] : [0, 0];
    } else {
      ann[`${key}At`] = null;
      ann[key] = [p.x, p.z];
    }
    return ann;
  }

  addLine(a, b, opts = {}) {
    const base = this.#end(b, this.#end(a, { type: 'line' }, 'a'), 'b');
    const ann = this.#styled(base, opts);
    return this.#commit(this.#build(ann, opts.preview), ann, opts.preview);
  }

  addArrow(a, b, opts = {}) {
    const base = this.#end(b, this.#end(a, { type: 'arrow' }, 'a'), 'b');
    const ann = this.#styled(base, opts);
    return this.#commit(this.#build(ann, opts.preview), ann, opts.preview);
  }

  addCircle(center, radius, opts = {}) {
    const ann = this.#styled({ type: 'circle', center: [center.x, center.z], radius: Math.max(radius, 0.02) }, opts);
    return this.#commit(this.#build(ann, opts.preview), ann, opts.preview);
  }

  addText(pos, text, yaw = 0, opts = {}) {
    const ann = this.#styled({ type: 'text', pos: [pos.x, pos.z], text, yaw }, opts);
    return this.#commit(this.#build(ann, opts.preview), ann, opts.preview);
  }

  // ------------------------------------------------------------ editing
  // Swap `obj` for the drawing its NEW annotation describes, in place. The
  // index is preserved because the children order is the undo order (⌫ Last
  // removes the last child) — a rebuilt shape must not jump to the end of it.
  #replace(obj, annotation) {
    const parent = obj.parent;
    if (!parent) return obj;
    const at = parent.children.indexOf(obj);
    const next = this.#build(annotation, parent === this.previewGroup);
    next.userData.annotation = annotation;
    next.traverse((o) => { o.renderOrder = next.userData.anchored ? ANCHORED_RENDER_ORDER : 2; });
    parent.remove(obj);
    disposeObject(obj);
    parent.add(next);
    parent.children.splice(parent.children.indexOf(next), 1);
    parent.children.splice(at, 0, next);
    if (this.selected === obj) {
      this.selected = next;
      this.refreshHandles();
    }
    return next;
  }

  // Recolour / re-weight an existing drawing. Returns the replacement object.
  restyle(obj, style) {
    if (!obj?.userData.annotation) return obj;
    return this.#replace(obj, this.#styled(obj.userData.annotation, style));
  }

  // The movable points of an annotation, in WORLD space (3D: an anchored end
  // is wherever its joint is right now). A line and an arrow are segments with
  // an end each; a circle is its centre plus a rim point (held at +x of the
  // centre, so the handle is somewhere predictable rather than wherever the
  // shape was first dragged from); text is a single position.
  handlePoints(ann) {
    if (!ann) return [];
    if (ann.type === 'line' || ann.type === 'arrow') {
      return [this.endWorld(ann, 'a'), this.endWorld(ann, 'b')];
    }
    if (ann.type === 'circle') {
      return [
        new THREE.Vector3(ann.center[0], DRAW_Y, ann.center[1]),
        new THREE.Vector3(ann.center[0] + ann.radius, DRAW_Y, ann.center[1]),
      ];
    }
    return [new THREE.Vector3(ann.pos[0], DRAW_Y, ann.pos[1])];
  }

  // Drag handle `index` of `obj` to floor point `p` — or, with `anchor` =
  // { fig, joint }, onto that joint, which is how an end is attached to (or
  // re-attached between) dancers. Dropping an anchored end back on the floor
  // detaches it: the two live in the same slot, so there is no third state to
  // get out of step. Returns the replacement.
  moveHandle(obj, index, p, anchor = null) {
    const ann = obj?.userData.annotation;
    if (!ann) return obj;
    if (ann.type === 'line' || ann.type === 'arrow') {
      const next = { ...ann, a: [...ann.a], b: [...ann.b] };
      this.#end(anchor || p, next, index === 0 ? 'a' : 'b');
      return this.#replace(obj, next);
    }
    if (ann.type === 'circle') {
      if (index === 0) return this.#replace(obj, { ...ann, center: [p.x, p.z] });
      const r = Math.max(Math.hypot(p.x - ann.center[0], p.z - ann.center[1]), 0.02);
      return this.#replace(obj, { ...ann, radius: r });
    }
    return this.#replace(obj, { ...ann, pos: [p.x, p.z] });
  }

  // ----------------------------------------------------------- selection
  select(obj) {
    this.selected = obj && obj.parent === this.group ? obj : null;
    this.refreshHandles();
    return this.selected;
  }

  clearHandles() {
    for (const h of [...this.handleGroup.children]) {
      this.handleGroup.remove(h);
      disposeObject(h);
    }
  }

  // Move the existing handle meshes to where their points are now, without
  // rebuilding them — the per-frame path for an anchored shape.
  #syncHandles() {
    if (!this.selected) return;
    const pts = this.handlePoints(this.selected.userData.annotation);
    if (pts.length !== this.handleGroup.children.length) { this.refreshHandles(); return; }
    this.handleGroup.children.forEach((mesh, i) => {
      mesh.position.set(pts[i].x, pts[i].y + 0.002, pts[i].z);
      mesh.updateMatrixWorld(true);
    });
  }

  refreshHandles() {
    this.clearHandles();
    if (!this.selected) return;
    const pts = this.handlePoints(this.selected.userData.annotation);
    pts.forEach((p, i) => {
      const geo = new THREE.SphereGeometry(HANDLE_R, 14, 10);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: HANDLE_COLOR, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false,
      }));
      mesh.position.set(p.x, p.y + 0.002, p.z);
      mesh.renderOrder = ANCHORED_RENDER_ORDER + 1; // above its own shape
      mesh.userData.drawHandle = { obj: this.selected, index: i };
      this.handleGroup.add(mesh);
      mesh.updateMatrixWorld(true); // pickable NOW, not at the next render
    });
  }

  // The handle under the ray, or null. Handles take precedence over the shapes
  // they edit — they sit on top of them by construction.
  handleHit(raycaster) {
    const hit = raycaster.intersectObjects(this.handleGroup.children, false)[0];
    return hit ? hit.object.userData.drawHandle : null;
  }

  // The committed annotation under the ray (its root object), or null.
  pickAt(raycaster) {
    const hit = raycaster.intersectObjects(this.group.children, true)[0];
    if (!hit) return null;
    for (let n = hit.object; n; n = n.parent) {
      if (n.parent === this.group) return n;
    }
    return null;
  }

  // Rubber-band preview while the second click is still pending.
  // `a`/`b` are the same two end forms the add* methods take, so a half-drawn
  // line already previews as the anchored 3D tube it is about to become.
  showPreview(tool, a, b) {
    if (tool === 'line') this.addLine(a, b, { preview: true });
    else if (tool === 'arrow') this.addArrow(a, b, { preview: true });
    else if (tool === 'circle' && a.distanceTo) this.addCircle(a, a.distanceTo(b), { preview: true });
  }

  clearPreview() {
    for (const o of [...this.previewGroup.children]) {
      this.previewGroup.remove(o);
      disposeObject(o);
    }
  }

  remove(obj) {
    if (!obj || obj.parent !== this.group) return false;
    if (this.selected === obj) this.select(null);
    this.group.remove(obj);
    disposeObject(obj);
    return true;
  }

  removeLast() {
    return this.remove(this.group.children[this.group.children.length - 1]);
  }

  clear() {
    this.select(null);
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
