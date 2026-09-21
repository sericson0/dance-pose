import * as THREE from 'three';
import { JOINT_BY_NAME, JOINT_TITLES, BODY_PARTS, FLOOR_CONTACT_FRAC } from './skeletonDef.js';
import { keyAngles, tangoStats, convexHull2D, stabilityMargin } from './analysis.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const STORAGE_KEY = 'tangoPoseStudio.poses.v1';
// The deck's running order. Separate from STORAGE_KEY so the name→slide map
// keeps the shape every already-saved pose is stored in.
const ORDER_KEY = 'tangoPoseStudio.slideOrder.v1';

const AXIS_FALLBACK = { x: 'Forward / back', y: 'Twist', z: 'Side' };

// WCAG 2.x relative luminance of a '#rrggbb' string (or a 0xrrggbb number —
// figure/part colours arrive in both forms).
export function relLum(color) {
  const n = typeof color === 'number'
    ? color
    : parseInt(String(color ?? '').replace('#', ''), 16);
  if (!Number.isFinite(n)) return 0;
  const [r, g, b] = [16, 8, 0]
    .map((s) => ((n >> s) & 0xff) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2.x contrast ratio between two colours.
export function contrastRatio(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Ink for text sitting on an arbitrary fill: whichever of black/white contrasts
// better. The highlight colours are picked by the user from a free
// <input type="color">, so a hardcoded foreground can be driven to zero contrast
// (the old '#1a1206' already read only 3.43:1 on the shipped Right-leg red, and
// a pick of #101010 would have been unreadable). Black-or-white is not a style
// choice but the optimum: the worst case over the WHOLE sRGB cube is 4.58:1, so
// no pick can drop below AA. Softening the inks measurably lowers that floor
// (#12100a/#f4f6fb bottom out at 4.19:1), so leave them pure.
export const readableInk = (color) =>
  (contrastRatio('#000000', color) >= contrastRatio('#ffffff', color) ? '#000000' : '#ffffff');

// Open vs. closed chain is only offered for the legs/pelvis (the joints with a
// foot to plant); arms and the spine are always open chain.
const CHAIN_JOINTS = new Set([
  'pelvis', 'hip_L', 'knee_L', 'ankle_L', 'toes_L', 'hip_R', 'knee_R', 'ankle_R', 'toes_R',
]);

// The heading toggle of a collapsible sidebar section: the <button> inside the
// <h2> (keyboard-reachable — an <h2> is not), falling back to the h2 itself so
// markup without the button still folds.
function sectionToggle(section) {
  const h2 = section?.querySelector('h2');
  if (!h2) return null;
  return h2.classList.contains('collapse-toggle') ? h2 : h2.querySelector('.collapse-toggle');
}

/**
 * Fold or unfold a sidebar section, keeping the styling class and the exposed
 * state in step: `.collapsed` on the <section> drives the CSS, `aria-expanded`
 * on the heading button tells assistive tech. Anything that opens a section
 * programmatically (e.g. revealing Contact pins when a pin is pending) must go
 * through here rather than touching the class, or the two drift apart.
 * @param {HTMLElement|null} section the sidebar <section>
 * @param {boolean} collapsed true to fold it away, false to open it
 */
export function setSectionCollapsed(section, collapsed) {
  if (!section) return;
  section.classList.toggle('collapsed', !!collapsed);
  sectionToggle(section)?.setAttribute('aria-expanded', String(!collapsed));
  // Opening a section that belongs to another tab must bring that tab forward
  // too, or a caller that "reveals" something (the joint panel on selection,
  // Contact pins on a pending spot, Labels after "Label highlighted") would
  // unfold it inside a hidden group and appear to do nothing.
  if (!collapsed) activateTab(section.dataset.tab);
  saveLayout();
}

// ------------------------------------------------------------- sidebar tabs
const LAYOUT_KEY = 'tangoPoseStudio.layout.v1';
const TABS = ['pose', 'teach', 'measure'];
// Restoring writes the very classes that trigger a save; nothing persists until
// the stored layout has been applied.
let layoutReady = false;

const sidebarSections = () => [...document.querySelectorAll('#sidebar > section')];

function readLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; }
}

function saveLayout(patch = {}) {
  if (!layoutReady) return;
  const sidebar = document.getElementById('sidebar');
  const next = {
    ...readLayout(),
    tab: sidebar?.dataset.activeTab,
    collapsed: sidebarSections().filter((s) => s.classList.contains('collapsed') && s.id).map((s) => s.id),
    ...patch,
  };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* full / private mode */ }
}

/**
 * Show one workflow's sections and hide the rest. The sections never move — a
 * section declares its group with data-tab and CSS filters on the sidebar's
 * data-active-tab — so DOM order stays visual order and focus order with it.
 * @param {string} name one of TABS; anything else is ignored
 */
export function activateTab(name) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || !TABS.includes(name)) return;
  sidebar.dataset.activeTab = name;
  for (const b of document.querySelectorAll('#sidebar-tabs button')) {
    b.setAttribute('aria-pressed', String(b.dataset.tab === name));
  }
  // The dividing hairline belongs to the last section actually SHOWN, which
  // :last-child cannot express: the filter hides with display:none, so the
  // markup's last child still matches it whatever tab is up.
  const shown = sidebarSections().filter((s) => s.dataset.tab === name);
  for (const s of sidebarSections()) s.classList.remove('last-shown');
  shown.at(-1)?.classList.add('last-shown');
  saveLayout();
}

// Put back the tab and the folded/unfolded set from the last visit. Sections
// are written directly rather than through setSectionCollapsed, which would
// activate a tab per restored section and fight the stored one.
function restoreLayout() {
  const saved = readLayout();
  if (Array.isArray(saved.collapsed)) {
    for (const s of sidebarSections()) {
      if (!s.id) continue;
      const collapsed = saved.collapsed.includes(s.id);
      s.classList.toggle('collapsed', collapsed);
      sectionToggle(s)?.setAttribute('aria-expanded', String(!collapsed));
    }
  }
  activateTab(TABS.includes(saved.tab) ? saved.tab : 'pose');
  layoutReady = true;
}

export function initUI(app) {
  const $ = (id) => document.getElementById(id);
  // Toggle the .active class across a button group; `isOn` picks the winner.
  const setActive = (btns, isOn) => btns.forEach((b) => b.classList.toggle('active', isOn(b)));
  // Snapshot undo history when a slider drag or keyboard focus begins.
  const pushHistoryOnEdit = (input) => {
    input.addEventListener('pointerdown', () => app.pushHistory());
    input.addEventListener('focus', () => app.pushHistory());
  };

  // ---------------------------------------------------------------- modes
  // One line per mode, written into #hint as the mode changes. The topbar
  // buttons already carry a paragraph of task-specific prose in their `title`,
  // but a title is invisible until you hover the very button you just clicked;
  // these are the same advice cut to one line at #hint's width. NAV is always
  // true, so it is appended rather than repeated in every row.
  const NAV_HINT = 'left-drag to orbit · right-drag to pan · scroll to zoom';
  const MODE_HINTS = {
    rotate: 'Click a joint, then drag a ring to rotate it · arrows nudge it (PageUp/Down = twist) · Esc clears the selection',
    ik: 'Click a hand or foot to drag the whole limb, the toes to caress the floor, an elbow or knee to swivel it · arrows move the handle',
    hips: 'Drag the hips handle: the upper body rides along, planted feet stay put · PageUp/Down crouch and rise',
    move: 'Click a dancer, then drag the arrows to slide them or the ring to turn them · pick the turn axis in "Turn about"',
    step: 'Click a dancer to walk them one step forward — keep clicking to walk · arrows step and turn',
    pin: 'Click a spot on one dancer, then the matching spot on the other, to hold them together · Esc cancels a half-made pin',
    draw: 'Click two points to draw — a JOINT pins that end to the dancer · click a finished shape to select it, then drag an end or recolour it',
    label: 'Click a bone, muscle or joint to name it; click it again to remove the label · the toolbar limits what a click may pick',
  };
  const hintEl = $('hint');
  const setHint = (mode) => {
    if (hintEl) hintEl.textContent = `${MODE_HINTS[mode] ?? MODE_HINTS.rotate} · ${NAV_HINT}`;
  };

  const modeButtons = [...document.querySelectorAll('#mode-buttons button')];
  const hipsPlantBox = $('hips-plant');
  // Planted feet belong to the hips SLIDE; the twist turns the legs and feet
  // round with the pelvis on purpose, so the choice does not apply there.
  const syncHipsPlant = () => {
    hipsPlantBox.hidden = app.mode !== 'hips' || app.hipsTool !== 'slide';
  };
  const selectMode = (mode) => {
    setActive(modeButtons, (b) => b.dataset.mode === mode);
    $('draw-tools').hidden = mode !== 'draw';
    $('label-tools').hidden = mode !== 'label';
    // The turn pivot only exists while moving a whole figure (the gizmo slides
    // and turns in one, so there is no Slide/Turn toggle); Slide/Twist and the
    // planted-feet choice only while moving the hips.
    $('move-pivot-box').hidden = mode !== 'move';
    $('hips-tools').hidden = mode !== 'hips';
    app.setMode(mode);
    syncHipsPlant();
    setHint(mode);
  };
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => selectMode(btn.dataset.mode));
  }
  setHint(app.mode);

  // Present mode. The button is the only way in; Esc, F11 and the capture-phase
  // key handler in main.js are the ways out.
  const presentBtn = $('present-btn');
  const syncPresent = () => {
    presentBtn.textContent = app.presenting ? '✕ End' : '▶ Present';
  };
  presentBtn.addEventListener('click', () => app.togglePresent());
  syncPresent();

  const movePivot = $('move-pivot');
  movePivot.addEventListener('change', () => app.setMovePivot(movePivot.value));

  // Move-hips sub-toolbar: translate the pelvis vs. twist it under a still chest.
  const hipsToolBtns = [...document.querySelectorAll('#hips-tools button[data-hips-tool]')];
  for (const btn of hipsToolBtns) {
    btn.addEventListener('click', () => {
      setActive(hipsToolBtns, (b) => b === btn);
      app.setHipsTool(btn.dataset.hipsTool);
      syncHipsPlant();
    });
  }

  // Move-hips planted feet: auto-set from floor contact when a dancer is
  // picked (app.selectFigure → onHipsPlantChanged), user-overridable here.
  const plantL = $('plant-L');
  const plantR = $('plant-R');
  plantL.addEventListener('change', () => { app.hipsPlant.L = plantL.checked; });
  plantR.addEventListener('change', () => { app.hipsPlant.R = plantR.checked; });

  // Draw-mode sub-toolbar: which annotation the next floor clicks author.
  const drawToolBtns = [...document.querySelectorAll('#draw-tools button[data-tool]')];
  for (const btn of drawToolBtns) {
    btn.addEventListener('click', () => {
      setActive(drawToolBtns, (b) => b === btn);
      app.setDrawTool(btn.dataset.tool);
    });
  }
  // Label-mode sub-toolbar: what a click is allowed to pick.
  const labelFilterBtns = [...document.querySelectorAll('#label-tools button[data-label-filter]')];
  for (const btn of labelFilterBtns) {
    btn.addEventListener('click', () => {
      setActive(labelFilterBtns, (b) => b === btn);
      app.setLabelFilter(btn.dataset.labelFilter);
    });
  }

  const drawUndo = $('draw-undo');
  const drawClear = $('draw-clear');
  const drawDelete = $('draw-delete');
  const drawHide = $('draw-hide');
  const drawColor = $('draw-color');
  const drawWidth = $('draw-width');
  const drawExtend = $('draw-extend');
  const drawFlip = $('draw-flip');
  const drawOwn = $('draw-own');
  const drawFocusTag = $('draw-focus-tag');
  // Claim / release the SELECTED drawing for the focused keyframe. This is the
  // way an EXISTING shape joins one — drawing a new one while focused claims it
  // automatically (app.claimForFocus), and this is the same rule reachable by
  // hand, in both directions. Shown only while a keyframe is focused: with none
  // there is no keyframe for a drawing to belong to.
  drawOwn.addEventListener('click', () => {
    const i = app.seqFocusIndex();
    const sel = app.drawSelected;
    if (i < 0 || !sel) return;
    const on = !app.seqOwnsDrawing(i, sel);
    app.seqOwnDrawing(i, sel, on);
    app.status(on
      ? `That drawing now belongs to keyframe ${i + 1} alone.`
      : `That drawing is back on every keyframe.`, 'info');
    syncDrawButtons();
  });
  drawUndo.addEventListener('click', () => app.removeLastDrawing());
  // A diagram now survives a reload, so Clear destroys authored work AND the
  // saved copy of it, and annotations sit outside the pose undo stack — Ctrl+Z
  // cannot bring one back. Ask, but only when there is something to lose (the
  // rule the sequence/pins/labels wipes already follow). The dialog lives here
  // and never in app.clearDrawings, which the headless scripts drive directly.
  drawClear.addEventListener('click', () => {
    const n = app.drawings.length;
    if (n && !window.confirm(`Remove all ${n} drawing${n === 1 ? '' : 's'}? This also clears the saved copy and cannot be undone.`)) return;
    app.clearDrawings();
    if (n) app.status(`Removed ${n} drawing${n === 1 ? '' : 's'}.`, 'info');
  });
  drawDelete.addEventListener('click', () => app.removeSelectedDrawing());
  // One control, two meanings, decided by the selection — the same idiom the
  // swatch and the width slider already carry. With a drawing selected it hides
  // that one; with nothing selected it brings every hidden drawing back. Hiding
  // is what builds the subset a sequence keyframe captures (◻ on its row), and
  // it is a VIEW state: nothing is deleted and nothing leaves the saved file.
  drawHide.addEventListener('click', () => {
    const sel = app.drawSelected;
    if (sel) {
      app.setDrawingVisible(sel, false);
      app.selectDrawing(null); // its handles would hang in the air over nothing
      app.status('Drawing hidden — ◻ on a keyframe row captures what is showing.', 'info');
      return;
    }
    app.setDrawVisibleIds(null);
    app.status('All drawings shown.', 'info');
  });
  // The swatch and the width slider are ONE control with two meanings, decided
  // by whether a drawing is selected: restyle that one, or set the look the
  // next one is drawn in (app.setDrawStyle owns the rule). `input` rather than
  // `change` so dragging the slider redraws live.
  drawColor.addEventListener('input', () => app.setDrawStyle({ color: drawColor.value }));
  drawWidth.addEventListener('input', () => app.setDrawStyle({ width: parseFloat(drawWidth.value) }));
  drawExtend.addEventListener('input', () => app.setDrawStyle({ extend: parseFloat(drawExtend.value) }));
  drawFlip.addEventListener('click', () => app.flipDrawFacing());
  const syncDrawButtons = () => {
    const empty = app.drawings.length === 0;
    drawUndo.disabled = empty;
    drawClear.disabled = empty;
    drawDelete.disabled = !app.drawSelected;
    // Flip belongs to a facing arrow alone, so it is only on the bar while one
    // is selected — the toolbar is the most crowded strip in the app.
    drawFlip.hidden = app.drawSelected?.userData.annotation?.type !== 'facing';
    // With nothing selected the button is the way back: it clears the filter
    // outright, so it is armed whenever there IS one, not only when a drawing
    // happens to be off screen (a full-set filter still silently excludes every
    // drawing authored after it).
    const filtered = app.drawVisibleIds !== null;
    drawHide.textContent = app.drawSelected ? '◐ Hide' : '◉ Show all';
    drawHide.disabled = !app.drawSelected && !filtered;
    // The focus, said in the Draw toolbar too: the user is in another mode, in
    // another corner of the screen, and needs to know their chalk is being
    // filed under one keyframe.
    const fi = app.seqFocusIndex?.() ?? -1;
    drawFocusTag.hidden = fi < 0;
    drawOwn.hidden = fi < 0;
    if (fi >= 0) {
      $('draw-focus-which').textContent = app.seqName(fi);
      const owns = app.drawSelected && app.seqOwnsDrawing(fi, app.drawSelected);
      drawOwn.textContent = owns ? '◼ Only this keyframe' : '◻ Only this keyframe';
      drawOwn.disabled = !app.drawSelected;
      drawOwn.title = app.drawSelected
        ? (owns
          ? `Release this drawing back to every keyframe`
          : `Make this drawing belong to ${app.seqName(fi)} alone`)
        : 'Select a drawing first, then this makes it belong to the focused keyframe alone';
    }
  };
  // A selected drawing hands its own colour and width to the toolbar, so the
  // controls always read the thing they would change.
  const syncDrawStyle = () => {
    const s = app.drawStyle;
    drawColor.value = s.color;
    drawWidth.value = String(s.width);
    drawExtend.value = String(s.extend ?? 0);
  };
  syncDrawButtons();
  syncDrawStyle();

  // The floor diagram survives a reload, like the sequence and the Muscles
  // panel's look. A teacher's chalk is authored work — a giro drawn on the
  // floor under a keyframe chain took as long to place as the keyframes did,
  // and a refresh mid-lesson used to throw all of it away while the sequence
  // it belonged to came back intact.
  const DRAW_KEY = 'tangoPoseStudio.drawings.v1';
  // Restoring goes through the very hook that saves (onDrawingsChanged), and
  // at startup the floor is EMPTY — so nothing may be written until the stored
  // diagram has been applied, or the first sync would overwrite the saved set
  // with nothing. Same guard the Muscles panel and the sidebar layout carry.
  let drawingsReady = false;
  // The keyframe rows carry a ◻ that only means anything with drawings on the
  // floor. Rebuilding the list on every drawing mutation would re-render it
  // for a colour tweak too, so the rows are refreshed when the COUNT moves.
  let lastDrawCount = null;
  function saveDrawings() {
    if (!drawingsReady) return;
    try {
      localStorage.setItem(DRAW_KEY, JSON.stringify(app.drawingsJSON()));
    } catch { /* full / private mode */ }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(DRAW_KEY));
    if (Array.isArray(saved) && saved.length) app.setDrawings(saved);
  } catch { /* corrupted storage: start with a clean floor */ }
  drawingsReady = true;
  syncDrawButtons();

  // Collapsible sidebar sections: the heading's button folds it away. The
  // button is what carries the click (and the keyboard: Enter/Space on an <h2>
  // fire nothing, which locked keyboard users out of every pre-collapsed
  // section), and setSectionCollapsed keeps aria-expanded in step.
  for (const section of document.querySelectorAll('#sidebar section')) {
    const h2 = section.querySelector('h2');
    if (!h2) continue;
    const btn = sectionToggle(section) ?? h2;
    btn.classList.add('collapse-toggle');
    const toggle = () => setSectionCollapsed(section, !section.classList.contains('collapsed'));
    btn.addEventListener('click', toggle);
    // Clicks landing on the heading itself (its padding, or a scripted
    // h2.click()) still fold, as they did when the h2 was the toggle.
    if (btn !== h2) h2.addEventListener('click', (e) => { if (e.target === h2) toggle(); });
    setSectionCollapsed(section, section.classList.contains('collapsed'));
  }
  app.setSectionCollapsed = setSectionCollapsed;

  // The three workflow tabs. Wired before restoreLayout so the stored tab is
  // applied through the same path a click takes.
  for (const btn of document.querySelectorAll('#sidebar-tabs button')) {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  }
  restoreLayout();
  app.activateTab = activateTab;

  // ---------------------------------------------------------------- embrace
  // Close embrace implies the hand hold: enabling close switches hands on,
  // releasing the hands releases the close embrace too.
  const embraceHands = $('embrace-hands');
  const embraceClose = $('embrace-close');
  const embraceControls = $('embrace-controls');
  const syncEmbrace = () => app.setEmbrace({
    hands: embraceHands.checked,
    close: embraceClose.checked,
  });
  // The clasp tilt/height sliders only matter with the arm frame held.
  const syncEmbraceControls = () => { embraceControls.hidden = !embraceHands.checked; };
  embraceHands.addEventListener('change', () => {
    if (!embraceHands.checked) embraceClose.checked = false;
    syncEmbrace();
    syncEmbraceControls();
  });
  embraceClose.addEventListener('change', () => {
    if (embraceClose.checked) embraceHands.checked = true;
    syncEmbrace();
    syncEmbraceControls();
  });
  const embraceTilt = $('embrace-tilt');
  const embraceTiltVal = $('embrace-tilt-val');
  embraceTilt.addEventListener('input', () => {
    embraceTiltVal.textContent = `${embraceTilt.value}°`;
    app.setClaspTilt(Number(embraceTilt.value));
  });
  // Clasp height: the slider value is a percent of mean stature above the
  // shoulders (0 = shoulder level).
  const embraceHeight = $('embrace-height');
  const embraceHeightVal = $('embrace-height-val');
  embraceHeight.addEventListener('input', () => {
    embraceHeightVal.textContent = embraceHeight.value;
    app.setClaspHeight(Number(embraceHeight.value) / 100);
  });
  // Anchor: freeze the couple for hands-on embrace placement (see app.setAnchor).
  const embraceAnchor = $('embrace-anchor');
  const embraceAnchorHint = $('embrace-anchor-hint');
  embraceAnchor.addEventListener('change', () => {
    app.setAnchor(embraceAnchor.checked);
    embraceAnchorHint.hidden = !embraceAnchor.checked;
  });
  // Fix elbows: a per-dancer hold on both elbows (app.setElbowsFixed). The
  // boxes are re-read from the app rather than trusted, so a script or a
  // future caller that flips the hold cannot leave a box lying about it.
  const elbowFix = [$('elbow-fix-0'), $('elbow-fix-1')];
  const syncElbowFix = () => elbowFix.forEach((box, i) => { box.checked = app.elbowsFixed(i); });
  elbowFix.forEach((box, i) => box.addEventListener('change', () => {
    app.setElbowsFixed(i, box.checked);
    if (box.checked) {
      app.status(`${app.figures[i].name}'s elbows are fixed in place — turn the chest, twist the hips or pivot the dancer, and the shoulders absorb it. Untick to release.`, 'info');
    }
  }));
  const showButtons = [...document.querySelectorAll('#show-buttons button')];
  for (const btn of showButtons) {
    btn.addEventListener('click', () => {
      setActive(showButtons, (b) => b === btn);
      app.setVisibleFigures(btn.dataset.show);
    });
  }

  // ---------------------------------------------------------------- tools
  const undoBtn = $('undo-btn');
  const redoBtn = $('redo-btn');
  undoBtn.addEventListener('click', () => app.undo());
  redoBtn.addEventListener('click', () => app.redo());
  $('ground-btn').addEventListener('click', () => app.groundFeet());
  $('link-couple').addEventListener('change', (e) => { app.linkCouple = e.target.checked; });
  for (const btn of document.querySelectorAll('#view-buttons button[data-view]')) {
    btn.addEventListener('click', () => app.setView(btn.dataset.view));
  }
  // The presets aim at the dancers now, but they still fix the distance; this
  // is the one control that fits whatever is shown from wherever you are.
  $('frame-btn').addEventListener('click', () => app.frameDancers());

  // Assets that fell back to a stand-in (app.degraded, filled by main.js's
  // loaders). The session is usable either way, but it is a DIFFERENT app —
  // worded like the Muscles panel's "Muscle atlas unavailable in this session."
  {
    const note = $('degraded-note');
    if (note && app.degraded?.length) {
      note.textContent = app.degraded.join(' ');
      note.hidden = false;
    }
  }

  $('photo-btn').addEventListener('click', () => app.capturePhoto());
  const photoScale = $('photo-scale');
  photoScale.addEventListener('change', () => app.setPhotoScale(Number(photoScale.value)));
  app.setPhotoScale(Number(photoScale.value));

  // Video format: ONE setting (studio.videoFormat) behind two controls — this
  // one beside the photo resolution, and the clips section's own copy. It used
  // to exist only inside the collapsed Movement-clips section while governing
  // the A→B and Sequence ⏺ buttons too.
  const videoFormat = $('video-format');
  const clipFormat = $('clip-format');
  const setVideoFormat = (value, from) => {
    app.setVideoFormat(value);
    if (from !== videoFormat) videoFormat.value = value;
    if (from !== clipFormat) clipFormat.value = value;
  };
  videoFormat.addEventListener('change', () => setVideoFormat(videoFormat.value, videoFormat));
  clipFormat.addEventListener('change', () => setVideoFormat(clipFormat.value, clipFormat));
  setVideoFormat(videoFormat.value, null);
  $('backdrop').addEventListener('change', (e) => app.setBackdrop(e.target.value));
  const frameMode = $('frame-mode');
  frameMode.addEventListener('change', () => app.setFrame(frameMode.value));

  // ---------------------------------------------------------------- layers
  // One dropdown, three mutually exclusive views. Muscles ride the skeleton
  // (they need the bones behind them to read as anatomy), so that mode shows
  // both; the clothed body is opaque, so it never combines with either.
  const LAYER_MODES = {
    body: { skeleton: false, body: true, muscle: false },
    skeleton: { skeleton: true, body: false, muscle: false },
    muscle: { skeleton: true, body: false, muscle: true },
  };
  const layerMode = () => $('layer-mode').value;
  const syncLayers = () => {
    const layers = LAYER_MODES[layerMode()] ?? LAYER_MODES.body;
    app.figures.forEach((f) => f.setLayers(layers));
  };
  $('layer-mode').addEventListener('change', syncLayers);

  const syncViz = () => app.setViz({
    cog: $('show-cog').checked,
    support: $('show-support').checked,
    couple: $('show-couple-cog').checked,
    dissoc: $('show-dissoc').checked,
  });
  ['show-cog', 'show-support', 'show-couple-cog', 'show-dissoc'].forEach((id) => $(id).addEventListener('change', syncViz));

  // The COG plumb line's own look. WebGL cannot widen a line, so the line is a
  // tube and this slider is its diameter. The controls act on the line you last
  // CLICKED in the 3D view, or on all three when none is selected — the target
  // is named beside the label so that is never a guess.
  const cogLineWidth = $('cog-line-width');
  const cogLineColor = $('cog-line-color');
  const cogLineTarget = $('cog-line-target');
  const syncCogLine = (which = app.cogLineSelected) => {
    const s = app.cogLineStyle();
    cogLineWidth.value = String(s.width);
    cogLineColor.value = s.color;
    cogLineTarget.textContent = which
      ? { leader: 'Leader', follower: 'Follower', couple: 'Couple' }[which]
      : 'all dancers';
  };
  cogLineWidth.addEventListener('input', () => app.setCogLineStyle({ width: parseFloat(cogLineWidth.value) }));
  cogLineColor.addEventListener('input', () => app.setCogLineStyle({ color: cogLineColor.value }));
  $('cog-line-reset').addEventListener('click', () => app.setCogLineStyle({ color: null }));
  syncCogLine();

  // ---------------------------------------------------------------- labels
  // Anatomy callouts (labels.js). Authoring happens in the 3D view (Label mode)
  // or via "Label highlighted"; this list edits text, flips a callout to the
  // other column, and removes it.
  const labelList = $('label-list');
  const labelClear = $('label-clear');
  const KIND_TAG = { bone: 'bone', muscle: 'muscle', joint: 'joint' };

  function renderLabels() {
    const rows = app.labels.list;
    labelClear.disabled = rows.length === 0;
    labelList.innerHTML = rows.length ? ''
      : '<span class="muted">No labels yet.</span>';
    for (const label of rows) {
      const row = document.createElement('div');
      row.className = 'pose-item label-item';
      const tag = document.createElement('span');
      tag.className = `label-kind ${KIND_TAG[label.kind]}`;
      // The initial, not just the hue — the dot's colour was its only channel.
      tag.textContent = (KIND_TAG[label.kind] ?? '?')[0].toUpperCase();
      tag.title = `${label.kind} · ${label.figure.name}`;
      // A recoloured callout carries its colour here as well as on the slide,
      // so the list reads as the same set of things the slide shows — whether
      // the colour came from its belly or was picked on the callout itself.
      const own = label.color ?? (label.kind === 'muscle' ? app.muscleColor(label.name) : null);
      if (own) tag.style.background = own;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = label.text;
      input.title = 'Edit the callout text';
      input.addEventListener('input', () => app.setLabelText(label.id, input.value));
      const flip = document.createElement('button');
      flip.textContent = '⇄';
      flip.title = 'Move this callout to the other side of the figure';
      flip.addEventListener('click', () => app.flipLabel(label.id));
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Remove this label';
      del.addEventListener('click', () => app.removeLabel(label.id));
      row.append(tag, input, flip, del);
      labelList.appendChild(row);
    }
  }
  // Typing in a label must not rebuild the list under the cursor.
  const onLabelsChanged = () => {
    if (labelList.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
      && app.labels.list.length === labelList.querySelectorAll('.label-item').length) return;
    renderLabels();
  };
  $('label-highlighted').addEventListener('click', () => {
    const n = app.labelHighlighted();
    if (!n) {
      const why = 'Nothing to label — highlight a body part (Highlight section) or some muscles first, in the Skeleton or Muscles layer.';
      labelList.innerHTML = `<span class="muted">${why}</span>`;
      // This section can be collapsed, so the explanation would otherwise be
      // written where the user cannot see it.
      app.status(why, 'info');
      return;
    }
    setSectionCollapsed($('labels-section'), false);
    app.status(`Added ${n} label${n === 1 ? '' : 's'}.`, 'info');
  });
  labelClear.addEventListener('click', () => {
    // Confirm only when there is something to lose (labels are persisted to
    // localStorage the moment they change, so this wipes the saved copy too).
    const n = app.labels.list.length;
    if (n && !window.confirm(`Remove ${n} label${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    app.clearLabels();
    if (n) app.status(`Removed ${n} label${n === 1 ? '' : 's'}.`, 'info');
  });
  $('labels-visible').addEventListener('change', (e) => app.setLabelsVisible(e.target.checked));
  const labelDetailBtns = [...document.querySelectorAll('#label-detail button')];
  for (const btn of labelDetailBtns) {
    btn.addEventListener('click', () => {
      setActive(labelDetailBtns, (b) => b === btn);
      app.setLabelDetail(btn.dataset.labelDetail);
    });
  }
  const labelSize = $('label-size');
  labelSize.addEventListener('input', () => {
    $('label-size-val').textContent = `${(Number(labelSize.value) / 10).toFixed(1)}%`;
    app.setLabelSize(Number(labelSize.value) / 1000);
  });
  renderLabels();

  // A browser with no MediaRecorder cannot record at all (app.canRecord). Every
  // ⏺ says so on its own tooltip and stays disabled, rather than looking live
  // and console.warning when pressed.
  const NO_RECORDER_TITLE = 'This browser has no video recorder (MediaRecorder). Use 📷 Save photo instead.';

  // ---------------------------------------------------------------- clips
  // Movement clips (studio.js + the MOVEMENTS table). Picking a movement puts
  // one dancer on the clip stage; Exit restores the couple.
  const clipMove = $('clip-move');
  const clipPlay = $('clip-play');
  const clipRecord = $('clip-record');
  const clipExit = $('clip-exit');
  const clipAnatomical = $('clip-anatomical');
  const clipScrub = $('clip-scrub');
  const clipFigBtns = [...document.querySelectorAll('#clip-fig button')];
  const clipSideBtns = [...document.querySelectorAll('#clip-side button')];
  let clipFig = 'leader';
  let clipSide = 'R';
  let clipBackdrop = null; // the backdrop the stage replaced, put back on exit
  {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Choose a movement…';
    clipMove.appendChild(none);
    const groups = new Map();
    for (const m of app.studio.movements) {
      if (!groups.has(m.group)) {
        const og = document.createElement('optgroup');
        og.label = m.group;
        groups.set(m.group, og);
        clipMove.appendChild(og);
      }
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.title;
      groups.get(m.group).appendChild(o);
    }
  }
  const clipOptions = () => ({
    title: $('clip-title').checked,
    angle: $('clip-angle').checked,
    plane: $('clip-plane').checked,
    movers: $('clip-movers').checked,
    fade: $('clip-fade').checked,
    autoFrame: $('clip-autoframe').checked,
    pattern: $('clip-pattern').value,
    stroke: Number($('clip-stroke').value) / 10,
    hold: Number($('clip-hold').value) / 10,
    loops: Number($('clip-loops').value),
  });
  const setClipLayer = () => {
    $('layer-mode').value = $('clip-layer').value;
    $('layer-mode').dispatchEvent(new Event('change'));
  };
  const enterClip = () => {
    if (!clipMove.value) return;
    const fresh = !app.studio.clipActive;
    app.setClipOptions(clipOptions());
    app.enterClip(clipMove.value, { figure: app[clipFig], side: clipSide });
    if (fresh) {
      // First step onto the stage: a clean slide look, unless already chosen.
      setClipLayer();
      if ($('backdrop').value === 'studio') {
        clipBackdrop = 'studio';
        $('backdrop').value = 'dark';
        app.setBackdrop('dark');
      }
    }
  };
  clipMove.addEventListener('change', enterClip);
  $('clip-layer').addEventListener('change', setClipLayer);
  for (const btn of clipFigBtns) {
    btn.addEventListener('click', () => {
      clipFig = btn.dataset.fig;
      setActive(clipFigBtns, (b) => b === btn);
      if (app.studio.clipActive) enterClip();
    });
  }
  for (const btn of clipSideBtns) {
    btn.addEventListener('click', () => {
      clipSide = btn.dataset.side;
      setActive(clipSideBtns, (b) => b === btn);
      if (app.studio.clipActive) enterClip();
    });
  }
  for (const id of ['clip-title', 'clip-angle', 'clip-plane', 'clip-movers', 'clip-fade',
    'clip-autoframe', 'clip-pattern', 'clip-stroke', 'clip-hold', 'clip-loops']) {
    $(id).addEventListener('input', () => {
      $('clip-stroke-val').textContent = `${(Number($('clip-stroke').value) / 10).toFixed(1)} s`;
      $('clip-hold-val').textContent = `${(Number($('clip-hold').value) / 10).toFixed(1)} s`;
      app.setClipOptions(clipOptions());
    });
  }
  // #clip-format is wired beside #video-format in the View section — one
  // setting, two controls that mirror each other.
  clipPlay.addEventListener('click', () => app.playClip(!app.studio.clipPlaying));
  clipRecord.addEventListener('click', () => app.recordClip());
  clipExit.addEventListener('click', () => app.exitClip());
  // The clip keeps whatever pose the dancer was in; this is the way TO the
  // textbook neutral stance, not back from it (Exit restores the couple).
  clipAnatomical.addEventListener('click', () => {
    if (app.clipAnatomical()) app.status('Dancer moved to the anatomical position.', 'info');
  });
  clipScrub.addEventListener('input', () => app.scrubClip(Number(clipScrub.value) / 1000));

  function syncClip() {
    const clip = app.studio.clip;
    const busy = app.studio.busy;
    $('clip-scrub-row').hidden = !clip;
    clipPlay.disabled = !clip || busy;
    clipRecord.disabled = !clip || busy || !app.canRecord;
    if (!app.canRecord) clipRecord.title = NO_RECORDER_TITLE;
    clipExit.disabled = !clip || busy;
    // Already neutral: nothing left to reset.
    clipAnatomical.disabled = !clip || busy || !!clip.anatomical;
    clipPlay.textContent = clip?.playing && !busy ? '⏸ Pause' : '▶ Play';
    clipRecord.textContent = clip?.arming ? '⏺ Preparing…' : busy ? '⏺ Recording…' : '⏺ Record';
    if (clip) $('clip-name').textContent = clip.move.title;
    else {
      clipMove.value = '';
      // The stage borrowed the backdrop; hand it back unless the user has since
      // chosen another one themselves.
      if (clipBackdrop && $('backdrop').value === 'dark') {
        $('backdrop').value = clipBackdrop;
        app.setBackdrop(clipBackdrop);
      }
      clipBackdrop = null;
    }
    // The stage switches the frame and hides the partner — mirror that in the
    // controls that show those states.
    frameMode.value = app.studio.frame;
    setActive(showButtons, (b) => b.dataset.show === (app.shown ?? 'both'));
  }
  app.studio.onClipChanged = syncClip;
  app.studio.onClipTick = (p, deg) => {
    if (document.activeElement !== clipScrub) clipScrub.value = Math.round(p * 1000);
    $('clip-angle-val').textContent = `${Math.round(deg)}°`;
  };

  // ---------------------------------------------------------------- pins
  // Contact pins (see pins.js): the list mirrors app.pins; authoring happens
  // in the 3D view via the Pin-spots mode.
  const pinList = $('pin-list');
  const pinClear = $('pin-clear');
  const endName = (end) => JOINT_TITLES[end.node] || end.node;
  let pinCount = app.pins.count(); // so a NEW pin can be announced, not just listed

  function renderPins() {
    const n = app.pins.count();
    const pending = app.pinPending;
    pinList.innerHTML = '';
    if (!n && !pending) {
      pinList.innerHTML = '<span class="muted">No pins yet — use the Pin spots mode.</span>';
    }
    app.pins.pins.forEach((pin, i) => {
      const row = document.createElement('div');
      row.className = 'pose-item';
      row.innerHTML = `<span class="name">${i + 1} · ${endName(pin.leader)} ↔ ${endName(pin.follower)}</span>`;
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Release this pin';
      del.addEventListener('click', () => app.removePin(i));
      row.appendChild(del);
      pinList.appendChild(row);
    });
    if (pending) {
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = `First spot set on the ${pending.figure.name.toLowerCase()} (${endName(pending).toLowerCase()}) — now click the matching spot on the partner.`;
      pinList.appendChild(note);
      // This section ships collapsed, so the instruction telling the user what
      // to do NEXT was being rendered into invisible DOM. Open the section and
      // put the same words on the status line, where a mid-authoring user is
      // already looking (the marker is sitting on the dancer in front of them).
      setSectionCollapsed($('pins-section'), false);
      app.status(note.textContent, 'info');
    } else if (n > pinCount) {
      app.status(`Pin ${n} created — it holds through moves, steps and turns.`, 'info');
    }
    pinCount = n;
    pinClear.disabled = !n;
  }
  pinClear.addEventListener('click', () => {
    // Confirm only when there is something to lose, so the empty case (and the
    // disabled button's own no-op) stays one click. A blocking dialog is the
    // right tool here and nowhere else: releasing every pin is a decision, not
    // a notification, and the status line cannot ask a question.
    const n = app.pins.count();
    if (n && !window.confirm(`Release ${n} contact pin${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    app.clearPins();
    if (n) app.status(`Released ${n} contact pin${n === 1 ? '' : 's'}.`, 'info');
  });
  renderPins();

  // ---------------------------------------------------------------- highlight
  const highlightChips = $('highlight-chips');
  const highlightClear = $('highlight-clear');
  const highlighted = new Set();

  // Each part carries its own highlight colour: the chip wears it while active
  // and its swatch (shown only then) repicks it, so several parts lit at once
  // stay tellable apart on a slide.
  const chipRows = [];

  const paintChip = (chip, swatch, part) => {
    const on = highlighted.has(part.id);
    const color = app.highlightColor(part.id);
    chip.classList.toggle('active', on);
    chip.style.background = on ? color : '';
    chip.style.borderColor = on ? color : '';
    chip.style.color = on ? readableInk(color) : '';
    swatch.hidden = !on;
    swatch.value = color;
  };

  const syncHighlight = () => {
    app.setHighlight(highlighted);
    highlightClear.disabled = highlighted.size === 0;
    for (const r of chipRows) paintChip(r.chip, r.swatch, r.part);
  };

  for (const part of BODY_PARTS) {
    const wrap = document.createElement('span');
    wrap.className = 'chip-wrap';
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = part.title;
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'chip-color';
    swatch.title = `Colour of the ${part.title.toLowerCase()} highlight`;
    swatch.hidden = true;
    swatch.value = part.color;
    chip.addEventListener('click', () => {
      if (highlighted.has(part.id)) highlighted.delete(part.id);
      else highlighted.add(part.id);
      syncHighlight();
    });
    swatch.addEventListener('input', () => {
      app.setHighlightColor(part.id, swatch.value);
      paintChip(chip, swatch, part);
    });
    wrap.append(chip, swatch);
    chipRows.push({ part, chip, swatch });
    highlightChips.appendChild(wrap);
  }
  highlightClear.addEventListener('click', () => {
    highlighted.clear();
    syncHighlight();
  });

  // Figure.setHighlight is a no-op on the clothed avatar (one continuous skin,
  // userData.noHighlight) and the app STARTS in the Body layer — so a first
  // click on "Torso" lit the chip and changed the 3D view by exactly nothing.
  // Same nudge the Muscles panel already carries for its own layer (see
  // syncMuscleNote below), kept in the same shape so the two stay consistent.
  const highlightLayerNote = $('highlight-layer-note');
  const syncHighlightNote = () => { highlightLayerNote.hidden = layerMode() !== 'body'; };
  $('layer-mode').addEventListener('change', syncHighlightNote);
  // Dispatch a real `change` rather than calling syncLayers directly, so every
  // listener on the dropdown runs — this note, the Muscles note and the layers
  // themselves. Setting .value and calling one of them by hand leaves the
  // others stale (the Muscles link used to do exactly that).
  const chooseLayer = (mode) => {
    $('layer-mode').value = mode;
    $('layer-mode').dispatchEvent(new Event('change'));
  };
  $('highlight-enable-layer').addEventListener('click', () => chooseLayer('skeleton'));
  syncHighlightNote();

  // ---------------------------------------------------------------- muscles
  // Per-muscle controls: uncheck a belly to fade it out (transparent), or hit
  // its "highlight" chip to recolour it. Both act on both dancers by label.
  const muscleList = $('muscle-list');
  const muscleClearHl = $('muscle-clear-hl');
  const muscleLayerNote = $('muscle-layer-note');
  const muscleKfNote = $('muscle-kf-note');
  const hiddenMuscles = new Set();
  const litMuscles = new Set();
  const muscleColors = new Map(); // atlas label → the colour the user gave it
  // What a lit belly looks like until someone picks a colour (MUSCLE_HL_COLOR
  // in figure.js) — the swatch has to open on something.
  const MUSCLE_HL_DEFAULT = '#ffce4a';
  const muscleSwatches = new Map(); // label → its row's colour input
  // The panel's look survives a reload. A colour picked for a belly is authored
  // work — it is what ties a lit muscle to the callout naming it on a slide —
  // and a refresh mid-lesson used to throw the whole set away, the same loss
  // the pose library and the sequence are already saved against. Slides still
  // capture the look too (getViewState); this is the running state, so the
  // colours are there on the next load without having to save a slide first.
  const MUSCLE_KEY = 'tangoPoseStudio.muscleLook.v1';
  // Restoring writes through the very handlers that save; nothing persists
  // until the stored look has been applied (as the sidebar layout does).
  let muscleLookReady = false;
  function saveMuscleLook() {
    if (!muscleLookReady) return;
    try {
      localStorage.setItem(MUSCLE_KEY, JSON.stringify({
        colors: [...muscleColors], lit: [...litMuscles], hidden: [...hiddenMuscles],
        tint: Number(muscleTint.value),
      }));
    } catch { /* full / private mode */ }
  }

  // ---- a sequence keyframe's own highlighting (kf.muscles) ----------------
  // A keyframe may carry its own lit set and colours. That is a VIEW OVERRIDE,
  // not an edit: `litMuscles` / `muscleColors` above stay the user's RUNNING
  // look, and scrubbing to an untagged keyframe hands it straight back.
  //
  // WHY THIS IS NOT applyViewState. Showing a SLIDE deliberately makes that
  // slide's look the running one — applyViewState ends with saveMuscleLook(),
  // and that is right there, because the user asked for that slide. Scrubbing a
  // timeline is not showing a slide: the playhead crosses every keyframe on the
  // way past, several times a second, and persisting each one would grind the
  // panel state the user authored down to whatever keyframe the scrubber last
  // happened to sit on. So an override reaches the FIGURES and the panel's
  // chips, and never localStorage.
  let muscleOverride = null;       // { lit: Set, colors: Map } | null
  const appliedColors = new Set(); // labels whose colour is on the figures now
  const effLit = () => muscleOverride?.lit ?? litMuscles;
  const effColors = () => muscleOverride?.colors ?? muscleColors;

  // Push the EFFECTIVE look at the dancers. Colours are cleared by DIFFERENCE
  // rather than wholesale, so dropping an override restores exactly the running
  // colours and nothing stays painted from the keyframe that just left.
  function pushMuscleLook() {
    const colors = effColors();
    for (const label of appliedColors) if (!colors.has(label)) app.setMuscleColor(label, null);
    appliedColors.clear();
    for (const [label, hex] of colors) {
      app.setMuscleColor(label, hex);
      appliedColors.add(label);
    }
    app.setMuscleLit(effLit());
    muscleClearHl.disabled = effLit().size === 0;
  }

  const sameLook = (a, b) => {
    if (!a || !b) return a === b;
    if (a.lit.size !== b.lit.size || a.colors.size !== b.colors.size) return false;
    for (const l of a.lit) if (!b.lit.has(l)) return false;
    for (const [l, h] of a.colors) if (b.colors.get(l) !== h) return false;
    return true;
  };

  // Called from main.js's applyKeyframeExtras — i.e. several times a second
  // while a sequence plays — so an UNCHANGED look must cost nothing. Restyling
  // ~130 bellies on two dancers every frame is a real cost, and rebuilding the
  // panel every frame would also eat the caret out of anything being typed.
  function setMuscleOverride(m) {
    const next = m
      ? { lit: new Set(m.lit ?? []), colors: new Map((m.colors ?? []).map(([l, h]) => [l, h])) }
      : null;
    if (sameLook(next, muscleOverride)) return;
    muscleOverride = next;
    pushMuscleLook();
    // The chips have to tell the truth about what is lit on screen, or the
    // panel lies for as long as the keyframe is up.
    renderMuscleList();
    muscleKfNote.hidden = !muscleOverride;
  }

  // The highlighting ON SCREEN right now, in the shape a keyframe stores — what
  // a row's muscle tag captures. It reads the EFFECTIVE look, so re-capturing a
  // keyframe that is already showing is idempotent rather than a wipe.
  const muscleLookNow = () => ({
    lit: [...effLit()],
    colors: [...effLit()].filter((l) => effColors().has(l)).map((l) => [l, effColors().get(l)]),
  });

  // Any edit in this panel is the user taking the look back, so it drops the
  // override — otherwise the chip they just pressed would be overwritten by the
  // keyframe on screen and the panel would read as dead.
  const takeBackMuscleLook = () => {
    if (!muscleOverride) return false;
    muscleOverride = null;
    muscleKfNote.hidden = true;
    return true;
  };

  // ---- WHERE a panel edit lands: the ONE seam ------------------------------
  // Ordinarily an edit is the user taking the look back (above) and lands in
  // the RUNNING sets, which persist. While a keyframe is FOCUSED (✎ on its row)
  // the same gesture belongs to that keyframe instead: it edits the override in
  // place and commits it to `kf.muscles`, and the running look — and
  // `tangoPoseStudio.muscleLook.v1` with it — must come through the whole
  // session BYTE-IDENTICAL.
  //
  // One seam rather than an `if (focused)` in each of the five handlers: a
  // sixth control added later inherits the rule instead of quietly not having
  // it. Every caller does the same three things — mutate `lit`/`colors`, push,
  // commit — and only this function knows which sets those are.
  //
  // The override is SEEDED from the running look when the focused keyframe has
  // none of its own, which is what makes entering focus change nothing on
  // screen: the first edit starts from exactly what the user was looking at.
  // `hidden` is deliberately out of scope — `kf.muscles` stores `lit` +
  // `colors` only, so the hide checkboxes go on editing the running set even
  // while focused (and go on saving it).
  function lookTarget() {
    const i = app.seqFocusIndex?.() ?? -1;
    if (i < 0) {
      return {
        focused: false, lit: litMuscles, colors: muscleColors,
        commit: saveMuscleLook,
      };
    }
    if (!muscleOverride) {
      muscleOverride = { lit: new Set(litMuscles), colors: new Map(muscleColors) };
    }
    return {
      focused: true, lit: muscleOverride.lit, colors: muscleOverride.colors,
      // Straight to the keyframe, never to storage. seqSetMuscles re-applies
      // the extras if that keyframe is the one showing, and setMuscleOverride's
      // sameLook early-out makes that a no-op — the sets it would rebuild are
      // the ones just edited.
      commit: () => app.seqSetMuscles(i, muscleLookNow()),
    };
  }

  // One place a muscle's colour changes, whichever control asked: the panel's
  // swatch or a click on the belly itself in a clip (app.ui.pickMuscleColor).
  // Takes one label or several, because a clip's callout names a group of
  // bellies and the colour belongs to the callout.
  const applyMuscleColor = (labels, hex) => {
    const t = lookTarget();
    // Focused, the override IS the thing being edited, so it must not be
    // dropped; unfocused, any edit here is the user taking the look back.
    const wasOverride = t.focused ? false : takeBackMuscleLook();
    for (const label of [labels].flat()) {
      t.colors.set(label, hex);
      const sw = muscleSwatches.get(label);
      if (sw) sw.value = hex;
    }
    pushMuscleLook();
    t.commit();
    if (wasOverride) renderMuscleList(); // every other row's chip may have changed
    renderLabels(); // the callout list's kind tag wears the colour too
  };

  // The picker a click (or a double-click on a callout) in the 3D view opens.
  // It is a real, rendered input — a display:none one has no picker to show —
  // parked under the cursor at zero size, so the swatch appears where the user
  // clicked. One input serves every customer; `pickTarget` is who gets the
  // colour, cleared by nothing because opening again simply replaces it.
  const floatingPicker = document.createElement('input');
  floatingPicker.type = 'color';
  floatingPicker.className = 'floating-picker';
  floatingPicker.setAttribute('aria-hidden', 'true');
  floatingPicker.tabIndex = -1;
  document.body.appendChild(floatingPicker);
  let pickTarget = null;
  floatingPicker.addEventListener('input', () => pickTarget?.(floatingPicker.value));
  const openPicker = (initial, what, onPick, x, y) => {
    pickTarget = onPick;
    floatingPicker.value = initial;
    if (x !== null && x !== undefined) {
      floatingPicker.style.left = `${x}px`;
      floatingPicker.style.top = `${y}px`;
    }
    app.status(`Pick a colour for ${what}.`, 'info');
    if (floatingPicker.showPicker) floatingPicker.showPicker();
    else floatingPicker.click();
  };

  const pickMuscleColor = (labels, x = null, y = null) => {
    const group = [labels].flat();
    if (!group.length) return;
    openPicker(muscleColors.get(group[0]) ?? MUSCLE_HL_DEFAULT, group.join(' + '),
      (hex) => applyMuscleColor(group, hex), x, y);
  };

  // A callout that names a bone or a joint: the colour is the CALLOUT's, since
  // there is no belly to carry it (a muscle callout goes through the belly
  // above, so the two keep matching). It opens on the accent the pill is
  // already wearing — its kind's colour until someone picks one.
  const pickLabelColor = (id, x = null, y = null) => {
    const label = app.labels.byId(id);
    if (!label) return;
    openPicker(app.labelAccent(id) ?? '#ffffff', label.text, (hex) => {
      app.setLabelColor(id, hex);
      renderLabels(); // the list's kind tag wears it too
    }, x, y);
  };

  // A sequence keyframe's on-screen NAME or CAPTION, tapped twice in the 3D
  // view. The colour belongs to that keyframe (main.js works out which one is
  // showing), so this is the same gesture as a callout's, pointed at the `kf`
  // block instead of at a label.
  const pickSeqTextColor = (i, which, x = null, y = null) => {
    const word = which === 'caption' ? 'caption' : 'name';
    const shown = word === 'caption' ? app.seqCaption(i) : app.seqNameForScreen(i);
    openPicker(app.seqTextStyle(i, word).color || '#f4f6fb',
      `“${shown}”`, (hex) => app.seqSetTextStyle(i, word, { color: hex }), x, y);
  };

  const MUSCLE_REGION = {
    chest: 'Chest & back', shoulder: 'Upper arm', elbow: 'Forearm',
    spine: 'Abdomen', hip: 'Hip & thigh', knee: 'Lower leg',
  };
  const MUSCLE_REGION_ORDER = ['chest', 'shoulder', 'elbow', 'spine', 'hip', 'knee'];

  function renderMuscleList() {
    if (!app.muscles || !app.muscles.length) {
      muscleList.className = 'muted';
      muscleList.textContent = 'Muscle atlas unavailable in this session.';
      return;
    }
    const byNode = new Map();
    for (const m of app.muscles) {
      if (!byNode.has(m.node)) byNode.set(m.node, []);
      byNode.get(m.node).push(m.label);
    }
    const nodes = [...byNode.keys()].sort(
      (a, b) => MUSCLE_REGION_ORDER.indexOf(a) - MUSCLE_REGION_ORDER.indexOf(b));
    muscleList.className = '';
    muscleList.innerHTML = '';
    muscleSwatches.clear();
    for (const node of nodes) {
      const group = document.createElement('div');
      group.className = 'muscle-group';
      const title = document.createElement('div');
      title.className = 'muscle-group-title';
      title.textContent = MUSCLE_REGION[node] || node;
      group.appendChild(title);
      for (const label of byNode.get(node)) {
        const row = document.createElement('div');
        row.className = 'muscle-row';
        const lbl = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !hiddenMuscles.has(label);
        cb.addEventListener('change', () => {
          if (cb.checked) hiddenMuscles.delete(label); else hiddenMuscles.add(label);
          app.setMuscleHidden(hiddenMuscles);
          saveMuscleLook();
        });
        lbl.append(cb, document.createTextNode(` ${label}`));
        const hl = document.createElement('button');
        hl.className = 'chip muscle-hl';
        hl.textContent = 'highlight';
        hl.title = 'Highlight this muscle';
        // The EFFECTIVE set, not the running one: while a keyframe's own
        // highlighting is showing, the chips must say what is lit on screen.
        hl.classList.toggle('active', effLit().has(label));
        // Its own colour, so several bellies lit at once stay tellable apart —
        // and so does each one's callout (see Labels.accentColor). Shown only
        // while the muscle is lit, like the Highlight panel's part swatches.
        const sw = document.createElement('input');
        sw.type = 'color';
        sw.className = 'chip-color';
        sw.title = `Colour of the ${label} highlight`;
        sw.hidden = !effLit().has(label);
        sw.value = effColors().get(label) ?? MUSCLE_HL_DEFAULT;
        sw.addEventListener('input', () => applyMuscleColor(label, sw.value));
        muscleSwatches.set(label, sw);
        hl.addEventListener('click', () => {
          // One seam (lookTarget): the running sets, or the focused keyframe's
          // own working copy. Everything below is written against whichever.
          const t = lookTarget();
          const wasOverride = t.focused ? false : takeBackMuscleLook();
          if (t.lit.has(label)) t.lit.delete(label); else t.lit.add(label);
          pushMuscleLook();
          t.commit();
          // Dropping an override changes every other row too, so the whole list
          // is rebuilt — otherwise just the two controls that moved.
          if (wasOverride) renderMuscleList();
          else {
            hl.classList.toggle('active', t.lit.has(label));
            sw.hidden = !t.lit.has(label);
          }
        });
        row.append(lbl, hl, sw);
        group.appendChild(row);
      }
      muscleList.appendChild(group);
    }
  }

  $('muscle-show-all').addEventListener('click', () => {
    hiddenMuscles.clear();
    app.setMuscleHidden(hiddenMuscles);
    saveMuscleLook();
    renderMuscleList();
  });
  $('muscle-hide-all').addEventListener('click', () => {
    for (const m of (app.muscles || [])) hiddenMuscles.add(m.label);
    app.setMuscleHidden(hiddenMuscles);
    saveMuscleLook();
    renderMuscleList();
  });
  // How much of a picked colour a belly takes. 100% (the default) renders the
  // swatch's colour exactly; lower mixes it back toward the muscle's own flesh
  // tone, for a tinted rather than painted look.
  const muscleTint = $('muscle-tint');
  const syncMuscleTint = () => {
    $('muscle-tint-val').textContent = `${muscleTint.value}%`;
    app.setMuscleTint(Number(muscleTint.value) / 100);
    saveMuscleLook();
  };
  muscleTint.addEventListener('input', syncMuscleTint);
  muscleClearHl.addEventListener('click', () => {
    const t = lookTarget();
    // Focused, "Clear highlights" is a real choice for THAT keyframe — "show no
    // highlighting here" — and is stored as an empty lit set rather than
    // wiping the user's running one.
    if (!t.focused) takeBackMuscleLook();
    t.lit.clear();
    pushMuscleLook();
    t.commit();
    renderMuscleList();
  });

  // Put the stored look back. The colours go on whether or not their belly is
  // lit right now — lighting it again has to find the colour it was given, not
  // the default amber. A muscle GLB that failed to load leaves every set empty
  // and this a no-op, so a degraded session still starts cleanly.
  function restoreMuscleLook() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(MUSCLE_KEY)); } catch { saved = null; }
    if (saved) {
      for (const [label, hex] of saved.colors ?? []) muscleColors.set(label, hex);
      for (const label of saved.lit ?? []) litMuscles.add(label);
      for (const label of saved.hidden ?? []) hiddenMuscles.add(label);
      if (saved.tint != null) muscleTint.value = saved.tint;
      syncMuscleTint();
      app.setMuscleHidden(hiddenMuscles);
      // Through pushMuscleLook, not the setters directly, so `appliedColors`
      // knows what is painted — a later keyframe override has to be able to
      // take exactly these colours back off again.
      pushMuscleLook();
    }
    muscleLookReady = true;
  }
  restoreMuscleLook();

  // The panel needs a layer that draws bellies at all. The Muscles view shows
  // every one of them; the Skeleton view shows exactly the LIT ones over the
  // bare bones (Figure.#syncMuscleVisibility), so the chips are live there too
  // and the nudge would be a lie. Only the opaque Body view hides the lot.
  const syncMuscleNote = () => { muscleLayerNote.hidden = layerMode() !== 'body'; };
  $('layer-mode').addEventListener('change', syncMuscleNote);
  $('muscle-enable-layer').addEventListener('click', () => chooseLayer('muscle'));
  syncMuscleNote();
  renderMuscleList();

  // ---------------------------------------------------------------- joint panel
  const jointPanel = $('joint-panel');
  const sliderRefs = []; // { input, valEl, node, axis }

  // Joint picker: jump straight to any joint (they're invisible click targets
  // in body view) without hunting in 3D. A Leader/Follower toggle chooses the
  // dancer; the joints render as a compact grid — the spine/head chips first,
  // then the left/right joints as PAIRED two-column rows (half the rows of a
  // flat list, and the columns carry the side so labels stay short).
  const jointGrid = $('joint-grid');
  const figToggleBtns = [...document.querySelectorAll('#joint-fig-toggle button')];
  const figureForRole = (role) => (role === 'follower' ? app.follower : app.leader);
  const activePickerRole = () =>
    figToggleBtns.find((b) => b.classList.contains('active'))?.dataset.role || 'leader';
  const jointButtons = new Map(); // jointName -> its grid button

  const pickJoint = (role, jointName) => {
    selectMode('rotate'); // the picker poses a joint, so switch to the rotate gizmo
    app.selectJoint(figureForRole(role), jointName);
  };

  {
    const gridButton = (name, label) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = JOINT_TITLES[name] || name;
      btn.addEventListener('click', () => pickJoint(activePickerRole(), name));
      jointButtons.set(name, btn);
      return btn;
    };
    const center = document.createElement('div');
    center.className = 'grid-center';
    for (const [name, label] of [
      ['pelvis', 'Pelvis'], ['spine', 'Lumbar'], ['chest', 'Chest'], ['neck', 'Neck'], ['head', 'Head'],
    ]) center.appendChild(gridButton(name, label));
    jointGrid.appendChild(center);
    for (const side of ['Left', 'Right']) {
      const head = document.createElement('div');
      head.className = 'grid-head';
      head.textContent = side;
      jointGrid.appendChild(head);
    }
    for (const [base, label] of [
      ['scapula', 'Shoulder blade'], ['shoulder', 'Shoulder'], ['elbow', 'Elbow'], ['wrist', 'Wrist'],
      ['hip', 'Hip'], ['knee', 'Knee'], ['ankle', 'Ankle'], ['toes', 'Toes'],
    ]) {
      jointGrid.appendChild(gridButton(`${base}_L`, label));
      jointGrid.appendChild(gridButton(`${base}_R`, label));
    }
  }

  figToggleBtns.forEach((btn) => btn.addEventListener('click', () => {
    const jointName = app.selected?.jointName; // re-select on the chosen dancer
    setActive(figToggleBtns, (b) => b === btn);
    if (jointName) pickJoint(btn.dataset.role, jointName);
  }));

  // Keep the picker in step with joints selected by clicking in the 3D view.
  function syncJointPicker() {
    const sel = app.selected;
    for (const [name, btn] of jointButtons) {
      btn.classList.toggle('active', !!sel && sel.jointName === name);
    }
    if (sel) {
      const role = sel.figure === app.follower ? 'follower' : 'leader';
      setActive(figToggleBtns, (b) => b.dataset.role === role);
    }
  }

  function renderJointPanel() {
    sliderRefs.length = 0;
    if (!app.selected) {
      jointPanel.innerHTML = '<span class="muted">Click a joint on a figure to select it.</span>';
      return;
    }
    const { figure, jointName } = app.selected;
    const def = JOINT_BY_NAME[jointName];
    const node = figure.nodes[jointName];
    const tagColor = `#${figure.color.toString(16).padStart(6, '0')}`;

    jointPanel.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'joint-title';
    title.innerHTML = `<span>${JOINT_TITLES[jointName] || jointName}</span>
      <span class="fig-tag" style="background:${tagColor}">${figure.name}</span>`;
    jointPanel.appendChild(title);

    // Legs/pelvis get the open/closed chain choice (selection always starts
    // open — see app.selectJoint); everything else is always open chain.
    if (CHAIN_JOINTS.has(jointName)) {
      const caption = document.createElement('div');
      caption.className = 'chain-caption';
      caption.textContent = 'Open moves the leg below this joint. Closed keeps the foot planted and moves the body above.';
      jointPanel.appendChild(caption);
      const toggle = document.createElement('div');
      toggle.className = 'chain-toggle btn-group';
      toggle.innerHTML = `
        <button data-chain="open">Open chain</button>
        <button data-chain="closed">Closed chain</button>`;
      const syncChain = () => setActive(toggle.querySelectorAll('button'),
        (b) => b.dataset.chain === app.chainMode);
      toggle.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        app.setChainMode(b.dataset.chain);
        syncChain();
      }));
      syncChain();
      jointPanel.appendChild(toggle);
    }

    for (const axis of ['x', 'y', 'z']) {
      const [min, max] = def.limits[axis];
      if (min === max) continue;
      const row = document.createElement('div');
      row.className = 'slider-row';
      const label = (def.labels && def.labels[axis]) || AXIS_FALLBACK[axis];
      const deg = node.rotation[axis] * R2D;
      row.innerHTML = `
        <div class="lbl"><span>${label}</span><span class="val">${deg.toFixed(0)}°</span></div>
        <input type="range" min="${min}" max="${max}" step="1" value="${deg}" />
        <div class="range-hint"><span>${min}°</span><span>${max}°</span></div>`;
      const input = row.querySelector('input');
      const valEl = row.querySelector('.val');
      pushHistoryOnEdit(input);
      input.addEventListener('input', () => {
        app.editJoint(figure, jointName, () => { node.rotation[axis] = Number(input.value) * D2R; });
        valEl.textContent = `${(node.rotation[axis] * R2D).toFixed(0)}°`;
        refreshJointValues();
      });
      jointPanel.appendChild(row);
      sliderRefs.push({ input, valEl, node, axis });
    }

    if (jointName === 'pelvis') {
      const H = figure.height;
      const row = document.createElement('div');
      row.className = 'slider-row';
      const cm = node.position.y * 100;
      row.innerHTML = `
        <div class="lbl"><span>Hip height (crouch / rise)</span><span class="val">${cm.toFixed(0)} cm</span></div>
        <input type="range" min="${(0.36 * H * 100).toFixed(0)}" max="${(0.56 * H * 100).toFixed(0)}" step="0.5" value="${cm}" />
        <div class="range-hint"><span>low</span><span>tall</span></div>`;
      const input = row.querySelector('input');
      const valEl = row.querySelector('.val');
      pushHistoryOnEdit(input);
      input.addEventListener('input', () => {
        app.setPelvisHeight(figure, Number(input.value) / 100);
        valEl.textContent = `${Number(input.value).toFixed(0)} cm`;
      });
      jointPanel.appendChild(row);
    }

    // Selecting a wrist also offers a whole-hand open/close (the fingers curl
    // together — not individual joints, just a looser or tighter hand). Only
    // the clothed avatar has finger bones to curl.
    if ((jointName === 'wrist_L' || jointName === 'wrist_R') && figure.fingerBones) {
      const side = jointName.slice(-1);
      const row = document.createElement('div');
      row.className = 'slider-row';
      const pct = Math.round(figure.handCurl[side] * 100);
      row.innerHTML = `
        <div class="lbl"><span>Hand (open / closed)</span><span class="val">${pct}%</span></div>
        <input type="range" min="0" max="100" step="1" value="${pct}" />
        <div class="range-hint"><span>open</span><span>closed</span></div>`;
      const input = row.querySelector('input');
      const valEl = row.querySelector('.val');
      pushHistoryOnEdit(input);
      input.addEventListener('input', () => {
        app.setHandCurl(figure, side, Number(input.value) / 100);
        valEl.textContent = `${input.value}%`;
      });
      jointPanel.appendChild(row);
    }

    const reset = document.createElement('button');
    reset.textContent = 'Reset this joint';
    reset.addEventListener('click', () => {
      app.pushHistory();
      app.editJoint(figure, jointName, () => {
        node.rotation.set(0, 0, 0);
        if (jointName === 'pelvis') node.position.y = 0.53 * figure.height;
      });
      if (jointName === 'wrist_L' || jointName === 'wrist_R') {
        app.setHandCurl(figure, jointName.slice(-1), 0);
      }
      refreshJointValues();
      renderJointPanel(); // the hand slider's value needs redrawing after a reset
    });
    jointPanel.appendChild(reset);
  }

  // "Selected joint" is the 8th sidebar section: on a 1366×768 laptop it starts
  // below the fold, and if the user has folded it away, clicking joints in the
  // 3D view produced no visible feedback at all. Open it and bring it into view
  // when the selection actually CHANGES — never on a re-render (renderJointPanel
  // also runs on every pose change, and scrolling the sidebar mid-drag would be
  // its own bug). `block: 'nearest'` means an already-visible panel does not
  // move, so this costs nothing when the section is on screen.
  let shownSelection = null;
  function revealJointPanel() {
    const sel = app.selected;
    const key = sel ? `${sel.figure.name}:${sel.jointName}` : null;
    if (key && key !== shownSelection) {
      const section = $('joint-section');
      setSectionCollapsed(section, false);
      section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    shownSelection = key;
  }

  function refreshJointValues() {
    for (const { input, valEl, node, axis } of sliderRefs) {
      if (document.activeElement === input) continue;
      const deg = node.rotation[axis] * R2D;
      input.value = deg;
      valEl.textContent = `${deg.toFixed(0)}°`;
    }
  }

  // ---------------------------------------------------------------- stats
  const statsPanel = $('stats-panel');

  function balanceLine(margin) {
    if (margin === null) return '<span class="off-balance">In the air</span>';
    const cm = Math.abs(margin * 100).toFixed(1);
    return margin > 0
      ? `<span class="balanced">Balanced</span> · margin ${cm} cm`
      : `<span class="off-balance">Off balance</span> · ${cm} cm outside`;
  }

  function weightLines(w) {
    if (!w) return '';
    const pct = (v) => `${Math.round(v * 100)}%`;
    const support = [`${w.support} foot`];
    if (w.footPart) support.push(w.footPart);
    if (w.onAxis) support.push('<span class="balanced">on axis</span>');
    return `<div class="stat-line"><span>Weight L / R</span><span class="v">${pct(w.shareL)} / ${pct(w.shareR)}</span></div>
      <div class="stat-line"><span>Support</span><span class="v">${support.join(' · ')}</span></div>`;
  }

  function figureBlock(figure, rep, dotColor) {
    const angles = [...keyAngles(figure), ...tangoStats(figure)]
      .map(([k, v]) => `<div class="stat-line"><span>${k}</span><span class="v">${v}</span></div>`)
      .join('');
    return `<div class="stat-block">
      <h3><span class="dot" style="background:${dotColor}"></span>${figure.name}</h3>
      <div class="stat-line"><span>Balance</span><span class="v">${balanceLine(rep.margin)}</span></div>
      ${weightLines(rep.weight)}
      <div class="stat-line"><span>COG height</span><span class="v">${(rep.cog.y * 100).toFixed(1)} cm</span></div>
      ${angles}
    </div>`;
  }

  // Chest distance, with the reason it is not at the held contact distance.
  // "Close embrace" pulls the chests together and body COLLISION refuses to
  // let them through — that is deliberate (collision always wins), but the
  // user sees chests apart with the box ticked and nothing saying why. When
  // the pull is short AND the bodies are touching somewhere, name it: the
  // couple is resting body-on-body, and the `title` says on what.
  function chestLine(chestSep) {
    const cm = `${(chestSep * 100).toFixed(1)} cm`;
    let note = '';
    let why = '';
    if (app.embrace.close && chestSep > app.embrace.contactDistance() + 0.01
      && app.bodyClearance() < 0.005) {
      const [tight] = app.bodyContacts(1);
      note = ' · resting body-on-body';
      // The pair names come from the COLLIDERS table (joint names), never from
      // the user or a file, so they interpolate into the attribute safely.
      why = tight
        ? ` title="Closest contact: ${tight.a} against ${tight.b} (${(tight.clearance * 100).toFixed(1)} cm). Collision stops the close-embrace pull here — the bodies are already touching."`
        : ' title="Collision stops the close-embrace pull here — the bodies are already touching."';
    }
    return `<div class="stat-line"${why}><span>Chest distance</span><span class="v">${cm}${note}</span></div>`;
  }

  // "Hold embrace" is ticked but Embrace.maintainHands has let the closed-side
  // arms go because the dancers are not facing each other (deliberate — see
  // embrace.js). Without this line the checkbox claims to be holding something
  // that is frozen mid-pose.
  function embraceHoldLine() {
    if (!app.embrace.hands || !app.embrace.heldPartially) return '';
    return '<div class="stat-line" title="The closed-side arms only solve while the dancers roughly face each other; past about 70° their rest points sit behind the shoulder\'s range."><span>Embrace</span><span class="v off-balance">arms released — dancers not facing</span></div>';
  }

  function updateStats({ a, b, couple }) {
    renderFootMap({ a, b });
    let html = '';
    if (a) html += figureBlock(app.leader, a, '#7fb3e8');
    if (b) html += figureBlock(app.follower, b, '#e89ab8');
    if (couple) {
      const sep = Math.hypot(couple.a.cog.x - couple.b.cog.x, couple.a.cog.z - couple.b.cog.z);
      const chestSep = app.leader.worldPos('chest').distanceTo(app.follower.worldPos('chest'));
      const handGap = app.embrace.handGap();
      // Joined palms sit a hand's thickness apart (the clasp stacks them).
      const handLine = app.embrace.hands && handGap < app.embrace.palmGap() + 0.01
        ? '<span class="balanced">joined</span>'
        : `${(handGap * 100).toFixed(1)} cm`;
      html += `<div class="stat-block">
          <h3><span class="dot" style="background:#ffe08a"></span>Couple</h3>
          <div class="stat-line"><span>Combined balance</span><span class="v">${balanceLine(couple.margin)}</span></div>
          <div class="stat-line"><span>COG separation</span><span class="v">${(sep * 100).toFixed(1)} cm</span></div>
          ${chestLine(chestSep)}
          <div class="stat-line"><span>Open-side hands</span><span class="v">${handLine}</span></div>
          ${embraceHoldLine()}
        </div>`;
    }
    statsPanel.innerHTML = html;
  }

  // ---------------------------------------------------------------- foot map
  // Top-down outline of one foot with the COG's floor point over it — where
  // the weight falls on the support foot (heel / mid-foot / ball, on or off
  // the foot). Redrawn with the stats tick (see updateStats).
  const fmCanvas = $('footmap-canvas');
  const fmNote = $('footmap-note');
  const fmFigBtns = [...document.querySelectorAll('#footmap-fig button')];
  const fmFootBtns = [...document.querySelectorAll('#footmap-foot button')];
  let fmFig = 'leader';
  let fmFoot = 'auto'; // 'auto' = the current support foot
  for (const btn of fmFigBtns) {
    btn.addEventListener('click', () => {
      fmFig = btn.dataset.fig;
      setActive(fmFigBtns, (b) => b === btn);
    });
  }
  for (const btn of fmFootBtns) {
    btn.addEventListener('click', () => {
      fmFoot = btn.dataset.foot;
      setActive(fmFootBtns, (b) => b === btn);
    });
  }

  const _fmV = new THREE.Vector3();
  const _fmW = new THREE.Vector3();
  const _fmT = new THREE.Vector3();
  // A sole corner counts as resting on the floor within this height — the same
  // threshold footContactsBySide uses (now one shared constant), so the print's
  // contact patch and the 3D support outline can't disagree.
  const FLOOR_CONTACT = FLOOR_CONTACT_FRAC;

  function renderFootMap(reps) {
    // ~350 lines of per-frame work (world matrices, a Newell best-fit plane, a
    // convex hull, a 10-anchor Catmull-Rom path, five toe pads) driven at 4 Hz
    // by the stats tick — worth nothing at all when the canvas is off screen,
    // which is now the DEFAULT case: the foot map lives in the Measure tab, so
    // it is hidden whenever the user is posing. Nothing needs to re-arm it:
    // the same 4 Hz tick repaints it within ~250 ms of becoming visible.
    if (!fmCanvas.clientWidth || !fmCanvas.clientHeight) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = fmCanvas.clientWidth;
    const cssH = fmCanvas.clientHeight;
    if (fmCanvas.width !== Math.round(cssW * dpr)) {
      fmCanvas.width = Math.round(cssW * dpr);
      fmCanvas.height = Math.round(cssH * dpr);
    }
    const ctx = fmCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const figure = fmFig === 'leader' ? app.leader : app.follower;
    const rep = fmFig === 'leader' ? reps.a : reps.b;
    if (!rep || !figure.group.visible) {
      fmNote.textContent = `${figure.name} is hidden.`;
      return;
    }
    // Which foot: the weighted support foot, else the lower ankle.
    let side = fmFoot;
    if (side === 'auto') {
      side = rep.weight?.support
        ?? (figure.worldPos('ankle_L', _fmV).y <= figure.worldPos('ankle_R', _fmW).y ? 'L' : 'R');
    }

    // Sole corners in world, traced around the outline: heel-in, heel-out,
    // ball-out, toe-out, toe-in, ball-in (foot corner order is hi/ho/bo/bi and
    // toe corners to/ti — see skeletonDef).
    const H = figure.height;
    figure.group.updateMatrixWorld(true);
    const fc = figure.footCorners[`_${side}`];
    const tc = figure.toeCorners[`_${side}`];
    const ankleNode = figure.nodes[`ankle_${side}`];
    const toesNode = figure.nodes[`toes_${side}`];
    const corner = (node, [x, y, z]) => node.localToWorld(new THREE.Vector3(x * H, y * H, z * H));
    const pts3 = [
      corner(ankleNode, fc[0]), corner(ankleNode, fc[1]), corner(ankleNode, fc[2]),
      corner(toesNode, tc[0]), corner(toesNode, tc[1]), corner(ankleNode, fc[3]),
    ];
    // The balance verdict stays a FLOOR question — hull and margin come from the
    // corners' floor projection, the same base of support the 3D view outlines.
    // Only the drawing below moves into the sole's plane.
    const pts = pts3.map((p) => ({ x: p.x, z: p.z }));
    const cog = { x: rep.cog.x, z: rep.cog.z };
    const margin = stabilityMargin(cog, convexHull2D(pts));
    // Which corners actually rest on the floor (same threshold as
    // footContactsBySide) — a heel-up or pointed foot only touches on the ball
    // and toes, and the print marks that region so it matches the 3D outline.
    const contact = pts3.map((p) => p.y <= FLOOR_CONTACT);
    const grounded = contact.filter(Boolean).length;

    // 2D frame: the print is drawn in the SOLE'S OWN PLANE — the foot seen
    // perpendicular to its sole — NOT projected flat onto the floor. Flattening
    // foreshortens a pitched foot into a blob (a pointed foot's ~28 cm cage
    // collapses to under 6 cm), which is what stopped the print resembling the
    // foot on screen and threw off where the COG read against it. When the foot
    // is flat the sole normal IS +Y, so this reduces exactly to the old floor
    // projection and a standing figure draws unchanged.
    const A = figure.worldPos(`ankle_${side}`, _fmV.clone());
    const T = figure.worldPos(`toe_${side}`, _fmW.clone());
    const centre = new THREE.Vector3();
    for (const p of pts3) centre.add(p);
    centre.multiplyScalar(1 / pts3.length);
    // Best-fit sole normal (Newell): the corners are only near-coplanar once the
    // toes bend, so fit the plane rather than trusting any three of them.
    const normal = new THREE.Vector3();
    for (let i = 0; i < pts3.length; i++) {
      const a = pts3[i];
      const b = pts3[(i + 1) % pts3.length];
      normal.x += (a.y - b.y) * (a.z + b.z);
      normal.y += (a.z - b.z) * (a.x + b.x);
      normal.z += (a.x - b.x) * (a.y + b.y);
    }
    if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
    normal.normalize();
    if (normal.y < 0) normal.negate(); // out of the sole, not into it
    // v runs heel→toe, flattened into the sole plane.
    const fwd = new THREE.Vector3().addVectors(pts3[3], pts3[4]).multiplyScalar(0.5)
      .sub(_fmT.addVectors(pts3[0], pts3[1]).multiplyScalar(0.5));
    fwd.addScaledVector(normal, -fwd.dot(normal));
    if (fwd.lengthSq() < 1e-10) { // degenerate — fall back to the figure's facing
      fwd.set(0, 0, 1).applyQuaternion(figure.group.quaternion);
      fwd.addScaledVector(normal, -fwd.dot(normal));
    }
    fwd.normalize();
    // latAxis is the foot's own lateral axis. `fwd × normal` reproduces the previous
    // (-fz, fx) floor axis exactly when the sole is flat, so the handedness — and
    // with it every orientation guarantee below — is preserved.
    const latAxis = new THREE.Vector3().crossVectors(fwd, normal).normalize();
    // The print is a footprint seen from above with the foot pointing away
    // (toes up), so it is ANATOMICALLY FIXED per foot: because the medial ("in")
    // corners of the two feet lie on opposite sides of the foot axis, this one
    // projection already draws a RIGHT foot with its big toe/arch on the canvas
    // LEFT and a LEFT foot's on the right — each reading as the correct foot
    // regardless of camera or which way the dancer faces.
    // Do NOT tie u to the camera: mirroring to match the view turns a right
    // foot's print into a left foot's. The COG dot shares this projection, so
    // it always lands on that foot's true medial/lateral side.
    const toUV = (p) => {
      _fmT.set(p.x, p.y ?? 0, p.z).sub(centre);
      return { u: _fmT.dot(latAxis), v: _fmT.dot(fwd) };
    };
    const uvPts = pts3.map(toUV);
    const uvCog = toUV(rep.cog); // the 3D COG, dropped along the sole normal

    // Fit foot + COG in view; the foot never smaller than half the canvas.
    let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
    for (const p of [...uvPts, uvCog]) {
      minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
      minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
    }
    const pad = 30; // room for the print's heel bulge, toe pads and labels
    const scale = Math.min(
      (cssW - 2 * pad) / Math.max(maxU - minU, 1e-6),
      (cssH - 2 * pad) / Math.max(maxV - minV, 1e-6),
      (cssH - 2 * pad) / (0.16 * H), // don't zoom in past ~a foot filling the height
    );
    const midU = (minU + maxU) / 2;
    const midV = (minV + maxV) / 2;
    const px = (p) => ({
      x: cssW / 2 + (p.u - midU) * scale,
      y: cssH / 2 - (p.v - midV) * scale,
    });

    // Foot outline: a stylized sole print hung on the six projected corners
    // (heel-in, heel-out, ball-out, toe-out, toe-in, ball-in), so it still
    // stretches, turns and foreshortens with the real foot. The corners are a
    // cage; the anchors derived from them add what makes a print read as a
    // foot — a rounded heel, the arch dented into the medial ("in") side, a
    // sole ending at the toe knuckles, and five separate toe pads.
    const col = fmFig === 'leader' ? '#7fb3e8' : '#e89ab8';
    const P = uvPts.map(px);
    const [HI, HO, BO, TO, TI, BI] = P;
    const mid = (a2, b2) => ({ x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 });
    const lerp2 = (a2, b2, s) => ({ x: a2.x + (b2.x - a2.x) * s, y: a2.y + (b2.y - a2.y) * s });
    const off = (p, d, s) => ({ x: p.x + d.x * s, y: p.y + d.y * s });
    const dir = (a2, b2) => {
      const dx = b2.x - a2.x;
      const dy = b2.y - a2.y;
      const l = Math.hypot(dx, dy);
      return l > 1e-6 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
    };
    const heelMid = mid(HI, HO);
    const ballMid = mid(BO, BI);
    const toeMid = mid(TO, TI);
    const lat = dir(HI, HO);             // medial → lateral across the heel
    const back = dir(ballMid, heelMid);  // out the rear of the foot
    const toeFwd = dir(ballMid, toeMid); // past the ball (follows toe flexion)
    const heelW = Math.hypot(HO.x - HI.x, HO.y - HI.y);
    const ballW = Math.hypot(BO.x - BI.x, BO.y - BI.y);
    // Front of the sole. The toe crease sits only just ahead of the
    // metatarsal heads — the toes own nearly the whole toe region (a hallux
    // is ~14% of foot length against a ~16% toe region), and the cage's toe
    // region is barely half the ball width, so a crease pushed further
    // forward eats the space the toe pads need and they collide with the
    // sole. The metatarsal break is also OBLIQUE — the 1st MTP head sits
    // forward of the 5th — and each ball corner bevels into the crease: the
    // chamfer anchor rides the straight chord from the MTP head to the
    // crease, which is what keeps the corner flat instead of rounding off
    // under the Catmull-Rom smoothing.
    const mtp1 = off(off(BI, lat, -0.04 * ballW), toeFwd, 0.04 * ballW);
    const mtp5 = off(off(BO, lat, 0.04 * ballW), toeFwd, -0.06 * ballW);
    const crease = off(lerp2(ballMid, toeMid, 0.10), toeFwd, 0.01 * ballW);
    // Main sole: the classic ink-print hourglass — broad beveled forefoot,
    // deep arch waist on the medial side, rounded slightly-narrower heel.
    const anchors = [
      mtp1,                                                    // 1st MTP head, forward
      off(lerp2(BI, HI, 0.48), lat, 0.26 * ballW),             // arch — the deep waist
      off(HI, lat, 0.10 * heelW),                              // medial heel, narrowed
      off(heelMid, back, 0.45 * heelW),                        // rounded heel back
      off(HO, lat, -0.10 * heelW),                             // lateral heel, narrowed
      off(lerp2(HO, BO, 0.55), lat, 0.02 * ballW),             // lateral border, near straight
      mtp5,                                                    // 5th MTP head, set back
      lerp2(mtp5, crease, 0.50),                               // bevel, lateral
      crease,                                                  // toe crease, mid
      lerp2(mtp1, crease, 0.50),                               // bevel, medial
    ];
    // Smooth closed Catmull-Rom curve through the anchors, kept as a Path2D
    // so the zone separator dashes below can clip to the print.
    const n = anchors.length;
    const sole = new Path2D();
    sole.moveTo(anchors[0].x, anchors[0].y);
    for (let i = 0; i < n; i++) {
      const p0 = anchors[(i + n - 1) % n];
      const p1 = anchors[i];
      const p2 = anchors[(i + 1) % n];
      const p3 = anchors[(i + 2) % n];
      sole.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y,
      );
    }
    sole.closePath();
    ctx.fillStyle = `${col}2e`;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.fill(sole);
    ctx.stroke(sole);

    // Toe pads: five tilted ovals ahead of the sole with the classic
    // ink-print gap, spaced anatomically. A real toe row spans the FULL
    // forefoot breadth (foot breadth is measured across the toes' own
    // knuckles, MTP1→MTP5), so each toe sits at a fixed cross-station of the
    // ball width (`c`, fraction medial→lateral: hallux centered ~17% in from
    // the medial edge … little toe ~88%) — NOT packed along the corner
    // cage's tapered shoe tip, which bunches them. Tips follow the toe arc
    // (`tip`, toe-region units, 1 = the tip line): the big toe reaches the
    // tip line and the others retreat laterally (from anthropometric toe
    // lengths — hallux tip 100% of foot length down to ~82% for the little
    // toe); the pad center hangs back from its tip by the pad's own length.
    // Sizes are in ball-width units (no foreshortening when the foot points).
    // Long axes radiate like real toes: the big toe lies near-parallel to
    // the foot axis (aimed at the heel), lateral toes tilt increasingly
    // toward the midline (`aimBack`, each toe's aim point on the ball→heel
    // segment).
    const ballAcross = dir(BI, BO); // medial → lateral along the ball line
    const toeLen = Math.hypot(toeMid.x - ballMid.x, toeMid.y - ballMid.y);
    const toePads = [
      { c: 0.160, tip: 1.04, rl: 0.200, rs: 0.140, aimBack: 1.00 }, // big toe
      { c: 0.405, tip: 0.96, rl: 0.128, rs: 0.090, aimBack: 0.70 },
      { c: 0.595, tip: 0.85, rl: 0.116, rs: 0.082, aimBack: 0.50 },
      { c: 0.765, tip: 0.71, rl: 0.103, rs: 0.075, aimBack: 0.35 },
      { c: 0.920, tip: 0.56, rl: 0.088, rs: 0.068, aimBack: 0.25 }, // little toe
    ];
    // Keep the row clear of the sole's front edge by construction. The cage's
    // toe region is barely half the ball width, and a stubbier shoe (the
    // follower's) or a foreshortened pointed foot squeezes it further, so
    // pads placed purely off their tips sink into the sole. The sole front is
    // modelled across the foot by its three front anchors (1st MTP forward,
    // crease mid, 5th MTP set back); the whole row then shifts forward by ONE
    // shared amount, so the retreating arc keeps its shape instead of the
    // crowded toes bunching up against the uncrowded ones.
    const fwdOf = (p) => (p.x - ballMid.x) * toeFwd.x + (p.y - ballMid.y) * toeFwd.y;
    const [front1, frontC, front5] = [mtp1, crease, mtp5].map(fwdOf);
    const soleFrontAt = (c) => (c <= 0.5
      ? front1 + (frontC - front1) * (c / 0.5)
      : frontC + (front5 - frontC) * ((c - 0.5) / 0.5));
    const baseFwd = (tp) => tp.tip * toeLen - 0.80 * tp.rl * ballW;
    const rowShift = Math.max(0, ...toePads.map(
      (tp) => soleFrontAt(tp.c) + (0.035 + tp.rl) * ballW - baseFwd(tp),
    ));
    ctx.lineWidth = 1.25;
    for (const tp of toePads) {
      const c = off(off(ballMid, ballAcross, (tp.c - 0.5) * 1.06 * ballW),
        toeFwd, baseFwd(tp) + rowShift);
      const aim = dir(c, lerp2(ballMid, heelMid, tp.aimBack));
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, tp.rl * ballW, tp.rs * ballW,
        Math.atan2(aim.y, aim.x), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Zone separators (clipped to the print): heel|arch where the heel pad
    // ends, arch|ball just behind the metatarsal heads. The sole ahead of
    // that line IS the ball; the toes are their own pads past the print gap.
    // Both they and the section labels fade out when the print is too small
    // to hold them (a pointed foot foreshortens to a blob, or the COG sits
    // far away and the fit zooms out).
    const printLen = Math.hypot(toeMid.x - heelMid.x, toeMid.y - heelMid.y);
    if (printLen > 45) {
      ctx.save();
      ctx.clip(sole);
      ctx.strokeStyle = `${col}77`;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      for (const t of [0.34, 0.78]) {
        const m = lerp2(HI, BI, t);
        const l = lerp2(HO, BO, t);
        ctx.beginPath();
        ctx.moveTo(m.x - (l.x - m.x), m.y - (l.y - m.y));
        ctx.lineTo(l.x + (l.x - m.x), l.y + (l.y - m.y));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Section labels, each on its own zone along the print's axis (the
    // print may be rotated on the canvas); "toes" past the tips, clamped to
    // the canvas.
    if (printLen > 70) {
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '9px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      const lab = (text, p) => ctx.fillText(text, p.x, Math.min(Math.max(p.y + 3, 9), cssH - 4));
      lab('heel', off(heelMid, back, 0.10 * heelW));
      // The arch waist is dented into the MEDIAL side, so the print's centre
      // there sits lateral of the corner cage's centreline — offset the label
      // by half the dent or it hangs out over the medial edge.
      lab('arch', off(lerp2(heelMid, ballMid, 0.58), lat, 0.13 * ballW));
      lab('ball', lerp2(heelMid, ballMid, 0.93));
      lab('toes', off(toeMid, toeFwd, 0.10 * toeLen + 0.30 * ballW));
    }

    // Contact patch: the part of the sole actually on the floor. With the heel
    // up (or on a pointed foot) only the ball and toes carry weight, and this is
    // the same region the 3D view outlines as the base of support — drawing it
    // here is what makes the two pictures agree. Corner order already traces the
    // perimeter, so the grounded run closes into a polygon directly.
    if (grounded >= 3 && grounded < pts3.length) {
      const on = P.filter((_, i) => contact[i]);
      ctx.save();
      ctx.beginPath();
      on.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = '#5fce7f26';
      ctx.strokeStyle = '#5fce7f99';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 3]);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // COG drop point: ring + dot, green over the foot, red off it.
    const g = px(uvCog);
    const ok = margin !== null && margin > 0;
    ctx.strokeStyle = ok ? '#5fce7f' : '#e0645f';
    ctx.fillStyle = ok ? '#5fce7f' : '#e0645f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 6.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(g.x, g.y, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Where along the foot the weight falls (same zones as the stats line).
    const fAx = T.x - A.x;
    const fAz = T.z - A.z;
    const fSq = fAx * fAx + fAz * fAz;
    let zone = '';
    if (fSq > 1e-9) {
      const t = ((cog.x - A.x) * fAx + (cog.z - A.z) * fAz) / fSq;
      zone = t < 0.35 ? 'over the heel' : (t > 0.7 ? 'over the ball' : 'over the mid-foot');
    }
    // Say so when only part of the sole is down: the dashed patch is then the
    // real base of support, and the COG is judged against that, not the outline.
    const lift = grounded === 0 ? ' · foot off the floor'
      : (grounded < pts3.length ? ' · heel up, weight on the dashed patch' : '');
    const cm = margin === null ? null : Math.abs(margin * 100).toFixed(1);
    fmNote.textContent = margin === null
      ? `${figure.name} · ${side === 'L' ? 'left' : 'right'} foot${lift}`
      : `${figure.name} · ${side === 'L' ? 'left' : 'right'} foot — COG ${cm} cm ${ok ? `inside, ${zone}` : 'outside the foot'}${lift}`;
  }

  // ---------------------------------------------------------------- compare
  const snaps = { A: null, B: null };
  const comparePanel = $('compare-panel');
  const interpRow = $('interp-row');
  const interpSlider = $('interp-slider');
  const interpVal = $('interp-val');
  const interpPlay = $('interp-play');
  const showPath = $('show-path');
  const ghostA = $('ghost-a');
  const ghostB = $('ghost-b');

  const syncGhosts = () => {
    app.setGhost('A', ghostA.checked ? snaps.A : null);
    app.setGhost('B', ghostB.checked ? snaps.B : null);
  };
  ghostA.addEventListener('change', syncGhosts);
  ghostB.addEventListener('change', syncGhosts);

  // The COG floor trail traces the sequence when it has one, else A→B —
  // one checkbox governs it either way (see app.trailStates).
  const syncPath = () => app.setPathVisible(
    (!!(snaps.A && snaps.B) || app.seqStates.length >= 2) && showPath.checked,
  );
  showPath.addEventListener('change', syncPath);

  // The scrubber, play button, and COG path all need both snapshots.
  function syncInterp() {
    const ready = !!(snaps.A && snaps.B);
    app.setInterpStates(snaps.A, snaps.B);
    interpRow.hidden = !ready;
    setInterpLabel(app.interpT); // the scrubber shows the player's position
    syncPlayButtons();
    syncRecordButtons();
    syncPath();
  }

  const setInterpLabel = (t) => {
    interpSlider.value = Math.round(t * 1000);
    interpVal.textContent = `${Math.round(t * 100)}%`;
  };
  pushHistoryOnEdit(interpSlider);
  // Grabbing the scrubber stops the player. Otherwise the two fight for the
  // same t: the tick drags the thumb out from under the cursor every frame,
  // and whatever the user lets go on is overwritten on the next. The user's
  // scrub wins, and playback stays stopped where they put it. `pointerdown` is
  // the grab itself (a press-and-hold fires no `input` at all); the stop
  // inside the input handler covers a keyboard or scripted change.
  interpSlider.addEventListener('pointerdown', () => app.stopInterp());
  interpSlider.addEventListener('input', () => {
    app.stopInterp();
    const t = Number(interpSlider.value) / 1000;
    app.applyInterp(t);
    interpVal.textContent = `${Math.round(t * 100)}%`;
  });
  // Play ⇄ Stop: while it runs, the only thing you want from this button is to
  // stop it. Play carries on from the scrubber (app.playInterp).
  interpPlay.addEventListener('click', () => {
    if (app.stopInterp()) return;
    app.pushHistory();
    app.playInterp(setInterpLabel);
  });
  $('interp-record').addEventListener('click', () => {
    if (!snaps.A || !snaps.B) return;
    app.pushHistory();
    app.recordPlayback([snaps.A, snaps.B], 'tangle-a-b');
  });

  function takeSnapshot(which) {
    snaps[which] = app.getCoupleState(`Snapshot ${which}`);
    $(`recall-${which.toLowerCase()}`).disabled = false;
    renderCompare();
    syncInterp();
    syncGhosts();
  }

  function renderCompare() {
    if (!snaps.A || !snaps.B) {
      comparePanel.innerHTML = '<span class="muted">Snapshot two poses to see joint-angle and COG changes.</span>';
      return;
    }
    const rows = [];
    app.figures.forEach((figure, fi) => {
      const short = figure.name === 'Leader' ? 'L' : 'F';
      const a = snaps.A.figures[fi].joints;
      const b = snaps.B.figures[fi].joints;
      for (const joint of Object.keys(a)) {
        if (!b[joint]) continue;
        ['x', 'y', 'z'].forEach((axis, ai) => {
          const da = a[joint][ai] * R2D;
          const db = b[joint][ai] * R2D;
          const delta = db - da;
          if (Math.abs(delta) < 3) return;
          const def = JOINT_BY_NAME[joint];
          const label = (def.labels && def.labels[axis]) || axis;
          rows.push({
            name: `${short} · ${JOINT_TITLES[joint] || joint}`,
            label, da, db, delta,
          });
        });
      }
    });
    rows.sort((r, s) => Math.abs(s.delta) - Math.abs(r.delta));
    const top = rows.slice(0, 16);
    const more = rows.length - top.length;
    const body = top.map((r) => `<tr>
        <td title="${r.label}">${r.name}</td>
        <td>${r.da.toFixed(0)}°</td><td>${r.db.toFixed(0)}°</td>
        <td class="${r.delta > 0 ? 'delta-pos' : 'delta-neg'}">${r.delta > 0 ? '+' : ''}${r.delta.toFixed(0)}°</td>
      </tr>`).join('');
    comparePanel.innerHTML = `
      <table class="cmp">
        <tr><th>Joint (A → B)</th><th>A</th><th>B</th><th>Δ</th></tr>
        ${body}
      </table>
      ${more > 0 ? `<div class="muted">…and ${more} smaller changes</div>` : ''}
      ${rows.length === 0 ? '<div class="muted">No joint changed by more than 3°.</div>' : ''}`;
  }

  $('snap-a').addEventListener('click', () => takeSnapshot('A'));
  $('snap-b').addEventListener('click', () => takeSnapshot('B'));
  const recallSnap = (which) => {
    if (!snaps[which]) return;
    app.pushHistory();
    app.applyCoupleState(snaps[which]);
  };
  $('recall-a').addEventListener('click', () => recallSnap('A'));
  $('recall-b').addEventListener('click', () => recallSnap('B'));

  // ---------------------------------------------------------------- sequence
  // Movement timeline: an ordered chain of couple-state keyframes, scrubbed /
  // played / recorded as one figure (see app.seqStates). Persisted per
  // session so a half-authored giro survives a reload.
  const SEQ_KEY = 'tangoPoseStudio.sequence.v1';
  // WHERE the two on-screen texts sit — one placement each for the whole
  // sequence, so a recorded lesson does not make them hop about between
  // keyframes. Its own key rather than a field inside SEQ_KEY's array: it is
  // not a keyframe, and a per-keyframe store would have to answer "which one
  // wins" on every scrub. Restored before the first render, behind the same
  // `ready` guard the drawings and the Muscles panel use — the studio starts at
  // its defaults and the restore writes through the very hook that saves, so
  // without the guard the first sync overwrites the stored placement with null.
  const SEQ_TEXT_KEY = 'tangoPoseStudio.seqText.v1';
  let seqTextReady = false;
  // The running chain, serialized — written by renderSequence (which builds it
  // for SEQ_KEY anyway) and read by the library's dirty marker. Declared up
  // here so nothing can reach it in its temporal dead zone.
  let seqStatesJson = '[]';
  const saveSeqText = () => {
    if (!seqTextReady) return;
    try { localStorage.setItem(SEQ_TEXT_KEY, JSON.stringify(app.seqTextPositions())); } catch { /* storage full */ }
  };
  // Whether transitions ease in and out (app.seqEase). Its own key beside the
  // keyframes for the same reason `textPos` has one — it is a setting of the
  // SEQUENCE, not of any keyframe — and behind the same `ready` guard, since
  // app starts at the fresh default and the restore writes through the very
  // hook that saves. The guard is opened only after the restore below, or that
  // first write would store the default over the user's choice.
  const SEQ_EASE_KEY = 'tangoPoseStudio.seqEase.v1';
  let seqEaseReady = false;
  const saveSeqEase = () => {
    if (!seqEaseReady) return;
    try { localStorage.setItem(SEQ_EASE_KEY, JSON.stringify(app.seqEase())); } catch { /* storage full */ }
  };
  const seqList = $('seq-list');
  const seqRow = $('seq-row');
  const seqSlider = $('seq-slider');
  const seqVal = $('seq-val');
  const seqPlay = $('seq-play');
  const seqRecord = $('seq-record');
  const seqClear = $('seq-clear');
  const seqExport = $('seq-export');
  const seqAddBtn = $('seq-add');
  const interpRecord = $('interp-record');

  // Both ⏺ buttons: armed when their chain can play, locked while a capture
  // runs. THREE states, not two — the H.264 encoder can take ~5.5 s to wake on
  // a page's first recording (see warmUpMp4 in studio.js) and the button used
  // to read "Recording…" through all of it while capturing nothing. The clip
  // recorder already distinguished them; app.recording.arming is the same flag.
  function syncRecordButtons() {
    const job = app.recording;
    const busy = !!job;
    const arming = !!job?.arming;
    const can = app.canRecord;
    interpRecord.disabled = busy || !can || !(snaps.A && snaps.B);
    seqRecord.disabled = busy || !can || app.seqStates.length < 2;
    const label = (idle) => (arming ? '⏺ Preparing…' : busy ? '⏺ Recording…' : idle);
    interpRecord.textContent = label('⏺ Record');
    seqRecord.textContent = label('⏺ Record video');
    if (!can) {
      interpRecord.title = NO_RECORDER_TITLE;
      seqRecord.title = NO_RECORDER_TITLE;
    }
    syncPlayButtons(); // a capture locks Play too — it owns the player
  }

  // Both Play buttons are PLAY ⇄ STOP toggles. A playback that can only run to
  // the end is the bug this fixes, and a button that goes on reading "▶ Play"
  // while the dancers move says the tool has no idea what it is doing — so the
  // label is derived from the flag, in one place, and every path that clears
  // that flag reports here through app.ui.onPlaybackChanged (see clearPlaying
  // in main.js). Disabled while a video capture runs: the recorder owns the
  // player for its whole length, and a Play press would only fight the capture.
  function syncPlayButtons() {
    const busy = !!app.recording;
    seqPlay.textContent = app.seqPlaying ? '■ Stop' : '▶ Play';
    seqPlay.title = app.seqPlaying
      ? 'Stop here — the dancers hold this pose and Play carries on from it'
      : 'Animate the couple through every keyframe';
    seqPlay.disabled = busy || app.seqStates.length < 2;
    interpPlay.textContent = app.interpPlaying ? '■ Stop' : '▶ Play A→B';
    interpPlay.title = app.interpPlaying
      ? 'Stop here — the dancers hold this pose and Play carries on from it'
      : 'Animate the couple from pose A to pose B';
    interpPlay.disabled = busy || !(snaps.A && snaps.B);
  }

  const setSeqLabel = (t) => {
    seqSlider.value = Math.round(t * 1000);
    seqVal.textContent = `${Math.round(t * 100)}%`;
  };
  pushHistoryOnEdit(seqSlider);
  // The grab stops the player — see the A→B scrubber above for why.
  seqSlider.addEventListener('pointerdown', () => app.stopSeq());
  seqSlider.addEventListener('input', () => {
    app.stopSeq();
    const t = Number(seqSlider.value) / 1000;
    app.applySeqT(t);
    seqVal.textContent = `${Math.round(t * 100)}%`;
  });
  seqPlay.addEventListener('click', () => {
    if (app.stopSeq()) return; // it was playing: this press is the Stop
    app.pushHistory();
    app.playSeq(setSeqLabel);
  });
  seqRecord.addEventListener('click', () => {
    app.pushHistory();
    // The recording plays what the scrubber plays: the flag is resolved HERE,
    // by the caller that knows this chain is the sequence (see recordPlayback).
    app.recordPlayback(app.seqStates, 'tangle-sequence', { ease: app.seqEase() });
  });
  seqAddBtn.addEventListener('click', () => app.seqAdd());

  // ---- which keyframe is CURRENT ---------------------------------------
  // The one the timeline is standing on (app.seqShownIndex): what "+ Add
  // keyframe" inserts after, and — because it is otherwise invisible — a
  // subtle marker on its own row. An accent edge and an accent index, not a
  // fill: this row is where you ARE, not a selection, and a loud one in a list
  // of three-line blocks reads as an error state.
  //
  // The class is TOGGLED and the list is deliberately NOT re-rendered.
  // renderSequence rebuilds every row from scratch, and this follows a playing
  // sequence — sixty rebuilds a second would tear the caret out of a caption
  // being typed and make the panel unusable while anything plays. `marked` is
  // the cheap guard on top of that: main.js only calls in when the keyframe
  // actually changes, and this only touches the DOM when the INDEX does (a
  // reorder can move the same keyframe to a new row, which is a re-render and
  // arrives through the `force` path below).
  let seqMarked = -1;
  function markSeqCurrent(force = false) {
    const i = app.seqShownIndex();
    if (!force && i === seqMarked) return;
    seqMarked = i;
    seqList.querySelectorAll('.seq-block').forEach((b, j) => {
      b.classList.toggle('seq-current', j === i);
    });
    // The button says where it will put one, because "after the current
    // keyframe" is a rule the user cannot see the input to otherwise.
    seqAddBtn.title = i >= 0
      ? `Insert the current couple pose as a keyframe after keyframe ${i + 1}`
      : 'Append the current couple pose as a keyframe';
  }

  // Ease in/out. The checkbox is the only writer of the setting in the UI, and
  // syncSeqEase the only reader, so a restore / an import / a script setting it
  // shows up in the box rather than leaving it lying about the playback.
  const seqEase = $('seq-ease');
  function syncSeqEase() {
    seqEase.checked = app.seqEase();
  }
  seqEase.addEventListener('change', () => {
    // No pushHistory: the undo stack holds couple POSES, and this changes none
    // — it changes when the timeline shows them. setSeqEase re-poses at the
    // scrubber's own t, so a toggle mid-scrub is visible at once.
    app.setSeqEase(seqEase.checked);
  });

  // The two ⟲s. Each is shown only once its text has actually been dragged
  // somewhere — a reset for a placement nobody has changed is a control that
  // can do nothing, and the row would then be permanent furniture. The gesture
  // that MOVES a text is the drag in the 3D view; this is only the way back.
  const seqTextRow = $('seq-text-row');
  const seqNameReset = $('seq-name-reset');
  const seqCaptionReset = $('seq-caption-reset');
  function syncSeqTextRow() {
    const name = !!app.seqTextPos('name');
    const caption = !!app.seqTextPos('caption');
    seqNameReset.hidden = !name;
    seqCaptionReset.hidden = !caption;
    seqTextRow.hidden = !(name || caption);
  }
  seqNameReset.addEventListener('click', () => {
    app.setSeqTextPos('name', null);
    app.status('The keyframe name is back in the top-left corner.', 'info');
  });
  seqCaptionReset.addEventListener('click', () => {
    app.setSeqTextPos('caption', null);
    app.status('The caption is back along the foot of the frame.', 'info');
  });

  // Clearing destroys every keyframe AND the localStorage copy in one click,
  // and the undo stack holds couple poses only, so nothing can bring them back.
  // Ask — but only when there is something to lose.
  seqClear.addEventListener('click', () => {
    const n = app.seqStates.length;
    if (n && !window.confirm(`Delete all ${n} keyframe${n === 1 ? '' : 's'}? This also clears the saved copy and cannot be undone.`)) return;
    app.setSeqStates([]);
    // There is no timeline left to be on, so its extras go with it: the caption
    // band clears and the Muscles panel takes its own look back.
    app.clearKeyframeExtras();
    if (n) app.status(`Deleted ${n} keyframe${n === 1 ? '' : 's'}.`, 'info');
  });

  // ---- the edit focus banner -------------------------------------------
  // The DURABLE indicator. app.status says it once and clears after ~3 s, and a
  // focus session lasts as long as the user spends drawing, so the mode needs
  // something that stays on screen: this banner, the row's pressed ✎, and the
  // one-liners in the Muscles panel and the Draw toolbar. Three places because
  // the user is in three places while it is on.
  const seqFocusNote = $('seq-focus-note');
  const muscleFocusNote = $('muscle-focus-note');
  $('seq-focus-end').addEventListener('click', () => app.seqFocus(null));
  function syncSeqFocus() {
    const i = app.seqFocusIndex?.() ?? -1;
    seqFocusNote.hidden = i < 0;
    muscleFocusNote.hidden = i < 0;
    if (i >= 0) {
      $('seq-focus-which').textContent = app.seqName(i);
      $('muscle-focus-which').textContent = app.seqName(i);
    }
    // While focused the panel's chips belong to the keyframe, so its own
    // "a keyframe is showing its highlighting" note would be a second, weaker
    // way of saying the same thing.
    if (i >= 0) muscleKfNote.hidden = true;
    syncDrawButtons();
  }

  // ---- keyframe reordering --------------------------------------------
  // A row is dragged with POINTER events, not HTML5 drag-and-drop. The row
  // carries a text field and a number box, and a `draggable` ancestor hijacks
  // the ordinary press-and-sweep that selects text inside them — the label
  // would become uneditable by the gesture users reach for first. Pointer
  // events also let the drop indicator follow the cursor continuously, which
  // is the whole point: you cannot aim at a landing place you cannot see.
  let seqDrag = null;
  const SEQ_DRAG_SLOP = 4; // px before a press counts as a drag, not a click
  // Bumped by every renderSequence, and captured by each row's handlers, so a
  // field can tell whether the list it belongs to is still the one on screen.
  let seqGen = 0;

  const seqRows = () => [...seqList.querySelectorAll('.pose-item')];

  // Where the dragged row would be INSERTED in the list as drawn (0..n): the
  // first row whose upper half the cursor is in, else past the last one.
  function seqDropIndex(clientY) {
    const rows = seqRows();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  // The visible landing place: a rule above the row it would push down, or
  // below the last row when the drop is off the end.
  function seqShowDrop(insert) {
    const rows = seqRows();
    rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (insert == null) return;
    if (insert < rows.length) rows[insert].classList.add('drop-before');
    else rows[rows.length - 1]?.classList.add('drop-after');
  }

  function seqDragEnd(commit) {
    const d = seqDrag;
    seqDrag = null;
    if (!d) return;
    seqShowDrop(null);
    d.row.classList.remove('seq-dragging');
    if (!commit || !d.active || d.insert == null) return;
    // `insert` indexes the list as DRAWN; lifting the dragged row out first
    // shifts every row after it down by one, so a drop below its old home
    // lands one place earlier than the indicator read.
    app.seqMoveTo(d.from, d.insert > d.from ? d.insert - 1 : d.insert);
  }

  // Bound on the window, not the row: a drag that leaves the sidebar (or ends
  // over the 3D view) must still finish rather than latch on forever.
  window.addEventListener('pointermove', (e) => {
    if (!seqDrag) return;
    if (!seqDrag.active) {
      if (Math.abs(e.clientY - seqDrag.y0) < SEQ_DRAG_SLOP) return;
      seqDrag.active = true;
      seqDrag.row.classList.add('seq-dragging');
    }
    seqDrag.insert = seqDropIndex(e.clientY);
    seqShowDrop(seqDrag.insert);
  });
  window.addEventListener('pointerup', () => seqDragEnd(true));
  window.addEventListener('pointercancel', () => seqDragEnd(false));

  function renderSequence() {
    const n = app.seqStates.length;
    seqGen++; // everything the previous rows still have in flight is now stale
    // Every row is rebuilt here, so committing a label with Enter — which
    // fires `change` while the field still holds the caret — would otherwise
    // drop focus out of the list entirely. Remember which field of which row
    // had it and hand it back.
    // `[data-index]` rather than `.pose-item`: a keyframe is now a BLOCK (the
    // controls row plus its extras line), and the caption field lives on the
    // second line, outside the row itself.
    const act = document.activeElement;
    const held = seqList.contains(act)
      ? { i: Number(act.closest('[data-index]')?.dataset.index), field: act.dataset.field }
      : null;
    seqList.innerHTML = n ? ''
      : '<span class="muted">No keyframes yet — pose the couple and add one.</span>';
    app.seqStates.forEach((state, i) => {
      // A keyframe is two lines: the controls row (index, label, buttons,
      // duration) and an extras line under it. They are wrapped so the row
      // itself stays exactly what the reorder drags and measures — seqDropIndex
      // and the drop indicator both work off `.pose-item` rects.
      const block = document.createElement('div');
      block.className = 'seq-block';
      block.dataset.index = String(i);
      const row = document.createElement('div');
      row.className = 'pose-item seq-item';
      row.dataset.index = String(i);
      row.dataset.field = 'row';
      // Focusable because the reorder must not be drag-only: a pointer gesture
      // is unreachable by keyboard, so Alt+↑/↓ on the focused row does the
      // same move. The tooltip is where both gestures are advertised.
      row.tabIndex = 0;
      row.title = 'Drag to reorder — or focus this row and press Alt+↑ / Alt+↓';
      // The number stays: it is how a row maps onto the movement scrubber.
      // It doubles as the grip, which is why it wears the grab cursor.
      row.innerHTML = `<span class="seq-index">${i + 1}</span>`;
      const btn = (label, title, fn, disabled = false) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', fn);
        row.appendChild(b);
        return b;
      };
      // The user's own word for this keyframe ("cross", "pivot out"). Left
      // blank the placeholder still names it by number, so no row is anonymous.
      const label = document.createElement('input');
      label.type = 'text';
      label.className = 'seq-name';
      label.dataset.field = 'name';
      label.maxLength = app.seqNameMax;
      label.value = typeof state.name === 'string' ? state.name : '';
      label.placeholder = `Keyframe ${i + 1}`;
      label.title = 'Name this keyframe — blank falls back to its number';
      // `change` fires on Enter and on a blur that altered the text; the blur
      // is belt-and-braces for anything that moves focus without it. Both go
      // through the same guard, so a no-op blur cannot re-render the list out
      // from under the caret.
      //
      // The generation check is the load-bearing half. Every re-render REPLACES
      // this field, and an edited field that is torn out fires its `change` on
      // the way — SYNCHRONOUSLY, while `innerHTML` is still clearing, so it is
      // not yet detached and `isConnected` reads true. Without the check it
      // wrote its abandoned text straight back over whatever had just renamed
      // the keyframe (measured: a rename from a script was undone inside its
      // own call). A row that belongs to a list that no longer exists must not
      // speak for it.
      const gen = seqGen;
      const commitName = () => {
        if (gen !== seqGen) return;
        if (label.value.trim() !== (state.name ?? '')) app.seqSetName(i, label.value);
      };
      label.addEventListener('change', commitName);
      label.addEventListener('blur', commitName);
      row.appendChild(label);
      btn('Show', 'Jump the couple to this keyframe (and the scrubber with it)', () => app.seqApply(i));
      btn('⟳', 'Overwrite this keyframe with the current pose', () => app.seqUpdate(i));
      // A sequence is mostly the same pose slightly changed — a walk is four
      // near-identical steps — so the fastest way to author the next keyframe
      // is to copy this one and adjust it, not to re-pose the couple from
      // whatever they happen to be doing. The copy lands directly after its
      // source and carries everything: pose, timing, name, caption, tags.
      btn('⧉', `Duplicate this keyframe — the copy becomes keyframe ${i + 2}`,
        () => app.seqDuplicate(i));
      // ✎ EDIT ONLY THIS KEYFRAME. The row is the only place this mode can
      // live — it is per keyframe, and the timeline is where a keyframe is
      // identified. It is a TOGGLE, and the pressed state is on the row (plus
      // the banner above the list), because the session lasts as long as the
      // user is drawing and app.status clears after three seconds.
      const focused = app.seqFocusIndex() === i;
      const ed = document.createElement('button');
      // Its own class, not the extras line's `.seq-kf-btn`: that selector is
      // how the sequence gates find the ONE tag button per row, and a second
      // button wearing it would shift every index they read.
      ed.className = 'seq-focus-btn';
      ed.textContent = '✎';
      ed.dataset.index = String(i);
      ed.setAttribute('aria-pressed', focused ? 'true' : 'false');
      ed.classList.toggle('active', focused);
      ed.title = focused
        ? 'Stop editing this keyframe on its own (Esc)'
        : 'Edit ONLY this keyframe — drawings you make and muscles you light belong to it alone';
      ed.addEventListener('click', () => app.seqFocus(focused ? null : i));
      row.appendChild(ed);
      btn('✕', 'Delete this keyframe', () => app.seqDelete(i));
      if (focused) row.classList.add('seq-focus');
      // A press on the row body arms the drag; a press on a control never
      // does, or the label could not be typed in nor a button pressed.
      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('input, button')) return;
        seqDrag = { from: i, row, y0: e.clientY, active: false, insert: null };
      });
      // The keyboard half of the reorder. stopPropagation because the arrow
      // keys are also the 3D view's joint nudges, which listen on the window.
      row.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        e.stopPropagation();
        const to = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= app.seqStates.length) return;
        app.seqMoveTo(i, to);
        seqRows()[to]?.focus(); // follow the row the user is carrying
      });
      block.appendChild(row);

      // ---- the keyframe's TIMING: two numbers, on a line of their own ----
      // A movement is not only travel — a teacher wants the couple to ARRIVE
      // and then be looked at — so a keyframe says how long it takes to get
      // into its pose and how long it stays there. Both live on their own line
      // rather than in the row: the row is already index + label + four buttons
      // inside a 320 px sidebar, and a second number box there would have left
      // each of them too narrow to read "2.4" in (which is the bug the single
      // box's width was widened to fix). Down here each one has room for its
      // own word and its unit, which is what makes two numbers on one line
      // tellable apart at a glance.
      const timing = document.createElement('div');
      timing.className = 'seq-time';
      const timeBox = (field, word, value, disabled, title) => {
        const lab = document.createElement('span');
        lab.className = 'seq-time-lab';
        lab.textContent = word;
        lab.title = title;
        const box = document.createElement('input');
        box.type = 'number';
        box.className = `seq-num seq-${field}`;
        box.dataset.field = field;
        box.min = String(field === 'move' ? app.seqTravelMin : app.seqHoldMin);
        box.max = String(app.seqSecondsMax);
        box.step = '0.1';
        box.value = String(value);
        box.disabled = disabled;
        box.title = title;
        const unit = document.createElement('span');
        unit.className = 'seq-time-unit';
        unit.textContent = 's';
        unit.title = title;
        timing.append(lab, box, unit);
        return box;
      };
      // The FIRST keyframe has nothing before it to travel from, so its move
      // box is disabled rather than hidden — the two columns stay aligned down
      // the list, and the reason is in the tooltip (the same choice the last
      // row's duration box used to make, at the other end of the chain).
      const first = i === 0;
      const mv = timeBox('move', 'into', first ? '' : app.seqTravel(i), first,
        first
          ? 'Keyframe 1 starts the movement — there is nothing before it to travel from.'
          : `Seconds to travel from keyframe ${i} into this one`);
      mv.addEventListener('change', () => {
        if (gen !== seqGen) return;
        app.seqSetTravel(i, parseFloat(mv.value));
      });
      const hd = timeBox('hold', 'hold', app.seqHold(i), false,
        'Seconds to stay in this pose once it is reached — 0 travels straight on');
      hd.addEventListener('change', () => {
        if (gen !== seqGen) return;
        app.seqSetHold(i, parseFloat(hd.value));
      });
      block.appendChild(timing);

      // ---- the keyframe's own EXTRAS: a caption and a muscle highlight ----
      // A LINE OF ITS OWN rather than two more controls on the row. The row is
      // already index + label + four buttons inside a 320 px sidebar, and a
      // caption is a sentence, not a chip. It is always shown
      // rather than hidden behind a disclosure because this list has no
      // "selected keyframe" to hang a panel off — and a caption you cannot see
      // while you order the sequence is one you will forget you wrote.
      const extras = document.createElement('div');
      extras.className = 'seq-extras';
      const cap = document.createElement('input');
      cap.type = 'text';
      cap.className = 'seq-caption';
      cap.dataset.field = 'caption';
      cap.maxLength = app.seqCaptionMax;
      cap.value = app.seqCaption(i);
      cap.placeholder = 'Caption on this keyframe…';
      cap.title = 'Words drawn across the foot of the picture while this keyframe is showing — they ride into the photo and the recorded video with it';
      // Same commit pair and the same stale-generation guard as the label
      // above: a field torn out by a re-render fires `change` on the way and
      // must not speak for a list that no longer exists.
      const commitCaption = () => {
        if (gen !== seqGen) return;
        if (cap.value.trim() !== app.seqCaption(i)) app.seqSetCaption(i, cap.value);
      };
      cap.addEventListener('change', commitCaption);
      cap.addEventListener('blur', commitCaption);
      extras.appendChild(cap);

      // Which floor drawings this keyframe shows. UNTAGGED (◻) means all of
      // the PUBLIC ones — every drawing no keyframe owns — which is what every
      // keyframe authored before this carries and why the control is inert
      // until someone presses it. Tagging CAPTURES what is on screen rather
      // than offering a list of every drawing: the teacher has just arranged
      // the diagram they want (Draw mode's ◐ Hide), and a checklist of fifteen
      // chalk marks named "Line 7" identifies nothing. Pressing it again on a
      // tagged row clears back to all.
      //
      // It lives HERE, on the extras line beside the muscle tag, rather than on
      // the controls row: the two are the same kind of thing (what this
      // keyframe shows, as against what it IS), and the row has to keep room
      // for ✎ inside a 320 px sidebar. It also gets its word back — "◻" alone
      // next to Show and ⟳ said nothing about drawings.
      const tagged = app.seqDrawIds(i);
      const nDraw = app.drawings.length;
      const nOwn = app.seqOwnIds(i)?.length ?? 0;
      const dBtn = document.createElement('button');
      // Its OWN class, deliberately NOT `.seq-kf-btn`: that selector is how the
      // keyframe-extras gate finds the one MUSCLE tag per row, and a second
      // button wearing it shifts every index it reads.
      dBtn.className = 'seq-draw-btn';
      dBtn.textContent = tagged ? `◼ ${tagged.length + nOwn}` : '◻ Drawings';
      dBtn.disabled = nDraw === 0;
      dBtn.title = tagged
        ? `Showing ${tagged.length + nOwn} of ${nDraw} drawings on this keyframe — click to show all again`
        : nOwn
          ? `${nOwn} drawing${nOwn === 1 ? '' : 's'} belong${nOwn === 1 ? 's' : ''} to this keyframe; the rest of the diagram shows too. Click to show only what is on screen now.`
          : 'Show only the drawings currently on screen when this keyframe plays';
      dBtn.addEventListener('click', () => {
        if (tagged) {
          app.seqSetDrawIds(i, null);
          app.status(`Keyframe ${i + 1} shows all drawings.`, 'info');
          return;
        }
        // Capture EXCLUDES what this keyframe owns — those are carried by
        // kf.own and would be a ghost entry here the day they are released.
        const ids = app.seqCaptureDrawIds(i);
        const shown = (ids?.length ?? 0) + nOwn;
        app.status(`Keyframe ${i + 1} shows ${shown} of ${nDraw} drawing${nDraw === 1 ? '' : 's'}.`, 'info');
      });
      extras.appendChild(dBtn);

      // The muscle tag — the drawings tag's twin, and CAPTURE for the same
      // reason: the teacher has just lit the bellies they mean in the Muscles
      // panel, and a checklist of 68 atlas names identifies nothing. Untagged
      // (◻) means the keyframe shows whatever the panel has running.
      const mus = app.seqMuscles(i);
      const nLit = mus?.lit.length ?? 0;
      const mBtn = document.createElement('button');
      mBtn.className = 'seq-kf-btn';
      mBtn.textContent = mus ? `◼ ${nLit}` : '◻ Muscles';
      mBtn.title = mus
        ? `This keyframe lights ${nLit} muscle${nLit === 1 ? '' : 's'} of its own — click to follow the Muscles panel again`
        : 'Light exactly the muscles highlighted right now whenever this keyframe is showing';
      mBtn.addEventListener('click', () => {
        if (mus) {
          app.seqSetMuscles(i, null);
          app.status(`Keyframe ${i + 1} follows the Muscles panel again.`, 'info');
          return;
        }
        const got = app.seqCaptureMuscles(i);
        const n2 = got?.lit.length ?? 0;
        // An empty capture is a real choice — "show no highlighting here" — so
        // it is stored, and the message says what was taken rather than
        // pretending nothing happened.
        app.status(n2
          ? `Keyframe ${i + 1} lights ${n2} muscle${n2 === 1 ? '' : 's'}.`
          : `Keyframe ${i + 1} now shows no muscle highlighting.`, 'info');
      });
      extras.appendChild(mBtn);

      // ---- how THIS keyframe inks its two on-screen texts ----------------
      // Show/hide and colour are per keyframe (a step you want to call out can
      // wear its own ink), while WHERE they sit is one setting for the whole
      // sequence — dragged in the 3D view, reset by the ⟲ row under the list.
      // A pair appears only once that keyframe HAS the text it styles. A
      // keyframe with neither — which is every one the moment it is added, and
      // every one in a sequence that uses none of this — draws the same extras
      // line it always did, rather than two dead controls per text per row in a
      // 320 px sidebar.
      const ink = document.createElement('span');
      ink.className = 'seq-ink';
      for (const [which, word] of [
        ['name', 'Name'],
        ['caption', 'Caption'],
      ]) {
        const has = !!(which === 'name' ? app.seqNameForScreen(i) : app.seqCaption(i));
        if (!has) continue;
        const st = app.seqTextStyle(i, which);
        const eye = document.createElement('button');
        // Its OWN class, deliberately not the muscle tag's `.seq-kf-btn`: that
        // selector is how the sequence gates find the one tag button per row,
        // and a second button wearing it shifts every index they read.
        eye.className = 'seq-eye';
        eye.dataset.text = which;
        // ◉ / ◎ rather than an eye emoji: the app's chrome is plain glyphs
        // (◻ / ◼ next door), and they stay legible at 11px in any font.
        eye.textContent = `${st.hidden ? '◎' : '◉'} ${word}`;
        eye.title = st.hidden
          ? `${word} hidden on this keyframe — click to show it again`
          : `Hide the ${word.toLowerCase()} while this keyframe is showing`;
        eye.addEventListener('click', () => {
          const now = app.seqSetTextStyle(i, which, { hidden: !st.hidden });
          app.status(`Keyframe ${i + 1}: ${word.toLowerCase()} ${now.hidden ? 'hidden' : 'shown'}.`, 'info');
        });
        ink.appendChild(eye);
        const sw = document.createElement('input');
        sw.type = 'color';
        sw.className = 'seq-ink-sw';
        sw.dataset.text = which;
        // No colour of its own = the backdrop's ink, which the swatch cannot
        // express (a colour input has no "unset"), so it opens on white — the
        // dark backdrops' own text colour — and picking anything commits.
        sw.value = st.color || '#f4f6fb';
        sw.disabled = st.hidden; // nothing on screen to colour
        sw.title = `Colour of the ${word.toLowerCase()} on this keyframe`;
        sw.addEventListener('input', () => app.seqSetTextStyle(i, which, { color: sw.value }));
        ink.appendChild(sw);
      }
      if (ink.childElementCount) extras.appendChild(ink);
      block.appendChild(extras);
      seqList.appendChild(block);
    });
    if (n >= 2) {
      const total = document.createElement('div');
      total.className = 'muted seq-total';
      total.textContent = `Whole movement: ${app.seqSeconds().toFixed(1)} s`;
      seqList.appendChild(total);
    }
    syncSeqTextRow();
    // Forced: every row here is a brand-new node with no class on it, and a
    // reorder can move the current keyframe to a different row without
    // changing WHICH keyframe it is.
    markSeqCurrent(true);
    syncSeqFocus();
    seqRow.hidden = n < 2;
    setSeqLabel(app.seqT); // the scrubber shows the player's position
    syncPlayButtons();
    seqClear.disabled = n === 0;
    seqExport.disabled = n < 2;
    if (held && Number.isFinite(held.i)) {
      // The row itself carries data-field="row", so one query serves both it
      // and the fields inside the block.
      const block = seqList.querySelectorAll('.seq-block')[held.i];
      block?.querySelector(`[data-field="${held.field}"]`)?.focus();
    }
    syncRecordButtons();
    syncPath();
    // Two paths change the ease setting without going through setSeqEase — the
    // fresh default on the first keyframe of an empty timeline, and Clear
    // putting it back — and both land here. So the box and the stored copy are
    // brought up to date from the same place the rows are.
    syncSeqEase();
    saveSeqEase();
    // Kept rather than thrown away: the dirty marker compares the timeline
    // against the library entry it came from part by part, and this is the
    // expensive part. Every path that changes a keyframe lands here, so the
    // cached string is always the current chain — which is what stops a drawing
    // drag (onDrawingsChanged fires per pointermove) re-serializing a 60 kB
    // chain it did not touch.
    seqStatesJson = JSON.stringify(app.seqStates);
    // NOTE (unchanged, deliberately): a full quota swallows this write in
    // silence. For the RUNNING timeline that is still the lesser evil — it
    // fires on every keystroke and reorder, so reporting here would turn one
    // full disk into a message per edit, and the work is still on screen. The
    // LIBRARY write is the opposite case and does report; see saveSeqLibrary.
    try { localStorage.setItem(SEQ_KEY, seqStatesJson); } catch { /* storage full */ }
    syncSeqLibCurrent(); // the timeline moved: the dirty marker may have too
  }

  // ---- the sequence BUNDLE: one capture, one apply -------------------------
  // Everything a sequence needs to be replayed, in ONE shape. A file and a
  // library entry are the same object — the file only wraps it in its `app` /
  // `type` / `version` envelope — so the two can never drift apart, and a new
  // per-sequence field is one line here and one line in applySeqBundle.
  //
  // The floor diagram travels WITH the sequence because a keyframe may name a
  // SUBSET of it (kf.draw): keyframes without the drawings their ids point at
  // cannot be replayed. `textPos` travels for the same reason — the keyframes
  // carry the words and this carries where they go. Both keys are additive and
  // the file version stays 1: a file without them is still a valid sequence,
  // and an older build ignores what it does not know.
  const deepCopy = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

  function captureSeqBundle() {
    return {
      // Deep-copied at the boundary, BOTH ways: a bundle handed to the library
      // must not be the live array (editing the timeline would rewrite the
      // saved entry under it), and a bundle handed back must not be the stored
      // one (setSeqStates keeps the array it is given, and normalizeSeqTiming
      // mutates it in place).
      states: deepCopy(app.seqStates),
      drawings: app.drawingsJSON(),
      textPos: app.seqTextPositions(),
      // A SETTING of the sequence, not of a keyframe: a figure saved eased and
      // loaded linear would replay the lesson with a different character.
      ease: app.seqEase(),
      // ---- ONE LINE PER new per-sequence setting, mirrored in applySeqBundle.
    };
  }

  /**
   * Put a bundle on the timeline. The ONE way a sequence arrives from outside
   * the running session — a file, a library entry — so the ordering rules live
   * here once: the drawings land BEFORE the keyframes (their kf.draw ids name
   * drawings, which must be on the floor to be pointed at) and the keyframe
   * extras are handed back AFTER (the caption, the muscle override and the
   * draw filter on screen belong to the sequence being replaced, and nothing
   * in the new chain would clear them until it was next scrubbed).
   * A `drawings` of null means "this bundle carries none" — a legacy file —
   * and leaves whatever is on the floor alone, rather than wiping it.
   * @param {{states:Array, drawings?:Array|null, textPos?:object|null}} bundle
   */
  function applySeqBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.states)) return false;
    // Loading is not a pose edit, but it MOVES the couple, so it takes a
    // history snapshot exactly as the file import always has.
    app.pushHistory();
    if (Array.isArray(bundle.drawings)) app.setDrawings(deepCopy(bundle.drawings));
    app.setSeqTextPositions(deepCopy(bundle.textPos) ?? null);
    app.setSeqStates(deepCopy(bundle.states));
    // ---- ONE LINE PER new per-sequence setting, mirrored in captureSeqBundle.
    // AFTER the chain, so the setting is never applied to the timeline being
    // replaced (setSeqEase re-poses at the scrubber's t) — and explicitly even
    // when false, because setSeqStates leaves the previous sequence's choice
    // standing for a non-empty chain. Absent means OFF: the bundle predates it.
    app.setSeqEase(bundle.ease === true);
    app.clearKeyframeExtras();
    return true;
  }

  seqExport.addEventListener('click', () => {
    const payload = { app: 'tangle', type: 'sequence', version: 1, ...captureSeqBundle() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tango-sequence.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('seq-import').addEventListener('click', () => $('seq-file').click());
  $('seq-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const states = Array.isArray(data) ? data : data.states;
      if (!Array.isArray(states) || states.length < 2 || !states.every((s) => s && s.figures)) {
        throw new Error('not a sequence');
      }
      // A file MAY carry the floor diagram its keyframes point at. One saved
      // before drawings travelled with a sequence has no such key, and must
      // import exactly as it always did — leaving whatever is on the floor
      // alone rather than wiping it.
      const incoming = Array.isArray(data.drawings) ? data.drawings : null;
      // An import REPLACES whatever is on the timeline. The pose import right
      // below this one has always taken a history snapshot first; this one did
      // not, which made the two inconsistent in the same file.
      const had = app.seqStates.length;
      const hadDrawings = incoming ? app.drawings.length : 0;
      // Ask only about what would actually be lost — the drawings clause is
      // there only when the file brings its own and there are some to replace.
      const losing = [
        had ? `${had} keyframe${had === 1 ? '' : 's'}` : null,
        hadDrawings ? `${hadDrawings} floor drawing${hadDrawings === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      const bringing = [
        `${states.length} keyframe${states.length === 1 ? '' : 's'}`,
        incoming ? `${incoming.length} drawing${incoming.length === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      if (losing.length && !window.confirm(`Replace the current ${losing.join(' and ')} with the ${bringing.join(' and ')} in this file?`)) {
        e.target.value = '';
        return;
      }
      // A file saved before the texts could be placed carries no `textPos`, and
      // must import exactly as it always did — which for a placement means the
      // default, not whatever the last sequence left on screen, since the words
      // arriving are this file's. `?? null` in the bundle is that rule.
      // `ease` absent means OFF: a file saved before easing existed was authored
      // against a linear timeline, and reading its silence as "ease it" would
      // change a movement whose timing its author had already judged.
      applySeqBundle({ states, drawings: incoming, textPos: data.textPos ?? null, ease: data.ease === true });
      // The timeline now holds a figure that is in no library entry — a file
      // and a saved sequence are different stores, and claiming otherwise
      // would offer to overwrite an entry this was never taken from.
      setSeqLibCurrent(null);
      app.status(`Loaded ${bringing.join(' and ')}.`, 'info');
    } catch {
      app.status('Could not read that file as a sequence.', 'error');
    }
    e.target.value = '';
  });

  // ------------------------------------------------- the sequence LIBRARY
  // Several NAMED figures, so starting a second one no longer means exporting
  // a file first or losing the first. Modelled on the slide library below:
  // name → bundle in one key, the running order in its own (a sequence may be
  // called "order"), a single delete that does not interrupt but offers Undo,
  // a bulk action that asks only when there is something to lose.
  const SEQ_LIB_KEY = 'tangoPoseStudio.seqLibrary.v1';
  const SEQ_LIB_ORDER_KEY = 'tangoPoseStudio.seqLibOrder.v1';
  // WHICH entry the timeline came from, so a reload still knows what the quick
  // Save would overwrite and whether there is unsaved work. Only the NAME is
  // stored: the bundle it is compared against is the library entry itself, and
  // keeping a second copy of a 60 kB chain here to answer "is it dirty?" would
  // double the storage a sequence costs for a single boolean.
  const SEQ_CUR_KEY = 'tangoPoseStudio.seqCurrent.v1';

  const seqLibList = $('seq-lib-list');
  const seqLibName = $('seq-lib-name');
  const seqLibCurrentEl = $('seq-lib-current');
  const seqLibUpdate = $('seq-lib-update');
  let seqLibCurrent = null; // the entry name the timeline corresponds to, or null
  // …and that entry's three parts, serialized. Held in memory rather than
  // re-read per check: the dirty marker is refreshed on every drawing mutation
  // (which fires per pointermove of a handle drag), and parsing the whole
  // library there to answer one boolean would make dragging a chalk line pay
  // for every figure the user has ever saved.
  let seqLibBase = null;

  function loadSeqLib() {
    try { return JSON.parse(localStorage.getItem(SEQ_LIB_KEY)) || {}; } catch { return {}; }
  }
  // Unlike the running timeline's own write (see renderSequence), a failure
  // here MUST be reported: this is the one copy of a figure the user asked to
  // keep, and a Save that silently did nothing is a figure lost at the next
  // "New". Bundles are big — a dozen keyframes of a couple is tens of kB — so
  // the quota is a real outcome, not a theoretical one. Non-modal, and it names
  // the way out (Export file), because that path has no quota at all.
  function saveSeqLib(lib) {
    try {
      localStorage.setItem(SEQ_LIB_KEY, JSON.stringify(lib));
      return true;
    } catch {
      app.status('NOT saved — browser storage is full. Delete a saved sequence, or use Export file instead.', 'error');
      return false;
    }
  }
  // The running order, kept beside the name→bundle map for the reason the
  // slide deck's is: an "order" key inside the map would collide with a
  // sequence actually called "order". Names missing from the list fall in
  // alphabetically at the end, so nothing a user saved can become unreachable.
  function loadSeqOrder(lib) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(SEQ_LIB_ORDER_KEY)) || []; } catch { saved = []; }
    const known = new Set(Object.keys(lib));
    const ordered = saved.filter((n) => known.has(n));
    const rest = [...known].filter((n) => !ordered.includes(n)).sort();
    return [...ordered, ...rest];
  }
  function saveSeqOrder(names) {
    try { localStorage.setItem(SEQ_LIB_ORDER_KEY, JSON.stringify(names)); } catch { /* full / private mode */ }
  }

  // ---- dirty tracking -------------------------------------------------------
  // "Does the timeline still say what the entry it came from says?" — compared
  // by CONTENT, not by an edited-since flag, so undoing an edit back to the
  // saved figure stops claiming there is work to lose. Part by part rather than
  // one JSON of the whole bundle: the states string is already built by
  // renderSequence for SEQ_KEY, and this runs on every drawing mutation.
  const seqPartsOf = (bundle) => [
    JSON.stringify(bundle?.states ?? []),
    JSON.stringify(bundle?.drawings ?? []),
    JSON.stringify(bundle?.textPos ?? null),
    // An entry saved before easing existed has no key and played linear.
    String(bundle?.ease === true),
  ];
  const seqLiveParts = () => [
    seqStatesJson,
    JSON.stringify(app.drawingsJSON()),
    JSON.stringify(app.seqTextPositions()),
    String(app.seqEase()),
  ];

  function seqLibDirty() {
    // No entry to compare against: unsaved work is simply "there are
    // keyframes". Drawings alone do not count — the floor is its own saved
    // thing, and the Draw toolbar owns it.
    if (!seqLibBase) return app.seqStates.length > 0;
    return seqLiveParts().some((s, i) => s !== seqLibBase[i]);
  }

  // Point the timeline at an entry (or at none) and remember it across reloads.
  function setSeqLibCurrent(name) {
    seqLibCurrent = name || null;
    seqLibBase = seqLibCurrent ? seqPartsOf(loadSeqLib()[seqLibCurrent]) : null;
    try {
      if (seqLibCurrent) localStorage.setItem(SEQ_CUR_KEY, JSON.stringify(seqLibCurrent));
      else localStorage.removeItem(SEQ_CUR_KEY);
    } catch { /* full / private mode: the link is a convenience, not the work */ }
    renderSeqLibrary();
  }

  // The heading line and the quick-Save button: which entry the timeline is,
  // and whether it still matches. Split from the list below because it is what
  // changes on every keyframe edit, drawing tweak and text drag, while the LIST
  // only changes when the library itself does — and rebuilding it there would
  // parse the whole store on each pointermove of a drawing handle.
  function syncSeqLibCurrent() {
    if (!seqLibCurrentEl) return;
    const dirty = seqLibDirty();
    seqLibCurrentEl.textContent = seqLibCurrent
      ? `${seqLibCurrent}${dirty ? ' •' : ''}`
      : (dirty ? 'unsaved •' : '');
    seqLibCurrentEl.title = seqLibCurrent
      ? (dirty
        ? `The timeline has changes that are not in the saved sequence “${seqLibCurrent}”`
        : `The timeline matches the saved sequence “${seqLibCurrent}”`)
      : (dirty ? 'This timeline has never been saved' : '');
    seqLibCurrentEl.className = dirty ? 'muted seq-dirty' : 'muted';
    seqLibUpdate.disabled = !seqLibCurrent;
    seqLibUpdate.textContent = seqLibCurrent ? `Save “${seqLibCurrent}”` : 'Save';
  }

  function renderSeqLibrary() {
    if (!seqLibList) return;
    const lib = loadSeqLib();
    const names = loadSeqOrder(lib);
    // An entry deleted from under the timeline leaves it corresponding to
    // nothing rather than to a ghost the quick Save would re-create.
    if (seqLibCurrent && !lib[seqLibCurrent]) { seqLibCurrent = null; seqLibBase = null; }
    syncSeqLibCurrent();

    seqLibList.innerHTML = names.length ? ''
      : '<span class="muted">No sequences saved yet.</span>';
    names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = `pose-item${name === seqLibCurrent ? ' current' : ''}`;
      // textContent, never innerHTML: a name is free text, and one can arrive
      // from a hand-edited storage key.
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = name;
      nameEl.title = `${lib[name]?.states?.length ?? 0} keyframes · ${lib[name]?.drawings?.length ?? 0} floor drawings`;

      const load = document.createElement('button');
      load.textContent = 'Load';
      load.title = 'Put this sequence on the timeline, with its drawings and text placement';
      // The confirm lives HERE and never inside app.seqLibLoad: the headless
      // scripts drive the scripted path directly, and a dialog in there would
      // hang every run (the behavioural rule in CLAUDE.md).
      load.addEventListener('click', () => {
        if (!confirmLosingTimeline(`Load “${name}”`)) return;
        app.seqLibLoad(name);
      });

      const move = (delta) => {
        const l = loadSeqLib();
        const order = loadSeqOrder(l);
        const at = order.indexOf(name);
        const to = at + delta;
        if (at < 0 || to < 0 || to >= order.length) return;
        order.splice(to, 0, ...order.splice(at, 1));
        saveSeqOrder(order);
        renderSeqLibrary();
      };
      const up = document.createElement('button');
      up.append(Object.assign(document.createElement('span'), { textContent: '↑', ariaHidden: 'true' }));
      up.setAttribute('aria-label', `Move “${name}” earlier in the list`);
      up.title = 'Move this sequence up';
      up.disabled = i === 0;
      up.addEventListener('click', () => move(-1));
      const down = document.createElement('button');
      down.append(Object.assign(document.createElement('span'), { textContent: '↓', ariaHidden: 'true' }));
      down.setAttribute('aria-label', `Move “${name}” later in the list`);
      down.title = 'Move this sequence down';
      down.disabled = i === names.length - 1;
      down.addEventListener('click', () => move(1));

      const del = document.createElement('button');
      del.append(Object.assign(document.createElement('span'), { textContent: '✕', ariaHidden: 'true' }));
      del.setAttribute('aria-label', `Delete the saved sequence “${name}”`);
      del.title = 'Delete this saved sequence';
      // A SINGLE delete does not interrupt — a dialog per row is worse than the
      // loss it prevents — so it deletes and offers the way back on the status
      // line, exactly as the slide library's ✕ does. The undo stack holds
      // couple poses only and could never recover this.
      del.addEventListener('click', () => {
        const order = loadSeqOrder(loadSeqLib());
        const wasCurrent = seqLibCurrent === name;
        const removed = app.seqLibDelete(name);
        if (!removed) return;
        app.status(`Deleted the sequence “${name}”.`, 'info', {
          label: 'Undo',
          run: () => {
            const l = loadSeqLib();
            l[name] = removed;
            if (saveSeqLib(l)) saveSeqOrder(order);
            if (wasCurrent) setSeqLibCurrent(name);
            else renderSeqLibrary();
          },
        });
      });
      row.append(nameEl, load, up, down, del);
      seqLibList.appendChild(row);
    });
  }

  // The one question the library ever asks before REPLACING the timeline: Load
  // and New both risk the same thing, and both are silent when there is
  // nothing to lose (an untouched sequence loading another must not nag).
  function confirmLosingTimeline(what) {
    if (!seqLibDirty()) return true;
    const n = app.seqStates.length;
    const which = seqLibCurrent
      ? `the unsaved changes to “${seqLibCurrent}”`
      : `${n} unsaved keyframe${n === 1 ? '' : 's'}`;
    return window.confirm(`${what} and lose ${which}?`);
  }

  // ---- the scripted API ----------------------------------------------------
  // On `app`, like the slide deck's slideNames/showSlide, so the headless
  // scripts and a future presenter can drive the library without the panel.
  // None of these opens a dialog: the questions belong to the click handlers.
  app.seqBundle = captureSeqBundle;
  app.setSeqBundle = applySeqBundle;
  app.seqLibNames = () => loadSeqOrder(loadSeqLib());
  app.seqLibEntry = (name) => deepCopy(loadSeqLib()[name] ?? null);
  app.seqLibCurrent = () => ({ name: seqLibCurrent, dirty: seqLibDirty() });

  app.seqLibSave = (name) => {
    const key = String(name ?? '').trim();
    if (!key) return false;
    const lib = loadSeqLib();
    const order = loadSeqOrder(lib);
    const isNew = !lib[key];
    lib[key] = captureSeqBundle();
    // The order is written only once the bundle itself is safely stored — an
    // entry in the running order that is not in the map is a name with nothing
    // behind it.
    if (!saveSeqLib(lib)) return false;
    if (isNew) saveSeqOrder([...order, key]);
    setSeqLibCurrent(key); // this is now the entry the timeline corresponds to
    return true;
  };

  app.seqLibLoad = (name) => {
    const bundle = loadSeqLib()[name];
    // A hand-edited store can hold a row that is not a bundle. It costs that
    // row, not the session — and the timeline goes on corresponding to
    // whatever it did before, since nothing was replaced.
    if (!applySeqBundle(bundle)) return false;
    setSeqLibCurrent(name);
    return true;
  };

  // Returns the removed bundle (so the caller can offer it back), or null.
  app.seqLibDelete = (name) => {
    const lib = loadSeqLib();
    const removed = lib[name];
    if (!removed) return null;
    delete lib[name];
    if (!saveSeqLib(lib)) return null;
    saveSeqOrder(loadSeqOrder(loadSeqLib()).filter((n) => n !== name));
    if (seqLibCurrent === name) setSeqLibCurrent(null);
    else renderSeqLibrary();
    return removed;
  };

  // Empty the timeline for a fresh figure. It replaces nothing in the library,
  // and leaves the FLOOR alone: the diagram is its own saved thing with its own
  // Clear, and wiping a teacher's chalk because they started a new figure over
  // it would be a surprise no message could excuse.
  app.seqLibNew = () => {
    app.setSeqStates([]);
    app.clearKeyframeExtras();
    setSeqLibCurrent(null);
  };

  // ---- the panel's own controls --------------------------------------------
  $('seq-lib-save').addEventListener('click', () => {
    const name = seqLibName.value.trim() || `Sequence ${new Date().toLocaleString()}`;
    // Saving over an existing name DESTROYS that entry, and the undo stack
    // holds couple poses only — so this one asks, while the quick Save below
    // does not (overwriting the entry you are working in IS the intent there).
    if (loadSeqLib()[name]
      && !window.confirm(`Replace the saved sequence “${name}” with the current timeline?`)) return;
    if (!app.seqLibSave(name)) return;
    seqLibName.value = '';
    app.status(`Saved the sequence “${name}”.`, 'info');
  });
  seqLibUpdate.addEventListener('click', () => {
    if (!seqLibCurrent) return;
    const name = seqLibCurrent;
    if (app.seqLibSave(name)) app.status(`Saved “${name}”.`, 'info');
  });
  $('seq-lib-new').addEventListener('click', () => {
    if (!confirmLosingTimeline('Start a new sequence')) return;
    const n = app.seqStates.length;
    app.seqLibNew();
    if (n) app.status('Empty timeline — the saved sequences and the floor drawings are untouched.', 'info');
  });
  // Enter in the name field saves, which is what a field beside a Save button
  // is for.
  seqLibName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('seq-lib-save').click(); }
  });

  // The block's own fold, kept in the sidebar's layout store beside the
  // sections' — one place the panel's shape is remembered, and the key is
  // ignored by anything that does not know it.
  const seqLibBlock = $('seq-lib');
  const seqLibToggle = seqLibBlock.querySelector('.sub-toggle');
  const foldSeqLib = (folded, persist = true) => {
    seqLibBlock.classList.toggle('collapsed', folded);
    seqLibToggle.setAttribute('aria-expanded', String(!folded));
    if (persist) saveLayout({ seqLibFolded: folded });
  };
  seqLibToggle.addEventListener('click', () => foldSeqLib(!seqLibBlock.classList.contains('collapsed')));
  foldSeqLib(readLayout().seqLibFolded === true, false);

  // Restore the previous session's sequence (before the first render below).
  try {
    const saved = JSON.parse(localStorage.getItem(SEQ_KEY));
    if (Array.isArray(saved) && saved.length && saved.every((s) => s && s.figures)) {
      app.setSeqStates(saved);
    }
  } catch { /* corrupted storage: start empty */ }
  // …and where its two on-screen texts sit. The guard is opened AFTER the
  // restore, so the write it triggers cannot be the one that lands.
  try {
    const savedText = JSON.parse(localStorage.getItem(SEQ_TEXT_KEY));
    if (savedText) app.setSeqTextPositions(savedText);
  } catch { /* corrupted storage: keep the defaults */ }
  seqTextReady = true;
  // …and whether its transitions ease. THREE cases, not two, and the third is
  // the compatibility one: a stored flag is the user's own choice and wins; no
  // stored flag with a restored CHAIN is a session from before easing existed,
  // which must play exactly as it did, so OFF; no stored flag and no chain is a
  // fresh start, which keeps app's own fresh default. Opened after, like the
  // texts, so the write this triggers cannot be the one that lands.
  try {
    const savedEase = JSON.parse(localStorage.getItem(SEQ_EASE_KEY));
    if (typeof savedEase === 'boolean') app.setSeqEase(savedEase);
    else if (app.seqStates.length) app.setSeqEase(false);
  } catch { /* corrupted storage: keep the default */ }
  seqEaseReady = true;
  // …and WHICH saved sequence the restored timeline corresponds to. Read
  // straight into the variable rather than through setSeqLibCurrent: that
  // writes the key it is restoring (harmless here, but it is the same trap the
  // `ready` guards above exist for) and renders a list the first renderSequence
  // is about to render anyway. A name whose entry has since gone is dropped by
  // renderSeqLibrary.
  try {
    const savedCur = JSON.parse(localStorage.getItem(SEQ_CUR_KEY));
    if (typeof savedCur === 'string' && savedCur && loadSeqLib()[savedCur]) {
      seqLibCurrent = savedCur;
      seqLibBase = seqPartsOf(loadSeqLib()[savedCur]);
    }
  } catch { /* corrupted storage: the timeline corresponds to nothing */ }
  renderSequence();
  renderSeqLibrary(); // the list itself; renderSequence only syncs the heading

  // ---------------------------------------------------------------- presets
  const presetSelect = $('preset-select');
  app.presets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  });
  presetSelect.value = 1;
  $('preset-apply').addEventListener('click', () => app.applyPreset(Number(presetSelect.value)));

  // ---------------------------------------------------------------- pose library
  const poseList = $('pose-list');

  function loadLibrary() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveLibrary(lib) {
    // An unguarded write throws on a full quota (or in Safari private mode) and
    // the exception escapes the click handler, so the list never re-renders and
    // Save appears to do nothing at all. Report it and still redraw. Non-modal:
    // an alert() here would interrupt a lesson to say something the user can
    // only act on afterwards.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
    } catch {
      app.status("Couldn't save — browser storage is full. Delete a saved pose or export to a file.", 'error');
    }
    renderLibrary();
  }
  // The deck's running order, kept beside the name→slide map rather than in
  // it: the map is the shape every previously saved pose is already stored in,
  // and an "order" key inside it would collide with a slide actually called
  // "order". Names missing from the list (saved before this, or hand-edited in)
  // fall in alphabetically at the end, so no slide can become unreachable.
  function loadOrder(lib) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(ORDER_KEY)) || []; } catch { saved = []; }
    const known = new Set(Object.keys(lib));
    const ordered = saved.filter((n) => known.has(n));
    const rest = [...known].filter((n) => !ordered.includes(n)).sort();
    return [...ordered, ...rest];
  }
  function saveOrder(names) {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(names)); } catch { /* full / private mode */ }
  }
  // The deck, in order, for Present mode's ← / → .
  app.slideNames = () => loadOrder(loadLibrary());
  app.showSlide = (name) => {
    const lib = loadLibrary();
    if (!lib[name]) return false;
    app.pushHistory();
    app.applyCoupleState(lib[name]);
    return true;
  };

  function renderLibrary() {
    const lib = loadLibrary();
    const names = loadOrder(lib);
    poseList.innerHTML = names.length ? '' : '<span class="muted">No slides saved yet.</span>';
    names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'pose-item';
      // textContent, never innerHTML: the name is free text from the Save field
      // or `state.name` inside an imported JSON pose file, so interpolating it
      // into markup runs whatever a third-party file cares to put there.
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = name;
      // A slide restores the view too; a file saved before slides existed
      // carries only the pose, and applyCoupleState leaves the view alone.
      const show = document.createElement('button');
      show.textContent = 'Show';
      show.title = lib[name]?.view
        ? 'Put the couple, the camera, the labels and the highlights back as this slide has them'
        : 'Pose only — this entry was saved before slides carried the view, so the layer, camera and labels stay as they are';
      show.addEventListener('click', () => app.showSlide(name));

      const move = (delta) => {
        const order = loadOrder(loadLibrary());
        const at = order.indexOf(name);
        const to = at + delta;
        if (at < 0 || to < 0 || to >= order.length) return;
        order.splice(to, 0, ...order.splice(at, 1));
        saveOrder(order);
        renderLibrary();
      };
      const up = document.createElement('button');
      up.append(Object.assign(document.createElement('span'), { textContent: '↑', ariaHidden: 'true' }));
      up.setAttribute('aria-label', `Move “${name}” earlier in the deck`);
      up.title = 'Show this slide earlier';
      up.disabled = i === 0;
      up.addEventListener('click', () => move(-1));
      const down = document.createElement('button');
      down.append(Object.assign(document.createElement('span'), { textContent: '↓', ariaHidden: 'true' }));
      down.setAttribute('aria-label', `Move “${name}” later in the deck`);
      down.title = 'Show this slide later';
      down.disabled = i === names.length - 1;
      down.addEventListener('click', () => move(1));

      const del = document.createElement('button');
      del.append(Object.assign(document.createElement('span'), { textContent: '✕', ariaHidden: 'true' }));
      del.setAttribute('aria-label', `Delete the slide “${name}”`);
      del.title = 'Delete this slide';
      del.addEventListener('click', () => {
        const l = loadLibrary();
        const removed = l[name];
        const order = loadOrder(l);
        delete l[name];
        saveOrder(order.filter((n) => n !== name));
        saveLibrary(l);
        // A saved slide is not pose STATE, so Ctrl+Z cannot bring it back — it
        // would restore the couple and leave the library entry gone. Offer the
        // recovery where the loss happened instead of a dialog beforehand.
        app.status(`Deleted the slide “${name}”.`, 'info', {
          label: 'Undo',
          run: () => {
            const lib2 = loadLibrary();
            lib2[name] = removed;
            saveOrder(order);
            saveLibrary(lib2);
          },
        });
      });
      row.append(nameEl, show, up, down, del);
      poseList.appendChild(row);
    });
  }

  $('pose-save').addEventListener('click', () => {
    const name = $('pose-name').value.trim() || `Slide ${new Date().toLocaleString()}`;
    const lib = loadLibrary();
    const order = loadOrder(lib);
    const isNew = !lib[name];
    lib[name] = app.getCoupleState(name, { view: true });
    // A new slide goes on the end of the deck; re-saving one keeps its place.
    if (isNew) saveOrder([...order, name]);
    saveLibrary(lib);
    $('pose-name').value = '';
    app.status(`Saved the slide “${name}”.`, 'info');
  });

  $('pose-export').addEventListener('click', () => {
    const name = $('pose-name').value.trim() || 'tango-slide';
    const blob = new Blob([JSON.stringify(app.getCoupleState(name, { view: true }), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w\- ]/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('pose-import').addEventListener('click', () => $('pose-file').click());
  $('pose-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const state = JSON.parse(await file.text());
      if (!state.figures) throw new Error('not a pose file');
      app.pushHistory();
      app.applyCoupleState(state);
      const lib = loadLibrary();
      const name = state.name || file.name.replace(/\.json$/i, '');
      const order = loadOrder(lib);
      const isNew = !lib[name];
      lib[name] = state;
      if (isNew) saveOrder([...order, name]);
      saveLibrary(lib);
      app.status(
        state.view
          ? `Loaded the slide “${name}”.`
          : `Loaded “${name}” — a pose-only file, so the view is unchanged.`,
        'info',
      );
    } catch {
      app.status('Could not read that file as a slide or pose.', 'error');
    }
    e.target.value = '';
  });

  renderLibrary();

  // ---------------------------------------------------------------- dancers
  const figCfg = $('figure-config');
  for (const figure of app.figures) {
    const div = document.createElement('div');
    div.className = 'fig-cfg';
    div.innerHTML = `<h3>${figure.name}</h3>
      <div class="row">
        <label>Height <input type="number" class="cfg-h" min="140" max="210" step="1" value="${(figure.height * 100).toFixed(0)}" /> cm</label>
        <label>Weight <input type="number" class="cfg-m" min="35" max="140" step="1" value="${figure.mass}" /> kg</label>
      </div>`;
    div.querySelector('.cfg-h').addEventListener('change', (e) => {
      const cm = Math.min(210, Math.max(140, Number(e.target.value) || figure.height * 100));
      e.target.value = cm;
      if (Math.abs(cm / 100 - figure.height) < 1e-6) return;
      // Snapshot BEFORE the resize: applyCoupleState restores meta.heights, so
      // undo puts the height back too. Without this, Ctrl+Z afterwards replayed
      // the old pose onto the NEW height — a confusing half-undo. markEdit, so
      // the embrace/collision pass knows whose partner should yield to a dancer
      // that just changed size.
      app.pushHistory();
      app.deselect();
      figure.setHeight(cm / 100);
      app.markEdit(figure);
    });
    div.querySelector('.cfg-m').addEventListener('change', (e) => {
      const kg = Math.min(140, Math.max(35, Number(e.target.value) || figure.mass));
      e.target.value = kg;
      figure.mass = kg;
    });
    figCfg.appendChild(div);
  }

  renderJointPanel();

  // ------------------------------------------------------------- slide view
  // Everything a SLIDE carries beyond the pose: the layer and backdrop, the
  // camera, who is on screen, the callouts, the lit parts and muscles.
  //
  // Deliberately NOT part of getCoupleState's default shape. That shape feeds
  // pushHistory, the COG trail and every sequence keyframe — an undo of a
  // joint nudge that also moved the camera would be a bug, and the trail
  // rebuilds state ~289 times per edit, where serialising a label set each
  // pass would be pure waste. main.js asks for this block only for a slide.
  const getViewState = () => ({
    layer: layerMode(),
    backdrop: $('backdrop').value,
    frame: $('frame-mode').value,
    shown: app.shown,
    viz: {
      cog: $('show-cog').checked,
      support: $('show-support').checked,
      couple: $('show-couple-cog').checked,
      dissoc: $('show-dissoc').checked,
    },
    camera: { pos: app.camera.position.toArray(), target: app.orbit.target.toArray() },
    labels: app.labels.toJSON(),
    labelsVisible: $('labels-visible').checked,
    highlight: { parts: [...highlighted], colors: [...(app.highlightColors ?? [])] },
    muscles: {
      hidden: [...hiddenMuscles], lit: [...litMuscles],
      colors: [...muscleColors], tint: Number(muscleTint.value),
    },
  });

  // Put a captured view back. A state with no `view` block is a pose-only file
  // — every slide saved before this existed, plus A/B snapshots and keyframes —
  // so it leaves the view exactly as it is rather than resetting it.
  const applyViewState = (v) => {
    if (!v) return;
    // Selects go back through a dispatched `change`, so every listener runs
    // (the layer note, the muscle note, the studio) instead of just one.
    if (v.layer) chooseLayer(v.layer);
    for (const [id, val] of [['backdrop', v.backdrop], ['frame-mode', v.frame]]) {
      if (!val) continue;
      $(id).value = val;
      $(id).dispatchEvent(new Event('change'));
    }
    if (v.shown) {
      app.setVisibleFigures(v.shown);
      setActive([...document.querySelectorAll('#show-buttons button')], (b) => b.dataset.show === v.shown);
    }
    if (v.viz) {
      $('show-cog').checked = !!v.viz.cog;
      $('show-support').checked = !!v.viz.support;
      $('show-couple-cog').checked = !!v.viz.couple;
      $('show-dissoc').checked = !!v.viz.dissoc;
      syncViz();
    }
    if (Array.isArray(v.labels)) {
      app.labels.fromJSON(v.labels);
      app.labels.onChange?.();
      onLabelsChanged();
    }
    if (typeof v.labelsVisible === 'boolean') {
      $('labels-visible').checked = v.labelsVisible;
      app.setLabelsVisible(v.labelsVisible);
    }
    if (v.highlight) {
      highlighted.clear();
      for (const id of v.highlight.parts ?? []) highlighted.add(id);
      app.setHighlight(highlighted, new Map(v.highlight.colors ?? []));
      highlightClear.disabled = highlighted.size === 0;
      for (const r of chipRows) paintChip(r.chip, r.swatch, r.part);
    }
    if (v.muscles) {
      // A SLIDE replaces the running look outright, so any keyframe override
      // showing is dropped rather than left sitting on top of it. (This is the
      // deliberate difference from a keyframe's own highlighting — see
      // setMuscleOverride: a slide is asked for, a scrub is passed through.)
      takeBackMuscleLook();
      hiddenMuscles.clear();
      for (const m of v.muscles.hidden ?? []) hiddenMuscles.add(m);
      litMuscles.clear();
      for (const m of v.muscles.lit ?? []) litMuscles.add(m);
      // A colour dropped from the slide goes back to the default amber, or a
      // belly recoloured since would keep a colour this slide never had —
      // pushMuscleLook clears by difference, which is that rule.
      muscleColors.clear();
      for (const [label, hex] of v.muscles.colors ?? []) muscleColors.set(label, hex);
      muscleTint.value = v.muscles.tint ?? 100;
      syncMuscleTint();
      app.setMuscleHidden(hiddenMuscles);
      pushMuscleLook();
      saveMuscleLook(); // the slide's look is now the running look
      renderMuscleList();
    }
    if (v.camera?.pos && v.camera?.target) {
      app.camera.position.fromArray(v.camera.pos);
      app.orbit.target.fromArray(v.camera.target);
      app.orbit.update();
    }
    app.requestRender();
  };

  return {
    getViewState,
    applyViewState,
    // A sequence keyframe's own highlighting, and what a keyframe captures.
    // Driven from main.js's applyKeyframeExtras; see setMuscleOverride for why
    // neither one touches the saved running look.
    setMuscleOverride,
    muscleLookNow,
    onPresentChanged: syncPresent,
    // Drive the frame through its own control so the dropdown keeps telling
    // the truth — Present mode forces 16:9, and a select left reading "Fill
    // window" would lie about what a photo or video will contain.
    setFrameMode(frame) {
      const el = $('frame-mode');
      if (!el || el.value === frame) return;
      el.value = frame;
      el.dispatchEvent(new Event('change'));
    },
    onSelectionChanged() {
      renderJointPanel();
      syncJointPicker();
      revealJointPanel();
    },
    onPoseChanged() {
      renderJointPanel();
    },
    onHistoryChanged() {
      undoBtn.disabled = app.history.length === 0;
      redoBtn.disabled = app.redoStack.length === 0;
    },
    // Move-hips mode picked a dancer: mirror its auto-planted feet choice.
    onHipsPlantChanged() {
      plantL.checked = app.hipsPlant.L;
      plantR.checked = app.hipsPlant.R;
    },
    // The elbow hold was switched on or off by something other than its box.
    onElbowsFixedChanged() {
      syncElbowFix();
    },
    // The sequence keyframes changed (add/update/reorder/delete/import).
    onSequenceChanged() {
      renderSequence();
    },
    // The timeline moved onto a DIFFERENT keyframe — a Show, a scrub, or a
    // player crossing into the next one. Only the row marker and the Add
    // button's aim depend on it, so it is a class toggle and nothing more:
    // main.js calls this from applyKeyframeExtras, which runs every frame of a
    // playback, and re-rendering the list there would rebuild every row
    // (and every field in it) sixty times a second.
    onShownKeyframeChanged() {
      markSeqCurrent();
    },
    // A keyframe took the edit focus, or gave it up (✎, Esc, Show, a player,
    // Present, a delete). Everything that says WHICH keyframe is being edited
    // is rebuilt from one place: the row's pressed ✎ (in the list), the banner
    // above it, and the notes in the Muscles panel and the Draw toolbar.
    onSeqFocusChanged() {
      renderSequence();
    },
    // One of the two on-screen texts was dragged to a new spot (or reset, or
    // restored from a file) — the single save point for that placement.
    onSeqTextChanged() {
      saveSeqText();
      syncSeqTextRow();
      syncSeqLibCurrent(); // the placement is part of the bundle, so it can dirty it
    },
    // The ease setting changed — from the checkbox, an import, the fresh
    // default, or a script. Deliberately NOT routed through onSequenceChanged:
    // no keyframe moved, and that hook rebuilds the COG trail (~289 replays of
    // the whole chain) for a setting that provably cannot move it.
    onSeqEaseChanged() {
      saveSeqEase();
      syncSeqEase();
      syncSeqLibCurrent(); // the setting is part of the bundle, so it can dirty it
    },
    // A second tap on the name or caption block in the 3D view: colour the text
    // of the keyframe that is showing (app.pickSeqTextColor found it).
    pickSeqTextColor,
    // A pin was authored, released, or a pending first spot changed.
    onPinsChanged() {
      renderPins();
    },
    // A video capture started or finished: refresh the ⏺ buttons (and the
    // ▶ ones, which a capture locks).
    onRecordingChanged() {
      syncRecordButtons();
    },
    // A player started, was stopped, or reached the end of its chain — from
    // ANY of the paths in main.js's clearPlaying. The button must follow, or
    // it is left offering to stop something that is not running.
    onPlaybackChanged() {
      syncPlayButtons();
    },
    // The scrubbers' own label setters, so a Play with no tick of its own (the
    // Space key, a script) still moves the slider it belongs to.
    seqScrubTo: setSeqLabel,
    interpScrubTo: setInterpLabel,
    // A drawing was added, removed, restyled, re-shaped, hidden or cleared —
    // every mutation lands here, which is what makes this the one save point.
    onDrawingsChanged() {
      syncDrawButtons();
      saveDrawings();
      const n = app.drawings.length;
      if (n !== lastDrawCount) { lastDrawCount = n; renderSequence(); }
      // The diagram is part of a saved sequence, so recolouring a line is
      // unsaved work like any other. renderSequence already ends there when the
      // COUNT moved, so this is the "same drawings, different look" case.
      else syncSeqLibCurrent();
    },
    // A drawing was selected or deselected in the 3D view.
    onDrawSelectionChanged() {
      syncDrawButtons();
      syncDrawStyle();
    },
    // A COG line was selected/deselected in the 3D view, or restyled.
    onCogLineChanged: syncCogLine,
    // A label was added, removed, flipped or cleared.
    onLabelsChanged,
    // A lit muscle was clicked in the 3D view, or a callout double-clicked:
    // open the colour picker under the cursor.
    pickMuscleColor,
    pickLabelColor,
    refreshJointValues,
    updateStats,
  };
}
