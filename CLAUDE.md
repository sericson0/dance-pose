# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TAngle (*Tango + Angle*) — an interactive 3D tool for teaching Argentine tango: pose two dancers (leader/follower) with anatomically constrained joints, view skeleton/body/muscle layers, and read off biomechanics (center of gravity, base of support, balance margin, joint angles, A/B pose comparison). Stack: Vite + Three.js, vanilla JS ES modules, no framework, no tests, no vite config file.

The skeleton *view* is an imported anatomical GLB whose bones are re-parented onto our own joint rig (`src/skeletonMesh.js`); `main.js` loads it with top-level `await` before building the figures and falls back to procedural bones on failure. The GLB is CC-BY-SA, so distributing this project with it requires attribution + a compatible license (`public/models/ATTRIBUTION.md`).

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
node scripts/dev-tune.mjs '<json cases>'       # pose-authoring probe: prints foot-sole heights for candidate joint angles
```

Both scripts print `No console errors.` on success. They use `window.__app` (exposed at the bottom of `src/main.js`) — the scripted API for selection (`selectJoint`), posing (`editJoint`, `setJointDegrees`), chain mode (`setChainMode`), visibility (`setVisibleFigures`), camera, etc. Write new verification scripts in this same pattern. The Edge path is hardcoded to `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.

## Architecture

Everything is **data-driven**: each body part, muscle, bone, joint limit, and movement is a row in a table, editable without touching the rest.

- `src/skeletonDef.js` — single source of anatomical truth: joint hierarchy (positions as height fractions, Drillis–Contini), per-axis joint limits in degrees, de Leva mass table (`MASS_SEGMENTS`) used for COG, IK chains, closed-chain anchor map (`ANCHOR_FOR`), and `BODY_PARTS`/`PART_OF_NODE` highlight groups. **Only the left side is defined; the right side is auto-mirrored.**
- `src/skeletonMesh.js` — loads the imported anatomical skeleton GLB (`public/models/skeleton.glb`, CC-BY-SA — see `public/models/ATTRIBUTION.md`) and classifies each of its ~144 named bones onto one of our joint nodes (`classifyBone`). The GLB is Draco-compressed (decoder self-hosted in `public/draco/`) and holds only right-side + axial bones; the left side is mirrored at bake time. Matching is alphanumeric-normalized (GLTFLoader sanitizes names) and side is read from the bone's GLTF group, not the name suffix.
- `src/anatomy.js` — **fallback** procedural bone/muscle geometry from data tables, used only if the GLB fails to load: `LONG` plus small builders (skull, ribcage, pelvis, spine, hand, foot). Muscles (`MUSCLES_LEFT` / `MUSCLES_CENTER`) are always procedural.
- `src/figure.js` — assembles a dancer as an Object3D joint tree (not a skinned mesh) with three toggleable mesh layers (skeleton / body / muscles); `addMesh(node, mesh, layer)` is the attach point for any geometry. `#buildMeshSkeleton()` scales the atlas bones to the figure's height, bakes each into its joint node's local frame (mirroring right→left, reversing winding), and merges per node+material into one mesh to keep draw calls low. Also owns `clampToFloor()` (runs every frame) and `setHighlight()`.
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
| a fallback bone's shape/thickness | the `LONG` table or a builder in `anatomy.js` (only shown if the GLB fails to load) |
| a muscle | its row in `MUSCLES_LEFT` / `MUSCLES_CENTER` in `anatomy.js` |
| body proportions / masses | `JOINTS` / `MASS_SEGMENTS` in `skeletonDef.js` |
| a preset pose or add one | `PRESETS` in `presets.js` |
| which foot anchors a closed chain | `ANCHOR_FOR` in `skeletonDef.js` |

## Behavioral rules (deliberate design decisions — do not "fix")

- **Feet are free.** Feet may point, rise to demi-pointe, or lift off the floor. Never add logic that forces feet down; only floor *penetration* is blocked (`clampToFloor` lifts the whole dancer just enough, and settles back only by undoing its own lifts). "Feet to floor" is an explicit opt-in button (`app.groundFeet`); it also flattens the toes joints. Demi-pointe: point the ankles (x>0) and extend the toes (`toes_L/R` x<0) so the toe pads stay flat on the floor.
- **Open vs. closed kinetic chain** is a core teaching feature: open chain rotates everything below the joint (ordinary FK); closed chain keeps the distal end (planted foot / joined hand) fixed and moves the body above. The anchor is picked automatically from `ANCHOR_FOR`; the toes joint anchors itself, so extending it in closed chain is a relevé (heel rises over the pinned ball of the foot). The pelvis hip-height slider is special-cased (`app.setPelvisHeight`): rigid root compensation cancels a pure translation exactly, so in closed chain the legs re-solve via IK instead — planted feet keep their place and sole orientation while the body sinks or rises.
- **Joint limits are enforced everywhere** — gizmo, sliders, IK, and presets must all stay within the ranges in `skeletonDef.js`.
- Pose-authoring gotcha: pelvis x-tilt or deep toe-points can push a foot below the floor, which makes the clamp lift the dancer and ruins the balance stats (the support foot floats and the weight reading lands on the wrong foot). Author trailing/pointed feet with hip/knee/ankle angle triples whose toe grazes y ≈ 0 — don't derive them by hand; probe candidate angles with `scripts/dev-tune.mjs` until `low` ≈ 0 and the standing sole is flat at 0. Known-good triples at standing pelvis heights: trailing grazing toe `hip 15 / knee 36 / ankle 33` (pelvisY 0.527), collected free foot beside the support foot `hip 2 / knee 50 / ankle 42` (pelvisY 0.525).
