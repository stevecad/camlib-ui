/**
 * The program forms' reading and writing of program.py (src/cam/pyCode.ts, src/cam/forms.ts) on the plate example.
 * tests/test_forms.py runs this with CAMLIB_UI_FORMS (the plate's program.py, its outline and camlib's fields, from the
 * server's own reader) and CAMLIB_UI_FORMS_OUT (a folder: each program the forms write goes there, and the Python test
 * then builds every one with camlib). Without them it is skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFields, type CamlibField } from '../src/cam/opSpecs.ts';
import { readProgram, type Outline } from '../src/cam/pyCode.ts';
import { deleteOp, duplicateOp, missingOf, newOp, newProgramCode, readOp, readSetup, reorderOps, writeOp, writeSetup, type SetupDraft } from '../src/cam/forms.ts';

const input = process.env.CAMLIB_UI_FORMS;
const out = process.env.CAMLIB_UI_FORMS_OUT;

test('the plate program read, edited and written back', { skip: !input && 'CAMLIB_UI_FORMS not set' }, () => {
  const { code, outline, fields } = JSON.parse(readFileSync(input!, 'utf8')) as { code: string; outline: Outline; fields: Record<string, CamlibField[]> };
  setFields(fields);
  const model = readProgram(outline)!;
  assert.deepEqual(model.setups.map((setup) => setup.id), ['top']);
  const setup = model.setups[0];
  assert.deepEqual(setup.operations.map((op) => [op.id, op.cls]), [['face', 'Facing'], ['pocket', 'Pocket'], ['outline', 'Contour'], ['holes', 'Drilling']]);
  assert.deepEqual(model.tools, { mill10: 't_em10', mill6: 't_em6', drill: 't_drill' });

  // Every operation reads into its form (geometry with its own keywords, the helical entry, typed hole points).
  const drafts = Object.fromEntries(setup.operations.map((op) => {
    const { draft, problems, tooling } = readOp(model, op);
    assert.deepEqual(problems, [], `${op.id}: ${problems.join('; ')}`);
    assert.equal(tooling, 'rack');
    return [op.id, draft!];
  }));
  assert.deepEqual(drafts.pocket.geometry.region.names, ['pocket_floor']);
  assert.deepEqual(drafts.pocket.geometry.region.keep, ['name="pocket"']);
  assert.equal(drafts.pocket.nested.entry.cls, 'HelicalEntry');
  assert.deepEqual(drafts.holes.geometry.centers_mm.points, [[10, 10], [90, 10], [10, 50], [90, 50]]);
  assert.equal(drafts.face.values.floor_z_mm, '20');

  // The setup reads into its form; OK on it unchanged writes nothing (its own MaterialCheck stays as it is).
  const { draft: setupDraft, problems } = readSetup(model, setup);
  assert.deepEqual(problems, []);
  assert.equal(setupDraft!.machine, 'mill');
  assert.equal(setupDraft!.tooling, 'rack');
  assert.equal(setupDraft!.material, true);
  assert.equal(setupDraft!.premises.work_to_machine, 'WorkFrame((200, 150, -300))');
  assert.equal(writeSetup(code, model, setupDraft!, setup), code);

  const written: Record<string, string> = {};
  const keep = (name: string, text: string) => { written[name] = text; };

  // An operation edited: only its own call changes.
  const pocket = setup.operations[1];
  const edited = writeOp(code, model, 'top', { ...drafts.pocket, values: { ...drafts.pocket.values, stepdown_mm: '1.5' } }, pocket);
  assert.equal(edited.slice(0, pocket.call!.s[0]), code.slice(0, pocket.call!.s[0]));
  assert.equal(edited.slice(edited.length - (code.length - pocket.call!.s[1])), code.slice(pocket.call!.s[1]));
  assert.match(edited, /stepdown_mm=1\.5/);
  // Unchanged geometry stays the code it was (the `floor` variable), not rewritten.
  assert.match(edited, /Pocket\("pocket", mill6, region=floor,/);
  // Picked again, it's written with the helper's own keywords kept.
  const repicked = writeOp(code, model, 'top', { ...drafts.pocket, geometry: { region: { names: ['pocket_floor', 'face3'], keep: drafts.pocket.geometry.region.keep } } }, pocket);
  assert.match(repicked, /region=region\(part, "pocket_floor", "face3", name="pocket"\)/);
  keep('edited', edited);

  // A new operation: a contour of the part's top face with a new tool variable for the 6 mm end mill already there.
  const contour = newOp('Contour', 'chamfer_edge');
  contour.tool = 't_em6';
  contour.geometry.region = { names: ['top'] };
  Object.assign(contour.values, { floor_z_mm: '18', stepdown_mm: '1', clearance_z_mm: '30', feed_mm_min: '800', plunge_mm_min: '300', spindle_rpm: '9000', coolant: '"flood"' });
  const added = writeOp(code, model, 'top', contour);
  assert.match(added, /Contour\("chamfer_edge", mill6, region=region\(part, "top"\)/);
  assert.match(added, /\*\*slot\(shop\.rack, mill6\)\),\n\)/);
  keep('added', added);

  // A new tool from the shop gets its own variable, in the setup's tools.
  const drilled = newOp('Drilling', 'spot');
  drilled.tool = 't_drill';
  drilled.geometry.centers_mm = { points: [[50, 30]] };
  Object.assign(drilled.values, { depth_z_mm: '15', clearance_z_mm: '30', feed_mm_min: '150', spindle_rpm: '1500' });
  // camlib requires these (no defaults): the form says so and OK waits for them.
  assert.deepEqual(missingOf(drilled), ['Retract feed', 'Coolant']);
  Object.assign(drilled.values, { retract_feed_mm_min: '600', coolant: '"flood"' });
  assert.deepEqual(missingOf(drilled), []);
  keep('drilled', writeOp(code, model, 'top', drilled, null, 0));

  // Tree edits.
  keep('deleted', deleteOp(code, model, setup.operations[2]));
  const duplicated = duplicateOp(code, model, setup.operations[0]);
  assert.equal(duplicated.id, 'face_2');
  keep('duplicated', duplicated.code);
  const reordered = reorderOps(code, model, 'top', [0, 1, 3, 2]);
  assert.ok(reordered.indexOf('Drilling("holes"') < reordered.indexOf('Contour("outline"'));
  keep('reordered', reordered);

  // A second setup: the program's one machine becomes a {setup: machine} dict; its first operation goes in after.
  const second: SetupDraft = { ...setupDraft!, id: 'bottom', read: undefined, material: false, stockContact: true };
  const withSetup = writeSetup(code, model, second, null);
  assert.match(withSetup, /bottom = Setup\("bottom"/);
  assert.match(withSetup, /program = Program\(\n?\s*job,\n?\s*\{"top": machine\(/);
  keep('second_setup', withSetup);

  // A new program (a project with only the blank template) with its first setup.
  const fresh = newProgramCode('bracket', { ...second, id: 'top' }, true);
  assert.match(fresh, /^"""bracket: machined from the project's part\."""/);
  assert.match(fresh, /from links import part, shop/);
  keep('new_program', fresh);

  if (out) for (const [name, text] of Object.entries(written)) writeFileSync(join(out, `${name}.py`), text);
});

/**
 * A new setup's first operation, as the app writes it once the setup's form is OK'd: into the code with the setup
 * written in (CAMLIB_UI_FORMS_FIRST: {name: {code, outline}}, read by the server), its tool added to the setup's tools.
 */
test('a new setup gets its first operation', { skip: !process.env.CAMLIB_UI_FORMS_FIRST && 'CAMLIB_UI_FORMS_FIRST not set' }, () => {
  const { fields, programs } = JSON.parse(readFileSync(process.env.CAMLIB_UI_FORMS_FIRST!, 'utf8')) as { fields: Record<string, CamlibField[]>; programs: Record<string, { code: string; outline: Outline; setup: string }> };
  setFields(fields);
  for (const [name, { code, outline, setup }] of Object.entries(programs)) {
    const model = readProgram(outline)!;
    assert.ok(model.setups.some((item) => item.id === setup), `${name}: no setup ${setup}`);
    const face = newOp('Facing', 'face_b');
    face.tool = 't_em10';
    Object.assign(face.values, { floor_z_mm: '20', stepdown_mm: '1', stepover_mm: '4', clearance_z_mm: '30', feed_mm_min: '1200', plunge_mm_min: '400', spindle_rpm: '9000', coolant: '"flood"' });
    const text = writeOp(code, model, setup, face);
    // The new setup's tools hold the operation's tool (a new variable, or the program's own for that shop tool).
    const tools = /Setup\("(?:top|bottom)", StockSpec\(\([^)]*\), \([^)]*\), [\d.]+\), \((\w+),\), (\w+_ops)/.exec(text);
    assert.ok(tools, `${name}: the setup's tools aren't one tool`);
    assert.match(text, new RegExp(`Facing\\("face_b", ${tools[1]},`), `${name}: the facing doesn't use the setup's tool`);
    if (out) writeFileSync(join(out, `${name}.py`), text);
  }
});
