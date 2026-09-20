// A uniform grid over a point cloud, for the bind-time "how far is this muscle
// vertex from that bone" questions (Figure's contact pins, SpineColumn's trunk
// field). Those were brute-force scans — every belly vertex against every cloud
// point — which is fine for one belly against 3000 points and is over a second
// of load per dancer once a dozen trunk sheets each ask it of three clouds.
//
// `pts` is a flat array with the position in the first three of every `stride`
// numbers; queries hand back the OFFSET of a point in it, so a caller can keep
// its own payload beside the position (the rib samples carry level + share).

const _grids = new WeakMap();

export class PointGrid {
  // One grid per (cloud, stride, cell) — the clouds are cached per node and
  // asked about by every belly on both sides.
  static of(pts, stride = 3, cell = 0.02) {
    let byKey = _grids.get(pts);
    if (!byKey) _grids.set(pts, byKey = new Map());
    const key = `${stride}:${cell}`;
    let grid = byKey.get(key);
    if (!grid) byKey.set(key, grid = new PointGrid(pts, stride, cell));
    return grid;
  }

  constructor(pts, stride = 3, cell = 0.02) {
    this.pts = pts;
    this.cell = cell;
    this.cells = new Map();
    for (let o = 0; o + 2 < pts.length; o += stride) {
      const k = this.#key(Math.floor(pts[o] / cell), Math.floor(pts[o + 1] / cell), Math.floor(pts[o + 2] / cell));
      const list = this.cells.get(k);
      if (list) list.push(o); else this.cells.set(k, [o]);
    }
  }

  // Cell coordinates stay within a few hundred of zero (metres / 2 cm), so
  // 11 bits an axis is room to spare and the key is one small integer.
  #key(ix, iy, iz) { return ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024); }

  // Distance to the nearest point, or `maxDist` if none lies within it.
  nearest(x, y, z, maxDist = 0.25) {
    const { pts, cell, cells } = this;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = maxDist * maxDist;
    const rings = Math.ceil(maxDist / cell);
    // Ring r holds nothing nearer than (r − 1) cells, so stop once that beats it.
    for (let r = 0; r <= rings && (r - 1) * cell < Math.sqrt(best); r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iy = cy - r; iy <= cy + r; iy++) {
          const edge = Math.abs(ix - cx) === r || Math.abs(iy - cy) === r;
          for (let iz = cz - r; iz <= cz + r; iz += edge ? 1 : Math.max(1, 2 * r)) {
            const list = cells.get(this.#key(ix, iy, iz));
            if (!list) continue;
            for (const o of list) {
              const dx = x - pts[o], dy = y - pts[o + 1], dz = z - pts[o + 2];
              const d = dx * dx + dy * dy + dz * dz;
              if (d < best) best = d;
            }
          }
        }
      }
    }
    return Math.sqrt(best);
  }

  // Call cb(offset, distance) for every point within `radius`.
  within(x, y, z, radius, cb) {
    const { pts, cell, cells } = this;
    const r2 = radius * radius;
    const x0 = Math.floor((x - radius) / cell), x1 = Math.floor((x + radius) / cell);
    const y0 = Math.floor((y - radius) / cell), y1 = Math.floor((y + radius) / cell);
    const z0 = Math.floor((z - radius) / cell), z1 = Math.floor((z + radius) / cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = cells.get(this.#key(ix, iy, iz));
          if (!list) continue;
          for (const o of list) {
            const dx = x - pts[o], dy = y - pts[o + 1], dz = z - pts[o + 2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d <= r2) cb(o, Math.sqrt(d));
          }
        }
      }
    }
  }
}
