// Presentation studio: everything that turns the posing tool into slide
// material — the label/overlay canvas, the backdrop, the 16:9 slide frame, the
// photo + video exports, and the movement-clip player.
//
// THE OVERLAY IS A SECOND 2D CANVAS, not 3D sprites and not a texture. Labels
// and clip overlays (title, angle arc, captions) are screen-space by nature
// (margin columns, readable type), so they are drawn with the Canvas 2D API on
// a canvas stacked over the WebGL one: zero GPU upload in the live view, and an
// export simply REDRAWS the overlay at the export resolution onto a composite
// canvas — vector-crisp at 1080p or 4K, never a scaled screenshot. Every size is
// a fraction of the frame height for the same reason (see labels.js).
//
// Consequence worth knowing: the WebGL canvas alone no longer holds the whole
// picture. Anything that exports it (photo, MediaRecorder) must go through
// photoDataURL / startRecorder here, which composite GL + overlay.
import * as THREE from 'three';
import { Labels, drawPill } from './labels.js';
import { MOVEMENTS, MOVEMENT_BY_ID, NEUTRAL, PLANES, FRAMES } from './movements.js';
import { JOINT_BY_NAME, DEG } from './skeletonDef.js';
import { LIMB_BASES } from './skeletonMesh.js';

const SLIDE_W = 1920;
const SLIDE_H = 1080;
// The slide frame sits beside the sidebar, so it has to know how wide the
// sidebar currently is. MEASURED, not a constant: Present mode hides the
// sidebar entirely, and a hardcoded 320 would letterbox the frame against a
// panel that is not on screen. A hidden element reports 0, which is exactly
// the answer wanted. Falls back to the --sidebar-w token if the element is
// missing (the clip stage builds before the DOM settles in some paths).
function sidebarWidth() {
  const el = document.getElementById('sidebar');
  if (el) return el.offsetWidth;
  const token = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w');
  return parseFloat(token) || 320;
}

const DARK = {
  text: '#f4f6fb', sub: '#c3cad8', pill: 'rgba(18,21,28,0.84)', edge: 'rgba(255,255,255,0.16)',
  line: '#f4f6fb', halo: 'rgba(8,10,14,0.8)', arcFill: 'rgba(244,246,251,0.26)',
};
const LIGHT = {
  text: '#14171d', sub: '#475063', pill: 'rgba(255,255,255,0.92)', edge: 'rgba(20,23,29,0.25)',
  line: '#14171d', halo: 'rgba(255,255,255,0.9)', arcFill: 'rgba(20,23,29,0.2)',
};
// `bg: null` = transparent (PNG photos; a video falls back to the dark colour).
const BACKDROPS = {
  studio: { bg: 0x191c22, wood: true, theme: DARK },
  dark: { bg: 0x0f1115, wood: false, theme: DARK, shadow: 0.45 },
  light: { bg: 0xffffff, wood: false, theme: LIGHT, shadow: 0.2 },
  transparent: { bg: null, wood: false, theme: DARK, shadow: 0.3 },
};

// Clip timing (seconds): a beat at neutral, the stroke out, a hold at end range
// so the audience can read the angle, the stroke back, and a short tail — it
// ends where it began, so the clip loops seamlessly on a slide.
const LEAD_IN = 0.5;
const TAIL = 0.35;

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - ((-2 * u + 2) ** 3) / 2);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export function createStudio({ renderer, scene, camera, orbit, floor, container, app, hooks }) {
  const gl = renderer.domElement;
  const hud = document.createElement('canvas');
  hud.id = 'hud';
  container.appendChild(hud);
  const hudCtx = hud.getContext('2d');

  const labels = new Labels(app.figures);
  const woodMaterial = floor.material;
  const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.3 });
  const studioFog = scene.fog;

  const studio = {
    labels,
    backdrop: 'studio',
    frame: 'window',     // 'window' | 'slide' (16:9, rendered at 1920×1080)
    photoScale: 1,       // photo export multiplier (2 = 4K from the slide frame)
    videoFormat: 'mp4',  // 'mp4' (H.264 — PowerPoint / Beamer) | 'webm'
    hover: null,         // { text, x, y, remove } label-mode cursor preview (CSS px)
    recorder: null,
    clip: null,          // the active movement clip (see enterClip)
    onClipTick: null,    // UI callback: (progress 0..1, angleDeg)
    onClipChanged: null, // UI callback: clip entered / exited / play state
    get theme() { return BACKDROPS[this.backdrop].theme; },
    get clipActive() { return !!this.clip; },
    get clipPlaying() { return !!this.clip?.playing; },
    get busy() { return !!(this.recorder || this.clip?.arming); }, // a capture is armed or running
  };

  // ---------------------------------------------------------------- backdrop
  studio.setBackdrop = (name) => {
    const b = BACKDROPS[name];
    if (!b) return;
    studio.backdrop = name;
    scene.background = b.bg === null ? null : new THREE.Color(b.bg);
    renderer.setClearColor(0x000000, b.bg === null ? 0 : 1);
    scene.fog = b.wood ? studioFog : null;
    floor.material = b.wood ? woodMaterial : shadowMaterial;
    if (!b.wood) shadowMaterial.opacity = b.shadow;
    container.classList.toggle('transparent-backdrop', b.bg === null);
    // The chrome floating over the stage (the 16:9 crop outline) is drawn in
    // dark-theme ink; on the white backdrop it needs the opposite. The title
    // and hint carry their own pill instead, so they need no class.
    container.classList.toggle('light-backdrop', b.theme === LIGHT);
  };

  // ------------------------------------------------------------ frame / size
  // 'window' fills the viewport as the app always has. 'slide' letterboxes a
  // 16:9 stage beside the sidebar and renders it at exactly 1920×1080, so the
  // live view IS the exported frame. (The buffer is sized with pixelRatio 1 +
  // an explicit CSS size: three's setSize floors width × ratio, and a fractional
  // ratio lands on 1919 px — an odd width H.264 refuses.)
  studio.layoutCanvas = () => {
    if (studio.frame === 'slide') {
      const top = document.getElementById('topbar')?.offsetHeight ?? 0;
      const availW = Math.max(200, window.innerWidth - sidebarWidth());
      const availH = Math.max(120, window.innerHeight - top);
      const cssW = Math.floor(Math.min(availW, availH * SLIDE_W / SLIDE_H));
      const cssH = Math.floor(cssW * SLIDE_H / SLIDE_W);
      renderer.setPixelRatio(1);
      renderer.setSize(SLIDE_W, SLIDE_H, false);
      for (const c of [gl, hud]) {
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
        c.style.left = `${Math.floor((availW - cssW) / 2)}px`;
        c.style.top = `${top + Math.floor((availH - cssH) / 2)}px`;
      }
      camera.aspect = SLIDE_W / SLIDE_H;
    } else {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      for (const c of [gl, hud]) { c.style.left = '0px'; c.style.top = '0px'; }
      hud.style.width = gl.style.width;
      hud.style.height = gl.style.height;
      camera.aspect = window.innerWidth / window.innerHeight;
    }
    container.classList.toggle('slide-frame', studio.frame === 'slide');
    hud.width = gl.width;
    hud.height = gl.height;
    camera.updateProjectionMatrix();
  };

  studio.setFrame = (frame) => {
    studio.frame = frame === 'slide' ? 'slide' : 'window';
    studio.layoutCanvas();
  };

  // ------------------------------------------------------------- the overlay
  function drawOverlay(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const theme = studio.theme;
    const top = studio.clip ? drawClipOverlay(ctx, w, h, theme) : 0;
    // In the window frame the sidebar covers the canvas's right edge; keep the
    // callouts out from under it (the slide frame already sits beside it).
    const right = studio.frame === 'window' ? sidebarWidth() * (w / (gl.clientWidth || w)) : 0;
    studio.lastLayout = labels.draw(ctx, camera, w, h, theme, { top, right });
    if (studio.hover && ctx === hudCtx) {
      const k = w / (gl.clientWidth || w); // CSS px → canvas px
      const font = labels.size * h * 0.8;
      drawPill(ctx, `${studio.hover.remove ? '✕ ' : '+ '}${studio.hover.text}`,
        studio.hover.x * k + font, studio.hover.y * k - font * 1.4, font, theme, { weight: 500 });
    }
  }

  // Render one frame: GL, then the overlay, then (while recording) the composite.
  studio.renderFrame = () => {
    renderer.render(scene, camera);
    drawOverlay(hudCtx, hud.width, hud.height);
    const r = studio.recorder;
    if (r) {
      if (studio.backdrop === 'transparent') {
        r.ctx.fillStyle = hex(BACKDROPS.dark.bg);
        r.ctx.fillRect(0, 0, r.canvas.width, r.canvas.height);
      }
      r.ctx.drawImage(gl, 0, 0, r.canvas.width, r.canvas.height);
      r.ctx.drawImage(hud, 0, 0, r.canvas.width, r.canvas.height);
    }
  };

  // -------------------------------------------------------------- photo/video
  // PNG of the view — GL + overlay, gizmos hidden — at `scale`× the live
  // resolution. The overlay is REDRAWN at the export size, not scaled up.
  studio.photoDataURL = (scale = studio.photoScale) => {
    const restoreGizmos = hooks.hideGizmos();
    const w0 = gl.width;
    const h0 = gl.height;
    const ratio = renderer.getPixelRatio();
    const css = [gl.style.width, gl.style.height];
    const W = Math.round(w0 * scale);
    const H = Math.round(h0 * scale);
    if (scale !== 1) {
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
    }
    renderer.render(scene, camera);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(gl, 0, 0);
    const over = document.createElement('canvas');
    over.width = W;
    over.height = H;
    drawOverlay(over.getContext('2d'), W, H);
    ctx.drawImage(over, 0, 0);
    if (scale !== 1) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(w0 / ratio, h0 / ratio, false);
      [gl.style.width, gl.style.height] = css;
    }
    restoreGizmos();
    studio.renderFrame();
    return out.toDataURL('image/png');
  };

  // THE H.264 ENCODER NEEDS WARMING UP. The first MP4 MediaRecorder sessions of
  // a page produce ZERO BYTES with no error event — measured ~5.5 s in headless
  // Chrome/Edge before one yields data, after which 1080p records at once — so
  // a user's first ⏺ would silently download an empty file. Tiny throwaway
  // sessions run until one produces bytes; recordings wait on this promise
  // (whenEncoderReady), and if the encoder never wakes the format falls back to
  // WebM rather than failing. WebM needs no warm-up.
  const MP4_MIMES = ['video/mp4;codecs=avc1.42E02A', 'video/mp4;codecs=avc1.4D402A', 'video/mp4'];
  let mp4Warm = null;
  function warmUpMp4() {
    if (mp4Warm) return mp4Warm;
    const mime = typeof MediaRecorder !== 'undefined' && MP4_MIMES.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { studio.mp4Broken = true; mp4Warm = Promise.resolve(false); return mp4Warm; }
    mp4Warm = (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      for (let k = 0; k < 20; k++) {
        const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: mime });
        let size = 0;
        rec.ondataavailable = (e) => { size += e.data.size; };
        rec.start();
        for (let i = 0; i < 12; i++) {
          ctx.fillStyle = `hsl(${(k * 12 + i) * 17},70%,50%)`;
          ctx.fillRect(0, 0, 320, 180);
          await new Promise((r) => setTimeout(r, 40));
        }
        await new Promise((r) => { rec.onstop = r; rec.stop(); });
        if (size > 0) return true;
      }
      console.warn('The MP4 (H.264) encoder never produced data in this browser — videos will be WebM.');
      studio.mp4Broken = true;
      return false;
    })();
    return mp4Warm;
  }
  studio.whenEncoderReady = () => (studio.videoFormat === 'mp4' && !studio.mp4Broken
    ? warmUpMp4() : Promise.resolve(true));
  setTimeout(warmUpMp4, 2500); // off the critical path of page load

  // Record the composited view. Returns { stop } or null. MP4/H.264 is the
  // default because PowerPoint will not play .webm; the file's extension
  // follows whatever container the browser actually granted.
  studio.startRecorder = (name, onDone) => {
    if (studio.recorder) return null;
    if (typeof MediaRecorder === 'undefined' || !hud.captureStream) {
      console.warn('MediaRecorder is not available in this browser.');
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = gl.width - (gl.width % 2); // H.264 wants even dimensions
    canvas.height = gl.height - (gl.height % 2);
    // The H.264 LEVEL in the codec string is load-bearing: 1080p60 needs level
    // 4.2, and a lower one (avc1.42E01E, level 3.0 — or High profile on a
    // software encoder) passes isTypeSupported and then records ZERO BYTES with
    // no error. Measured in Chrome and Edge; Baseline@4.2 is what both encode,
    // and Baseline is also the profile PowerPoint is least fussy about.
    const mp4 = MP4_MIMES;
    const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const wantMp4 = studio.videoFormat === 'mp4' && !studio.mp4Broken;
    const mime = (wantMp4 ? [...mp4, ...webm] : [...webm, ...mp4])
      .find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(canvas.captureStream(60),
      { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 16e6 });
    const ext = (mime || 'video/webm').includes('mp4') ? 'mp4' : 'webm';
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
      studio.recorder = null;
      if (!blob.size && ext === 'mp4') {
        // This browser advertises an MP4 encoder it cannot actually run. Don't
        // hand the user an empty file: remember, and let the caller re-record
        // (the retry lands on WebM).
        console.warn('MP4 recording produced no data in this browser — re-recording as WebM.');
        studio.mp4Broken = true;
        if (onDone) onDone({ retry: true });
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (onDone) onDone({ retry: false });
    };
    studio.recorder = { canvas, ctx: canvas.getContext('2d'), rec, ext };
    studio.renderFrame(); // seed the stream with the opening frame
    rec.start();
    return { stop: () => { if (rec.state !== 'inactive') rec.stop(); }, ext };
  };

  // ==================================================================== clips
  // A bare limb base ('shoulder', 'hand', 'toe') takes the clip's side; a full
  // joint name ('hip_R', 'chest') is literal.
  const sided = (joint, side) => (JOINT_BY_NAME[joint] ? joint : `${joint}_${side}`);
  // Rows are authored for the left side; the right negates y and z (see movements.js).
  const signed = (axis, deg, side) => (side === 'R' && axis !== 'x' ? -deg : deg);

  function setDegrees(figure, map, side) {
    for (const [joint, axes] of Object.entries(map)) {
      const node = figure.nodes[sided(joint, side)];
      if (!node) continue;
      for (const [axis, deg] of Object.entries(axes)) node.rotation[axis] = signed(axis, deg, side) * DEG;
    }
  }

  // Hold the clip figure at progress `u` of `move` (0 = base, 1 = end range).
  function poseClip(clip, move, u) {
    const { figure, side } = clip;
    for (const [name, axes] of Object.entries(clip.baseAngles)) {
      for (const [axis, v] of Object.entries(axes)) figure.nodes[name].rotation[axis] = v;
    }
    for (const d of move.drive) {
      const name = sided(d.joint, side);
      const from = clip.baseAngles[name][d.axis];
      figure.nodes[name].rotation[d.axis] = from + (signed(d.axis, d.to, side) * DEG - from) * u;
      figure.clampJoint(name);
    }
    figure.syncAtlasNodes();
    figure.group.updateMatrixWorld(true);
  }

  // World axis the primary joint turns about. With three's XYZ Euler order
  // (R = Rx·Ry·Rz) a change in x turns about the PARENT's x; a change in y about
  // Rx·ŷ; a change in z about the node's own z — so the axis is exact even when
  // the test position has already bent the joint on another axis.
  function axisWorld(clip, move, out) {
    const { figure, side } = clip;
    if (move.axisFig) {
      out.set(move.axisFig === 'x' ? 1 : 0, move.axisFig === 'y' ? 1 : 0, move.axisFig === 'z' ? 1 : 0);
      return out.applyQuaternion(figure.group.getWorldQuaternion(_q)).normalize();
    }
    const d = move.drive[0];
    const name = sided(d.joint, side);
    const node = figure.nodes[name];
    if (d.axis === 'x') out.set(1, 0, 0);
    else if (d.axis === 'y') out.set(0, 1, 0).applyEuler(_e.set(node.rotation.x, 0, 0));
    else out.set(0, 0, 1).applyQuaternion(node.quaternion);
    out.applyQuaternion(node.parent.getWorldQuaternion(_q)).normalize();
    // Point it the way the movement turns, so a positive angle is always "out".
    if (signed(d.axis, d.to, side) * DEG < clip.baseAngles[name][d.axis]) out.negate();
    return out;
  }

  function markerWorld(clip, move, out) {
    const { figure, side } = clip;
    const d = move.drive[0];
    const m = move.marker;
    if (m && !Array.isArray(m)) {
      out.set(m.axis === 'x' ? 1 : 0, m.axis === 'y' ? 1 : 0, m.axis === 'z' ? 1 : 0);
      return out.applyQuaternion(figure.nodes[sided(m.node, side)].getWorldQuaternion(_q));
    }
    const from = sided(m ? m[0] : d.joint, side);
    const to = m ? sided(m[1], side)
      : figure.nodes[from].children.find((c) => JOINT_BY_NAME[c.userData?.jointName] && !c.userData.isAtlas)?.userData.jointName;
    return figure.surfacePos(to, out).sub(figure.surfacePos(from, _b));
  }

  // Measure the marker's swing about the axis since neutral → clip.angle (rad,
  // unwrapped so a 179° abduction doesn't flip sign at ±180).
  function measure(clip) {
    const m = clip.motion;
    markerWorld(clip, clip.move, _a).addScaledVector(m.axis, -_a.dot(m.axis));
    if (_a.lengthSq() < 1e-10) return;
    _a.normalize();
    let ang = Math.atan2(m.axis.dot(_b.crossVectors(m.u0, _a)), m.u0.dot(_a));
    while (ang - m.angle > Math.PI) ang -= 2 * Math.PI;
    while (ang - m.angle < -Math.PI) ang += 2 * Math.PI;
    m.angle = ang;
    clip.figure.surfacePos(sided(clip.move.center ?? clip.move.drive[0].joint, clip.side), m.center);
  }

  // Build the motion frame for `move`: axis, neutral marker direction, arc
  // radius and the end-range angle — sampled by stepping the pose out to u = 1
  // — plus every point the camera must keep in shot along the way.
  function prepareMotion(clip, move) {
    const { figure, side } = clip;
    poseClip(clip, move, 0);
    const m = { axis: new THREE.Vector3(), u0: new THREE.Vector3(), center: new THREE.Vector3(), angle: 0, end: 0, radius: 0.2 };
    clip.motion = m;
    clip.move = move;
    axisWorld(clip, move, m.axis);
    const len = markerWorld(clip, move, _a).length();
    m.u0.copy(_a).addScaledVector(m.axis, -_a.dot(m.axis)).normalize();
    const H = figure.height;
    m.radius = Array.isArray(move.marker) || !move.marker
      ? THREE.MathUtils.clamp(len * 0.72, 0.05 * H, 0.17 * H) : 0.12 * H;
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      poseClip(clip, move, k / 6);
      measure(clip);
      for (const j of FRAMES[move.frame] ?? FRAMES.body) pts.push(figure.surfacePos(sided(j, side)).clone());
    }
    m.end = m.angle;
    poseClip(clip, move, 0);
    m.angle = 0;
    measure(clip);
    return pts;
  }

  const planeHalf = (clip) => Math.max(clip.motion.radius * 1.55, 0.16 * clip.figure.height);

  // Everything the shot must contain: the framed joints along the whole motion,
  // plus the overlays drawn around the joint (arc + readout, plane corners).
  function shotPoints(clip, pts) {
    const m = clip.motion;
    const out = [...pts];
    const basis = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), m.axis);
    if (clip.opts.plane) {
      const half = planeHalf(clip);
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        out.push(new THREE.Vector3(sx * half, sy * half, 0).applyQuaternion(basis).add(m.center));
      }
    }
    if (clip.opts.angle) {
      for (let k = 0; k <= 8; k++) {
        out.push(m.u0.clone().applyAxisAngle(m.axis, m.end * (k / 8)).multiplyScalar(m.radius * 1.6).add(m.center));
      }
    }
    return out;
  }

  // Exact camera fit of a point set seen from `dir` — a unit vector pointing
  // from the subject TOWARD the camera. The distance is solved from the points'
  // extents measured in the camera's OWN screen axes, not from a bounding
  // sphere: a standing body is far taller than wide, and a sphere fit wastes
  // most of a 16:9 frame. `fillX`/`fillY` are the share of the frame the subject
  // may occupy (a clip keeps the top clear for its title and the sides for the
  // callout columns), `pad` adds flesh around the sampled points, and `lower`
  // drops the subject by that fraction of the frame's half-height.
  //
  // Shared by the clip auto-frame below and by app.frameDancers / the View
  // presets in main.js, so there is exactly one fitter in the app.
  function fitCameraToPoints(pts, dir, { fillX = 0.8, fillY = 0.88, pad = 0, lower = 0 } = {}) {
    if (!pts || !pts.length) return false;
    const up = new THREE.Vector3(0, 1, 0);
    // Looking straight down (the Top view does exactly that) leaves up × dir
    // degenerate, so fall back to world X for the screen-right axis.
    const right = Math.abs(dir.dot(up)) > 0.999
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3().crossVectors(up, dir).normalize();
    const upCam = new THREE.Vector3().crossVectors(dir, right);
    const center = new THREE.Box3().setFromPoints(pts).getCenter(new THREE.Vector3());
    let [x0, x1, y0, y1, zMax] = [Infinity, -Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pts) {
      _a.subVectors(p, center);
      x0 = Math.min(x0, _a.dot(right)); x1 = Math.max(x1, _a.dot(right));
      y0 = Math.min(y0, _a.dot(upCam)); y1 = Math.max(y1, _a.dot(upCam));
      zMax = Math.max(zMax, _a.dot(dir));
    }
    center.addScaledVector(right, (x0 + x1) / 2).addScaledVector(upCam, (y0 + y1) / 2);
    const hx = (x1 - x0) / 2 + pad;
    const hy = (y1 - y0) / 2 + pad;
    const tanV = Math.tan(camera.fov * DEG / 2);
    const dist = Math.max(hy / (tanV * fillY), hx / (tanV * camera.aspect * fillX)) + zMax;
    if (lower) center.addScaledVector(upCam, dist * tanV * lower);
    orbit.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    orbit.update();
    return true;
  }
  studio.fitPoints = fitCameraToPoints;

  // Auto-frame: look along the axis of motion (so the swing is seen square-on)
  // from the side the limb isn't hidden behind the body, then come off-axis a
  // little so the plane of motion reads as a plane rather than a flat tint. The
  // distance is fitCameraToPoints' exact fit of the shot's points.
  function frameCamera(clip) {
    const { figure, side, move, opts } = clip;
    const pts = clip.shot;
    const gq = figure.group.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3(0, 0, move.from === 'back' ? -1 : 1).applyQuaternion(gq);
    const out = new THREE.Vector3(side === 'L' ? 1 : -1, 0, 0).applyQuaternion(gq);
    const a = clip.motion.axis;
    const dir = new THREE.Vector3();
    const mix = (p, q, deg) => dir.copy(p).multiplyScalar(Math.cos(deg * DEG)).addScaledVector(q, Math.sin(deg * DEG));
    if (Math.abs(a.dot(up)) > 0.7) mix(fwd, up, 52).addScaledVector(out, 0.25);
    else if (Math.abs(a.dot(out)) > 0.7) mix(out, fwd, 22).addScaledVector(up, 0.14);
    else mix(fwd, out, 20).addScaledVector(up, 0.14);
    dir.normalize();
    fitCameraToPoints(pts, dir, {
      pad: 0.07 * figure.height,       // flesh around the joint centres
      fillY: opts.title ? 0.76 : 0.88, // keep the top clear for the title
      fillX: opts.movers ? 0.46 : 0.8, // …and the sides for the callout columns
      lower: opts.title ? 0.09 : 0,    // sit the subject under the title block
    });
  }

  // The plane of motion + its axis, as real 3D objects (the body occludes them,
  // which is what makes the plane read as passing THROUGH the joint).
  const planeViz = (() => {
    const group = new THREE.Group();
    group.visible = false;
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 }));
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12), new THREE.MeshBasicMaterial());
    rod.rotation.x = Math.PI / 2; // cylinder's length along the group's z (the axis)
    group.add(quad, edge, rod);
    scene.add(group);
    return { group, quad, edge, rod, mat };
  })();

  function updatePlaneViz() {
    const clip = studio.clip;
    const on = !!clip && clip.opts.plane;
    planeViz.group.visible = on;
    if (!on) return;
    const m = clip.motion;
    const color = PLANES[clip.move.plane].color;
    planeViz.mat.color.setHex(color);
    planeViz.edge.material.color.setHex(color);
    planeViz.rod.material.color.setHex(color);
    const half = planeHalf(clip);
    planeViz.group.position.copy(m.center);
    planeViz.group.quaternion.setFromUnitVectors(_a.set(0, 0, 1), m.axis);
    planeViz.quad.scale.setScalar(half * 2);
    planeViz.edge.scale.setScalar(half * 2);
    planeViz.rod.scale.set(0.0035, half * 1.7, 0.0035);
  }

  // Prime movers: light the moving side's bellies and hang a callout on each
  // group. They only SHOW in the muscle layer (a label hides with its mesh).
  function applyMovers(clip) {
    const { figure, side, move, opts } = clip;
    labels.clear({ temp: true });
    const groups = (opts.movers ? move.movers ?? [] : []).map((g) => (Array.isArray(g) ? g : [g, g]));
    const names = groups.flatMap((g) => g.slice(1));
    figure.setMuscleLit(new Set(names.map((n) => `${n}|${side}`)));
    const all = [...new Set(figure.layerMeshes.muscle.map((m) => m.userData.muscleName).filter(Boolean))];
    figure.setMuscleHidden(opts.movers && opts.fade ? new Set(all.filter((n) => !names.includes(n))) : null);
    for (const [text, ...bellies] of groups) {
      const mesh = bellies.map((n) => labels.muscleMesh(figure, n, side)).find(Boolean);
      if (mesh) labels.addMuscle(figure, mesh, { text, camera, temp: true });
    }
  }

  function buildTimeline(clip) {
    const { opts } = clip;
    const main = clip.baseMove;
    const pair = MOVEMENT_BY_ID[main.pair];
    // A full sweep needs both halves to share one test position, or the pose
    // would jump as it passes neutral (elbow flexion/extension are one motion).
    const sweep = opts.pattern === 'sweep' && pair
      && JSON.stringify(pair.base ?? null) === JSON.stringify(main.base ?? null);
    clip.moves = sweep ? [main, pair] : [main];
    const segs = [];
    let t = 0;
    for (const move of clip.moves) {
      const t0 = t + LEAD_IN;
      segs.push({ move, t0, t1: t0 + opts.stroke, t2: t0 + opts.stroke + opts.hold, t3: t0 + 2 * opts.stroke + opts.hold });
      t = t0 + 2 * opts.stroke + opts.hold;
    }
    clip.segs = segs;
    clip.duration = t + TAIL;
  }

  function evalTimeline(clip, t) {
    let seg = clip.segs[0];
    for (const s of clip.segs) if (t >= s.t0 - LEAD_IN) seg = s;
    let u = 0;
    if (t >= seg.t0 && t < seg.t1) u = ease((t - seg.t0) / (seg.t1 - seg.t0));
    else if (t >= seg.t1 && t < seg.t2) u = 1;
    else if (t >= seg.t2 && t < seg.t3) u = 1 - ease((t - seg.t2) / (seg.t3 - seg.t2));
    return { move: seg.move, u };
  }

  function applyClipTime(clip) {
    const { move, u } = evalTimeline(clip, clip.t);
    if (move !== clip.move) {
      // A full sweep has crossed neutral into the opposite movement: its own
      // axis, arc, title and prime movers take over.
      prepareMotion(clip, move);
      applyMovers(clip);
      if (labels.frozen) freezeLabels(clip);
      studio.onClipChanged?.();
    }
    poseClip(clip, move, u);
  }

  studio.clipOptions = {
    title: true, angle: true, plane: true, movers: true, fade: false,
    autoFrame: true, pattern: 'loop', stroke: 2.0, hold: 1.0, loops: 1,
    // Reset the dancer to the anatomical position on entering a clip. Default
    // off — see enterClip.
    anatomical: false,
  };

  // Enter (or switch) the clip: one dancer alone at the origin in the neutral
  // stance, the partner hidden, constraints and balance visuals suspended (see
  // main.js `studio.clipActive`). The scene as it was is put back by exitClip.
  studio.enterClip = (moveId, {
    figure = app.leader, side = 'R', anatomical = studio.clipOptions.anatomical,
  } = {}) => {
    const move = MOVEMENT_BY_ID[moveId];
    if (!move) return false;
    if (studio.busy) return false;
    const opts = studio.clipOptions;
    if (!studio.clip) {
      app.deselect();
      studio.saved = {
        state: app.getCoupleState('clip'),
        shown: app.shown ?? 'both',
        cam: [camera.position.clone(), orbit.target.clone()],
        minDistance: orbit.minDistance,
        frame: studio.frame,
        looks: app.figures.map((f) => [f, f.litMuscles, f.hiddenMuscles]),
        spheres: app.figures.map((f) => f.pickSpheres.map((s) => s.visible)),
      };
      orbit.minDistance = 0.3;
      studio.setFrame('slide');
      // Pick spheres are click targets, not anatomy — keep them out of the shot.
      for (const f of app.figures) for (const s of f.pickSpheres) s.visible = false;
    }
    app.setVisibleFigures(figure === app.leader ? 'leader' : 'follower');
    // The textbook neutral stance at the origin — the anatomical position every
    // range of motion is defined from. OFF by default: a teacher showing what
    // hip flexion looks like INSIDE a cruzada wants the pose they built, not a
    // dancer who snaps to a T-pose the moment the clip opens. The ⟲ button (and
    // studio.clipOptions.anatomical) asks for it explicitly.
    //
    // Keeping the pose stays honest because nothing downstream assumes neutral:
    // `drive` targets are absolute angles, and the angle readout measures the
    // marker's swing since the pose the clip OPENED on (clip.baseAngles, just
    // below), so it reports the movement actually made from here.
    if (anatomical) {
      figure.group.position.set(0, 0, 0);
      figure.group.rotation.set(0, 0, 0);
      figure.resetPose();
      figure.setJointDegrees(NEUTRAL);
    }
    const clip = {
      figure, side, opts, baseMove: move, move, t: 0, anatomical,
      playing: studio.clip?.playing ?? false,
    };
    // The row's own test position (elbow at 90° for shoulder rotation, the leg
    // carried forward for hip adduction) is applied EITHER WAY: it is part of
    // the movement's definition, touches only the joints that movement needs,
    // and the marker, arc and plane are all defined against it. Most rows have
    // no `base` at all, so this is a no-op for them.
    setDegrees(figure, move.base ?? {}, side);
    // Base angle of every joint any segment drives (both halves of a sweep).
    clip.baseAngles = {};
    for (const mv of [move, MOVEMENT_BY_ID[move.pair]].filter(Boolean)) {
      for (const d of mv.drive) {
        const name = sided(d.joint, side);
        (clip.baseAngles[name] ??= {})[d.axis] = figure.nodes[name].rotation[d.axis];
      }
    }
    studio.clip = clip;
    buildTimeline(clip);
    // The shot covers every movement the clip plays (both halves of a sweep);
    // the main movement is prepared last, so the clip opens on it.
    clip.shot = [...clip.moves].reverse().flatMap((mv) => shotPoints(clip, prepareMotion(clip, mv)));
    // Callout columns stand clear of the whole swing, not just the rest pose.
    labels.boundsPoints = clip.shot;
    if (opts.autoFrame) frameCamera(clip);
    applyMovers(clip);
    hooks.setDissoc(move.floor === 'dissoc' ? figure : null);
    if (clip.playing) freezeLabels(clip); else labels.unfreeze();
    studio.onClipChanged?.();
    return true;
  };

  // Put the dancer into the anatomical position without leaving the clip. It
  // re-enters the same movement with the neutral stance applied, so the base
  // angles, the timeline, the shot points and the framing are all rebuilt
  // against it rather than left describing the pose that has just been thrown
  // away. One-way on purpose: the pose it replaced is the user's, and
  // exitClip's saved state is what brings that back.
  studio.clipAnatomical = () => {
    const clip = studio.clip;
    if (!clip || studio.busy) return false;
    return studio.enterClip(clip.baseMove.id, {
      figure: clip.figure, side: clip.side, anatomical: true,
    });
  };

  studio.exitClip = () => {
    const s = studio.saved;
    if (!studio.clip || !s || studio.busy) return;
    studio.clip = null;
    studio.saved = null;
    labels.clear({ temp: true });
    labels.unfreeze();
    labels.boundsPoints = null;
    planeViz.group.visible = false;
    hooks.setDissoc(null);
    for (const [f, lit, hidden] of s.looks) { f.setMuscleLit(lit); f.setMuscleHidden(hidden); }
    app.figures.forEach((f, i) => f.pickSpheres.forEach((sp, j) => { sp.visible = s.spheres[i][j]; }));
    app.applyCoupleState(s.state);
    app.setVisibleFigures(s.shown);
    orbit.minDistance = s.minDistance;
    studio.setFrame(s.frame);
    camera.position.copy(s.cam[0]);
    orbit.target.copy(s.cam[1]);
    studio.onClipChanged?.();
  };

  // Re-apply after an option changed (overlay toggles, timing). A change of
  // PATTERN changes what the shot must contain, so it re-enters (and re-frames);
  // the rest deliberately leave the camera alone — the user may have orbited.
  studio.refreshClip = (reenter = false) => {
    const clip = studio.clip;
    if (!clip) return;
    if (reenter) { studio.enterClip(clip.baseMove.id, { figure: clip.figure, side: clip.side }); return; }
    buildTimeline(clip);
    clip.t = Math.min(clip.t, clip.duration);
    applyMovers(clip);
    studio.onClipChanged?.();
  };

  studio.playClip = (on = true) => {
    const clip = studio.clip;
    if (!clip) return;
    clip.playing = on;
    if (on) freezeLabels(clip); else labels.unfreeze();
    studio.onClipChanged?.();
  };

  studio.scrubClip = (p) => {
    const clip = studio.clip;
    if (!clip) return;
    clip.playing = false;
    clip.t = THREE.MathUtils.clamp(p, 0, 1) * clip.duration;
    applyClipTime(clip);
    studio.onClipChanged?.();
  };

  // Lay the callouts out ONCE for the whole clip — at mid-stroke, the pose that
  // best represents where the anatomy spends the motion — and hold the text
  // there while only the leader lines follow (see Labels.freeze).
  function freezeLabels(clip) {
    labels.unfreeze();
    const keep = clip.t;
    poseClip(clip, clip.move, 0.5);
    clip.figure.updateMuscleSkin();
    labels.freeze(labels.layout(hudCtx, camera, hud.width, hud.height, { top: titleBottom(hud.height) }));
    clip.t = keep;
    applyClipTime(clip);
  }

  // Record `opts.loops` passes of the clip to a video file.
  studio.recordClip = () => {
    const clip = studio.clip;
    if (!clip || studio.busy) return false;
    app.deselect();
    clip.t = 0;
    applyClipTime(clip);
    freezeLabels(clip);
    clip.loopsLeft = Math.max(1, clip.opts.loops);
    clip.playing = false;
    clip.arming = true; // held at the first frame until the encoder is awake
    studio.onClipChanged?.();
    const side = LIMB_BASES.has(clip.baseMove.drive[0].joint) ? `-${clip.side}` : '';
    studio.whenEncoderReady().then(() => {
      if (studio.clip !== clip || !clip.arming) return;
      clip.arming = false;
      const rec = studio.startRecorder(`tangle-${clip.baseMove.id}${side}`, ({ retry }) => {
        labels.unfreeze();
        studio.onClipChanged?.();
        if (retry) studio.recordClip();
      });
      if (rec) {
        clip.rec = rec;
        clip.playing = true;
      }
      studio.onClipChanged?.();
    });
    return true;
  };

  // Per-frame: advance the clip (main.js calls this before the floor clamp).
  studio.update = (dt) => {
    const clip = studio.clip;
    if (!clip) return;
    if (clip.playing) {
      clip.t += dt;
      if (clip.t >= clip.duration) {
        if (clip.rec && --clip.loopsLeft <= 0) {
          clip.t = clip.duration;
          clip.playing = false;
          const rec = clip.rec;
          clip.rec = null;
          setTimeout(() => rec.stop(), 150); // let the last frames reach the file
        } else clip.t %= clip.duration;
      }
    }
    applyClipTime(clip);
  };

  // Per-frame, after every constraint has run: read the final pose back.
  studio.updateViz = () => {
    const clip = studio.clip;
    if (!clip) return;
    measure(clip);
    updatePlaneViz();
    studio.onClipTick?.(clip.t / clip.duration, Math.abs(clip.motion.angle) / DEG);
  };

  // ------------------------------------------------------- the clip overlay
  const titleBottom = (h) => (studio.clip?.opts.title ? h * 0.155 : 0);

  function project(v, w, h, out) {
    _b.copy(v).project(camera);
    out.x = (_b.x * 0.5 + 0.5) * w;
    out.y = (-_b.y * 0.5 + 0.5) * h;
    return out;
  }

  function haloText(ctx, text, x, y, fill, theme, width) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.halo;
    ctx.lineWidth = width;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function drawClipOverlay(ctx, w, h, theme) {
    const clip = studio.clip;
    const { move, motion: m, opts } = clip;
    const plane = PLANES[move.plane];
    const color = plane.color;
    const p = { x: 0, y: 0 };
    const q = { x: 0, y: 0 };
    const base = labels.size * h;

    if (opts.angle && m.u0.lengthSq() > 0.5) {
      // The arc lives in 3D (centre, axis, neutral direction) but is DRAWN in
      // 2D from projected points, so its strokes stay thick and crisp at any
      // export size and never sink inside the body.
      const at = (ang, r, out) => project(
        _a.copy(m.u0).applyAxisAngle(m.axis, ang).multiplyScalar(r).add(m.center), w, h, out);
      const path = (a0, a1, r, close) => {
        const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (4 * DEG)));
        ctx.beginPath();
        if (close) { project(m.center, w, h, p); ctx.moveTo(p.x, p.y); }
        for (let i = 0; i <= n; i++) {
          at(a0 + (a1 - a0) * (i / n), r, p);
          if (i === 0 && !close) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        if (close) ctx.closePath();
      };
      const lw = Math.max(1.5, base * 0.1);
      ctx.lineCap = ctx.lineJoin = 'round';
      // The arc is drawn in the backdrop's ink, not the plane's colour: a red
      // sagittal sector over red muscle simply disappears.
      path(0, m.angle, m.radius, true);
      ctx.fillStyle = theme.arcFill;
      ctx.fill();
      // The whole range, dashed, with a tick at end range.
      ctx.setLineDash([lw * 2.2, lw * 2.6]);
      ctx.strokeStyle = theme.line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = lw * 0.8;
      path(0, m.end, m.radius, false);
      ctx.stroke();
      project(m.center, w, h, p); at(0, m.radius * 1.12, q);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.setLineDash([]);
      at(m.end, m.radius * 0.9, p); at(m.end, m.radius * 1.1, q);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.globalAlpha = 1;
      // The swept arc and the moving arm of the angle.
      for (const [ink, width] of [[theme.halo, lw * 2.8], [theme.line, lw * 1.5]]) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = width;
        path(0, m.angle, m.radius, false);
        ctx.stroke();
        project(m.center, w, h, p); at(m.angle, m.radius * 1.12, q);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      project(m.center, w, h, p);
      ctx.fillStyle = theme.line;
      ctx.beginPath(); ctx.arc(p.x, p.y, lw * 1.6, 0, Math.PI * 2); ctx.fill();
      // The readout rides the middle of the swept angle, just outside the arc.
      at(m.angle / 2, m.radius * 1.5, p);
      drawPill(ctx, `${Math.round(Math.abs(m.angle) / DEG)}°`, p.x, p.y, base * 1.35, theme, { align: 'center', weight: 700 });
    }

    if (opts.plane) {
      // Captions at the plane's highest corner and the axis's upper end.
      const half = planeHalf(clip);
      const font = base * 0.82;
      ctx.font = `600 ${font}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      let best = null;
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        _a.set(sx * half, sy * half, 0).applyQuaternion(planeViz.group.quaternion).add(m.center);
        project(_a, w, h, q);
        if (!best || q.y < best.y) best = { x: q.x, y: q.y };
      }
      haloText(ctx, plane.title, best.x + font * 0.4, best.y + font * 0.9, hex(color), theme, font * 0.28);
      const e1 = project(_a.copy(m.axis).multiplyScalar(half * 0.85).add(m.center), w, h, { x: 0, y: 0 });
      const e2 = project(_a.copy(m.axis).multiplyScalar(-half * 0.85).add(m.center), w, h, { x: 0, y: 0 });
      // The axis end farther from the plane caption, so the two never collide.
      const far = (o) => Math.hypot(o.x - best.x, o.y - best.y);
      const e = far(e1) > far(e2) ? e1 : e2;
      // Looking straight down the axis both ends project onto the joint — the
      // caption would sit on the arc, so it is dropped (the subtitle names it).
      if (Math.hypot(e1.x - e2.x, e1.y - e2.y) > font * 9 && far(e) > font * 6) {
        haloText(ctx, plane.axis, e.x + font * 0.5, e.y, hex(color), theme, font * 0.28);
      }
    }

    if (opts.title) {
      const x = h * 0.045;
      const big = h * 0.052;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `700 ${big}px "Segoe UI", system-ui, sans-serif`;
      haloText(ctx, move.title, x, h * 0.088, theme.text, theme, big * 0.16);
      const small = h * 0.026;
      ctx.font = `500 ${small}px "Segoe UI", system-ui, sans-serif`;
      const rom = `0–${Math.round(Math.abs(m.end) / DEG)}°`;
      const sub = [move.subtitle, plane.title, plane.axis.toLowerCase(), rom].filter(Boolean).join('  ·  ');
      haloText(ctx, sub, x, h * 0.088 + small * 1.7, theme.sub, theme, small * 0.22);
    }
    return titleBottom(h);
  }

  studio.movements = MOVEMENTS;
  studio.layoutCanvas();
  return studio;
}
