# TAngle

*Tango + Angle* — an interactive 3D tool for teaching Argentine tango: pose two dancers with
anatomically constrained joints, view them as skeleton / body / muscles, and
read off the biomechanics — center of gravity, base of support, balance
margin, and joint angles — including before/after comparisons between poses.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL (usually http://localhost:5173).

To make a shareable static build: `npm run build` → the `dist/` folder can be
hosted anywhere (or opened via `npm run preview`).

## How to use

| Action | How |
| --- | --- |
| Orbit / zoom camera | drag on empty space / scroll |
| Rotate a joint | **Rotate joints** mode → click a joint → drag the rings, or use the sliders in the panel |
| Pose a whole limb | **Drag hand/foot** mode → click a hand or foot → drag the target; the arm/leg follows with natural elbow/knee bend |
| Move / turn a dancer | **Move figure** / **Turn figure** modes → click a dancer → drag |
| Crouch / rise | select the pelvis → "Hip height" slider |
| Change views | View section: Skeleton / Body / Muscles (any combination) |
| Compare two poses | pose → **Set A** → change the pose → **Set B**; the table lists every joint change ≥ 3° |
| Save & share poses | Poses section: save to the browser, or Export/Import `.json` files |

Every joint respects a simplified anatomical range of motion — the knee is a
pure hinge, the hip and shoulder are ball joints with realistic limits, the
spine bends across three segments. You cannot put a figure into an impossible
position with either the gizmo or the sliders.

## The statistics

- **Center of gravity** (per dancer, and combined for the couple) is computed
  from segment masses using the de Leva (1996) anthropometric tables, i.e. the
  same model used in biomechanics courses. Shown as a floating ball with a
  dashed drop line to the floor.
- **Base of support** is the convex hull of the foot-sole corners that touch
  the floor (a foot on its toes contributes only the toe area).
- **Balance margin** is the distance from the COG's floor projection to the
  edge of the base of support — green/positive when balanced, red/negative
  when off balance. The *couple* margin uses both dancers' feet and their
  combined COG, which is exactly the physics of an apilado lean: each dancer
  can be individually "off balance" while the couple is stable.
- **Joint angles** are shown live, and the A/B comparison lists per-joint
  changes between two saved snapshots.

## Project layout

- `src/skeletonDef.js` — the anatomy: joint hierarchy, proportions
  (Drillis–Contini), per-axis joint limits, de Leva mass model, IK chains.
- `src/figure.js` — builds a dancer: joint nodes plus three visual layers
  (skeleton, mannequin body, major muscles).
- `src/ik.js` — analytic two-bone IK with limit clamping; feet-to-floor helper.
- `src/analysis.js` — COG, foot contacts, convex hull, stability margin, key angles.
- `src/presets.js` — starting poses (embrace, walk, apilado, dissociation).
- `src/main.js` — scene, picking, gizmos, modes, balance visuals.
- `src/ui.js` — side panel: sliders, stats, A/B compare, pose library.

## Roadmap ideas

- Replace the mannequin body with a skinned glTF mesh (smooth deformation,
  real clothing) driven by the same skeleton.
- Contact/connection constraints between partners (keep hands joined while
  posing the rest of the body).
- Pose-to-pose animation (tween A → B) to show the transition, not just the
  endpoints.
- Weight distribution between the two feet (which leg is the standing leg).
- Floor-plan view with step diagrams; export images for handouts.
