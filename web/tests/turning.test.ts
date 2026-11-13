/**
 * The program forms on a lathe program (src/cam/pyCode.ts, src/cam/forms.ts): the shaft example's turning operations
 * read into their forms and written back. tests/test_turning.py runs this with CAMLIB_UI_TURNING (the shaft's
 * program.py, the same program without its parting tool, their outlines and camlib's fields, from the server's own
 * reader) and CAMLIB_UI_FORMS_OUT (a folder: each program the forms write goes there, and the Python test then builds
 * every one with camlib). Without them only the self-contained test runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldsOf, OP_BY_CLASS, OP_SPECS, setFields, turningToolType, type CamlibField } from '../src/cam/opSpecs.ts';
import { readProgram, type Outline } from '../src/cam/pyCode.ts';
import { deleteOp, duplicateOp, FormError, missingOf, newOp, readOp, readSetup, reorderOps, setupContext, writeOp } from '../src/cam/forms.ts';

const input = process.env.CAMLIB_UI_TURNING;
const out = process.env.CAMLIB_UI_FORMS_OUT;

test('turning tools are told apart by what they cut', () => {
  assert.equal(turningToolType('iso_code', 'outer'), 'turn_outer');
  assert.equal(turningToolType('iso', 'inner'), 'turn_inner');
  assert.equal(turningToolType('groove', 'outer'), 'groove_outer');
  assert.equal(turningToolType('thread', 'inner'), 'thread_inner');
  assert.equal(turningToolType('drill', 'outer'), 'turn_drill');
  assert.equal(turningToolType('laser', 'outer'), null);
  // Every turning operation is a spec of its own group, takes no geometry and names the tools that fit it.
  const turning = OP_SPECS.filter((spec) => spec.turning);
  assert.equal(turning.length, 10);
  assert.ok(turning.every((spec) => spec.group === 'Turning' && Object.keys(spec.geometry).length === 0 && spec.cutters.length > 0));
  assert.deepEqual(OP_BY_CLASS.TurnPartOff.cutters, ['groove_outer']);
});

test('the shaft program read, edited and written back', { skip: !input && 'CAMLIB_UI_TURNING not set' }, () => {
  const data = JSON.parse(readFileSync(input!, 'utf8')) as { code: string; outline: Outline; fields: Record<string, CamlibField[]>; bare: { code: string; outline: Outline } };
  const { code, outline, fields } = data;
  setFields(fields);
  const model = readProgram(outline)!;
  const setup = model.setups[0];
  assert.deepEqual([setup.id, setup.turning, setup.turret], ['turn', true, 'turret']);
  assert.deepEqual(setupContext(setup), { tooling: 'turret', workOffset: 1 });
  assert.deepEqual(setup.operations.map((op) => [op.id, op.cls]), [['face', 'TurnFace'], ['rough', 'TurnRough'], ['finish', 'TurnFinish'], ['thread', 'TurnThread'], ['part_off', 'TurnPartOff']]);
  assert.deepEqual(model.tools, { rough: 't_rough', finish: 't_finish', thread: 't_thread', part_off: 't_part' });

  // Every operation reads into its form: its tool by the id the code names, its values as the code wrote them.
  const drafts = Object.fromEntries(setup.operations.map((op) => {
    const { draft, problems } = readOp(model, op);
    assert.deepEqual(problems, [], `${op.id}: ${problems.join('; ')}`);
    return [op.id, draft!];
  }));
  assert.equal(drafts.rough.tool, 't_rough');
  assert.deepEqual(drafts.rough.values, { depth_of_cut_mm: '2', allowance_mm: '0.3', feed_mm_rev: '0.25', rpm: '1200' });
  assert.equal(drafts.thread.values.pitch_mm, '2.5');
  assert.deepEqual(missingOf(drafts.thread), []);
  // camlib's own fields, in camlib's order; feeds and speeds have no default, so the form requires them.
  const finish = fieldsOf('TurnFinish');
  assert.deepEqual(finish.filter((field) => field.required).map((field) => field.key), ['id', 'tool', 'feed_mm_rev', 'rpm']);
  assert.equal(finish.find((field) => field.key === 'feed_mm_rev')!.unit, 'mm/rev');
  assert.equal(finish.find((field) => field.key === 'compensation')!.kind, 'choice');
  // A lathe setup itself is edited in code: the setup form writes milling setups.
  assert.ok(readSetup(model, setup).problems.length > 0);

  const written: Record<string, string> = {};
  // An operation edited: only its own call changes, and it names its tool as it did.
  const op = setup.operations[2];
  const edited = writeOp(code, model, 'turn', { ...drafts.finish, values: { ...drafts.finish.values, feed_mm_rev: '0.08' } }, op);
  assert.equal(edited.slice(0, op.call!.s[0]), code.slice(0, op.call!.s[0]));
  assert.equal(edited.slice(edited.length - (code.length - op.call!.s[1])), code.slice(op.call!.s[1]));
  assert.match(edited, /TurnFinish\("finish", "t_finish", feed_mm_rev=0\.08, rpm=1500\)/);
  written.edited = edited;

  // A new operation with a tool the setup already holds: its call, and nothing else, is added.
  const spring = newOp('TurnFinish', 'spring');
  spring.tool = 't_finish';
  assert.deepEqual(missingOf(spring), ['Feed', 'Spindle speed']);
  Object.assign(spring.values, { feed_mm_rev: '0.06', rpm: '1500' });
  const added = writeOp(code, model, 'turn', spring, null, 3);
  assert.match(added, /TurnFinish\("spring", "t_finish", feed_mm_rev=0\.06, rpm=1500\),\n\s+# M20/);
  assert.equal(added.split('station(').length, code.split('station(').length);
  assert.ok(!added.includes('slot('));
  written.added = added;

  // A tool new to the program: its tool(shop.…) variable, its station in the setup's tools, and the helpers' imports.
  const bare = readProgram(data.bare.outline)!;
  assert.deepEqual(Object.values(bare.tools), ['t_rough', 't_finish', 't_thread']);
  const part = newOp('TurnPartOff', 'part_off');
  part.tool = 't_part';
  Object.assign(part.values, { z_mm: '-40', feed_mm_rev: '0.05', rpm: '800' });
  const parted = writeOp(data.bare.code, bare, 'turn', part);
  assert.match(parted, /^t_part = tool\(shop\.t_part\)$/m);
  assert.match(parted, /station\(shop\.turret, thread\), station\(shop\.turret, t_part\)\)/);
  assert.match(parted, /TurnPartOff\("part_off", "t_part", z_mm=-40, feed_mm_rev=0\.05, rpm=800\),\n\)/);
  assert.match(parted, /from camlib import [^\n]*TurnPartOff/);
  written.parted = parted;

  // A milling operation doesn't go into a lathe setup.
  const face = newOp('Facing', 'mill_face');
  face.tool = 't_rough';
  assert.throws(() => writeOp(code, model, 'turn', face), (error: unknown) => error instanceof FormError && /lathe setup/.test(error.message));

  // Tree edits are the same as a milling setup's.
  const duplicated = duplicateOp(code, model, setup.operations[2]);
  assert.equal(duplicated.id, 'finish_2');
  written.duplicated = duplicated.code;
  written.deleted = deleteOp(code, model, setup.operations[3]);
  const reordered = reorderOps(code, model, 'turn', [1, 0, 2, 3, 4]);
  assert.ok(reordered.indexOf('TurnRough("rough"') < reordered.indexOf('TurnFace("face"'));

  if (out) for (const [name, text] of Object.entries(written)) writeFileSync(join(out, `${name}.py`), text);
});
