import * as THREE from 'three';
import { JOINT_BY_NAME, JOINT_TITLES, BODY_PARTS } from './skeletonDef.js';
import { keyAngles, tangoStats, convexHull2D, stabilityMargin } from './analysis.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const STORAGE_KEY = 'tangoPoseStudio.poses.v1';

const AXIS_FALLBACK = { x: 'Forward / back', y: 'Twist', z: 'Side' };

// Open vs. closed chain is only offered for the legs/pelvis (the joints with a
// foot to plant); arms and the spine are always open chain.
const CHAIN_JOINTS = new Set([
  'pelvis', 'hip_L', 'knee_L', 'ankle_L', 'toes_L', 'hip_R', 'knee_R', 'ankle_R', 'toes_R',
]);

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
  const modeButtons = [...document.querySelectorAll('#mode-buttons button')];
  const hipsPlantBox = $('hips-plant');
  const selectMode = (mode) => {
    setActive(modeButtons, (b) => b.dataset.mode === mode);
    app.setMode(mode);
    // The planted-feet choice only exists while moving the hips.
    hipsPlantBox.hidden = mode !== 'hips';
  };
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => selectMode(btn.dataset.mode));
  }

  // Move-hips planted feet: auto-set from floor contact when a dancer is
  // picked (app.selectFigure → onHipsPlantChanged), user-overridable here.
  const plantL = $('plant-L');
  const plantR = $('plant-R');
  plantL.addEventListener('change', () => { app.hipsPlant.L = plantL.checked; });
  plantR.addEventListener('change', () => { app.hipsPlant.R = plantR.checked; });

  // Collapsible sidebar sections: clicking a heading folds it away.
  for (const section of document.querySelectorAll('#sidebar section')) {
    const h2 = section.querySelector('h2');
    if (!h2) continue;
    h2.classList.add('collapse-toggle');
    h2.addEventListener('click', () => section.classList.toggle('collapsed'));
  }

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
  // The clasp tilt/height/elbow sliders only matter with the arm frame held.
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
  // Open-side elbow swivel per dancer (alternative embrace model): swings the
  // elbow between the joined hands without moving either hand.
  for (const role of ['leader', 'follower']) {
    const slider = $(`embrace-elbow-${role}`);
    const val = $(`embrace-elbow-${role}-val`);
    slider.addEventListener('input', () => {
      val.textContent = `${slider.value}°`;
      app.setOpenElbow(role, Number(slider.value));
    });
  }

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
  for (const btn of document.querySelectorAll('#view-buttons button')) {
    btn.addEventListener('click', () => app.setView(btn.dataset.view));
  }
  $('photo-btn').addEventListener('click', () => app.capturePhoto());

  // ---------------------------------------------------------------- layers
  const syncLayers = () => {
    const layers = {
      skeleton: $('layer-skeleton').checked,
      body: $('layer-body').checked,
      muscle: $('layer-muscle').checked,
    };
    app.figures.forEach((f) => f.setLayers(layers));
  };
  ['layer-skeleton', 'layer-body', 'layer-muscle'].forEach((id) => $(id).addEventListener('change', syncLayers));

  const syncViz = () => app.setViz({
    cog: $('show-cog').checked,
    support: $('show-support').checked,
    couple: $('show-couple-cog').checked,
    dissoc: $('show-dissoc').checked,
  });
  ['show-cog', 'show-support', 'show-couple-cog', 'show-dissoc'].forEach((id) => $(id).addEventListener('change', syncViz));

  // ---------------------------------------------------------------- pins
  // Contact pins (see pins.js): the list mirrors app.pins; authoring happens
  // in the 3D view via the Pin-spots mode.
  const pinList = $('pin-list');
  const pinClear = $('pin-clear');
  const endName = (end) => JOINT_TITLES[end.node] || end.node;

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
    }
    pinClear.disabled = !n;
  }
  pinClear.addEventListener('click', () => app.clearPins());
  renderPins();

  // ---------------------------------------------------------------- highlight
  const highlightChips = $('highlight-chips');
  const highlightClear = $('highlight-clear');
  const highlighted = new Set();

  const syncHighlight = () => {
    app.setHighlight(highlighted);
    highlightClear.disabled = highlighted.size === 0;
  };
  for (const part of BODY_PARTS) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = part.title;
    chip.addEventListener('click', () => {
      if (highlighted.has(part.id)) highlighted.delete(part.id);
      else highlighted.add(part.id);
      chip.classList.toggle('active', highlighted.has(part.id));
      syncHighlight();
    });
    highlightChips.appendChild(chip);
  }
  highlightClear.addEventListener('click', () => {
    highlighted.clear();
    highlightChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    syncHighlight();
  });

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
  const syncMuscleNote = () => { muscleLayerNote.hidden = $('layer-muscle').checked; };
  $('layer-muscle').addEventListener('change', syncMuscleNote);
  $('muscle-enable-layer').addEventListener('click', () => {
    $('layer-muscle').checked = true;
    syncLayers();
    syncMuscleNote();
  });
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

    // Legs/pelvis get the open/closed chain choice (defaulted by app.selectJoint
    // from whether the foot is planted); everything else is always open chain.
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

    const reset = document.createElement('button');
    reset.textContent = 'Reset this joint';
    reset.addEventListener('click', () => {
      app.pushHistory();
      app.editJoint(figure, jointName, () => {
        node.rotation.set(0, 0, 0);
        if (jointName === 'pelvis') node.position.y = 0.53 * figure.height;
      });
      refreshJointValues();
    });
    jointPanel.appendChild(reset);
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
          <div class="stat-line"><span>Chest distance</span><span class="v">${(chestSep * 100).toFixed(1)} cm</span></div>
          <div class="stat-line"><span>Open-side hands</span><span class="v">${handLine}</span></div>
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
    const corner = (node, [x, y, z]) => {
      const p = node.localToWorld(_fmV.set(x * H, y * H, z * H));
      return { x: p.x, z: p.z };
    };
    const pts = [
      corner(ankleNode, fc[0]), corner(ankleNode, fc[1]), corner(ankleNode, fc[2]),
      corner(toesNode, tc[0]), corner(toesNode, tc[1]), corner(ankleNode, fc[3]),
    ];
    const cog = { x: rep.cog.x, z: rep.cog.z };
    const margin = stabilityMargin(cog, convexHull2D(pts));

    // 2D frame: v runs heel→toe (drawn upward), u lateral. Falls back to the
    // figure's facing when the foot points straight down.
    const A = figure.worldPos(`ankle_${side}`, _fmV.clone());
    const T = figure.worldPos(`toe_${side}`, _fmW.clone());
    let fx = T.x - A.x;
    let fz = T.z - A.z;
    const fLen = Math.hypot(fx, fz);
    if (fLen < 0.05 * H) {
      const f = _fmW.set(0, 0, 1).applyQuaternion(figure.group.quaternion);
      fx = f.x; fz = f.z;
    }
    const fn = Math.hypot(fx, fz) || 1;
    fx /= fn; fz /= fn;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    const toUV = (p) => ({
      u: (p.x - cx) * fz - (p.z - cz) * fx,
      v: (p.x - cx) * fx + (p.z - cz) * fz,
    });
    const uvPts = pts.map(toUV);
    const uvCog = toUV(cog);

    // Fit foot + COG in view; the foot never smaller than half the canvas.
    let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
    for (const p of [...uvPts, uvCog]) {
      minU = Math.min(minU, p.u); maxU = Math.max(maxU, p.u);
      minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v);
    }
    const pad = 22;
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

    // Foot outline: smooth closed curve through the corners (midpoint quads).
    const col = fmFig === 'leader' ? '#7fb3e8' : '#e89ab8';
    const P = uvPts.map(px);
    ctx.beginPath();
    const mid = (a2, b2) => ({ x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 });
    let m0 = mid(P[P.length - 1], P[0]);
    ctx.moveTo(m0.x, m0.y);
    for (let i = 0; i < P.length; i++) {
      const m1 = mid(P[i], P[(i + 1) % P.length]);
      ctx.quadraticCurveTo(P[i].x, P[i].y, m1.x, m1.y);
    }
    ctx.closePath();
    ctx.fillStyle = `${col}2e`;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();

    // Ball line (where the toes flex) and heel/toe labels.
    ctx.strokeStyle = `${col}88`;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(P[2].x, P[2].y);
    ctx.lineTo(P[5].x, P[5].y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    const heelMid = mid(P[0], P[1]);
    const toeMid = mid(P[3], P[4]);
    ctx.fillText('heel', heelMid.x, Math.min(heelMid.y + 12, cssH - 4));
    ctx.fillText('toe', toeMid.x, Math.max(toeMid.y - 6, 9));

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
    const cm = margin === null ? null : Math.abs(margin * 100).toFixed(1);
    fmNote.textContent = margin === null
      ? `${figure.name} · ${side === 'L' ? 'left' : 'right'} foot`
      : `${figure.name} · ${side === 'L' ? 'left' : 'right'} foot — COG ${cm} cm ${ok ? `inside, ${zone}` : 'outside the foot'}`;
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

  // Both ⏺ buttons: armed when their chain can play, locked while a capture runs.
  function syncRecordButtons() {
    const busy = !!app.recording;
    interpRecord.disabled = busy || !(snaps.A && snaps.B);
    seqRecord.disabled = busy || app.seqStates.length < 2;
    interpRecord.textContent = busy ? '⏺ Recording…' : '⏺ Record';
    seqRecord.textContent = busy ? '⏺ Recording…' : '⏺ Record video';
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
  seqClear.addEventListener('click', () => app.setSeqStates([]));

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
      app.setSeqStates(states);
    } catch {
      alert('Could not read that file as a sequence.');
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
    renderLibrary();
  }
  function renderLibrary() {
    const lib = loadLibrary();
    const names = Object.keys(lib).sort();
    poseList.innerHTML = names.length ? '' : '<span class="muted">No saved poses yet.</span>';
    for (const name of names) {
      const row = document.createElement('div');
      row.className = 'pose-item';
      row.innerHTML = `<span class="name">${name}</span>`;
      const load = document.createElement('button');
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        app.pushHistory();
        app.applyCoupleState(lib[name]);
      });
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete';
      del.addEventListener('click', () => {
        const l = loadLibrary();
        delete l[name];
        saveLibrary(l);
      });
      row.append(load, del);
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
      alert('Could not read that file as a pose.');
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
      app.deselect();
      figure.setHeight(cm / 100);
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
    refreshJointValues,
    updateStats,
  };
}
