// The movement-clip library: every joint movement a clip can play is ONE ROW
// here (see studio.js for the player). Rows are authored for the LEFT side in
// the rig's own sign conventions (skeletonDef.js / presets.js); playing the
// RIGHT side negates every y and z target, which mirrors sided joints across
// the sagittal plane and — deliberately — also turns a central joint's "to the
// left" movement (side bend, rotation) into "to the right".
//
//   drive   joints the clip animates: [{ joint, axis, to }] in degrees, lerped
//           from the neutral/base value to `to`. A limb BASE ('shoulder') takes
//           the clip's side; a full name ('hip_R', 'chest') is literal. The
//           FIRST entry is the primary joint: the angle arc, the plane and the
//           axis of motion are drawn on it.
//   complex the arm-on-trunk total that several drives in ONE plane SHARE (see
//           sh_abd, the scapulohumeral rhythm). Coupled joints add, so the
//           total has to be stated somewhere a check can read it: the drives
//           must sum to it, and it must fit the primary joint's own limits,
//           which is where this rig keeps complex ROM.
//   base    extra joint angles held through the clip on top of NEUTRAL — the
//           test position (elbow at 90° to show shoulder rotation, the foot
//           lifted clear of the floor for ankle work).
//   marker  what visibly sweeps, measured for the angle readout: [from, to]
//           joints (default: primary joint → its distal joint; both must be
//           real joints, not the hand/toe ENDPOINTS, which have no seat on the
//           visible skeleton and would mix two frames) or
//           { node, axis } — a local axis of a node, for twists whose segment
//           does not change direction (pronation, trunk rotation).
//   center  joint the arc is drawn on (default: the primary joint).
//   axisFig figure-frame axis override ('x' | 'y' | 'z') for movements whose
//           visible rotation is not the primary joint's own axis (a relevé
//           turns about the ball of the foot, not the ankle).
//   plane   the anatomical plane the movement is DESCRIBED in (the caption).
//           The drawn plane is always the real one, perpendicular to the axis.
//   from    'back' to film a frontal-plane movement from behind (posterior
//           movers); default is from the front.
//   frame   which joints the auto-framed camera keeps in shot (a FRAMES key).
//   movers  prime movers, by the muscle atlas labels (the Muscles panel names).
//           A string is one belly labelled as itself; an array is
//           [callout text, ...bellies] — several heads under one callout.
//   pair    the opposite movement, for the "full sweep" pattern.
//   floor   'dissoc' shows the hip/shoulder-axis floor wedge during the clip.

export const NEUTRAL = {
  // The arm rig rests ~9° abducted (it sits on the atlas joint centres); bring
  // it in to hang at the side so every arm movement starts from anatomical zero.
  shoulder_L: { z: -9 }, shoulder_R: { z: 9 },
};

export const PLANES = {
  sagittal: { title: 'Sagittal plane', axis: 'Mediolateral axis', color: 0xe0645f },
  frontal: { title: 'Frontal plane', axis: 'Anteroposterior axis', color: 0x5b9bd5 },
  transverse: { title: 'Transverse plane', axis: 'Longitudinal axis', color: 0x5fce7f },
};

// Joints the auto-frame keeps in shot. Limb bases take the clip's side.
export const FRAMES = {
  arm: ['headTop', 'pelvis', 'shoulder_L', 'shoulder_R', 'shoulder', 'elbow', 'wrist', 'hand'],
  forearm: ['shoulder', 'elbow', 'wrist', 'hand'],
  leg: ['chest', 'pelvis', 'hip', 'knee', 'ankle', 'toe', 'ankle_L', 'ankle_R'],
  foot: ['knee', 'ankle', 'toes', 'toe'],
  trunk: ['headTop', 'pelvis', 'shoulder_L', 'shoulder_R', 'knee_L', 'knee_R'],
  neck: ['headTop', 'head', 'neck', 'chest', 'shoulder_L', 'shoulder_R'],
  body: ['headTop', 'pelvis', 'shoulder_L', 'shoulder_R', 'toe_L', 'toe_R', 'ankle_L', 'ankle_R'],
};

// Test positions.
const ELBOW_90 = { elbow: { x: -71 } };             // rest already bends 19°
const FOOT_UP = { hip: { x: -55 }, knee: { x: 65 } }; // foot clear of the floor

// The biceps acts on the elbow THROUGH its common tendon, for the same reason
// the quadriceps and the calf do: both heads stop ~26 mm short of the forearm,
// so they ride the humerus and only the tendon crosses (see the `elbow` group in
// MUSCLE_INSERT). Without the tendon in the callout an elbow row would highlight
// only the half that cannot move there.
const BICEPS = ['Biceps brachii', 'Long head of biceps brachii', 'Short head of biceps brachii',
  'Common tendon of biceps brachii'];
const TRICEPS = ['Triceps brachii', 'Long head of triceps brachii', 'Lateral head of triceps brachii', 'Medial head of triceps brachii'];
// The thigh groups act on the KNEE through their tendons, in the same way the
// calf acts on the ankle through the Achilles: the bellies stop well short of
// the joint line (the quadriceps by 66-81 mm, measured), so they ride the femur
// and only the tendon crosses. A knee callout therefore has to cover the whole
// muscle-tendon unit or it highlights only the half that cannot move there.
const PES = 'Pes anserinus common tendon';
const HAMSTRINGS = ['Hamstrings', 'Long head of biceps femoris', 'Semitendinosus', 'Semimembranosus', 'Short head of biceps femoris'];
const HAMSTRINGS_KNEE = [...HAMSTRINGS, 'Common tendon of biceps femoris', 'Semimembranosus muscle tendon', PES];
const QUADS = ['Quadriceps', 'Rectus femoris', 'Vastus lateralis', 'Vastus medialis', 'Vastus intermedius'];
const QUADS_KNEE = [...QUADS, 'Quadriceps common tendon and patellar ligament'];
// The calf acts on the ankle THROUGH its tendon: the bellies now ride the femur
// and cross the knee (their real origin), and the Achilles spans the ankle, so
// the callout has to cover the whole muscle-tendon unit or an ankle clip would
// highlight only the half that cannot move there.
const GASTROC = ['Gastrocnemius', 'Lateral head of gastrocnemius', 'Medial head of gastrocnemius',
  'Calcaneal tendon'];
// The soleus is the other half of the triceps surae and needs the same
// treatment for the same reason: it stops 85 mm short of the ankle, so it rides
// the shank rigidly and the Achilles carries it across (see the `ankle` group in
// MUSCLE_INSERT). Naming the tendon here is what keeps this callout pointing at
// something that can move. The callout still reads "Soleus" and still anchors on
// the soleus belly — `applyMovers` hangs it on the first named belly that
// resolves — so the tendon only joins the lit set, where GASTROC already puts it.
const SOLEUS = ['Soleus', 'Soleus', 'Calcaneal tendon'];
const ILIOPSOAS = ['Iliopsoas', 'Iliacus', 'Psoas major'];
const ADDUCTORS = ['Adductors', 'Adductor longus', 'Adductor magnus', 'Adductor brevis'];
const RHOMBOIDS = ['Rhomboids', 'Rhomboid major', 'Rhomboid minor'];
const OBLIQUES = ['External abdominal oblique', 'Internal abdominal oblique'];

export const MOVEMENTS = [
  // ------------------------------------------------------------ shoulder
  { id: 'sh_flex', group: 'Shoulder', title: 'Shoulder flexion', plane: 'sagittal', frame: 'arm', pair: 'sh_ext',
    drive: [{ joint: 'shoulder', axis: 'x', to: -170 }],
    movers: [['Deltoid (anterior)', 'Deltoid'], 'Pectoralis major', 'Coracobrachialis', BICEPS] },
  { id: 'sh_ext', group: 'Shoulder', title: 'Shoulder extension', plane: 'sagittal', frame: 'arm', pair: 'sh_flex',
    drive: [{ joint: 'shoulder', axis: 'x', to: 45 }],
    movers: ['Latissimus dorsi', 'Teres major', ['Deltoid (posterior)', 'Deltoid'], ['Triceps (long head)', 'Long head of triceps brachii']] },
  // SCAPULOHUMERAL RHYTHM — the one row that drives two joints in ONE plane.
  // The arm does not reach overhead on the glenohumeral joint alone: past the
  // first ~30° the scapula upwardly rotates to supply roughly a third of the
  // elevation, which is why this row names the trapezius and the serratus at
  // all. Over a motionless scapula they were named and did nothing visible.
  // The coupling SPLITS the 170° rather than adding to it, because the 170 is
  // the ARM-ON-TRUNK total: this rig deliberately keeps complex ROM on the
  // shoulder's own limits rather than glenohumeral-only (docs/rom-research.md).
  // Driving the scapula on TOP of a 170° shoulder carries the arm 190°, past
  // the vertical and down the far side — measured, and the reason an earlier
  // attempt at this row read as moving the wrong way. `complex` states the
  // shared total, so the table is checked against itself (movements.test.js)
  // and the played readout against the table (dev-verify-studio.mjs).
  // Three honest simplifications. The rig's scapula pivots at the STERNO-
  // CLAVICULAR joint, so its `z` lumps clavicular elevation in with scapular
  // upward rotation; both joints lerp from 0, spending the girdle's share
  // evenly instead of holding it back through the setting phase; and 20° of a
  // 170° total is well short of the real ~2:1 rhythm (the rig's scapula `z`
  // stops at 25°, and pinning a target to a limit is how ranges silently go
  // stale). This is the rhythm made visible, not a measured ratio.
  // Only ABDUCTION is coupled: in the frontal plane the scapula turns about the
  // same axis the shoulder does, so the two angles simply add. In the sagittal
  // plane (sh_flex) that axis is skew to the motion, so the same shrug would
  // tilt the humerus out of the measured plane — corrupting the readout for a
  // movement the camera barely sees.
  { id: 'sh_abd', group: 'Shoulder', title: 'Shoulder abduction', plane: 'frontal', frame: 'arm', pair: 'sh_add',
    complex: 170,
    drive: [{ joint: 'shoulder', axis: 'z', to: 150 }, { joint: 'scapula', axis: 'z', to: 20 }],
    movers: [['Deltoid (middle)', 'Deltoid'], 'Supraspinatus', 'Trapezius', 'Serratus anterior'] },
  { id: 'sh_add', group: 'Shoulder', title: 'Shoulder adduction', plane: 'frontal', frame: 'arm', pair: 'sh_abd',
    base: { shoulder: { x: -25 } }, // a little forward, so the arm crosses in front of the body
    drive: [{ joint: 'shoulder', axis: 'z', to: -30 }],
    movers: ['Pectoralis major', 'Latissimus dorsi', 'Teres major'] },
  { id: 'sh_ir', group: 'Shoulder', title: 'Shoulder internal rotation', plane: 'transverse', frame: 'arm', pair: 'sh_er',
    base: ELBOW_90, marker: ['elbow', 'wrist'],
    drive: [{ joint: 'shoulder', axis: 'y', to: -70 }],
    movers: ['Subscapularis', 'Pectoralis major', 'Latissimus dorsi', 'Teres major'] },
  { id: 'sh_er', group: 'Shoulder', title: 'Shoulder external rotation', plane: 'transverse', frame: 'arm', pair: 'sh_ir',
    base: ELBOW_90, marker: ['elbow', 'wrist'],
    drive: [{ joint: 'shoulder', axis: 'y', to: 80 }],
    movers: ['Infraspinatus', 'Teres minor', ['Deltoid (posterior)', 'Deltoid']] },
  { id: 'sh_hadd', group: 'Shoulder', title: 'Horizontal adduction', plane: 'transverse', frame: 'arm', pair: 'sh_habd',
    base: { shoulder: { z: 90 } },
    drive: [{ joint: 'shoulder', axis: 'y', to: -80 }],
    movers: ['Pectoralis major', ['Deltoid (anterior)', 'Deltoid'], 'Coracobrachialis'] },
  { id: 'sh_habd', group: 'Shoulder', title: 'Horizontal abduction', plane: 'transverse', frame: 'arm', pair: 'sh_hadd',
    base: { shoulder: { z: 90 } },
    drive: [{ joint: 'shoulder', axis: 'y', to: 35 }],
    movers: [['Deltoid (posterior)', 'Deltoid'], 'Infraspinatus', 'Teres minor'] },

  // ------------------------------------------------------ shoulder girdle
  { id: 'sc_elev', group: 'Shoulder girdle', title: 'Scapular elevation', plane: 'frontal', frame: 'arm', from: 'back', pair: 'sc_dep',
    marker: ['scapula', 'shoulder'],
    drive: [{ joint: 'scapula', axis: 'z', to: 25 }],
    movers: [['Trapezius (upper)', 'Trapezius'], RHOMBOIDS] },
  { id: 'sc_dep', group: 'Shoulder girdle', title: 'Scapular depression', plane: 'frontal', frame: 'arm', from: 'back', pair: 'sc_elev',
    marker: ['scapula', 'shoulder'],
    drive: [{ joint: 'scapula', axis: 'z', to: -12 }],
    movers: [['Trapezius (lower)', 'Trapezius'], 'Pectoralis minor', 'Latissimus dorsi'] },
  { id: 'sc_pro', group: 'Shoulder girdle', title: 'Scapular protraction', plane: 'transverse', frame: 'arm', pair: 'sc_ret',
    marker: ['scapula', 'shoulder'],
    drive: [{ joint: 'scapula', axis: 'y', to: -25 }],
    movers: ['Serratus anterior', 'Pectoralis minor'] },
  { id: 'sc_ret', group: 'Shoulder girdle', title: 'Scapular retraction', plane: 'transverse', frame: 'arm', pair: 'sc_pro',
    marker: ['scapula', 'shoulder'],
    drive: [{ joint: 'scapula', axis: 'y', to: 25 }],
    movers: [RHOMBOIDS, ['Trapezius (middle)', 'Trapezius']] },

  // --------------------------------------------------- elbow and forearm
  { id: 'el_flex', group: 'Elbow & forearm', title: 'Elbow flexion', plane: 'sagittal', frame: 'arm', pair: 'el_ext',
    drive: [{ joint: 'elbow', axis: 'x', to: -150 }],
    movers: ['Brachialis', BICEPS, 'Brachioradialis'] },
  { id: 'el_ext', group: 'Elbow & forearm', title: 'Elbow extension', plane: 'sagittal', frame: 'arm', pair: 'el_flex',
    base: { elbow: { x: -130 } },
    drive: [{ joint: 'elbow', axis: 'x', to: 0 }],
    movers: [TRICEPS, 'Anconeus'] },
  { id: 'fa_pro', group: 'Elbow & forearm', title: 'Forearm pronation', plane: 'transverse', frame: 'forearm', pair: 'fa_sup',
    base: ELBOW_90, marker: { node: 'wrist', axis: 'x' },
    drive: [{ joint: 'elbow', axis: 'y', to: -80 }],
    movers: ['Pronator quadratus'] },
  { id: 'fa_sup', group: 'Elbow & forearm', title: 'Forearm supination', plane: 'transverse', frame: 'forearm', pair: 'fa_pro',
    base: ELBOW_90, marker: { node: 'wrist', axis: 'x' },
    drive: [{ joint: 'elbow', axis: 'y', to: 80 }],
    movers: ['Supinator', BICEPS] },

  // ---------------------------------------------------------------- wrist
  // THE AXES HERE ARE NOT A TYPO. The rig's wrist frame is the anatomical
  // position (palm forward: x = flex/extend, z = deviate), but the clothed hand
  // is bound mid-prone, its palm rolled ~110° about the forearm onto the thigh
  // (see Figure.handMesh). Measured on the visible hand, a wrist-Z rotation is
  // what carries the fingers toward the palm (flexion) and wrist-X toward the
  // thumb (radial deviation) — the joint panel's own x/z labels describe the
  // rig frame, not the hand you see. So flexion is limited to the rig's ±30° z
  // range (a real wrist flexes ~80°); widening it means re-cutting the wrist
  // limits in skeletonDef.js, which the embrace solve also leans on.
  { id: 'wr_flex', group: 'Wrist', title: 'Wrist flexion', plane: 'sagittal', frame: 'forearm', pair: 'wr_ext',
    base: ELBOW_90, drive: [{ joint: 'wrist', axis: 'z', to: -30 }],
    movers: ['Flexor carpi radialis'] },
  { id: 'wr_ext', group: 'Wrist', title: 'Wrist extension', plane: 'sagittal', frame: 'forearm', pair: 'wr_flex',
    base: ELBOW_90, drive: [{ joint: 'wrist', axis: 'z', to: 30 }],
    movers: ['Extensor digitorum'] },
  { id: 'wr_rad', group: 'Wrist', title: 'Radial deviation', plane: 'frontal', frame: 'forearm', pair: 'wr_uln',
    base: ELBOW_90, drive: [{ joint: 'wrist', axis: 'x', to: -20 }],
    movers: ['Flexor carpi radialis'] },
  { id: 'wr_uln', group: 'Wrist', title: 'Ulnar deviation', plane: 'frontal', frame: 'forearm', pair: 'wr_rad',
    base: ELBOW_90, drive: [{ joint: 'wrist', axis: 'x', to: 30 }],
    movers: [] },

  // ------------------------------------------------------------------ hip
  { id: 'hp_flex', group: 'Hip', title: 'Hip flexion', plane: 'sagittal', frame: 'leg', pair: 'hp_ext',
    drive: [{ joint: 'hip', axis: 'x', to: -120 }, { joint: 'knee', axis: 'x', to: 110 }],
    movers: [ILIOPSOAS, 'Rectus femoris', 'Sartorius', 'Pectineus'] },
  { id: 'hp_ext', group: 'Hip', title: 'Hip extension', plane: 'sagittal', frame: 'leg', pair: 'hp_flex',
    drive: [{ joint: 'hip', axis: 'x', to: 35 }],
    movers: ['Gluteus maximus', HAMSTRINGS] },
  { id: 'hp_abd', group: 'Hip', title: 'Hip abduction', plane: 'frontal', frame: 'leg', pair: 'hp_add',
    drive: [{ joint: 'hip', axis: 'z', to: 45 }],
    movers: ['Gluteus medius', 'Gluteus minimus'] },
  { id: 'hp_add', group: 'Hip', title: 'Hip adduction', plane: 'frontal', frame: 'leg', pair: 'hp_abd',
    base: { hip: { x: -14 } }, // slightly forward, so the leg crosses in front of the standing one
    drive: [{ joint: 'hip', axis: 'z', to: -25 }],
    movers: [ADDUCTORS, 'Gracilis', 'Pectineus'] },
  { id: 'hp_ir', group: 'Hip', title: 'Hip internal rotation', plane: 'transverse', frame: 'leg', pair: 'hp_er',
    marker: { node: 'ankle', axis: 'z' }, // the foot's forward axis: the toes swing in/out
    drive: [{ joint: 'hip', axis: 'y', to: -40 }],
    movers: ['Gluteus minimus', ['Gluteus medius (anterior)', 'Gluteus medius']] },
  { id: 'hp_er', group: 'Hip', title: 'Hip external rotation', plane: 'transverse', frame: 'leg', pair: 'hp_ir',
    marker: { node: 'ankle', axis: 'z' }, // the foot's forward axis: the toes swing in/out
    drive: [{ joint: 'hip', axis: 'y', to: 40 }],
    movers: ['Piriformis', 'Gluteus maximus', 'Sartorius'] },

  // ----------------------------------------------------------------- knee
  { id: 'kn_flex', group: 'Knee', title: 'Knee flexion', plane: 'sagittal', frame: 'leg', pair: 'kn_ext',
    drive: [{ joint: 'knee', axis: 'x', to: 145 }],
    movers: [HAMSTRINGS_KNEE, GASTROC, ['Gracilis', 'Gracilis', PES], ['Sartorius', 'Sartorius', PES]] },
  { id: 'kn_ext', group: 'Knee', title: 'Knee extension', plane: 'sagittal', frame: 'leg', pair: 'kn_flex',
    base: { hip: { x: -60 }, knee: { x: 100 } },
    drive: [{ joint: 'knee', axis: 'x', to: 0 }],
    movers: [QUADS_KNEE] },

  // ------------------------------------------------------- ankle and toes
  { id: 'an_df', group: 'Ankle & foot', title: 'Ankle dorsiflexion', plane: 'sagittal', frame: 'foot', pair: 'an_pf',
    base: FOOT_UP, marker: ['ankle', 'toes'],
    drive: [{ joint: 'ankle', axis: 'x', to: -25 }],
    movers: ['Tibialis anterior', 'Extensor digitorum longus', 'Extensor hallucis longus'] },
  { id: 'an_pf', group: 'Ankle & foot', title: 'Ankle plantarflexion', plane: 'sagittal', frame: 'foot', pair: 'an_df',
    base: FOOT_UP, marker: ['ankle', 'toes'],
    drive: [{ joint: 'ankle', axis: 'x', to: 45 }],
    movers: [GASTROC, SOLEUS, 'Tibialis posterior', 'Fibularis longus'] },
  { id: 'an_inv', group: 'Ankle & foot', title: 'Foot inversion', plane: 'frontal', frame: 'foot', pair: 'an_ev',
    base: FOOT_UP, marker: { node: 'ankle', axis: 'x' },
    drive: [{ joint: 'ankle', axis: 'z', to: -20 }],
    movers: ['Tibialis anterior', 'Tibialis posterior'] },
  { id: 'an_ev', group: 'Ankle & foot', title: 'Foot eversion', plane: 'frontal', frame: 'foot', pair: 'an_inv',
    base: FOOT_UP, marker: { node: 'ankle', axis: 'x' },
    drive: [{ joint: 'ankle', axis: 'z', to: 20 }],
    movers: ['Fibularis longus', 'Fibularis brevis'] },
  { id: 'to_ext', group: 'Ankle & foot', title: 'Toe extension (MTP)', plane: 'sagittal', frame: 'foot', pair: 'to_flex',
    base: FOOT_UP, marker: { node: 'toes', axis: 'z' },
    drive: [{ joint: 'toes', axis: 'x', to: -70 }],
    // The bellies sit up the shank and stop at the ankle; only their long
    // TENDONS cross the MTP, so the callout has to include them or this clip
    // highlights nothing that can move (see the `ankle` group in MUSCLE_NODE).
    movers: [['Extensor digitorum longus', 'Extensor digitorum longus', 'Extensor digitorum longus tendons'],
      'Extensor hallucis longus'] },
  { id: 'to_flex', group: 'Ankle & foot', title: 'Toe flexion (MTP)', plane: 'sagittal', frame: 'foot', pair: 'to_ext',
    base: FOOT_UP, marker: { node: 'toes', axis: 'z' },
    drive: [{ joint: 'toes', axis: 'x', to: 35 }],
    movers: ['Flexor hallucis longus', 'Flexor digitorum longus'] },

  // ------------------------------------------------------ trunk and pelvis
  { id: 'tr_flex', group: 'Trunk & pelvis', title: 'Trunk flexion', plane: 'sagittal', frame: 'trunk', pair: 'tr_ext',
    marker: ['spine', 'neck'],
    drive: [{ joint: 'spine', axis: 'x', to: 50 }, { joint: 'chest', axis: 'x', to: 30 }],
    movers: [['Rectus abdominis', 'Rectus abdominal'], ...OBLIQUES] },
  { id: 'tr_ext', group: 'Trunk & pelvis', title: 'Trunk extension', plane: 'sagittal', frame: 'trunk', pair: 'tr_flex',
    marker: ['spine', 'neck'],
    drive: [{ joint: 'spine', axis: 'x', to: -25 }, { joint: 'chest', axis: 'x', to: -20 }],
    movers: [] },
  { id: 'tr_lat', group: 'Trunk & pelvis', title: 'Trunk lateral flexion', plane: 'frontal', frame: 'trunk',
    marker: ['spine', 'neck'],
    drive: [{ joint: 'spine', axis: 'z', to: -20 }, { joint: 'chest', axis: 'z', to: -25 }],
    movers: OBLIQUES },
  { id: 'tr_rot', group: 'Trunk & pelvis', title: 'Trunk rotation', plane: 'transverse', frame: 'trunk',
    center: 'chest', marker: { node: 'chest', axis: 'z' },
    drive: [{ joint: 'chest', axis: 'y', to: 35 }, { joint: 'spine', axis: 'y', to: 8 }],
    movers: OBLIQUES },
  { id: 'pv_ant', group: 'Trunk & pelvis', title: 'Anterior pelvic tilt', plane: 'sagittal', frame: 'trunk', pair: 'pv_post',
    marker: { node: 'pelvis', axis: 'z' },
    // The hips and lumbar spine counter-rotate, so the legs and the chest stay
    // where they are and only the pelvis tips (the hip joints lie ON its x axis).
    drive: [{ joint: 'pelvis', axis: 'x', to: 15 }, { joint: 'hip_L', axis: 'x', to: -15 },
      { joint: 'hip_R', axis: 'x', to: -15 }, { joint: 'spine', axis: 'x', to: -15 }],
    movers: [ILIOPSOAS, 'Rectus femoris'] },
  { id: 'pv_post', group: 'Trunk & pelvis', title: 'Posterior pelvic tilt', plane: 'sagittal', frame: 'trunk', pair: 'pv_ant',
    marker: { node: 'pelvis', axis: 'z' },
    drive: [{ joint: 'pelvis', axis: 'x', to: -12 }, { joint: 'hip_L', axis: 'x', to: 12 },
      { joint: 'hip_R', axis: 'x', to: 12 }, { joint: 'spine', axis: 'x', to: 12 }],
    movers: [['Rectus abdominis', 'Rectus abdominal'], 'Gluteus maximus', HAMSTRINGS] },

  // ----------------------------------------------------------------- neck
  { id: 'nk_flex', group: 'Neck', title: 'Neck flexion', plane: 'sagittal', frame: 'neck', pair: 'nk_ext',
    marker: ['neck', 'headTop'],
    drive: [{ joint: 'neck', axis: 'x', to: 50 }, { joint: 'head', axis: 'x', to: 20 }], movers: [] },
  { id: 'nk_ext', group: 'Neck', title: 'Neck extension', plane: 'sagittal', frame: 'neck', pair: 'nk_flex',
    marker: ['neck', 'headTop'],
    drive: [{ joint: 'neck', axis: 'x', to: -40 }, { joint: 'head', axis: 'x', to: -25 }],
    movers: [['Trapezius (upper)', 'Trapezius']] },
  { id: 'nk_lat', group: 'Neck', title: 'Neck lateral flexion', plane: 'frontal', frame: 'neck',
    marker: ['neck', 'headTop'],
    drive: [{ joint: 'neck', axis: 'z', to: -35 }, { joint: 'head', axis: 'z', to: -10 }], movers: [] },
  { id: 'nk_rot', group: 'Neck', title: 'Neck rotation', plane: 'transverse', frame: 'neck',
    center: 'head', marker: { node: 'head', axis: 'z' },
    drive: [{ joint: 'neck', axis: 'y', to: 70 }, { joint: 'head', axis: 'y', to: 10 }], movers: [] },

  // ---------------------------------------------------------------- tango
  { id: 'tg_dissoc', group: 'Tango', title: 'Dissociation', subtitle: 'The chest turns over a still pelvis',
    plane: 'transverse', frame: 'body', floor: 'dissoc',
    center: 'chest', marker: { node: 'chest', axis: 'z' },
    drive: [{ joint: 'chest', axis: 'y', to: 35 }, { joint: 'spine', axis: 'y', to: 8 }],
    movers: OBLIQUES },
  { id: 'tg_pivot', group: 'Tango', title: 'Hip pivot (ocho)', subtitle: 'The hips turn under a still chest',
    plane: 'transverse', frame: 'body', floor: 'dissoc',
    marker: { node: 'pelvis', axis: 'z' },
    // Pelvis +40 paid for by the trunk's whole counter-twist budget (chest 35 +
    // lumbar 5 of its 8), so the shoulders never move — app.pivotHips's rule.
    drive: [{ joint: 'pelvis', axis: 'y', to: 40 }, { joint: 'chest', axis: 'y', to: -35 },
      { joint: 'spine', axis: 'y', to: -5 }],
    movers: [...OBLIQUES, 'Piriformis', 'Gluteus medius'] },
  { id: 'tg_releve', group: 'Tango', title: 'Relevé', subtitle: 'Rising onto the balls of the feet',
    plane: 'sagittal', frame: 'body', center: 'toes', marker: ['toes', 'ankle'], axisFig: 'x',
    // Point the ankles and extend the toes by the same angle: the toe pads stay
    // flat, and the floor clamp lifts the body over them — a rise, from plain FK.
    drive: [{ joint: 'ankle', axis: 'x', to: 40 }, { joint: 'toes', axis: 'x', to: -40 },
      { joint: 'ankle_L', axis: 'x', to: 40 }, { joint: 'toes_L', axis: 'x', to: -40 },
      { joint: 'ankle_R', axis: 'x', to: 40 }, { joint: 'toes_R', axis: 'x', to: -40 }],
    movers: [GASTROC, SOLEUS, 'Flexor hallucis longus', 'Tibialis posterior', 'Fibularis longus'] },
];

export const MOVEMENT_BY_ID = Object.fromEntries(MOVEMENTS.map((m) => [m.id, m]));
