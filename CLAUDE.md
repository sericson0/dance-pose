# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TAngle (*Tango + Angle*) — an interactive 3D tool for teaching Argentine tango: pose two dancers (leader/follower) with anatomically constrained joints, view skeleton/body/muscle layers, and read off biomechanics (center of gravity, base of support, balance margin, joint angles, A/B pose comparison). Stack: Vite + Three.js, vanilla JS ES modules, no framework, no tests, no vite config file.

All three mesh layers are imported GLBs whose parts are re-parented onto our own joint rig (`src/skeletonMesh.js`); `main.js` loads them with top-level `await` before building the figures and falls back to procedural geometry on failure. The skeleton and muscle views are anatomical atlases (CC-BY-SA — distributing them requires attribution + a compatible license); the muscle GLB shares the skeleton's atlas frame, so it is loaded only when the skeleton did and bakes with the skeleton's scale. The body view is a pair of clothed Microsoft Rocketbox avatars (`man.glb` / `woman.glb`, MIT) — skinned meshes whose Biped bones are retargeted onto our joints at load. See `public/models/ATTRIBUTION.md` for all licenses.

## Commands

```bash
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # static build to dist/
npm run preview    # serve the build
```

### Headless verification (the project's substitute for tests)

With the dev server running, drive the app in headless Edge via puppeteer-core:

```bash
node scripts/dev-screenshot.mjs <outDir>       # layer views + closed-chain check, screenshots + console errors
node scripts/dev-interact.mjs <outDir>         # selection, IK drag, A/B compare, screenshots + console errors
node scripts/dev-verify-features.mjs <outDir>  # presets stay grounded, weight/tango stats, interpolation, ghosts, pivot
node scripts/dev-verify-toes.mjs <outDir>      # toes (MTP) joint, demi-pointe, closed-chain relevé + pelvis height
node scripts/dev-verify-muscles.mjs <outDir>   # bi-articular muscles skin between their two joints (deform on bend), screenshots
node scripts/dev-verify-body.mjs <outDir>      # clothed avatars load + retarget, soles graze the floor, knees move feet not heads
node scripts/dev-tune.mjs '<json cases>'       # pose-authoring probe: prints foot-sole heights for candidate joint angles
```

Both scripts print `No console errors.` on success. They use `window.__app` (exposed at the bottom of `src/main.js`) — the scripted API for selection (`selectJoint`), posing (`editJoint`, `setJointDegrees`), chain mode (`setChainMode`), visibility (`setVisibleFigures`), camera, etc. Write new verification scripts in this same pattern. The Edge path is hardcoded to `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.

## Architecture

Everything is **data-driven**: each body part, muscle, bone, joint limit, and movement is a row in a table, editable without touching the rest.

- `src/skeletonDef.js` — single source of anatomical truth: joint hierarchy (positions as height fractions, Drillis–Contini), per-axis joint limits in degrees, de Leva mass table (`MASS_SEGMENTS`) used for COG, IK chains, closed-chain anchor map (`ANCHOR_FOR`), and `BODY_PARTS`/`PART_OF_NODE` highlight groups. **Only the left side is defined; the right side is auto-mirrored.**
- `src/skeletonMesh.js` — loads the imported anatomical skeleton GLB (`public/models/skeleton.glb`, CC-BY-SA — see `public/models/ATTRIBUTION.md`) and classifies each of its ~144 named bones onto one of our joint nodes (`classifyBone`). The GLB is Draco-compressed (decoder self-hosted in `public/draco/`) and holds only right-side + axial bones; the left side is mirrored at bake time. Matching is alphanumeric-normalized (GLTFLoader sanitizes names) and side is read from the bone's GLTF group, not the name suffix. Also loads the muscle GLB (`public/models/muscles.glb`, same source/license) via `loadMuscleMeshes`, routing ~60 named main-mover bellies to joint nodes with `classifyMuscle` (an exact normalized-name → `{ node, insert? }` map: `MUSCLE_NODE` gives the bone a belly rides, `MUSCLE_INSERT` names the far joint a bi-articular belly also crosses so it can skin/deform between the two — see `figure.js`); all shipped muscles are right-side and mirror to the left. The abdominal wall (rectus abdominis + obliques) rides the `spine` node and skins toward the `chest`. Also loads the clothed body avatars (`public/models/man.glb` / `woman.glb`, Microsoft Rocketbox, MIT) via `loadBodyMesh`, and exports `BODY_RETARGET` — the table mapping each 3ds Max Biped bone to the joint it snaps to, the bone/joint pair that defines its alignment direction, and its axial-stretch / foot-squash flags (see `Figure.#buildMeshBody`).
- `src/anatomy.js` — **fallback** procedural bone/muscle geometry from data tables, used only if a GLB fails to load: `LONG` plus small builders (skull, ribcage, pelvis, spine, hand, foot), and the muscle spindles (`MUSCLES_LEFT` / `MUSCLES_CENTER`).
- `scripts/build-muscles.mjs` — one-off asset pipeline (gltf-transform, run manually): trims the AnatomyTOOL "Upper limb" / "Lower limb" / "Muscles of thorax, abdomen and back" source GLBs down to the classified main-mover muscles, flattens materials, merges all three (deduping bellies that appear in more than one source, so the trunk model contributes only the abdominal wall), and Draco-compresses to `public/models/muscles.glb`. Imports `classifyMuscle` so its keep-list can't drift from the runtime.
- `scripts/build-body.mjs` — one-off asset pipeline for the body avatars: takes an FBX2glTF conversion of a Microsoft Rocketbox avatar (FBX → GLB comes out untextured because the FBX references 3ds Max map names), decodes the source TGA textures itself, downsizes them to 1024², wires them onto the body/head/opacity materials, and Draco-compresses to `public/models/man.glb` / `woman.glb`. The skin (bones + weights) passes through intact.
- `src/figure.js` — assembles a dancer as an Object3D joint tree (not a skinned mesh) with three toggleable mesh layers (skeleton / body / muscles); `addMesh(node, mesh, layer)` is the attach point for any geometry. `#buildMeshSkeleton()` scales the atlas bones to the figure's height, bakes each into its joint node's local frame (mirroring right→left, reversing winding), and merges per node+material into one mesh to keep draw calls low. `#buildMeshMuscles()` does the same bake/mirror for the muscle GLB using the *skeleton's* atlas scale, keeping muscles as individual named meshes (each carries `userData.muscleName`). A belly that only rides one bone is parented rigidly to its joint; a bi-articular belly (one with an `insert`, e.g. biceps, gastrocnemius, rectus femoris) is baked in figure-local space, hung off `group`, and **skinned between its two joints** — `#addSkinnedMuscle` computes a per-vertex weight along the origin→insertion axis, and `updateMuscleSkin()` re-blends the baked positions/normals from the two joints' current transforms every frame (called from `main.js`'s loop and from `setPose`; it no-ops unless the muscle layer is visible). This is CPU linear-blend skinning, not `THREE.SkinnedMesh`, so the muscle's own frame never moves and the skin stays correct as the whole dancer translates/turns. `#buildMeshBody()` attaches the clothed avatar: it keeps the GLB's `THREE.SkinnedMesh` + skin weights but re-parents each Biped bone onto the matching joint node with a constant local matrix. To make the three layers coincide (so they overlay when toggled together), the body is retargeted onto the *atlas* rest pose, not the rig's own rest — the skeleton and muscle layers render the atlas pose (arms slightly abducted, hands/feet splayed), so `#atlasLimbRest()` estimates each limb joint's atlas position from the loaded skeleton bones (the meeting point of adjacent bone clusters), and each Biped bone snaps its origin to that atlas joint, aligns its bind direction along the atlas segment, and stretches axially to reach it (torso joints, which already agree, stay on the rig rest). A world-Y squash on foot/toe bones keeps shoe soles — heels included — grazing y = 0 at rest. Unmapped bones (fingers, face, clavicles) ride their re-parented ancestor unchanged, and the mesh hangs off `group` in 'attached' bind mode so all deformation is GPU-skinned with no per-frame CPU cost. Body highlight is a no-op on the avatar (one continuous skin, `userData.noHighlight`). Also owns `clampToFloor()` (runs every frame) and `setHighlight()`.
- `src/ik.js` — analytic two-bone IK for open-chain limb dragging, and the closed-chain math (`editWithAnchor`, `pinAnchor`: pin a distal foot/hand, move the body above via rigid root compensation); feet-to-floor helper.
- `src/analysis.js` — COG from segment masses, foot contacts, convex hull, balance margin, key angles; weight distribution between feet (`weightDistribution`: L/R split, support foot, heel/mid/ball, on-axis) and tango metrics (`tangoStats`: dissociation, step length, turnout). Couple stats combine both dancers.
- `src/presets.js` — starting poses. **Joint sign conventions are documented at the top of this file** — read them before authoring poses.
- `src/main.js` — scene, picking, gizmos, interaction modes (rotate joint / drag hand-foot / move / turn / pivot-on-foot), undo stack, balance visuals, wooden floor; A→B pose interpolation (`lerpPose`, `applyInterp`, `playInterp`) with a COG floor trail, translucent ghost figures of snapshots (`setGhost`), and `pivotFigure` (rotate about the ball of the support foot; combines with "Move as couple" for a calesita).
- `src/ui.js` — side panel: sliders, stats, A/B compare with movement scrubber + ghost toggles, pose library (localStorage + JSON export/import).

### Where to make common edits

| To change… | Edit |
| --- | --- |
| a joint's range of motion | its `limits` in `skeletonDef.js` |
| which bone mesh maps to which joint | `classifyBone` in `skeletonMesh.js` |
| which muscle to ship / which joint it rides | the `MUSCLE_NODE` table (`classifyMuscle`) in `skeletonMesh.js`, then re-run `scripts/build-muscles.mjs` |
| which second joint a muscle skins toward (bi-articular deform) | the `MUSCLE_INSERT` table in `skeletonMesh.js` (omit a muscle to keep it rigid on its `node`) |
| which Biped bone drives which joint (body avatars) | the `BODY_RETARGET` table in `skeletonMesh.js` |
| swap in a different Rocketbox avatar | download its FBX + TGAs, run FBX2glTF, then `scripts/build-body.mjs` (see its header) |
| a fallback bone's shape/thickness | the `LONG` table or a builder in `anatomy.js` (only shown if the GLB fails to load) |
| a fallback muscle | its row in `MUSCLES_LEFT` / `MUSCLES_CENTER` in `anatomy.js` (only shown if the muscle GLB fails to load) |
| the fallback mannequin body | `#buildBody` in `figure.js` (only shown if a body GLB fails to load; also used by ghost figures) |
| body proportions / masses | `JOINTS` / `MASS_SEGMENTS` in `skeletonDef.js` |
| a preset pose or add one | `PRESETS` in `presets.js` |
| which foot anchors a closed chain | `ANCHOR_FOR` in `skeletonDef.js` |

## Behavioral rules (deliberate design decisions — do not "fix")

- **Feet are free.** Feet may point, rise to demi-pointe, or lift off the floor. Never add logic that forces feet down; only floor *penetration* is blocked (`clampToFloor` lifts the whole dancer just enough, and settles back only by undoing its own lifts). "Feet to floor" is an explicit opt-in button (`app.groundFeet`); it also flattens the toes joints. Demi-pointe: point the ankles (x>0) and extend the toes (`toes_L/R` x<0) so the toe pads stay flat on the floor.
- **Open vs. closed kinetic chain** is a core teaching feature: open chain rotates everything below the joint (ordinary FK); closed chain keeps the distal end (planted foot / joined hand) fixed and moves the body above. The anchor is picked automatically from `ANCHOR_FOR`; the toes joint anchors itself, so extending it in closed chain is a relevé (heel rises over the pinned ball of the foot). The pelvis hip-height slider is special-cased (`app.setPelvisHeight`): rigid root compensation cancels a pure translation exactly, so in closed chain the legs re-solve via IK instead — planted feet keep their place and sole orientation while the body sinks or rises.
- **Joint limits are enforced everywhere** — gizmo, sliders, IK, and presets must all stay within the ranges in `skeletonDef.js`.
- Pose-authoring gotcha: pelvis x-tilt or deep toe-points can push a foot below the floor, which makes the clamp lift the dancer and ruins the balance stats (the support foot floats and the weight reading lands on the wrong foot). Author trailing/pointed feet with hip/knee/ankle angle triples whose toe grazes y ≈ 0 — don't derive them by hand; probe candidate angles with `scripts/dev-tune.mjs` until `low` ≈ 0 and the standing sole is flat at 0. Known-good triples at standing pelvis heights: trailing grazing toe `hip 15 / knee 36 / ankle 33` (pelvisY 0.527), collected free foot beside the support foot `hip 2 / knee 50 / ankle 42` (pelvisY 0.525).
