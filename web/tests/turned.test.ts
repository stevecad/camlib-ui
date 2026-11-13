/**
 * The turned stock the 3D view draws (src/cam/turnedStock.ts) and the stream reader's turned grid: the mesh is closed
 * and faces outward (its volume is the stock's), a section is the same solid cut, and steps between bins get walls.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshVolume, turnedBins, turnedMesh, turnedOutline } from '../src/cam/turnedStock.ts';
import { initialGrid, volume, type StreamSetup } from '../src/cam/stream.ts';
import { simPlan } from '../src/cam/playback.ts';
import type { Motion } from '../src/cam/motion.ts';

/** A turned stock's grid: per bin [outer lower, outer upper], then per bin [bore lower, bore upper]. */
function grid(outer: number[], bore: number[]): Float32Array {
  const out = new Float32Array(outer.length * 4);
  outer.forEach((r, i) => { out[2 * i] = r; out[2 * i + 1] = r; });
  bore.forEach((r, i) => { out[2 * (outer.length + i)] = r; out[2 * (outer.length + i) + 1] = r; });
  return out;
}

/** The volume of a ring of bins as a polygon of `segments` sides round the axis draws it, over `sweep` radians. */
const drawn = (outer: number[], bore: number[], dz: number, segments: number, sweep: number) =>
  outer.reduce((sum, r, i) => sum + (r > bore[i] ? (r * r - bore[i] * bore[i]) * dz : 0), 0) * 0.5 * segments * Math.sin(sweep / segments);

test('the mesh of a bar is closed and faces outward', () => {
  const stock = { nx: 4, z_min_mm: -4, z_max_mm: 0 };
  const bar = grid([10, 10, 10, 10], [0, 0, 0, 0]);
  const whole = turnedMesh(stock, bar, { segments: 48, sweep: 2 * Math.PI });
  assert.ok(Math.abs(meshVolume(whole) - drawn([10, 10, 10, 10], [0, 0, 0, 0], 1, 48, 2 * Math.PI)) < 1e-3);
  // Three quarters of it, with the section's two faces closing it.
  const cut = turnedMesh(stock, bar, { segments: 48 });
  assert.ok(Math.abs(meshVolume(cut) - drawn([10, 10, 10, 10], [0, 0, 0, 0], 1, 48, 1.5 * Math.PI)) < 1e-3);
  assert.ok(meshVolume(cut) > 0.74 * Math.PI * 100 * 4 && meshVolume(cut) < 0.75 * Math.PI * 100 * 4);
  // Every normal is a unit vector.
  for (let i = 0; i < cut.normals.length; i += 3) assert.ok(Math.abs(Math.hypot(cut.normals[i], cut.normals[i + 1], cut.normals[i + 2]) - 1) < 1e-6);
});

test('steps, a bore and an empty bin are meshed as the solid they are', () => {
  // A shoulder, a bored front and a bin parted off (no material) between two pieces.
  const outer = [12, 12, 0, 8, 8, 5], bore = [0, 0, 0, 0, 3, 3];
  const stock = { nx: 6, z_min_mm: 0, z_max_mm: 3 };
  for (const sweep of [2 * Math.PI, 1.5 * Math.PI]) {
    const mesh = turnedMesh(stock, grid(outer, bore), { segments: 36, sweep });
    assert.ok(Math.abs(meshVolume(mesh) - drawn(outer, bore, 0.5, 36, sweep)) < 1e-3, `sweep ${sweep}`);
  }
  // Nothing is drawn where a bin's bore is not inside its outside.
  const none = turnedMesh(stock, grid([2, 2, 2, 2, 2, 2], [2, 2, 3, 3, 2, 2]));
  assert.equal(none.indices.length, 0);
});

test('a slope is shaded as a slope, a shoulder as a wall', () => {
  // 0.1 mm a bin along 1 mm bins: a cone. Its outside normals lean toward +Z (the radius falls toward +Z).
  const cone = turnedMesh({ nx: 5, z_min_mm: 0, z_max_mm: 5 }, grid([10, 9.9, 9.8, 9.7, 9.6], [0, 0, 0, 0, 0]), { segments: 8, sweep: 2 * Math.PI });
  const leaning = [...cone.normals].filter((_, i) => i % 3 === 2).filter((nz) => nz > 0.05 && nz < 0.2).length;
  assert.ok(leaning > 0);
  // A 5 mm shoulder: its wall faces straight along the axis.
  const step = turnedMesh({ nx: 2, z_min_mm: 0, z_max_mm: 2 }, grid([10, 5], [0, 0]), { segments: 8, sweep: 2 * Math.PI });
  const along = new Set([...step.normals].filter((_, i) => i % 3 === 2).map((nz) => Math.round(nz * 1e6) / 1e6));
  assert.deepEqual([...along].sort(), [-1, 0, 1]);
});

test('the bins drawn are the most material there may be', () => {
  // Outer radius bounds [9, 10], bore bounds [2, 3]: drawn from 2 to 10.
  const bins = turnedBins(1, new Float32Array([9, 10, 2, 3]));
  assert.deepEqual([bins.bore[0], bins.outer[0]], [2, 10]);
  assert.deepEqual(turnedOutline({ nx: 2, z_min_mm: -1, z_max_mm: 0 }, grid([4, 6], [0, 0])), [[4, -1], [4, -0.5], [6, -0.5], [6, 0]]);
});

test('a turned stream starts as its bar and counts rings of material', () => {
  const setup = { stock: { kind: 'turned', nx: 4, ny: 2, cell_mm: [0.5, 0.5], min_mm: [-10, -10, -2], max_mm: [10, 10, 0], z_min_mm: -2, z_max_mm: 0, outer_radius_mm: 10, bore_radius_mm: 4 } } as unknown as StreamSetup;
  const start = initialGrid(setup);
  assert.deepEqual([...start], [10, 10, 10, 10, 10, 10, 10, 10, 4, 4, 4, 4, 4, 4, 4, 4]);
  const [upper, lower] = volume(setup, start);
  assert.ok(Math.abs(upper - Math.PI * (100 - 16) * 2) < 1e-3 && upper === lower);
  // One bin turned down to between 6 and 7 mm: the most and the least that is left.
  start[0] = 6; start[1] = 7;
  const [most, least] = volume(setup, start);
  assert.ok(Math.abs(most - (upper - Math.PI * (100 - 49) * 0.5)) < 1e-3 && Math.abs(least - (upper - Math.PI * (100 - 36) * 0.5)) < 1e-3);
});

test('a lathe setup and a sheet show camlib’s own stock, not a swept cutter’s', () => {
  const motion = { first: 0, count: 0, start: [0, 0, 0], restarts: new Map(), end: new Float32Array(0), kind: new Uint8Array(0), operation: new Uint32Array(0),
    tool: new Uint32Array(0), rpm: new Float32Array(0), feed: new Float32Array(0), line: new Uint32Array(0) } as unknown as Motion;
  const mill = { id: 'em6', name: 'em6', shape: { kind: 'flat' }, diameter_mm: 6, cutting_length_mm: 18, overall_length_mm: 60, shank_diameter_mm: 6, flutes: 3, stickout_mm: 30,
    gauge_length_mm: 100, holders: [{ z_min_mm: 30, z_max_mm: 100, radius_min_mm: 17, radius_max_mm: 17 }] };
  const box = { min_mm: [0, 0, 0], max_mm: [10, 10, 5], nx: 20, ny: 20, cell_mm: [0.5, 0.5] };
  const header = (stock: object, tools: object[]) => ({ header: { stock, tools } as unknown as StreamSetup, motion, bands: [] });
  // A milling setup's display stock is a height field cut by its tools' profiles.
  assert.ok(simPlan(header(box, [mill])));
  // A torch cuts the sheet through from above it; a turned stock isn't a height field.
  assert.equal(simPlan(header(box, [{ ...mill, shape: { kind: 'beam' } }])), null);
  assert.equal(simPlan(header({ ...box, kind: 'turned', ny: 2, z_min_mm: -5, z_max_mm: 0, outer_radius_mm: 10, bore_radius_mm: 0 }, [{ id: 't', name: 't', turning: {} }])), null);
});
