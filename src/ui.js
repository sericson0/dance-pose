import { JOINTS, JOINT_BY_NAME, JOINT_TITLES, BODY_PARTS } from './skeletonDef.js';
import { keyAngles, tangoStats } from './analysis.js';

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
  const selectMode = (mode) => {
    setActive(modeButtons, (b) => b.dataset.mode === mode);
    app.setMode(mode);
  };
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => selectMode(btn.dataset.mode));
  }

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
  });
  ['show-cog', 'show-support', 'show-couple-cog'].forEach((id) => $(id).addEventListener('change', syncViz));

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

  // Joint picker: jump straight to any joint (they're invisible click targets in
  // body view) without hunting in 3D. A Leader/Follower toggle chooses the dancer.
  const jointSelect = $('joint-select');
  const figToggleBtns = [...document.querySelectorAll('#joint-fig-toggle button')];
  const figureForRole = (role) => (role === 'follower' ? app.follower : app.leader);
  const activePickerRole = () =>
    figToggleBtns.find((b) => b.classList.contains('active'))?.dataset.role || 'leader';

  {
    const groups = { center: [], L: [], R: [] };
    for (const def of JOINTS) {
      if (def.endpoint || !JOINT_TITLES[def.name]) continue;
      const key = def.name.endsWith('_L') ? 'L' : def.name.endsWith('_R') ? 'R' : 'center';
      groups[key].push(def);
    }
    const addGroup = (label, defs) => {
      if (!defs.length) return;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const def of defs) {
        const opt = document.createElement('option');
        opt.value = def.name;
        // Keep the full "Left / Right …" title so the closed select stays
        // unambiguous; the optgroup label just aids scanning the open list.
        opt.textContent = JOINT_TITLES[def.name] || def.name;
        og.appendChild(opt);
      }
      jointSelect.appendChild(og);
    };
    addGroup('Spine & head', groups.center);
    addGroup('Left side', groups.L);
    addGroup('Right side', groups.R);
  }

  const pickJoint = (role) => {
    const jointName = jointSelect.value; // capture first: selectMode deselects,
    if (!jointName) return;              // which resets the dropdown via syncJointPicker
    selectMode('rotate'); // the picker poses a joint, so switch to the rotate gizmo
    app.selectJoint(figureForRole(role), jointName);
  };
  jointSelect.addEventListener('change', () => {
    if (!jointSelect.value) { app.deselect(); return; }
    pickJoint(activePickerRole());
  });
  figToggleBtns.forEach((btn) => btn.addEventListener('click', () => {
    setActive(figToggleBtns, (b) => b === btn);
    pickJoint(btn.dataset.role); // re-select the same joint on the chosen dancer
  }));

  // Keep the picker in step with joints selected by clicking in the 3D view.
  function syncJointPicker() {
    if (app.selected) {
      jointSelect.value = app.selected.jointName;
      const role = app.selected.figure === app.follower ? 'follower' : 'leader';
      setActive(figToggleBtns, (b) => b.dataset.role === role);
    } else {
      jointSelect.value = '';
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

  // The scrubber, play button, and COG path all need both snapshots.
  function syncInterp() {
    const ready = !!(snaps.A && snaps.B);
    app.setInterpStates(snaps.A, snaps.B);
    interpRow.hidden = !ready;
    interpPlay.disabled = !ready;
    app.setPathVisible(ready && showPath.checked);
  }
  showPath.addEventListener('change', () => {
    app.setPathVisible(!!(snaps.A && snaps.B) && showPath.checked);
  });

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
    refreshJointValues,
    updateStats,
  };
}
