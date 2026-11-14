/** An operation's planning report as the result panel lists it (src/cam/report.ts), and arcs in every plane. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUT, reportHeadlines, reportRows } from '../src/cam/report.ts';
import { curvePoint } from '../src/cam/stream.ts';
import { alongMove, moveStart, tipAt, type Motion } from '../src/cam/motion.ts';

test('a report of any shape is listed whole', () => {
  const rows = reportRows({ strategy: 'x', depth_passes: 2, ok: true, missing: null, sizes_mm: [1, 2.5], diagnostics: ['loop 2 has no tab'], nested: { a_b: 0.1 + 0.2 }, layers: [{ tip_z_mm: 5.5 }, { tip_z_mm: 3 }], empty: [] });
  const text = rows.map((row) => `${'  '.repeat(row.depth)}${row.label}${row.value === null ? ':' : ` = ${row.value}`}${row.tone ? ' !' : ''}`);
  assert.deepEqual(text, [
    'strategy = x', 'depth passes = 2', 'ok = yes', 'missing = —', 'sizes mm = 1, 2.5',
    'diagnostics (1): !', '  · = loop 2 has no tab !',
    'nested:', '  a b = 0.3',
    'layers (2):', '  1:', '    tip z mm = 5.5', '  2:', '    tip z mm = 3',
    'empty = none',
  ]);
  assert.deepEqual(reportRows(null), []);
  assert.deepEqual(reportRows('odd').map((row) => row.value), ['odd']);
  // More rows than the limit (1 heading and 50 × 2 here) are counted, never dropped silently.
  const long = reportRows({ values: Array.from({ length: 50 }, (_, index) => ({ index })) }, 10);
  assert.equal(long.length, 11);
  assert.deepEqual(long.at(-1), { depth: 0, label: CUT, value: '91 more values aren’t listed', tone: 'warn' });
  // What the server cut from a long report shows as a row to notice.
  assert.deepEqual(reportRows({ layers: [{ [CUT]: '12 more of 16 not listed' }] }).at(-1), { depth: 2, label: CUT, value: '12 more of 16 not listed', tone: 'warn' });
});

test('an adaptive clearing’s proof is said as camlib reported it', () => {
  const layer = (proven: number, confined: number) => ({ tip_z_mm: 0, clearing: { engagement_limit_deg: 60, proven_max_engagement_deg: proven, engagement_proved_strokes: 100, wall_passes: 1,
    confined_strokes: confined, confined_stroke_mm: confined * 0.5, confined_max_engagement_deg: confined ? 107.3 : 0, diagnostics: ['every stroke is certified'] } });
  const lines = reportHeadlines({ clearing: 'engagement_front', max_engagement_deg: 60, layers: [layer(59.9, 6), layer(58, 0)] }).map((line) => line.text);
  assert.deepEqual(lines, [
    'Engagement proven on 200 strokes: at most 59.9° (limit 60°)',
    '6 strokes in confined material cut as entry moves at the entry feed, not within that limit: 3 mm, up to 107.3°',
    '2 wall passes over 2 levels',
    'every stroke is certified',
  ]);
  // Nothing is claimed that the report doesn't say.
  assert.deepEqual(reportHeadlines({ strategy: 'contour', loops: 1 }), []);
  assert.deepEqual(reportHeadlines({ strategy: 'thermal_cut', pierces: 12, cut_length_mm: 2400, rapid_length_mm: 900, feed_seconds: 54, dwell_seconds: 6, crop_length_mm: 300 }).map((line) => line.text), [
    '12 pierces, 2400 mm of cut, 900 mm of travel between cuts',
    'About 1 min cutting at the programmed feeds (6 s of it pierce delays); travel and the controller’s own height moves come on top',
    'Crop cut last: 300 mm',
  ]);
  assert.deepEqual(reportHeadlines(null), []);
  assert.deepEqual(reportHeadlines({ shadow_error_mm: 0.004, diagnostics: ['loop 2 of the region has no tab position: it is cut free'] }).map((line) => [line.text, line.tone]), [
    ['Shadow error at most 0.004 mm (the cutter’s flat against the levels cut)', undefined], ['loop 2 of the region has no tab position: it is cut free', 'warn'],
  ]);
});

/** One arc as a player motion (float32 columns, as a stream fills them). */
const arc = (start: [number, number, number], end: number[], center: number[], sweep: number, plane: number, restarts = new Map<number, [number, number, number]>()): Motion => ({
  first: 0, count: 1, start, restarts, end: new Float32Array(end), kind: new Uint8Array(1), operation: new Uint32Array(1), tool: new Uint32Array(1), rpm: new Float32Array(1),
  feed: new Float32Array(1), line: new Uint32Array(1), arcs: { curve: new Uint8Array([1]), center: new Float32Array(center), sweep: new Float32Array([sweep]), plane: new Uint8Array([plane]) },
});
const near = (got: ArrayLike<number>, want: number[]) => want.forEach((value, axis) => assert.ok(Math.abs(got[axis] - value) < 1e-6, `${[...Array.from(got)]} ≠ ${want}`));

test('arcs turn the right way in every plane', () => {
  // camlib: a positive sweep is right-handed about the plane's normal (python/camlib/motion.py): about +Z from +X to
  // +Y; in XZ about +Y, from +Z to +X (a lathe's G18); in YZ about +X, from +Y to +Z. A third of a quarter turn (30°)
  // tells the direction: the mirror image has the other sign.
  const s = Math.sin(Math.PI / 6), c = Math.cos(Math.PI / 6), quarter = Math.PI / 2;
  near(alongMove(arc([1, 0, 0], [0, 1, 0], [0, 0, 0], quarter, 0), 0, [1, 0, 0], 1 / 3, [0, 0, 0]), [c, s, 0]);
  near(alongMove(arc([0, 0, 1], [1, 0, 0], [0, 0, 0], quarter, 1), 0, [0, 0, 1], 1 / 3, [0, 0, 0]), [s, 0, c]);
  near(alongMove(arc([0, 1, 0], [0, 0, 1], [0, 0, 0], quarter, 2), 0, [0, 1, 0], 1 / 3, [0, 0, 0]), [0, c, s]);
  // Clockwise (a negative sweep) in XZ: from +X back to +Z, off-centre and away from the origin (a turned fillet).
  near(alongMove(arc([25, 0, -10], [20, 0, -5], [20, 0, -10], -quarter, 1), 0, [25, 0, -10], 1 / 3, [0, 0, 0]), [20 + 5 * c, 0, -10 + 5 * s]);
  // The stream reader's own interpolation agrees, plane by name.
  near(curvePoint([0, 0, 1], [1, 0, 0], 'arc', [0, 0, 0], quarter, 'xz', 1 / 3), [s, 0, c]);
  near(curvePoint([0, 1, 0], [0, 0, 1], 'arc', [0, 0, 0], quarter, 'yz', 1 / 3), [0, c, s]);
  near(curvePoint([25, 0, -10], [20, 0, -5], 'arc', [20, 0, -10], -quarter, 'xz', 1 / 3), [20 + 5 * c, 0, -10 + 5 * s]);
  // A helix in XZ advances along Y as it turns.
  near(curvePoint([0, 0, 1], [1, 4, 0], 'helix', [0, 0, 0], quarter, 'xz', 0.5), [Math.SQRT1_2, 2, Math.SQRT1_2]);
});

test('a move after a tool change starts where the change left the tip', () => {
  const motion: Motion = {
    first: 0, count: 2, start: [0, 0, 60], restarts: new Map([[1, [10, 0, 45]]]), end: new Float32Array([10, 0, 30, 20, 0, 45]),
    kind: new Uint8Array(2), operation: new Uint32Array(2), tool: new Uint32Array(2), rpm: new Float32Array(2), feed: new Float32Array(2), line: new Uint32Array(2),
  };
  assert.deepEqual(moveStart(motion, 1), [10, 0, 45]);
  assert.deepEqual(tipAt(motion, 1), [10, 0, 45]);
  assert.deepEqual(tipAt(motion, 1.5), [15, 0, 45]);
  assert.deepEqual(tipAt(motion, 0.5), [5, 0, 45]);
});
