/** A running build's progress in words (src/cam/progress.ts): the header's status, the list's rows, the tree's marks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countWords, elapsed, fractionWords, operationRows, percent, runHeading, runningStatus, runWords, stageWords, took, treeState,
  type BuildProgress, type OperationProgress, type RunProgress,
} from '../src/cam/progress.ts';

const op = (id: string, state: OperationProgress['state'], more: Partial<OperationProgress> = {}): OperationProgress =>
  ({ id, kind: null, state, seconds: null, moves: null, basis: null, fraction: null, done: null, total: null, ...more });
const run = (operations: OperationProgress[], more: Partial<RunProgress> = {}): RunProgress =>
  ({ setup: 'top', machine: 'mill', index: 0, count: 1, engine_progress: true, operations, ...more });
const at = (stage: BuildProgress['stage'], r: RunProgress | null = null): BuildProgress => ({ stage, stage_seconds: 1, run: r });

const seven = run([
  op('face', 'done', { moves: 1240, seconds: 2.4 }), op('rough', 'done', { moves: 1, seconds: 75.2 }),
  op('adaptive', 'planning', { basis: 'layers', fraction: 0.4299, done: 2, total: 5, seconds: 12.7 }),
  op('holes', 'pending'), op('finish', 'pending'), op('chamfer', 'pending'), op('outline', 'pending'),
]);

test('the header says the operation, its place and camlib’s fraction', () => {
  assert.equal(runningStatus('full', 'running', at('planning', seven)), 'Building: adaptive (3 of 7) · 42% of levels');
  // Each basis in its own words; a fraction is rounded down, so 100% is only said when camlib says all is done.
  assert.equal(fractionWords({ basis: 'area', fraction: 0.999 }), '99% by area');
  assert.equal(fractionWords({ basis: 'passes', fraction: 1 }), '100% of passes');
  assert.equal(fractionWords({ basis: 'layers', fraction: 0 }), '0% of levels');
  assert.equal(percent(0.29), 29);
  assert.equal(percent(0.57), 57);
});

test('an operation camlib counts nothing for gets no percentage', () => {
  const drilling = run([op('face', 'done'), op('holes', 'planning', { seconds: 3 })]);
  assert.equal(runningStatus('full', 'running', at('planning', drilling)), 'Building: holes (2 of 2)');
  assert.equal(fractionWords(drilling.operations[1]), null);
  // A fraction without its basis (or a basis without a fraction) is no fraction.
  assert.equal(fractionWords({ basis: null, fraction: 0.5 }), null);
  assert.equal(fractionWords({ basis: 'layers', fraction: null }), null);
  const row = operationRows(drilling)[1];
  assert.deepEqual([row.state, row.bar, row.percent, row.detail], ['planning', 'busy', null, 'planning · 3 s']);
});

test('the header before, between and after planning', () => {
  assert.equal(runningStatus('full', 'queued', null), 'Building: waiting');
  assert.equal(runningStatus('full', 'running', undefined), 'Building: running…');
  assert.equal(runningStatus('preview', 'running', at('program')), 'Checking: running the program');
  assert.equal(runningStatus('full', 'running', at('describe')), 'Building: reading the program');
  // Between two operations nothing is being planned: how many are done.
  const between = run([op('face', 'done'), op('pocket', 'pending')]);
  assert.equal(runningStatus('full', 'running', at('planning', between)), 'Building: planning · 1 of 2 operations done');
  assert.equal(runningStatus('full', 'running', at('checking', between)), 'Building: posting and checking');
  assert.equal(runningStatus('full', 'running', at('playback', between)), 'Building: writing the playback');
  assert.equal(runningStatus('full', 'running', at('release', between)), 'Building: deciding the release');
  assert.equal(runningStatus('full', 'running', at('files', between)), 'Building: checking the files');
  assert.equal(stageWords('nonsense' as BuildProgress['stage']), 'running');
});

test('a camlib without planning progress: the stage and what is done, no operation claimed', () => {
  const plain = run([op('face', 'done', { moves: 40 }), op('pocket', 'pending'), op('holes', 'pending')], { engine_progress: false });
  assert.equal(runningStatus('full', 'running', at('planning', plain)), 'Building: planning · 1 of 3 operations done');
  assert.deepEqual(operationRows(plain).map((row) => [row.state, row.bar, row.detail]), [['done', 'none', '40 moves'], ['pending', 'none', ''], ['pending', 'none', '']]);
});

test('a build of several setups or machines says which run', () => {
  const second = run([op('pocket', 'planning', { basis: 'area', fraction: 0.5, done: 1, total: 2 })], { setup: 'bottom', machine: 'router', index: 1, count: 3 });
  assert.equal(runWords(second), 'bottom on router (2 of 3)');
  assert.equal(runWords(seven), null);
  assert.equal(runningStatus('full', 'running', at('planning', second)), 'Building: bottom on router (2 of 3) · pocket (1 of 1) · 50% by area');
  assert.equal(runningStatus('full', 'running', at('release', second)), 'Building: bottom on router (2 of 3) · deciding the release');
  assert.equal(runHeading(second), 'Setup bottom on router (2 of 3) · 0 of 1 operations done');
  assert.equal(runHeading(seven), 'Setup top on mill · 2 of 7 operations done');
});

test('the list: pending, planning with a bar, done with its moves and time', () => {
  const rows = operationRows(seven);
  assert.deepEqual(rows.map((row) => row.state), ['done', 'done', 'planning', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(rows.map((row) => row.bar), ['none', 'none', 'fraction', 'none', 'none', 'none', 'none']);
  assert.deepEqual(rows.map((row) => row.percent), [null, null, 42, null, null, null, null]);
  assert.equal(rows[0].detail, '1,240 moves · 2.4 s');
  assert.equal(rows[1].detail, '1 move · 1 min 15 s');
  assert.equal(rows[2].detail, '42% of levels · level 3 of 5 · 12 s');
  assert.equal(rows[3].detail, '');
  // Done with nothing known about it is still done.
  assert.equal(operationRows(run([op('face', 'done')]))[0].detail, 'done');
  // At most one operation is being planned in what camlib reports; the rows say only what each operation's state is.
  assert.equal(rows.filter((row) => row.state === 'planning').length, 1);
});

test('levels and passes done of those planned', () => {
  assert.equal(countWords({ basis: 'layers', done: 0, total: 3 }), 'level 1 of 3');
  assert.equal(countWords({ basis: 'area', done: 1, total: 2 }), 'level 2 of 2');
  assert.equal(countWords({ basis: 'passes', done: 11, total: 40 }), 'pass 12 of 40');
  assert.equal(countWords({ basis: 'passes', done: 40, total: 40 }), '40 of 40 passes');
  assert.equal(countWords({ basis: 'layers', done: 1, total: 1 }), '1 of 1 level');
  assert.equal(countWords({ basis: null, done: 1, total: 2 }), null);
  assert.equal(countWords({ basis: 'layers', done: null, total: 2 }), null);
  assert.equal(elapsed(0.4), '0 s');
  assert.equal(elapsed(59.9), '59 s');
  assert.equal(elapsed(125), '2 min 05 s');
  assert.equal(took(0.04), '0.0 s');
  assert.equal(took(0.44), '0.4 s');
  assert.equal(took(9.96), '9 s');
  assert.equal(took(75.2), '1 min 15 s');
});

test('the tree marks the operations of the setup being built', () => {
  const progress = at('planning', seven);
  assert.equal(treeState(progress, 'top', 'adaptive'), 'planning');
  assert.equal(treeState(progress, 'top', 'face'), 'done');
  assert.equal(treeState(progress, 'top', 'outline'), 'pending');
  assert.equal(treeState(progress, 'top', 'unknown'), null);
  assert.equal(treeState(progress, 'bottom', 'adaptive'), null);
  assert.equal(treeState(at('program'), 'top', 'adaptive'), null);
  assert.equal(treeState(null, 'top', 'adaptive'), null);
});
