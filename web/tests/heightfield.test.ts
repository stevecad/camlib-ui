/** The display stock's simulation (src/cam/heightfield.ts) and its input from a playback stream (simPlan). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeightField, HeightSim, millProfile, type SimMoves } from '../src/cam/heightfield.ts';
import { simPlan, simPosition } from '../src/cam/playback.ts';
import type { Motion } from '../src/cam/motion.ts';
import type { StreamSetup } from '../src/cam/stream.ts';

const near = (a: number, b: number, tolerance: number, what: string) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} ≠ ${b} ± ${tolerance}`);

test('a level move of a flat end mill cuts a slot its diameter wide, to its depth', () => {
  const field = new HeightField([0, 0, 0], [40, 20, 20], 0.05);
  field.cut([5, 10, 15], [35, 10, 15], 0, 1, millProfile(6), 1);
  near(field.at(20, 10), 15, 1e-6, 'floor');
  near(field.at(20, 12.9), 15, 1e-6, 'just inside the wall');
  near(field.at(20, 13.1), 20, 1e-6, 'just outside the wall');
  // The slot's ends are round: 3 mm beyond the end point on the axis, less off it.
  near(field.at(37.9, 10), 15, 1e-6, 'end, on the axis');
  near(field.at(37.9, 12), 20, 1e-6, 'end, off the axis');
});

test('a ball end mill leaves its own scallop', () => {
  const field = new HeightField([0, 0, 0], [20, 20, 20], 0.05);
  field.cut([10, 2, 10], [10, 18, 10], 0, 1, millProfile(8, 4), 1);
  // 2 mm off the axis a 4 mm ball sits 4 − √(16 − 4) above its tip.
  near(field.at(12.025, 10), 10 + 4 - Math.sqrt(16 - 2.025 ** 2), 0.01, 'scallop');
  near(field.at(10.025, 10), 10, 0.01, 'bottom');
});

test('seeking back and forth gives the field playing forward gives', () => {
  const moves: SimMoves = {
    count: 3, start: new Float64Array([2, 2, 25, 2, 2, 15, 18, 2, 15]), end: new Float64Array([2, 2, 15, 18, 2, 15, 18, 18, 12]),
    cutter: new Int16Array([0, 0, 0]), tag: new Uint8Array([1, 1, 2]),
  };
  const fresh = () => new HeightSim(new HeightField([0, 0, 0], [20, 20, 20], 0.1), moves, [millProfile(4)], { snapshotWork: 1000 });
  const played = fresh();
  played.seek(2.5);
  const jumped = fresh();
  jumped.seek(3); jumped.seek(0.5); jumped.seek(2.5);
  assert.deepEqual([...jumped.field.h], [...played.field.h]);
  assert.equal(jumped.position, played.position);
});

test('arcs are cut as chords, and player positions map onto them', () => {
  // A half circle of radius 10 about (10, 0) from (0, 0) to (20, 0), then a line.
  const motion: Motion = {
    first: 0, count: 2, start: [0, 0, 5], restarts: new Map(),
    end: new Float32Array([20, 0, 5, 30, 0, 5]), kind: new Uint8Array(2), operation: new Uint32Array(2), tool: new Uint32Array([0, 0]),
    rpm: new Float32Array(2), feed: new Float32Array(2), line: new Uint32Array(2),
    arcs: { curve: new Uint8Array([1, 0]), center: new Float32Array([10, 0, 5, 0, 0, 0]), sweep: new Float32Array([-Math.PI, 0]), plane: new Uint8Array(2) },
  };
  const tool = { id: 't', name: 't', shape: { kind: 'flat' }, diameter_mm: 4, cutting_length_mm: 10, overall_length_mm: 40, shank_diameter_mm: 4, flutes: 2, stickout_mm: 20, gauge_length_mm: 60, holders: [] };
  const header = { stock: { min_mm: [-5, -15, 0], max_mm: [35, 15, 10], nx: 80, ny: 60, cell_mm: [0.5, 0.5] }, tools: [tool] } as unknown as StreamSetup;
  const plan = simPlan({ header, motion, bands: [{ operation: 'a', index: 0, first: 0, last: 1 }] })!;
  assert.equal(plan.moves.count, 24 + 1);
  // Every chord of the arc ends on the circle; clockwise from (0, 0) the arc goes through (10, 10).
  for (let s = 0; s < 24; s++) near(Math.hypot(plan.moves.end[s * 3] - 10, plan.moves.end[s * 3 + 1]), 10, 1e-9, `chord ${s}`);
  near(plan.moves.end[11 * 3 + 1], 10, 1e-9, 'top of the arc');
  assert.equal(simPosition(plan.starts, 0.5), 12);
  assert.equal(simPosition(plan.starts, 1.5), 24.5);
  assert.equal(simPosition(plan.starts, 9), 25);
  near(plan.cell, 0.05, 1e-12, 'cell for a 4 mm cutter');
});
