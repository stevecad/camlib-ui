/**
 * A lathe setup's stock as the 3D view draws it: camlib's own turned stock from the playback stream (per z bin the
 * bounds of the bar's outer radius and of its bore's radius; docs/playback-stream.md "Turned stock") revolved about the
 * spindle axis (the work's Z), with a quarter cut away so the section and the tool in it show.
 *
 * What is drawn is the most material that may still be there: each bin's outer radius' upper bound around its bore's
 * lower bound. Display only: camlib's checks, not this mesh, decide. No imports, so it runs under plain Node
 * (tests/turned.test.ts).
 */

export interface TurnedGrid { nx: number; z_min_mm: number; z_max_mm: number }
export interface TurnedMesh { positions: Float32Array; normals: Float32Array; indices: Uint32Array }
export interface TurnedOptions {
  /** Steps round the axis over the sweep. */
  segments?: number;
  /** Where the material starts and how far round it goes (radians about +Z from +X): three quarters by default. */
  start?: number; sweep?: number;
}

/** A step between neighbouring bins up to this many bin lengths is shaded as a slope (a cone or a fillet), not a wall. */
const SLOPE_STEPS = 2.5;

/** Each bin's material, [bore, outer] (mm): the bore's lower bound and the outer radius' upper bound; outer ≤ bore: none. */
export function turnedBins(nx: number, grid: ArrayLike<number>): { bore: Float32Array; outer: Float32Array } {
  const bore = new Float32Array(nx), outer = new Float32Array(nx);
  for (let i = 0; i < nx; i++) { outer[i] = grid[2 * i + 1]; bore[i] = Math.max(0, grid[2 * (nx + i)]); }
  return { bore, outer };
}

/** The half-section's outline, (r, z) from the back of the bar along its outside to the front: what a 2D view draws. */
export function turnedOutline(stock: TurnedGrid, grid: ArrayLike<number>): [number, number][] {
  const { outer } = turnedBins(stock.nx, grid);
  const dz = (stock.z_max_mm - stock.z_min_mm) / stock.nx;
  const out: [number, number][] = [];
  for (let i = 0; i < stock.nx; i++) out.push([outer[i], stock.z_min_mm + i * dz], [outer[i], stock.z_min_mm + (i + 1) * dz]);
  return out;
}

/**
 * The stock as a closed triangle mesh in work coordinates (x = r cos φ, y = r sin φ, z): per bin its outside and its
 * bore, the faces between bins where their material differs, and the two cut faces of the section.
 */
export function turnedMesh(stock: TurnedGrid, grid: ArrayLike<number>, options: TurnedOptions = {}): TurnedMesh {
  const { segments = 72, start = 0, sweep = 1.5 * Math.PI } = options;
  const full = sweep >= 2 * Math.PI - 1e-9;
  const nx = stock.nx, dz = (stock.z_max_mm - stock.z_min_mm) / nx;
  const { bore, outer } = turnedBins(nx, grid);
  const has = (i: number) => i >= 0 && i < nx && outer[i] > bore[i] + 1e-9;
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const cos = new Float64Array(segments + 1), sin = new Float64Array(segments + 1);
  for (let j = 0; j <= segments; j++) { const a = start + (sweep * j) / segments; cos[j] = Math.cos(a); sin[j] = Math.sin(a); }

  /**
   * A band round the axis between (r0, z0) and (r1, z1), its normal (nr, nz) in the half-section. Unflipped it faces +Z
   * (r0 < r1 at one z) or the axis (r0 = r1, z0 < z1); `flip` turns it round.
   */
  const band = (r0: number, z0: number, r1: number, z1: number, nr: number, nz: number, flip: boolean) => {
    const base = positions.length / 3;
    for (let j = 0; j <= segments; j++) {
      positions.push(r0 * cos[j], r0 * sin[j], z0, r1 * cos[j], r1 * sin[j], z1);
      normals.push(nr * cos[j], nr * sin[j], nz, nr * cos[j], nr * sin[j], nz);
    }
    for (let j = 0; j < segments; j++) {
      const a = base + 2 * j, b = a + 1, c = a + 2, d = a + 3;
      if (flip) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
    }
  };
  /** The slope dr/dz a surface is shaded with at bin i (0 where a neighbour's step is a wall). */
  const slope = (radius: Float32Array, i: number) => {
    const before = has(i - 1) ? radius[i - 1] : radius[i], after = has(i + 1) ? radius[i + 1] : radius[i];
    if (Math.abs(radius[i] - before) > SLOPE_STEPS * dz || Math.abs(after - radius[i]) > SLOPE_STEPS * dz) return 0;
    return (after - before) / (((has(i - 1) ? 1 : 0) + (has(i + 1) ? 1 : 0)) * dz || 1);
  };
  /** The faces across the plane z between material [a0, a1] below it and [b0, b1] above it (either may be empty). */
  const between = (z: number, a0: number, a1: number, b0: number, b1: number, nrBelow: number, nrAbove: number) => {
    const below = a1 > a0, above = b1 > b0;
    const face = (r0: number, r1: number, up: boolean, nr: number) => {
      if (r1 <= r0 + 1e-9) return;
      // A small step of a slope takes the slope's shading; a wall faces along the axis.
      const small = r1 - r0 <= SLOPE_STEPS * dz && nr !== 0;
      const length = small ? Math.hypot(1, nr) : 1;
      band(r0, z, r1, z, small ? 1 / length : 0, small ? -nr / length : up ? 1 : -1, !up);
    };
    if (below && !above) face(a0, a1, true, 0);
    else if (above && !below) face(b0, b1, false, 0);
    else if (below && above) {
      // Below's material that above doesn't cover faces +Z; above's that below doesn't cover faces −Z.
      face(Math.max(a0, b1), a1, true, nrBelow); face(a0, Math.min(a1, b0), true, 0);
      face(Math.max(b0, a1), b1, false, nrAbove); face(b0, Math.min(b1, a0), false, 0);
    }
  };
  for (let i = 0; i < nx; i++) {
    const z0 = stock.z_min_mm + i * dz, z1 = z0 + dz;
    const so = has(i) ? slope(outer, i) : 0;
    if (has(i)) {
      const lo = Math.hypot(1, so);
      band(outer[i], z0, outer[i], z1, 1 / lo, -so / lo, true);
      if (bore[i] > 1e-9) { const sb = slope(bore, i), lb = Math.hypot(1, sb); band(bore[i], z0, bore[i], z1, -1 / lb, sb / lb, false); }
    }
    if (i === 0 && has(0)) between(z0, 0, 0, bore[0], outer[0], 0, 0);
    const next = has(i + 1);
    between(z1, has(i) ? bore[i] : 0, has(i) ? outer[i] : 0, next ? bore[i + 1] : 0, next ? outer[i + 1] : 0, so, next ? slope(outer, i + 1) : 0);
  }
  if (!full) {
    // The section's two faces: each bin's rectangle between its bore and its outside, in the cut planes.
    for (const [j, sign] of [[0, -1], [segments, 1]] as const) {
      const nxn = -sign * sin[j], nyn = sign * cos[j];
      for (let i = 0; i < nx; i++) {
        if (!has(i)) continue;
        const z0 = stock.z_min_mm + i * dz, z1 = z0 + dz, base = positions.length / 3;
        for (const [r, z] of [[bore[i], z0], [outer[i], z0], [bore[i], z1], [outer[i], z1]] as const) {
          positions.push(r * cos[j], r * sin[j], z);
          normals.push(nxn, nyn, 0);
        }
        if (sign < 0) indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2); else indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

/** The volume a mesh encloses (mm³), from its triangles: positive when they face outward (a check of the mesh above). */
export function meshVolume(mesh: TurnedMesh): number {
  const p = mesh.positions;
  let six = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] * 3, b = mesh.indices[t + 1] * 3, c = mesh.indices[t + 2] * 3;
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return six / 6;
}
