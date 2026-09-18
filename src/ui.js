import * as THREE from 'three';
import { JOINT_BY_NAME, JOINT_TITLES, BODY_PARTS, FLOOR_CONTACT_FRAC } from './skeletonDef.js';
import { keyAngles, tangoStats, convexHull2D, stabilityMargin } from './analysis.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const STORAGE_KEY = 'tangoPoseStudio.poses.v1';

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
    draw: 'Pick a shape, then click two points on the floor (Text: one click, then type) · Esc cancels a half-drawn shape',
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
    hipsPlantBox.hidden = app.mode !== 'hips' || app.hipsTool === 'twist';
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
  drawUndo.addEventListener('click', () => app.removeLastDrawing());
  drawClear.addEventListener('click', () => app.clearDrawings());
  const syncDrawButtons = () => {
    const empty = app.drawings.length === 0;
    drawUndo.disabled = empty;
    drawClear.disabled = empty;
  };
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
  clipScrub.addEventListener('input', () => app.scrubClip(Number(clipScrub.value) / 1000));

  function syncClip() {
    const clip = app.studio.clip;
    const busy = app.studio.busy;
    $('clip-scrub-row').hidden = !clip;
    clipPlay.disabled = !clip || busy;
    clipRecord.disabled = !clip || busy || !app.canRecord;
    if (!app.canRecord) clipRecord.title = NO_RECORDER_TITLE;
    clipExit.disabled = !clip || busy;
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
  const hiddenMuscles = new Set();
  const litMuscles = new Set();

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
        });
        lbl.append(cb, document.createTextNode(` ${label}`));
        const hl = document.createElement('button');
        hl.className = 'chip muscle-hl';
        hl.textContent = 'highlight';
        hl.title = 'Highlight this muscle';
        hl.classList.toggle('active', litMuscles.has(label));
        hl.addEventListener('click', () => {
          if (litMuscles.has(label)) litMuscles.delete(label); else litMuscles.add(label);
          hl.classList.toggle('active', litMuscles.has(label));
          app.setMuscleLit(litMuscles);
          muscleClearHl.disabled = litMuscles.size === 0;
        });
        row.append(lbl, hl);
        group.appendChild(row);
      }
      muscleList.appendChild(group);
    }
  }

  $('muscle-show-all').addEventListener('click', () => {
    hiddenMuscles.clear();
    app.setMuscleHidden(hiddenMuscles);
    renderMuscleList();
  });
  $('muscle-hide-all').addEventListener('click', () => {
    for (const m of (app.muscles || [])) hiddenMuscles.add(m.label);
    app.setMuscleHidden(hiddenMuscles);
    renderMuscleList();
  });
  muscleClearHl.addEventListener('click', () => {
    litMuscles.clear();
    app.setMuscleLit(litMuscles);
    muscleClearHl.disabled = true;
    renderMuscleList();
  });

  // The panel only shows through the Muscles layer — nudge the user to enable it.
  const syncMuscleNote = () => { muscleLayerNote.hidden = layerMode() === 'muscle'; };
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
    const dpr = window.devicePixelRatio || 1;
    const cssW = fmCanvas.clientWidth || 296;
    const cssH = fmCanvas.clientHeight || 175;
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
    interpPlay.disabled = !ready;
    syncRecordButtons();
    syncPath();
  }

  const setInterpLabel = (t) => {
    interpSlider.value = Math.round(t * 1000);
    interpVal.textContent = `${Math.round(t * 100)}%`;
  };
  pushHistoryOnEdit(interpSlider);
  interpSlider.addEventListener('input', () => {
    const t = Number(interpSlider.value) / 1000;
    app.applyInterp(t);
    interpVal.textContent = `${Math.round(t * 100)}%`;
  });
  interpPlay.addEventListener('click', () => {
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
  const seqList = $('seq-list');
  const seqRow = $('seq-row');
  const seqSlider = $('seq-slider');
  const seqVal = $('seq-val');
  const seqPlay = $('seq-play');
  const seqRecord = $('seq-record');
  const seqClear = $('seq-clear');
  const seqExport = $('seq-export');
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
  }

  const setSeqLabel = (t) => {
    seqSlider.value = Math.round(t * 1000);
    seqVal.textContent = `${Math.round(t * 100)}%`;
  };
  pushHistoryOnEdit(seqSlider);
  seqSlider.addEventListener('input', () => {
    const t = Number(seqSlider.value) / 1000;
    app.applySeqT(t);
    seqVal.textContent = `${Math.round(t * 100)}%`;
  });
  seqPlay.addEventListener('click', () => {
    app.pushHistory();
    app.playSeq(setSeqLabel);
  });
  seqRecord.addEventListener('click', () => {
    app.pushHistory();
    app.recordPlayback(app.seqStates, 'tangle-sequence');
  });
  $('seq-add').addEventListener('click', () => app.seqAdd());
  // Clearing destroys every keyframe AND the localStorage copy in one click,
  // and the undo stack holds couple poses only, so nothing can bring them back.
  // Ask — but only when there is something to lose.
  seqClear.addEventListener('click', () => {
    const n = app.seqStates.length;
    if (n && !window.confirm(`Delete all ${n} keyframe${n === 1 ? '' : 's'}? This also clears the saved copy and cannot be undone.`)) return;
    app.setSeqStates([]);
    if (n) app.status(`Deleted ${n} keyframe${n === 1 ? '' : 's'}.`, 'info');
  });

  function renderSequence() {
    const n = app.seqStates.length;
    seqList.innerHTML = n ? ''
      : '<span class="muted">No keyframes yet — pose the couple and add one.</span>';
    app.seqStates.forEach((state, i) => {
      const row = document.createElement('div');
      row.className = 'pose-item';
      row.innerHTML = `<span class="name">${i + 1}</span>`;
      const btn = (label, title, fn, disabled = false) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', fn);
        row.appendChild(b);
      };
      btn('Show', 'Jump the couple to this keyframe', () => app.seqApply(i));
      btn('⟳', 'Overwrite this keyframe with the current pose', () => app.seqUpdate(i));
      btn('↑', 'Play this keyframe earlier', () => app.seqMove(i, -1), i === 0);
      btn('↓', 'Play this keyframe later', () => app.seqMove(i, 1), i === n - 1);
      btn('✕', 'Delete this keyframe', () => app.seqDelete(i));
      seqList.appendChild(row);
    });
    seqRow.hidden = n < 2;
    seqPlay.disabled = n < 2;
    seqClear.disabled = n === 0;
    seqExport.disabled = n < 2;
    syncRecordButtons();
    syncPath();
    try { localStorage.setItem(SEQ_KEY, JSON.stringify(app.seqStates)); } catch { /* storage full */ }
  }

  seqExport.addEventListener('click', () => {
    const payload = { app: 'tangle', type: 'sequence', version: 1, states: app.seqStates };
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
      // An import REPLACES whatever is on the timeline. The pose import right
      // below this one has always taken a history snapshot first; this one did
      // not, which made the two inconsistent in the same file.
      const had = app.seqStates.length;
      if (had && !window.confirm(`Replace the current ${had} keyframe${had === 1 ? '' : 's'} with the ${states.length} in this file?`)) {
        e.target.value = '';
        return;
      }
      app.pushHistory();
      app.setSeqStates(states);
      app.status(`Loaded ${states.length} keyframes.`, 'info');
    } catch {
      app.status('Could not read that file as a sequence.', 'error');
    }
    e.target.value = '';
  });

  // Restore the previous session's sequence (before the first render below).
  try {
    const saved = JSON.parse(localStorage.getItem(SEQ_KEY));
    if (Array.isArray(saved) && saved.length && saved.every((s) => s && s.figures)) {
      app.setSeqStates(saved);
    }
  } catch { /* corrupted storage: start empty */ }
  renderSequence();

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
  function renderLibrary() {
    const lib = loadLibrary();
    const names = Object.keys(lib).sort();
    poseList.innerHTML = names.length ? '' : '<span class="muted">No saved poses yet.</span>';
    for (const name of names) {
      const row = document.createElement('div');
      row.className = 'pose-item';
      // textContent, never innerHTML: the name is free text from the Save field
      // or `state.name` inside an imported JSON pose file, so interpolating it
      // into markup runs whatever a third-party file cares to put there.
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = name;
      const load = document.createElement('button');
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        app.pushHistory();
        app.applyCoupleState(lib[name]);
      });
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete this saved pose';
      del.addEventListener('click', () => {
        const l = loadLibrary();
        const removed = l[name];
        delete l[name];
        saveLibrary(l);
        // A saved pose is not pose STATE, so Ctrl+Z cannot bring it back — it
        // would restore the couple and leave the library entry gone. Offer the
        // recovery where the loss happened instead of a dialog beforehand.
        app.status(`Deleted the saved pose “${name}”.`, 'info', {
          label: 'Undo',
          run: () => {
            const lib2 = loadLibrary();
            lib2[name] = removed;
            saveLibrary(lib2);
          },
        });
      });
      row.append(nameEl, load, del);
      poseList.appendChild(row);
    }
  }

  $('pose-save').addEventListener('click', () => {
    const name = $('pose-name').value.trim() || `Pose ${new Date().toLocaleString()}`;
    const lib = loadLibrary();
    lib[name] = app.getCoupleState(name);
    saveLibrary(lib);
    $('pose-name').value = '';
  });

  $('pose-export').addEventListener('click', () => {
    const name = $('pose-name').value.trim() || 'tango-pose';
    const blob = new Blob([JSON.stringify(app.getCoupleState(name), null, 2)], { type: 'application/json' });
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
      lib[state.name || file.name.replace(/\.json$/i, '')] = state;
      saveLibrary(lib);
    } catch {
      app.status('Could not read that file as a pose.', 'error');
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

  return {
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
    // The sequence keyframes changed (add/update/reorder/delete/import).
    onSequenceChanged() {
      renderSequence();
    },
    // A pin was authored, released, or a pending first spot changed.
    onPinsChanged() {
      renderPins();
    },
    // A video capture started or finished: refresh the ⏺ buttons.
    onRecordingChanged() {
      syncRecordButtons();
    },
    // A drawing was added, removed, or cleared.
    onDrawingsChanged: syncDrawButtons,
    // A label was added, removed, flipped or cleared.
    onLabelsChanged,
    refreshJointValues,
    updateStats,
  };
}
