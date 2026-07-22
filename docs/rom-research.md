# Joint range-of-motion research — proposed limits for `skeletonDef.js`

Research pass over normative human ROM, mapped onto this rig's axis conventions.
Anchor sources: AAOS normative values, AMA Guides, Norkin & White *Measurement of
Joint Motion*, Boone & Azen 1979, Soucie/CDC 2011 (the best modern both-sexes
goniometric base), plus dance-medicine literature (JDMS, Russell, Khan, Steinberg,
Champion & Chatfield) where a tango tool needs trained-dancer ranges.

Sign conventions per `skeletonDef.js` / `presets.js`:
hip x<0 leg forward · knee x>0 bend · ankle x>0 point toes · toes x<0 toes up ·
spine/chest x>0 lean forward · shoulder x<0 arm forward/up · elbow x<0 bend ·
left-side z>0 = out to the side. Labels read `min / max`.

---

## Summary table

| Joint | Axis | Current | Proposed | Basis |
|---|---|---|---|---|
| **spine** (lumbar) | x | `[-25, 50]` | `[-28, 60]` | flexion 60–65°, extension 25–31° |
| | y | `[-8, 8]` | **keep** | lumbar twist 7–10°; facet-limited, does not vary with age |
| | z | `[-20, 20]` | `[-25, 25]` | lateral flexion 20–30° |
| **chest** (thoracic) | x | `[-20, 30]` | `[-22, 28]` | flexion 25–30°, extension 20–25° |
| | y | `[-35, 35]` | `[-45, 45]` | thoracic rotation 45–47°; supplies ~80% of trunk twist |
| | z | `[-25, 25]` | `[-30, 30]` | lateral flexion ~30° |
| **neck** (C2–C7) | x | `[-40, 50]` | `[-25, 40]` | lower-cervical share of flex/ext |
| | y | `[-70, 70]` | `[-45, 45]` | C2–C7 ≈ half of total cervical rotation |
| | z | `[-35, 35]` | **keep** | lower cervical carries nearly all side-bend |
| **head** (C0–C2) | x | `[-25, 25]` | `[-30, 15]` | C0–C1 gives 69–71% of upper-cervical *extension*, little flexion |
| | y | `[-40, 40]` | **keep** | C1–C2 ≈ 50% of cervical rotation (38.9° in vitro, ~50° in vivo) |
| | z | `[-20, 20]` | `[-12, 12]` | upper cervical lateral tilt is small (~6°/segment) |
| **scapula** | x | `[-15, 15]` | `[-15, 20]` | posterior tilt ~30° during elevation (SD 13° — soft number) |
| | y | `[-25, 25]` | `[-18, 18]` | protraction/retraction ~15–17° each |
| | z | `[-12, 25]` | `[-10, 40]` | elevation ~40°, depression ~10° |
| **shoulder** | x | `[-170, 45]` | `[-170, 55]` | extension 50–60°; flexion kept at complex ROM (see note) |
| | y | `[-80, 80]` | `[-70, 85]` | IR ~70°, ER ~85–90° at abduction |
| | z | `[-30, 170]` | `[-40, 170]` | horizontal adduction 30–45° |
| **elbow** | x | `[-150, 0]` | `[-150, 5]` | flexion 150°; hyperextension normal (♀4.7° / ♂0.8°) |
| | y | `[-120, 120]` | `[-85, 85]` | **pronation/supination is only ~80–85°** |
| | z | `[0, 0]` | **keep** | correct — no frontal-plane motion |
| **wrist** | x | `[-65, 65]` | `[-75, 75]` | flexion ~76–80°, extension ~70–75° |
| | y | `[0, 0]` | **keep** | correct — forearm rotation belongs to the elbow |
| | z | `[-30, 30]` | `[-20, 35]` | **asymmetric**: radial 20°, ulnar 35° (radial styloid bony block) |
| **hip** | x | `[-120, 35]` | `[-125, 30]` | flexion 120–134° knee-flexed; extension 17–30° |
| | y | `[-40, 40]` | `[-40, 55]` | **asymmetric**: dancer ER 50–60°, IR 40–45° |
| | z | `[-25, 45]` | `[-30, 45]` | abduction 45°, adduction 30° |
| **knee** | x | `[0, 145]` | `[-5, 145]` | flexion 135–142°; recurvatum 1–5° in 10–30% of people |
| | y / z | `[0, 0]` | **keep** | correct — see note |
| **ankle** | x | `[-25, 45]` | `[-25, 60]` | talocrural supplies 57.6° of the pointe; DF 20–25° |
| | y | `[0, 0]` | **keep** | transverse rotation is tibial, not talocrural |
| | z | `[-20, 20]` | asymmetric 30/15 | inversion 20–35°, eversion 10–15° — **verify sign first** |
| **toes** (MTP) | x | `[-70, 35]` | `[-90, 45]` | demi-pointe needs ~90° MTP extension; flexion 40–45° |
| **pelvis** | all | `free` | **keep** | correct — this is whole-body orientation, not a joint |

---

## Notes on the non-obvious calls

### The lumbar twist of ±8° is already right — don't touch it
Lumbar axial rotation is 7–15°/side (in-vivo MRI: ~10° total lumbar out of 56°
trunk rotation), blocked by sagittalized facet articulations. It is also the one
spinal motion that *does not decline with age*, because it is bone-limited rather
than soft-tissue limited. Whoever set ±8° got this right.

The corollary matters for tango: the thoracic spine supplies ~80% of trunk twist,
which is exactly where `CLAUDE.md` already says dissociation lives. Widening
`chest.y` to ±45 is the anatomically honest way to give dissociation more room —
never `spine.y`.

Also relevant: Swain et al. 2019 (21 dancers vs 39 non-dancers, motion capture)
found dancers have greater *lateral flexion* but **no difference in trunk
rotation**. So there is no dancer justification for widening twist beyond ±45°.

### Elbow pronation is the clearest error in the current table
`elbow.y` is `±120°`, but real forearm pronation/supination is ~80–85° each way.
`embrace.js` already knows this — `CLASP_PRONATION_DEG = 85` caps the clasp solve
to "the forearm's natural ±85° range" because letting the solve reach past it
"lets it pick a strained pronation branch that leaves the joined hands gapping
after a pivot." The rig limit is the outlier; tightening it to ±85° makes the
gizmo and slider agree with what the embrace solver already enforces.

### Two joints should become asymmetric
- **Wrist deviation.** Ulnar deviation (~35°) is roughly *twice* radial (~20°).
  This is bony, not soft-tissue: the radial styloid abuts the scaphoid/trapezium
  early, while the shorter ulna leaves the ulnocarpal space bridged only by the
  TFCC. A symmetric ±30° is wrong in both directions at once.
- **Hip rotation.** The robust dancer signature is not a large absolute gain in
  external rotation — it is the **ER:IR ratio shift** (Khan 1997, Eleftheraki
  2025, Bennell 1999 all agree on the ratio even where they disagree on absolute
  values; Gupta 2004 found no total-ROM difference at all). Dancer ER 50–60° vs
  general 45°, with IR *lower* than general population. `[-40, 55]` encodes that.

### Knee lock: keep it, and the research says so explicitly
Ab/adduction exists only as ~6.7° of passive laxity under an external moment — no
muscle produces it, it is not a pose parameter. Tibial rotation is ~0° at
extension, peaks at ~40° arc around 30–40° flexion, and is largely obligatory
(screw-home) rather than independently posed. For tango — modest turnout, knees
near-extended through the walk — locking both is correct.

The one caveat, recorded so it isn't rediscovered later: kinematic studies
attribute ~32% of visible *ballet* turnout to knee-level rotation, so a locked
knee under-renders turnout and pushes the whole demand onto the hip. If turnout
fidelity ever matters, the honest relaxation is ±15–20° tibial rotation **gated on
knee flexion > 30°**, never at extension.

### Arabesque is not hip extension
Advanced dancers measure 23.5 ± 10.0° of prone hip hyperextension — only modestly
above the 17–18° general adult value. The Vaganova "110° arabesque" is a
leg-to-torso *line*, reached through lumbar extension (20–25°), ipsilateral side
bend (~20°), contralateral rotation (~10°), and anterior pelvic tilt. The current
`hip.x` max of 35° is already generous; proposing 30°.

### Ankle: the point comes ~70% from the ankle, 30% from the midfoot
X-ray superimposition of experienced ballet dancers puts the talocrural
contribution to *en pointe* plantarflexion at 57.6 ± 5.2°, with the remaining ~30%
distributed between talus/navicular/cuneiform/1st metatarsal. Dancers total
74.3 ± 7.1° vs 57.2 ± 6.8° in non-dancers — and the 70/30 ratio is **the same in
both groups**; dancers have more range everywhere rather than shifting the burden
to the midfoot.

Since this rig has no midfoot joint, `ankle.x` max of 60° covers the talocrural
share of a full point, and the remaining ~30% is unmodellable without a midfoot
joint. Worth noting that dancers have *less* dorsiflexion than controls
(26.7° vs 33.9°), so the -25° dorsiflexion limit needs no widening.

### Toes: 90° is a demi-pointe requirement, not a passive maximum
Passive 1st MTP extension is 70–90° (spread across sources 40–100°). Demi-pointe
is commonly stated to require ~90° with the ankle fully plantarflexed. Caveat
worth recording: that 90° figure circulates in dance-medicine review and clinical
education literature, not in a primary cohort measurement — treat it as a
well-attested clinical convention rather than a measured norm. Normal *walking*
needs only 35–45°, so the current -70° was never the gait constraint.

---

## The one genuine architectural decision: shoulder GH vs. complex

This rig has a **separate `scapula` joint**, which strictly means `shoulder`
should carry *glenohumeral-only* ROM — about **90–120° of flexion/abduction**, not
the 170° currently set. The remaining 60–90° is scapular upward rotation
(scapulohumeral rhythm, roughly 2:1).

**Recommendation: keep the complex-ROM values (170°) and document the
simplification.** Reasons:

1. The rig's `scapula` is a *posture* joint — protraction/retraction for tango
   chest-opening — not a load-bearing contributor to arm elevation. Its `z`
   ("Depress / elevate") is not the upward-rotation axis that would need to supply
   the missing 60°.
2. Nothing couples scapular rotation to humeral elevation, so cutting the shoulder
   to 120° would simply make overhead reach unreachable rather than redistributing
   it.
3. `ik.js`, `embrace.js`, and the authored presets all assume the shoulder alone
   can reach the clasp.

Doing it *properly* would mean adding a scapulohumeral-rhythm coupling — scapula
upward rotation driven as a fraction of shoulder elevation. That is a real feature
(it would make the shoulders shrug naturally on a high clasp), but it is a
separate change from retuning limits, and it would invalidate the frozen rig
calibration.

---

## Risks when applying

Several authored poses currently sit **exactly at** the limits, which suggests
some limits were fitted to poses rather than to anatomy:

| Pose value | Current limit | Under proposal |
|---|---|---|
| `chest y: 35` (dissociation) | `±35` — pinned | ±45, gains headroom ✓ |
| `spine y: ±8` | `±8` — pinned | unchanged, stays pinned (correct) |
| `ankle x: 45` | `45` — pinned | 60, gains headroom ✓ |
| `elbow y: ±30` (embrace clasp) | `±120` | ±85, still ample ✓ |
| `hip x: -48` (walk) | `-120` | -125 ✓ |
| `knee x: 70` | `145` | unchanged ✓ |

No authored pose is clipped by the proposal. The tightenings that *could* bite are
`neck.y` (70→45) and `neck.x` (50→40): authored neck values peak at `y: -20` and
`x: -10`, so both stay clear, but the embrace re-solves head angles per frame and
should be re-verified.

**Signs to verify before applying** — I could not resolve these two from the source
alone, and guessing would silently mirror a limit:
- `wrist.z` "Deviate out / in": which sign is radial? Proposal assumes
  min = out = radial (`[-20, 35]`).
- `ankle.z` "Roll out / in": which sign is inversion? Proposal assumes inversion
  gets the larger magnitude (30) and eversion the smaller (15).

Note the label-order convention is inconsistent between joints — `hip.z` reads
"Toward midline / out to side" with max = out, while `ankle.z` reads "Roll out /
in" with min = out. So the ordering cannot be assumed; check each empirically by
nudging the axis in the app.

Re-verification after applying: `dev-verify-embrace.mjs` (run 3–5×, judge by
majority), `dev-verify-collision.mjs`, `dev-verify-gait.mjs`,
`dev-verify-features.mjs`.

---

## Possible follow-up: per-figure ROM profiles

Two sex differences are large enough to be visible and both map onto this app's
man/woman avatars:

- **Elbow hyperextension**: ♀4.7° vs ♂0.8° (ages 20–44, Soucie/CDC). A hard 0°
  stop models an adult male specifically.
- **Genu recurvatum**: more common in women, 10–30% population prevalence.

Also: generalized joint hypermobility runs 64–72% in dance cohorts vs ~5% in
young adults (~11×). A `romScale` figure option — mirroring the existing
`soleScale` pattern — would let the follower carry dancer-typical ranges without
hardcoding them into the shared table.

---

## Source reliability

Solid and reproduced across independent sources: AAOS and AMA chart values;
McClure 2001 bone-pin scapular kinematics; Fujii 2007 in-vivo lumbar/thoracic
rotation MRI; Russell 2010/2011 dancer ankle radiography; Soucie/CDC.

Softer, flagged rather than treated as fact:
- Boone & Azen 1979 is paywalled (JBJS) — all specific values are secondhand from
  citing sources. It is also **males only** (n=109), so it cannot speak to any of
  the sex differences above.
- Norkin & White Table A.1 cross-study spreads came via search summary; direct
  fetch returned 403.
- Scapular isolated protraction/retraction/elevation figures are textbook-lineage
  secondary sources. Reviews are candid that **no validated non-invasive clinical
  measurement of scapular ROM exists** — treat all girdle numbers as softer than
  the spine numbers.
- The ~90° demi-pointe MTP requirement is clinical convention, not a measured
  cohort.
- **No peer-reviewed goniometric ROM data exists for tango/ballroom dancers** — a
  genuine gap. Ballet values are the nearest proxy and likely overstate tango's
  demands, which is why the proposals above lean toward general-population numbers
  everywhere except the ankle and hip rotation.

Active vs. passive, and goniometer vs. motion-capture, differ by about the same
magnitude as the sex differences — so don't mix sources within a single joint's row.
