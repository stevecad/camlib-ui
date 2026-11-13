/**
 * The program forms on a plasma program (src/cam/forms.ts): the sheet example's cut read into its form (through its
 * `**plan` dict and the shop's cutting(...) recipe) and written back with micro-joints, and a mark added before it.
 * tests/test_cutting.py runs this with CAMLIB_UI_THERMAL (the sheet's program.py, its outline and camlib's fields) and
 * CAMLIB_UI_FORMS_OUT, then builds what was written with camlib. Without them it is skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldsOf, setFields, type CamlibField } from '../src/cam/opSpecs.ts';
import { readProgram, type Outline } from '../src/cam/pyCode.ts';
import { emptyNested, invalidOf, linesSource, linesText, missingOf, newOp, readOp, setupKindOf, writeOp, BAD_LINES } from '../src/cam/forms.ts';

const input = process.env.CAMLIB_UI_THERMAL;
const out = process.env.CAMLIB_UI_FORMS_OUT;

test('typed lines are polylines, and read back', () => {
  assert.equal(linesSource('(0, 0), (40, 0)\n (5,5),(5, 9), (8, 9) '), '(polyline((0, 0), (40, 0)), polyline((5,5),(5, 9), (8, 9)),)');
  assert.equal(linesSource('(0, 0)'), null);
  assert.equal(linesSource('(0, 0), (a, 1)'), null);
  assert.equal(linesSource(''), '');
  assert.equal(linesText('(polyline((0, 0), (40, 0)), polyline((5, 5), (5, 9)),)'), '(0, 0), (40, 0)\n(5, 5), (5, 9)');
  assert.equal(linesText('paths(part, "edge_1")'), null);
  assert.equal(linesText('(polyline((0, 0), (40, 0)), other,)'), null);
});

test('the sheet program’s cut read, edited and written back', { skip: !input && 'CAMLIB_UI_THERMAL not set' }, () => {
  const { code, outline, fields } = JSON.parse(readFileSync(input!, 'utf8')) as { code: string; outline: Outline; fields: Record<string, CamlibField[]> };
  setFields(fields);
  const model = readProgram(outline)!;
  const setup = model.setups[0];
  assert.equal(setupKindOf(setup), 'sheet');
  assert.deepEqual(model.heads, { torch: { machine: 'table', recipe: 'steel6' } });
  const cut = setup.operations[0];
  assert.deepEqual([cut.id, cut.cls], ['cut', 'ThermalCut']);

  // The cut reads through `**plan` (a dict of keywords) and its `**process` (the shop's recipe).
  const { draft, problems } = readOp(model, cut);
  assert.deepEqual(problems, []);
  assert.equal(draft!.tool, 'torch');
  assert.deepEqual(draft!.values, { parts: 'nest.region', overcut_mm: '-0.5', height_control: 'True', tool_number: '1', length_register: '1',
    height_mode: '"fixed"', lead_in_radius_mm: '3', lead_out_radius_mm: '2' });
  assert.equal(draft!.nested.small_holes.cls, 'SmallHoles');
  assert.equal(draft!.nested.small_holes.values.feed_percent, '60');
  assert.deepEqual(missingOf(draft!), []);
  // The recipe's values aren't the form's: the cut chart is the shop's.
  const shown = fieldsOf('ThermalCut').map((field) => field.key);
  for (const key of ['feed_mm_min', 'cut_height_mm', 'pierce_delay_s', 'lead_in', 'power_percent']) assert.ok(!shown.includes(key), key);
  for (const key of ['height_mode', 'lead_in_radius_mm', 'lead_out_radius_mm', 'overcut_mm', 'micro_joints']) assert.ok(shown.includes(key), key);

  // Micro-joints added: the cut is written as one call with its recipe; nothing else changes.
  const joints = { ...emptyNested('MicroJoints'), values: { width_mm: '0.8', count: '2' } };
  const edited = writeOp(code, model, 'sheet', { ...draft!, nested: { ...draft!.nested, micro_joints: joints } }, cut);
  assert.ok(edited.replace(/\s+/g, ' ').includes('ThermalCut("cut", torch, nest.region, overcut_mm=-0.5, height_control=True, small_holes=SmallHoles(feed_percent=60), '
    + 'micro_joints=MicroJoints(width_mm=0.8, count=2), tool_number=1, length_register=1, '
    + '**cutting(shop.steel6, shop.table, height_mode="fixed", lead_in_radius_mm=3, lead_out_radius_mm=2)),'), edited);
  assert.match(edited, /from camlib import .*MicroJoints/);
  assert.equal(edited.slice(0, 200), code.slice(0, 200));
  if (out) writeFileSync(join(out, 'joints.py'), edited);

  // A mark before the cut, on the sheet's margin (off the parts: said so). Lines that aren't points are refused by OK.
  const mark = newOp('ThermalMark', 'mark');
  assert.deepEqual(missingOf(mark), ['Head', 'Parts', 'Lines', 'Feed', 'Mark height', 'Power', 'Mark width']);
  mark.tool = 'torch';
  Object.assign(mark.values, { parts: 'nest.region', paths: BAD_LINES + '(4, 20)', feed_mm_min: '3000', mark_height_mm: '2.5', power_percent: '100', mark_width_mm: '0.6', allow_off_part: 'True' });
  assert.deepEqual(invalidOf(mark), ['Lines']);
  mark.values.paths = linesSource('(4, 20), (4, 80)\n(4, 100), (4, 160)')!;
  assert.deepEqual(invalidOf(mark), []);
  assert.deepEqual(missingOf(mark), []);
  const marked = writeOp(code, model, 'sheet', mark, null, 0);
  assert.ok(marked.replace(/\s+/g, ' ').includes('ThermalMark("mark", torch, nest.region, paths=(polyline((4, 20), (4, 80)), polyline((4, 100), (4, 160)),), '
    + 'feed_mm_min=3000, mark_height_mm=2.5, power_percent=100, mark_width_mm=0.6, allow_off_part=True, tool_number=1, length_register=1),'), marked);
  assert.match(marked, /import .*polyline/);
  assert.ok(marked.indexOf('ThermalMark("mark"') < marked.indexOf('ThermalCut("cut", torch, nest.region'));
  if (out) writeFileSync(join(out, 'marked.py'), marked);

  // A milling operation doesn't go into a sheet setup.
  assert.throws(() => writeOp(code, model, 'sheet', { ...newOp('Facing', 'face'), tool: 't_em10' }), /milling operation: sheet is a plasma or laser setup/);
});
