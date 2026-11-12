/**
 * The forms' newer options: entries per operation (a ramp), tabs at points, a trace beside its path, the adaptive
 * planner's own fields, a tool change in place, the part's outline at a depth. The first tests are self-contained;
 * tests/test_forms.py runs the last with CAMLIB_UI_OPTIONS (the cover example's program.py, its outline and camlib's
 * fields, from the server's own reader, and a flat edge of its part) and CAMLIB_UI_FORMS_OUT (a folder: each program the
 * forms write goes there, and the Python test then builds every one with camlib).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldsOf, nestedOf, notTaken, setFields, type CamlibField } from '../src/cam/opSpecs.ts';
import { readProgram, type Outline } from '../src/cam/pyCode.ts';
import { changesInPlace, emptyNested, invalidOf, missingOf, newOp, pointsSource, pointsText, readOp, readSetup, writeOp, writeSetup } from '../src/cam/forms.ts';

// camlib's own fields as the server gives them (camlib_ui/forms.py), cut down to what these tests read.
const FIELDS: Record<string, CamlibField[]> = {
  AdaptivePocket: [['id', 'str', null, false], ['tool', 'object', null, false], ['stepover_mm', 'float', null, false], ['rest_tolerance_mm', 'float | None', 'None', false],
    ['max_stay_down_mm', 'float | None', 'None', false], ['orbit_radius_mm', 'float | None', 'None', false], ['clockwise', 'bool', 'True', false],
    ['min_orbit_radius_mm', 'float | None', 'None', false], ['local_orbit_tolerance_mm', 'float | None', 'None', false], ['path_strategy', 'str', "'engagement_front'", false],
    ['cutting_sense', 'str | None', 'None', false]],
  AdaptiveClearing: [['max_radial_engagement_mm', 'float', null, false], ['orbit_radius_mm', 'float | None', 'None', false], ['path_strategy', 'str', "'engagement_front'", false]],
  Tabs: [['width_mm', 'float', null, false], ['height_mm', 'float', null, false], ['count', 'int | None', 'None', false], ['positions_mm', 'tuple | None', 'None', false],
    ['position_tolerance_mm', 'float', '0.01', false]],
  Contour: [['id', 'str', null, false], ['tool', 'object', null, false], ['tabs', 'object | None', 'None', false], ['entry', 'object | None', 'None', false]],
  Parallel: [['id', 'str', null, false], ['tool', 'object', null, false], ['one_way', 'bool', 'False', false]],
};

test('an entry offers what its operation takes', () => {
  assert.deepEqual(nestedOf('Pocket', 'entry')!.classes, ['HelicalEntry', 'StockEdgeEntry', 'RampEntry']);
  assert.deepEqual(nestedOf('Contour', 'entry')!.classes, ['RampEntry']);
  assert.deepEqual(nestedOf('AdaptivePocket', 'entry')!.classes, ['HelicalEntry', 'StockEdgeEntry']);
  assert.equal(nestedOf('Contour', 'entry')!.label('RampEntry'), 'Ramp along the path');
  assert.deepEqual(nestedOf('Trace', 'side_offset')!.classes, ['TraceSideOffset']);
  assert.equal(nestedOf('Pocket', 'stepdown_mm'), undefined);
});

test('the fields a planner refuses are known from its path', () => {
  setFields(FIELDS);
  // camlib's default planner follows the stock: no orbits, its own links, no rest tolerance.
  assert.deepEqual([...notTaken('AdaptivePocket', {}).keys()].sort(), ['local_orbit_tolerance_mm', 'max_stay_down_mm', 'min_orbit_radius_mm', 'orbit_radius_mm', 'rest_tolerance_mm']);
  assert.deepEqual([...notTaken('AdaptivePocket', { path_strategy: '"disk_front"' }).keys()].sort(), ['cutting_sense', 'max_stay_down_mm']);
  assert.deepEqual([...notTaken('AdaptiveClearing', {}).keys()], ['orbit_radius_mm', 'min_orbit_radius_mm', 'local_orbit_tolerance_mm']);
  assert.equal(notTaken('AdaptiveClearing', { path_strategy: "'disk_front'" }).size, 0);
  assert.equal(notTaken('Pocket', {}).size, 0);
  // A camlib whose default is still the orbit planner keeps its orbit fields.
  setFields({ ...FIELDS, AdaptivePocket: FIELDS.AdaptivePocket.map((field) => (field[0] === 'path_strategy' ? ['path_strategy', 'str', "'disk_front'", false] : field)) });
  assert.equal(notTaken('AdaptivePocket', {}).has('orbit_radius_mm'), false);
  // And one without the field at all refuses nothing here.
  setFields({ ...FIELDS, AdaptivePocket: FIELDS.AdaptivePocket.filter((field) => field[0] !== 'path_strategy') });
  assert.equal(notTaken('AdaptivePocket', {}).size, 0);
});

test('tab points are written as points or not at all', () => {
  setFields(FIELDS);
  assert.equal(fieldsOf('Tabs').find((field) => field.key === 'positions_mm')!.kind, 'points');
  assert.equal(fieldsOf('Parallel').find((field) => field.key === 'one_way')!.kind, 'bool');
  assert.equal(pointsSource('(10, 0), (90.5, -2)'), '((10, 0), (90.5, -2),)');
  assert.equal(pointsSource(' (45, 0) '), '((45, 0),)');
  assert.equal(pointsSource(''), '');
  for (const bad of ['10, 0', '(10, 0), (90', '(1, 2, 3)', '(a, 0)', 'import os']) assert.equal(pointsSource(bad), null, bad);
  assert.equal(pointsText('((10, 0), (90.5, -2),)'), '(10, 0), (90.5, -2)');
  assert.equal(pointsText('[(10, 0), (90, 0)]'), '(10, 0), (90, 0)');
  assert.equal(pointsText('tab_points'), 'tab_points');
  // A draft whose points aren't points stops OK; points, a name the code had, or none don't.
  const draft = newOp('Contour', 'outline');
  draft.nested.tabs = { ...emptyNested('Tabs'), values: { width_mm: '6', height_mm: '1.5', positions_mm: '(10, 0), (90' } };
  assert.deepEqual(invalidOf(draft), ['Tabs: At points']);
  for (const good of ['((10, 0), (90, 0),)', 'tab_points', '']) {
    draft.nested.tabs.values.positions_mm = good;
    assert.deepEqual(invalidOf(draft), [], good);
  }
});

const input = process.env.CAMLIB_UI_OPTIONS;
const out = process.env.CAMLIB_UI_FORMS_OUT;

test('the cover program read, edited and written back', { skip: !input && 'CAMLIB_UI_OPTIONS not set' }, () => {
  const { code, outline, fields, edge, silhouette } = JSON.parse(readFileSync(input!, 'utf8')) as
    { code: string; outline: Outline; fields: Record<string, CamlibField[]>; edge: string; silhouette: { code: string; outline: Outline } };
  setFields(fields);
  const model = readProgram(outline)!;
  const setup = model.setups[0];
  assert.deepEqual(setup.operations.map((op) => [op.id, op.cls]), [['pocket', 'AdaptivePocket'], ['recess', 'Pocket'], ['outline', 'Contour']]);
  const drafts = Object.fromEntries(setup.operations.map((op) => {
    const { draft, problems } = readOp(model, op);
    assert.deepEqual(problems, [], `${op.id}: ${problems.join('; ')}`);
    return [op.id, draft!];
  }));
  // The ramp entry and the tabs at points read into their forms.
  assert.equal(drafts.recess.nested.entry.cls, 'RampEntry');
  assert.deepEqual(drafts.recess.nested.entry.values, { angle_deg: '3', min_length_mm: '4' });
  assert.equal(drafts.outline.nested.tabs.cls, 'Tabs');
  assert.equal(pointsText(drafts.outline.nested.tabs.values.positions_mm), '(45, 0), (90, 25), (45, 50), (0, 25)');
  assert.deepEqual(missingOf(drafts.outline), []);
  assert.deepEqual(invalidOf(drafts.outline), []);
  // Every operation written back unchanged says the same (its call, formatted by the form).
  for (const op of setup.operations) {
    const again = readProgramText(writeOp(code, model, 'top', drafts[op.id], op));
    assert.ok(again, op.id);
  }

  const written: Record<string, string> = {};
  const outlineOp = setup.operations[2], pocket = setup.operations[0], recess = setup.operations[1];

  // Tabs at other points: only the contour's call changes.
  const moved = writeOp(code, model, 'top', { ...drafts.outline, nested: { ...drafts.outline.nested, tabs: { ...drafts.outline.nested.tabs,
    values: { ...drafts.outline.nested.tabs.values, positions_mm: pointsSource('(20, 0), (70, 50)')! } } } }, outlineOp);
  assert.match(moved, /tabs=Tabs\(width_mm=6, height_mm=1\.5, positions_mm=\(\(20, 0\), \(70, 50\),\)\)/);
  assert.equal(moved.slice(0, outlineOp.call!.s[0]), code.slice(0, outlineOp.call!.s[0]));
  written.tabs_moved = moved;

  // The contour with a ramp around its loop instead of tabs (camlib takes one or the other).
  const ramped = writeOp(code, model, 'top', { ...drafts.outline, nested: { tabs: emptyNested(null), entry: { ...emptyNested('RampEntry'), values: { angle_deg: '2' } } } }, outlineOp);
  assert.match(ramped, /tabs=None,\s+entry=RampEntry\(angle_deg=2\)/);
  written.ramped = ramped;
  // A ramp entry needs its angle (camlib gives it no default): OK waits for it.
  assert.deepEqual(missingOf({ ...drafts.outline, nested: { entry: emptyNested('RampEntry') } }), ['Entry: Ramp angle']);

  // The recess entered by a helix again: the import comes with it.
  const helix = writeOp(code, model, 'top', { ...drafts.recess, nested: { entry: emptyNested('HelicalEntry') } }, recess);
  assert.match(helix, /entry=HelicalEntry\(\)/);
  assert.match(helix, /from camlib import [^\n]*HelicalEntry/);
  written.helix = helix;

  // The adaptive pocket on the earlier planner with its orbit radius (which the default planner refuses).
  const orbits = writeOp(code, model, 'top', { ...drafts.pocket, values: { ...drafts.pocket.values, path_strategy: '"disk_front"', orbit_radius_mm: '1' } }, pocket);
  assert.match(orbits, /orbit_radius_mm=1,\s+path_strategy="disk_front"/);
  written.orbits = orbits;
  assert.equal(notTaken('AdaptivePocket', drafts.pocket.values).has('orbit_radius_mm'), true);
  assert.equal(notTaken('AdaptivePocket', { path_strategy: '"disk_front"' }).has('orbit_radius_mm'), false);

  // A trace beside an edge of the part: the cutter's radius to its left.
  const trace = newOp('Trace', 'step');
  trace.tool = 't_em6';
  trace.geometry.paths = { names: [edge] };
  Object.assign(trace.values, { top_z_mm: '8', depth_z_mm: '7', stepdown_mm: '1', clearance_z_mm: '20', feed_mm_min: '900', plunge_mm_min: '300', spindle_rpm: '11000', coolant: '"flood"' });
  trace.nested.side_offset = emptyNested('TraceSideOffset');
  assert.deepEqual(missingOf(trace), ['Cutter position: Side']);
  trace.nested.side_offset.values.side = '"left"';
  assert.deepEqual(missingOf(trace), []);
  const traced = writeOp(code, model, 'top', trace);
  assert.match(traced, /side_offset=TraceSideOffset\(side="left"\)/);
  assert.match(traced, /from camlib import [^\n]*TraceSideOffset/);
  written.traced = traced;

  // Rows all one way: camlib's own field, written as it is.
  const parallel = newOp('Parallel', 'finish');
  parallel.tool = 't_em6';
  parallel.geometry.surface = { whole: true };
  Object.assign(parallel.values, { floor_z_mm: '0', stepover_mm: '0.5', clearance_z_mm: '20', feed_mm_min: '900', plunge_mm_min: '300', spindle_rpm: '11000', coolant: '"flood"', one_way: 'True' });
  assert.match(writeOp(code, model, 'top', parallel), /one_way=True/);

  // A tool change in place: the machine's mode and the setup's own tool change are written together, and taken out together.
  const { draft: setupDraft } = readSetup(model, setup);
  assert.equal(changesInPlace(setupDraft!), false);
  const inPlace = writeSetup(code, model, { ...setupDraft!, premises: { ...setupDraft!.premises, tool_change_position_mode: '"preserve_spindle"' } }, setup);
  assert.match(inPlace, /tool_change=ToolChangeInPlace\(\)/);
  assert.match(inPlace, /tool_change_position_mode="preserve_spindle"/);
  assert.match(inPlace, /from camlib import [^\n]*ToolChangeInPlace/);
  written.in_place = inPlace;
  if (out) for (const [name, text] of Object.entries(written)) writeFileSync(join(out, `${name}.py`), text);

  // The part's outline at a depth stays the code it is; the rest of its contour is edited in the form.
  const other = readProgram(silhouette.outline)!;
  const contour = other.setups[0].operations[2];
  const read = readOp(other, contour);
  assert.deepEqual(read.problems, []);
  assert.equal(read.draft!.geometry.region.src, 'outline');
  assert.match(read.draft!.geometry.region.shown!, /^silhouette\(part, 0, max_error_mm=0\.003/);
  const deeper = writeOp(silhouette.code, other, 'top', { ...read.draft!, values: { ...read.draft!.values, stepdown_mm: '1' } }, contour);
  assert.match(deeper, /Contour\("outline", mill6, region=outline, floor_z_mm=0,\s+stepdown_mm=1,/);
  if (out) writeFileSync(join(out, 'silhouette.py'), deeper);
});

/** Whether code still reads as text the forms wrote (a call that kept its parentheses balanced). */
function readProgramText(code: string): boolean {
  let depth = 0;
  for (const c of code) { if (c === '(') depth++; else if (c === ')') depth--; if (depth < 0) return false; }
  return depth === 0;
}

/** After the tool change in place is OK'd and read again by the server: another mode takes the setup's own change out. */
test('a tool change in place is taken out again', { skip: !process.env.CAMLIB_UI_OPTIONS_BACK && 'CAMLIB_UI_OPTIONS_BACK not set' }, () => {
  const { code, outline, fields } = JSON.parse(readFileSync(process.env.CAMLIB_UI_OPTIONS_BACK!, 'utf8')) as { code: string; outline: Outline; fields: Record<string, CamlibField[]> };
  setFields(fields);
  const model = readProgram(outline)!;
  const setup = model.setups[0];
  const { draft, problems } = readSetup(model, setup);
  assert.deepEqual(problems, []);
  assert.equal(changesInPlace(draft!), true);
  // OK on it unchanged writes nothing.
  assert.equal(writeSetup(code, model, draft!, setup), code);
  const back = writeSetup(code, model, { ...draft!, premises: { ...draft!.premises, tool_change_position_mode: '"preserve_tip"' } }, setup);
  assert.doesNotMatch(back, /tool_change=/);
  assert.match(back, /tool_change_position_mode="preserve_tip"/);
  if (out) writeFileSync(join(out, 'back.py'), back);
});
