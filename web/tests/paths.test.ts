/**
 * Hiding and showing toolpaths (src/cam/pathVisibility.ts) and the line geometry they are left out of
 * (src/cam/toolpathLines.ts): the eye's state, what is kept between visits, the rule for the moves between operations,
 * and the vertex ranges drawn for what is shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawRanges, hiddenCount, hiddenOwners, moveOwners, ownerRuns, parseStored, pathHidden, pruned, samePaths, setupState, setupToggled, soloed, storageKey, stored,
  toggled, type ProjectPaths, type SetupPaths,
} from '../src/cam/pathVisibility.ts';
import { toolpathLines } from '../src/cam/toolpathLines.ts';
import { UNASSIGNED, type Motion } from '../src/cam/motion.ts';

const ALL = ['face', 'outline', 'holes', 'adaptive'];
const U = UNASSIGNED;

test('an eye hides a shown toolpath and shows a hidden one; a new operation is shown', () => {
  let paths: SetupPaths | undefined;
  assert.equal(pathHidden(paths, 'face'), false);
  paths = toggled(paths, 'face');
  assert.deepEqual(paths, { hidden: ['face'], solo: null });
  assert.equal(pathHidden(paths, 'face'), true);
  assert.equal(pathHidden(paths, 'outline'), false);
  assert.equal(pathHidden(paths, 'never seen before'), false);
  paths = toggled(paths, 'holes');
  assert.deepEqual(paths.hidden, ['face', 'holes']);
  paths = toggled(paths, 'face');
  assert.deepEqual(paths, { hidden: ['holes'], solo: null });
  assert.equal(hiddenCount(paths, ALL), 1);
  // An id hidden that the setup doesn't have (not built yet) doesn't count.
  assert.equal(hiddenCount({ hidden: ['holes', 'gone'], solo: null }, ALL), 1);
});

test('show only one, and the same again puts back what was hidden before', () => {
  const before: SetupPaths = { hidden: ['holes'], solo: null };
  const alone = soloed(before, 'outline', ALL);
  assert.deepEqual(alone.hidden, ['face', 'holes', 'adaptive']);
  assert.deepEqual(alone.solo, { operation: 'outline', before: ['holes'] });
  assert.deepEqual(soloed(alone, 'outline', ALL), before);
  // From nothing hidden: back to nothing hidden.
  assert.deepEqual(soloed(soloed(undefined, 'face', ALL), 'face', ALL), { hidden: [], solo: null });
});

test('from one operation alone to another keeps what the first remembered', () => {
  const before: SetupPaths = { hidden: ['holes'], solo: null };
  const second = soloed(soloed(before, 'outline', ALL), 'adaptive', ALL);
  assert.deepEqual(second.hidden, ['face', 'outline', 'holes']);
  assert.deepEqual(second.solo, { operation: 'adaptive', before: ['holes'] });
  assert.deepEqual(soloed(second, 'adaptive', ALL), before);
});

test('a change by hand ends "only this one"; alone by hand goes back to all shown', () => {
  const alone = soloed({ hidden: ['holes'], solo: null }, 'outline', ALL);
  const changed = toggled(alone, 'face');
  assert.deepEqual(changed, { hidden: ['holes', 'adaptive'], solo: null });
  // Showing only `outline` now remembers the state changed by hand.
  const again = soloed(changed, 'outline', ALL);
  assert.deepEqual(again.solo?.before, ['holes', 'adaptive']);
  assert.deepEqual(soloed(again, 'outline', ALL), changed);
  // Hidden one by one until one is left: there is nothing remembered, so the others come back.
  const byHand: SetupPaths = { hidden: ['face', 'holes', 'adaptive'], solo: null };
  assert.deepEqual(soloed(byHand, 'outline', ALL), { hidden: [], solo: null });
  // A setup's only toolpath stays shown.
  assert.deepEqual(soloed(undefined, 'face', ['face']).hidden, []);
});

test('an operation built since one was shown alone is shown, and showing only that one again hides it', () => {
  const alone = soloed({ hidden: ['holes'], solo: null }, 'outline', ALL);
  const more = [...ALL, 'chamfer'];
  assert.equal(pathHidden(alone, 'chamfer'), false);
  const again = soloed(alone, 'outline', more);
  assert.deepEqual(again.hidden, ['face', 'holes', 'adaptive', 'chamfer']);
  assert.deepEqual(again.solo, { operation: 'outline', before: ['holes'] });
});

test('a setup’s eye: all shown, all hidden, or mixed; a click hides all or shows all', () => {
  assert.equal(setupState(undefined, ALL), 'shown');
  assert.equal(setupState({ hidden: ['face'], solo: null }, ALL), 'mixed');
  assert.equal(setupState({ hidden: [...ALL], solo: null }, ALL), 'hidden');
  assert.equal(setupState({ hidden: ['not in this setup'], solo: null }, ALL), 'shown');
  assert.equal(setupState(undefined, []), 'shown');
  assert.deepEqual(setupToggled(undefined, ALL), { hidden: ALL, solo: null });
  assert.deepEqual(setupToggled({ hidden: ['face'], solo: null }, ALL), { hidden: [], solo: null });
  assert.deepEqual(setupToggled({ hidden: [...ALL], solo: null }, ALL), { hidden: [], solo: null });
  assert.deepEqual(setupToggled(soloed(undefined, 'face', ALL), ALL), { hidden: [], solo: null });
  // Nothing built: nothing to hide.
  assert.deepEqual(setupToggled(undefined, []), { hidden: [], solo: null });
});

test('what is kept is by project, then setup id and operation id, and reads back as it was', () => {
  assert.equal(storageKey('plate'), 'camlib-ui:toolpaths:plate');
  assert.notEqual(storageKey('plate'), storageKey('bracket'));
  const paths: ProjectPaths = { top: soloed({ hidden: ['holes'], solo: null }, 'outline', ALL), bottom: { hidden: ['face'], solo: null }, side: { hidden: [], solo: null } };
  const text = stored(paths);
  assert.deepEqual(JSON.parse(text), { top: { hidden: ['face', 'holes', 'adaptive'], solo: { operation: 'outline', before: ['holes'] } }, bottom: { hidden: ['face'], solo: null } });
  assert.deepEqual(parseStored(text), { top: paths.top, bottom: paths.bottom });
  assert.ok(samePaths(parseStored(text), paths));
  assert.ok(!samePaths({}, paths));
});

test('kept text that isn’t this is nothing hidden', () => {
  for (const text of [null, undefined, '', 'eye', '[]', '3', 'null', '"top"', '{"top": 4}', '{"top": []}', '{"top": {"hidden": "face"}}', '{"top": {"hidden": []}}']) {
    assert.deepEqual(parseStored(text), {}, String(text));
  }
  assert.deepEqual(parseStored('{"top": {"hidden": ["face", 7, null, "", "face"], "solo": {"operation": 5}}}'), { top: { hidden: ['face'], solo: null } });
  assert.deepEqual(parseStored('{"top": {"hidden": ["face"], "solo": {"operation": "face", "before": "x"}}}'), { top: { hidden: ['face'], solo: { operation: 'face', before: [] } } });
});

test('an operation or a setup that is no longer built is dropped; the rest stays', () => {
  const paths: ProjectPaths = {
    top: { hidden: ['face', 'old pocket', 'holes'], solo: null },
    bottom: { hidden: ['face'], solo: null },
    flip: { hidden: ['outline', 'gone'], solo: { operation: 'holes', before: ['gone', 'outline'] } },
    lost: { hidden: ['x'], solo: { operation: 'removed', before: ['x'] } },
  };
  const built = [
    { id: 'top', operations: ['face', 'outline', 'holes', 'new one'] },
    { id: 'flip', operations: ['outline', 'holes'] },
    { id: 'lost', operations: ['y'] },
    { id: 'fresh', operations: ['face'] },
  ];
  const kept = pruned(paths, built);
  assert.deepEqual(kept, {
    top: { hidden: ['face', 'holes'], solo: null },
    flip: { hidden: ['outline'], solo: { operation: 'holes', before: ['outline'] } },
  });
  // The operation built since is shown; one built again under the same id is still hidden.
  assert.equal(pathHidden(kept.top, 'new one'), false);
  assert.equal(pathHidden(kept.top, 'face'), true);
  assert.deepEqual(pruned(kept, built), kept);
});

test('a connecting move belongs to the operation it leads to; the last retract to the operation before it', () => {
  //                 start  ── op 0 ──  link    ── op 1 ──  gap in op 1  link  op 0 again  end
  const operation = [U, U, 0, 0, 0, U, U, 1, 1, U, 1, U, 0, 0, U, U];
  assert.deepEqual([...moveOwners(operation)], [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(ownerRuns(moveOwners(operation)), [
    { owner: 0, first: 0, end: 5 }, { owner: 1, first: 5, end: 11 }, { owner: 0, first: 11, end: 16 },
  ]);
  // No move has an operation: one run that nothing hides.
  assert.deepEqual([...moveOwners([U, U, U])], [U, U, U]);
  assert.deepEqual(ownerRuns(moveOwners([U, U, U])), [{ owner: U, first: 0, end: 3 }]);
  assert.deepEqual(ownerRuns(moveOwners([])), []);
  // Only the first `count` moves.
  assert.deepEqual([...moveOwners(new Uint32Array([U, 2, U, 3]), 3)], [2, 2, 2]);
});

/** A motion of straight moves between the points given (move i ends at points[i]), with each move's operation. */
function motionOf(ends: [number, number, number][], operation: number[], extra: Partial<Motion> = {}): Motion {
  const count = ends.length;
  return {
    first: 0, count, start: [0, 0, 10], restarts: new Map(), end: new Float32Array(ends.flat()), kind: new Uint8Array(count), operation: new Uint32Array(operation),
    tool: new Uint32Array(count), rpm: new Float32Array(count), feed: new Float32Array(count), line: new Uint32Array(count), ...extra,
  };
}

test('each move’s vertices are where `first` says, arcs as several chords', () => {
  const turn = 1.5;
  const [ex, ey] = [10 * Math.cos(turn), 10 * Math.sin(turn)];
  const motion = motionOf([[10, 0, 10], [10, 0, 0], [ex, ey, 0], [ex, ey, 10]], [U, 0, 0, U], {
    // Move 2: 1.5 rad about the origin in XY (12 chords: one for each 7.5° begun).
    arcs: { curve: new Uint8Array([0, 0, 1, 0]), center: new Float32Array(12), sweep: new Float32Array([0, 0, turn, 0]), plane: new Uint8Array(4) },
    kind: new Uint8Array([0, 2, 1, 5]),
  });
  const lines = toolpathLines(motion);
  assert.deepEqual([...lines.first], [0, 2, 4, 28, 30]);
  assert.equal(lines.positions.length, 30 * 3);
  assert.equal(lines.moves.length, 30);
  for (let i = 0; i < motion.count; i++) {
    for (let v = lines.first[i]; v < lines.first[i + 1]; v++) {
      assert.equal(lines.moves[v], i);
      assert.equal(lines.kinds[v], motion.kind[i]);
    }
    // A move's last vertex is its end.
    const last = (lines.first[i + 1] - 1) * 3;
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(lines.positions[last + a] - motion.end[i * 3 + a]) < 1e-4, `move ${i} axis ${a}`);
  }
  // The arc's chords stay on its circle.
  for (let v = lines.first[2]; v < lines.first[3]; v++) assert.ok(Math.abs(Math.hypot(lines.positions[v * 3], lines.positions[v * 3 + 1]) - 10) < 1e-4);
});

test('the ranges drawn leave out the hidden operations’ lines and the moves that lead to them', () => {
  //                  rapid in, op 0 ×2, link, op 1 (an arc), link, op 2, retract out
  const operation = [U, 0, 0, U, 1, U, 2, U];
  const ends: [number, number, number][] = [[10, 0, 10], [10, 0, 0], [20, 0, 0], [20, 0, 10], [0, 20, 10], [0, 20, 12], [5, 5, 0], [5, 5, 10]];
  const curve = new Uint8Array(8), sweep = new Float32Array(8);
  curve[4] = 1; sweep[4] = 1.5;
  const motion = motionOf(ends, operation, { arcs: { curve, center: new Float32Array(24), sweep, plane: new Uint8Array(8) } });
  const { first } = toolpathLines(motion);
  assert.deepEqual([...first], [0, 2, 4, 6, 8, 32, 34, 36, 38]);
  const runs = ownerRuns(moveOwners(motion.operation, motion.count));
  assert.deepEqual(runs, [{ owner: 0, first: 0, end: 3 }, { owner: 1, first: 3, end: 5 }, { owner: 2, first: 5, end: 8 }]);
  const ids = ['face', 'outline', 'holes'];
  const drawn = (hidden: string[]) => drawRanges(runs, first, hiddenOwners(ids, hidden));
  // Nothing hidden: everything, in one draw.
  assert.deepEqual(drawn([]), [{ start: 0, count: 38 }]);
  // `outline` hidden: its arc and the link into it go; the link out of it (into `holes`) stays.
  assert.deepEqual(drawn(['outline']), [{ start: 0, count: 6 }, { start: 32, count: 6 }]);
  // `face` hidden: the first rapid (it leads to `face`) goes with it.
  assert.deepEqual(drawn(['face']), [{ start: 6, count: 32 }]);
  // `holes` hidden: the link into it and the last retract (nothing after it) go with it.
  assert.deepEqual(drawn(['holes']), [{ start: 0, count: 32 }]);
  // Only `outline` shown.
  assert.deepEqual(drawn(['face', 'holes']), [{ start: 6, count: 26 }]);
  assert.deepEqual(drawn(ids), []);
  // An id the stream doesn't have hides nothing.
  assert.deepEqual(drawn(['gone']), [{ start: 0, count: 38 }]);
  // Every vertex is drawn by exactly the ranges of the operations shown.
  for (const hidden of [[], ['face'], ['outline'], ['holes'], ['face', 'holes'], ['outline', 'holes']]) {
    const owners = moveOwners(motion.operation, motion.count);
    const want = new Uint8Array(first[motion.count]);
    for (let i = 0; i < motion.count; i++) if (!hidden.includes(ids[owners[i]])) want.fill(1, first[i], first[i + 1]);
    const got = new Uint8Array(first[motion.count]);
    for (const range of drawn(hidden)) got.fill(1, range.start, range.start + range.count);
    assert.deepEqual(got, want, hidden.join(','));
  }
});

test('two operations with one id are hidden together; an operation run in pieces is one toggle', () => {
  assert.deepEqual([...hiddenOwners(['face', 'drill', 'face'], ['face'])], [0, 2]);
  assert.deepEqual([...hiddenOwners(['face'], undefined)], []);
  // Operation 0 runs, then 1, then 0 again (as a tool change can order them).
  const owners = moveOwners([0, 0, U, 1, U, 0, 0]);
  const runs = ownerRuns(owners);
  const first = Uint32Array.from({ length: 8 }, (_, i) => i * 2);
  assert.deepEqual(drawRanges(runs, first, new Set([0])), [{ start: 4, count: 4 }]);
  assert.deepEqual(drawRanges(runs, first, new Set([1])), [{ start: 0, count: 4 }, { start: 8, count: 6 }]);
});

test('a toggle walks the runs, not the moves: 100,000 moves change in a few ranges', () => {
  const count = 100_000, operations = 5;
  const operation = new Uint32Array(count);
  for (let i = 0; i < count; i++) operation[i] = i % 20_000 < 3 ? U : Math.floor(i / 20_000);
  const runs = ownerRuns(moveOwners(operation));
  assert.equal(runs.length, operations);
  const first = Uint32Array.from({ length: count + 1 }, (_, i) => i * 2);
  const began = performance.now();
  let ranges = 0;
  for (let turn = 0; turn < 1000; turn++) ranges += drawRanges(runs, first, new Set([turn % operations])).length;
  const each = (performance.now() - began) / 1000;
  assert.ok(ranges <= 2000);
  assert.ok(each < 1, `${each} ms a toggle`);
  assert.deepEqual(drawRanges(runs, first, new Set([2])), [{ start: 0, count: 80_000 }, { start: 120_000, count: 80_000 }]);
});
