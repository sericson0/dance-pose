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
//
// TEXT takes the same anchor, in the same vocabulary: a text has ONE position,
// so it is the a-end case of that — `posAt` beside `pos`, resolved by the same
// endWorld — plus a `lift` in metres, which is what puts the words ABOVE the
// joint ("click the head, get text over the head") rather than inside it. A
// text that has left the floor is BILLBOARDED: it faces the camera outright,
// because a label about a dancer that is legible from one seat in the room is
// not a label. That pass is orientation only (updateBillboards) — never a
// rebuild, which would re-render a canvas texture every frame — and it is
// driven by the CAMERA, not by the pose, so main.js runs it on view-only
// frames too. See the note on updateBillboards.
//
// Every record also carries a stable `id`. A diagram is authored work — it
// survives a reload (toJSON/fromJSON, saved by ui.js) and a sequence keyframe
// may name a subset of it (`kf.draw`), so a drawing needs a name that outlives
// its Object3D. #replace builds a NEW object from the SAME record, which is
// exactly what keeps the id through a restyle or an endpoint drag: the id is
// in the record, never in the mesh.
import * as THREE from 'three';

const DRAW_COLOR = '#ffd27f'; // chalk amber, readable on the dark wood
const DRAW_Y = 0.008;        // above the hull/trail lines (0.004/0.006)
const LINE_W = 0.02;         // default stroke width in metres
const HEAD_W = 0.075;        // arrow head width at the default stroke width
const HEAD_L = 0.1;          // arrow head length at the default stroke width
const TEXT_H = 0.16;         // world height of a text line at the default width

// How far above its anchored joint a floating text sits, in metres. Sized so
// that anchoring to `head` clears the skull (the head joint is ~13 cm below the
// crown on a 1.75 m figure, and the text is TEXT_H tall) — "click the head, get
// text above the head" with nothing further to fiddle with. Coarser placement
// is had by anchoring somewhere else (chest, wrist, ankle), which is why there
// is no lift handle: the floor-plane handle system cannot express a height, and
// the joint list already gives the user the choice that matters.
const TEXT_LIFT = 0.25;

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

// The shapes a record may describe — the guard fromJSON runs a restored record
// past before it is handed to #build, which otherwise falls through to the text
// branch and dies on a missing string. Stored files are user data; a corrupt or
// hand-edited one must cost the drawings it names, not the session.
const TYPES = new Set(['line', 'arrow', 'circle', 'text']);

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
    // The camera a billboarded text turns to face. Held here rather than passed
    // per call so a shape can be aimed the instant it is BUILT — a billboard
    // that waits for the next frame to turn is unpickable and wrong-facing in
    // between, which is the same on-demand-render trap #commit answers.
    this.camera = null;
    // Which drawings are on screen: a Set of ids, or null for "all of them".
    // A visibility FILTER, not a property of any record — a keyframe names the
    // subset it wants (setVisibleIds) and the record is untouched, so the same
    // drawing can be in one keyframe's diagram and out of the next's.
    this.visible = null;
    // Serial behind #nextId. Restoring bumps it past everything it loaded, so a
    // drawing added after a reload cannot take an id a saved one already holds.
    this.serial = 0;
  }

  #nextId() {
    return `d${++this.serial}`;
  }

  setFigures(figures) {
    this.figures = figures || [];
  }

  setCamera(camera) {
    this.camera = camera || null;
  }

  // ------------------------------------------------------------- anchors
  // An end is either a floor point (`a: [x, z]`, the original and still the
  // default) or a joint of a dancer (`aAt: { fig, joint }`). This is the ONE
  // place that choice is resolved, so authoring, rebuilding, the per-frame
  // refresh and the handles can never disagree about where an end is.
  //
  // `which` is the record's own key for that end — 'a'/'b' for a segment,
  // 'pos' for a text — and the anchor always lives in `<which>At`. One rule,
  // so a text anchor needed no parallel vocabulary.
  //
  // The joint is read through `surfacePos`, not `worldPos`: the question a
  // drawn line asks is "where is this dancer physically", which is the node the
  // visible body is welded to — the two differ by up to ~18 cm on a flexed arm
  // (see the two-frames rule in CLAUDE.md).
  endWorld(ann, which, out = new THREE.Vector3()) {
    const at = ann[`${which}At`];
    const fig = at && this.figures[at.fig];
    if (fig && fig.nodes?.[at.joint]) return fig.surfacePos(at.joint, out);
    const p = ann[which];
    // An anchor whose dancer is hidden or gone falls back to the floor point
    // kept beside it, so the line stays drawable instead of collapsing.
    return p ? out.set(p[0], DRAW_Y, p[1]) : out.set(0, DRAW_Y, 0);
  }

  // Does this shape RIDE A DANCER — i.e. must it be re-placed when the pose
  // changes? An anchored end of a segment, or an anchored text.
  static anchored(ann) {
    return !!(ann && (ann.aAt || ann.bAt || ann.posAt));
  }

  // Has this TEXT left the floor? Either because it is anchored to a joint or
  // because it was simply given a height. Such a text is billboarded and is
  // drawn through the dancers; a floor text keeps its flat, yaw-oriented look.
  static floating(ann) {
    return ann?.type === 'text' && !!(ann.posAt || (ann.lift ?? 0) > 0);
  }

  get anchoredCount() {
    return this.group.children.filter((o) => Drawings.anchored(o.userData.annotation)).length;
  }

  // How many shapes must re-aim when the CAMERA moves. Deliberately a separate
  // count from anchoredCount: the two passes answer different events, and a
  // free-floating billboard anchors nothing at all.
  get billboardCount() {
    return this.group.children.filter((o) => o.userData.billboard).length
      + this.previewGroup.children.filter((o) => o.userData.billboard).length;
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
  // and a drawing saved before colour/width (or before ids) existed still
  // rebuilds. The id is minted ONCE, here, and `...ann` carries it through
  // every later edit — restyle and moveHandle both build their new record off
  // the old one, so a keyframe's reference to a drawing survives being
  // recoloured, re-weighted or dragged by an end.
  #styled(ann, { color, width } = {}) {
    return {
      ...ann,
      id: ann.id || this.#nextId(),
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
    // Text either lies flat on the floor or FLOATS (anchored to a joint, or
    // simply lifted). Flat text is oriented by `yaw` (0 = readable looking
    // along -z), which the caller usually derives from the camera so the label
    // reads right-way-up from the current viewpoint. `yaw` is MEANINGLESS on a
    // floating text and is deliberately ignored there — it is still recorded,
    // so dropping the text back onto the floor (a handle drag onto the floor
    // plane) lands it readable instead of at an arbitrary angle.
    //
    // Either way the size follows the stroke width, so one slider sets the
    // weight of the whole diagram.
    const floating = Drawings.floating(ann);
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
    // CONSTANT WORLD SIZE, not constant screen size, and the choice is
    // deliberate. This is GL scene content, so it shrinks with distance exactly
    // as the dancer does: the words keep a fixed proportion to the body, which
    // is what makes a photo or a recorded clip show the same picture as the
    // screen, and it keeps the one stroke-width slider setting the weight of
    // the WHOLE diagram (a floor arrow and a floating caption drawn at the same
    // width read as the same chalk). A constant screen size would grow the text
    // relative to the dancer as the camera pulled back, and would have to be
    // re-derived per export resolution — which is the very problem the overlay
    // canvas solves with its fractions of frame height, and that machinery is
    // not available down here in the GL scene.
    const h = TEXT_H * (w / LINE_W);
    const geo = new THREE.PlaneGeometry(h * canvas.width / canvas.height, h);
    // A floor text lies in the floor plane; a floating one stays an upright
    // screen-facing quad, which the billboard pass then turns each frame.
    if (!floating) geo.rotateX(-Math.PI / 2);
    // The glyphs carry the colour (baked into the canvas), so the material
    // must not tint them a second time.
    const mesh = new THREE.Mesh(geo, this.#material({
      preview,
      mat: {
        map: tex,
        color: 0xffffff,
        opacity: preview ? 0.45 : 1,
        // Like an anchored stroke, a floating text draws THROUGH the dancers:
        // a caption about a dancer that is buried in their torso is not doing
        // its job, and the anchor point is the depth cue.
        ...(floating ? { depthTest: false, polygonOffset: false } : {}),
      },
    }));
    if (floating) {
      mesh.userData.anchored = true;  // → ANCHORED_RENDER_ORDER in #commit
      mesh.userData.billboard = true; // → updateBillboards
      this.#placeAnchored(mesh, ann);
      return mesh;
    }
    mesh.position.set(ann.pos[0], DRAW_Y, ann.pos[1]);
    mesh.rotation.y = ann.yaw;
    return mesh;
  }

  // Lay an anchored shape's unit meshes between its two live end points. Called
  // at build time and again every frame the dancers move — nothing here
  // allocates, so it is safe in the render loop.
  #placeAnchored(obj, ann) {
    // A floating text is a single point plus a height. `lift` is applied in
    // WORLD y (not along any joint axis): the words hang above the joint
    // however the dancer is turned or bent, which is what a caption wants —
    // an upside-down label over an inverted colgada is not more informative.
    if (ann.type === 'text') {
      this.endWorld(ann, 'pos', _pa);
      obj.position.set(_pa.x, _pa.y + (ann.lift ?? 0), _pa.z);
      this.#aimBillboard(obj);
      return;
    }
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

  // Turn one billboard to face the camera. The FULL camera quaternion, not a
  // yaw-only spin about world up: a yaw-only billboard goes edge-on (and so
  // invisible) the moment the camera looks down, and the Top view is one of the
  // four presets. Copying the camera's own rotation keeps the quad parallel to
  // the screen from any angle, which is the whole point of the feature.
  //
  // `group` hangs off the scene with no transform of its own, so the camera's
  // world quaternion and this local one are the same thing.
  #aimBillboard(obj) {
    if (this.camera) obj.quaternion.copy(this.camera.quaternion);
    obj.updateMatrixWorld(true); // pickable NOW — main.js renders on demand
  }

  // Re-aim every billboarded text. ORIENTATION ONLY: rebuilding a text means
  // re-rendering its canvas texture, which is far too expensive to do per
  // frame, and #build stays the one place a record becomes geometry.
  //
  // This is a separate pass from updateAnchored on purpose, because the two
  // answer different events. An anchored end rides the POSE, so it is refreshed
  // in the simulation pass. A billboard tracks the CAMERA, and an orbit changes
  // no pose at all — on a view-only frame the solve pass is skipped entirely.
  // Gating this on `anchoredCount` (as the anchored pass is gated) would also
  // miss a free-floating lifted text, which anchors nothing. main.js calls it
  // from both branches of its render loop; see the note there.
  updateBillboards() {
    for (const o of this.group.children) if (o.userData.billboard) this.#aimBillboard(o);
    for (const o of this.previewGroup.children) if (o.userData.billboard) this.#aimBillboard(o);
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
      this.#applyVisible(obj);
    }
    return obj;
  }

  // ------------------------------------------------------- visibility
  // Which committed drawings are on screen. `null` shows every one of them,
  // which is what an untagged keyframe (and a session that has never tagged
  // anything) means — so this is inert until someone asks for a subset.
  //
  // A FLAG, never a rebuild: the filter changes several times a second while a
  // sequence plays, and it must be free. previewGroup and handleGroup are
  // editing chrome and are deliberately not touched — a half-drawn shape and
  // the handles of the one being edited belong to the user, not to the slide.
  setVisibleIds(ids) {
    this.visible = Array.isArray(ids) ? new Set(ids) : null;
    for (const o of this.group.children) this.#applyVisible(o);
    // Handles over a shape that has just gone off screen are handles onto
    // nothing — and the ray would still find them (they are their own group).
    if (this.selected && !this.selected.visible) this.select(null);
    return this.visibleIds();
  }

  // The filter as a plain array (what a keyframe stores), or null for "all".
  visibleIds() {
    return this.visible ? [...this.visible] : null;
  }

  // The ids actually ON SCREEN right now, in draw order — the set a keyframe
  // captures. Resolved against the live children rather than against `visible`,
  // so an id left over from a deleted drawing cannot be captured.
  shownIds() {
    return this.group.children
      .filter((o) => o.visible)
      .map((o) => o.userData.annotation?.id)
      .filter(Boolean);
  }

  ids() {
    return this.group.children.map((o) => o.userData.annotation?.id).filter(Boolean);
  }

  #applyVisible(obj) {
    const id = obj.userData.annotation?.id;
    obj.visible = !this.visible || this.visible.has(id);
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

  // `pos` takes the same two end forms the segments do — a floor point
  // ({x, z}) or a joint anchor ({ fig, joint }) — through the same #end, so a
  // text's position is the a-end case of it and nothing here is a parallel
  // path. An anchored text gets TEXT_LIFT by default (words go ABOVE the joint,
  // not inside it); a floor text gets no lift unless one is asked for, which is
  // what keeps every text authored before this byte-identical.
  addText(pos, text, yaw = 0, opts = {}) {
    const base = this.#end(pos, { type: 'text', text, yaw }, 'pos');
    const lift = opts.lift ?? (base.posAt ? TEXT_LIFT : 0);
    // A plain floor text keeps the record it has always had (no `lift` key at
    // all), so nothing about the old shape — or an old saved file — changes.
    const ann = this.#styled(lift ? { ...base, lift } : base, opts);
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
    // The rebuilt object is born visible; the filter has to be re-stamped on
    // it, or restyling a drawing that a keyframe has filtered out would bring
    // it back on screen.
    if (parent === this.group) this.#applyVisible(next);
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
    // Text: its one position, wherever that is right now — on the floor, or up
    // in the air over a joint. Via endWorld + lift, so the handle is ON the
    // words rather than on the floor beneath them.
    const p = this.endWorld(ann, 'pos');
    p.y += ann.lift ?? 0;
    return [p];
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
    // Text takes the same two end forms as a segment's, through the same #end:
    // dropped on a joint it anchors (and takes the default lift if it had
    // none), dropped on the floor it detaches. A lift the text already has is
    // KEPT through a floor move — the handle system is floor-plane oriented, so
    // a drag is a move in x/z and height is not one of the things it says.
    const next = { ...ann, pos: [...(ann.pos ?? [0, 0])] };
    this.#end(anchor || p, next, 'pos');
    if (next.posAt && !(next.lift > 0)) next.lift = TEXT_LIFT;
    return this.#replace(obj, next);
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
  // Filtered to what is SHOWN: three's raycaster does not consult `visible`,
  // and a drawing hidden by a keyframe's filter must not take a click — you
  // cannot select, restyle or re-shape what you cannot see.
  pickAt(raycaster) {
    const hit = raycaster.intersectObjects(this.group.children.filter((o) => o.visible), true)[0];
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

  // ---------------------------------------------------------- serialization
  // A diagram is authored work and must survive a reload, an export and an
  // import. The records already ARE the drawings (#build is the only path from
  // one to the other), so there is nothing to serialize but them — and nothing
  // to restore but a rebuild. This is why an anchored end stores its dancer as
  // an INDEX and not as a Figure: a record is plain JSON by construction.
  //
  // Deep-copied on the way out so a caller that holds the result (localStorage,
  // an export payload, a keyframe) cannot be rewritten under it by a later
  // restyle — the live records are mutated in place nowhere, but a handed-out
  // reference into the scene is a trap waiting for the first time they are.
  toJSON() {
    return JSON.parse(JSON.stringify(this.list()));
  }

  // Rebuild the whole diagram from `list`, replacing whatever is on the floor.
  // Records go through #styled, so one saved before colour/width/ids existed
  // gains them here rather than rebuilding into a broken shape; the serial is
  // then carried past every id that arrived, so the next drawing authored in
  // this session cannot collide with a restored one. Returns how many landed.
  fromJSON(list) {
    this.clear();
    // A filter names ids that have just ceased to exist; the incoming diagram
    // is whole until a keyframe asks for part of it.
    this.visible = null;
    if (!Array.isArray(list)) return 0;
    // Bump the serial over EVERY incoming id before minting any, or a legacy
    // record with no id could be handed one that a record later in the same
    // file already holds.
    for (const raw of list) {
      const n = /^d(\d+)$/.exec(raw?.id ?? '');
      if (n) this.serial = Math.max(this.serial, Number(n[1]));
    }
    for (const raw of list) this.#restoreOne(raw);
    return this.count;
  }

  // Put records BACK on the floor without touching the ones already there —
  // the Undo of a delete, which has to restore exactly the drawings that went
  // (ids included, so every keyframe still naming them finds them again). The
  // serial is bumped first for the same reason fromJSON bumps it. Restored
  // shapes land at the END of the children, which is the undo order ⌫ Last
  // reads: a drawing brought back is the most recent thing that happened to
  // the diagram, so that is where it belongs. Returns how many landed.
  restore(list) {
    if (!Array.isArray(list)) return 0;
    for (const raw of list) {
      const n = /^d(\d+)$/.exec(raw?.id ?? '');
      if (n) this.serial = Math.max(this.serial, Number(n[1]));
    }
    let added = 0;
    for (const raw of list) if (this.#restoreOne(raw)) added++;
    return added;
  }

  // One record → one committed drawing, with the validation both entry points
  // need. Shared so a restore can never accept a record a load would refuse.
  #restoreOne(raw) {
    if (!raw || !TYPES.has(raw.type)) return null;
    // #build reads these without asking; a record missing its own geometry
    // is not a drawing, and silently skipping it keeps the rest of the file.
    if ((raw.type === 'line' || raw.type === 'arrow') && !(raw.a && raw.b)) return null;
    if (raw.type === 'circle' && !(raw.center && Number.isFinite(raw.radius))) return null;
    // A text needs somewhere to be: its floor point (every text ever saved
    // has one, and an anchored one keeps it filled in beside the anchor) or,
    // for a hand-written record, the anchor alone — endWorld tolerates a
    // missing floor pair, so that one still builds.
    if (raw.type === 'text' && !((raw.pos || raw.posAt) && typeof raw.text === 'string')) return null;
    const ann = this.#styled(JSON.parse(JSON.stringify(raw)));
    return this.#commit(this.#build(ann, false), ann, false);
  }
}
