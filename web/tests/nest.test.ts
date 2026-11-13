/**
 * The nest's form (src/cam/forms.ts readNest/writeNest) on the nest example: its parts and values read, and a start
 * corner, a fill axis, a quantity and a rotation set written back, changing nothing else. tests/test_cutting.py runs
 * this with CAMLIB_UI_NEST (the example's program.py and its outline) and CAMLIB_UI_FORMS_OUT, then builds what was
 * written with camlib. Without them it is skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFields, type CamlibField } from '../src/cam/opSpecs.ts';
import { readProgram, type Outline } from '../src/cam/pyCode.ts';
import { nestProblems, readNest, writeNest } from '../src/cam/forms.ts';

const input = process.env.CAMLIB_UI_NEST;
const out = process.env.CAMLIB_UI_FORMS_OUT;

test('the nest read, edited and written back', { skip: !input && 'CAMLIB_UI_NEST not set' }, () => {
  const { code, outline, fields } = JSON.parse(readFileSync(input!, 'utf8')) as { code: string; outline: Outline; fields: Record<string, CamlibField[]> };
  setFields(fields);
  const model = readProgram(outline)!;
  const { draft, problems } = readNest(model);
  assert.deepEqual(problems, []);
  assert.equal(draft!.variable, 'layout');
  assert.equal(draft!.sheet, 'sheet');
  assert.deepEqual(draft!.parts, [
    { region: 'bracket', quantity: '4', rotations: '(0, 90, 180, 270)', mirror: false },
    { region: 'ring', quantity: '5', rotations: '(0,)', mirror: false },
    { region: 'gusset', quantity: '6', rotations: '(0, 90, 180, 270)', mirror: false },
  ]);
  assert.deepEqual(draft!.values, { part_spacing_mm: '3', edge_margin_mm: '10', resolution_mm: '1', start_corner: '"lower_left"', fill_axis: '"y"' });
  assert.deepEqual(nestProblems(draft!), []);
  // Unchanged: nothing is rewritten.
  assert.equal(writeNest(code, model, draft!), code);

  // From the upper right in rows, one bracket fewer, gussets as drawn only.
  const edited = writeNest(code, model, {
    ...draft!,
    values: { ...draft!.values, start_corner: '"upper_right"', fill_axis: '"x"' },
    parts: [{ ...draft!.parts[0], quantity: '3' }, draft!.parts[1], { ...draft!.parts[2], rotations: '(0,)' }],
  });
  assert.match(edited, /NestPart\(bracket, quantity=3, rotations_deg=\(0, 90, 180, 270\)\)/);
  assert.match(edited, /NestPart\(ring, quantity=5, rotations_deg=\(0,\)\)/);
  assert.match(edited, /NestPart\(gusset, quantity=6, rotations_deg=\(0,\)\)/);
  assert.match(edited, /start_corner="upper_right", fill_axis="x"\)/);
  // Only those places changed.
  assert.equal(edited.length, code.length + 'upper_right'.length - 'lower_left'.length - '90, 180, 270'.length - 1);
  if (out) writeFileSync(join(out, 'nest_edited.py'), edited);

  // A quantity that isn't a whole number is refused by OK.
  assert.deepEqual(nestProblems({ ...draft!, parts: [{ ...draft!.parts[0], quantity: '2.5' }, ...draft!.parts.slice(1)] }), ['bracket: a whole quantity']);
  assert.deepEqual(nestProblems({ ...draft!, values: { ...draft!.values, part_spacing_mm: '' } }), ['part spacing']);
});
