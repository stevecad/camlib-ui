/**
 * The program's forms and the browser's edits of program.py (from STEVE Studio's camlibEditor.ts): the program as its
 * code says (read through the server's outline of program.py; nothing runs), the open form of an operation or a setup
 * (shown in the right panel), geometry picked on the part in the viewport, and the tree's actions (delete, reorder,
 * duplicate). Each writes exactly the code it changes into program.py and saves it; OK on a form also builds it.
 */
import { create } from 'zustand';
import { api, type PartMesh } from '../api';
import { findDefinition, revealIn, startBuild, toast, useApp } from '../state';
import { fieldsLoaded, OP_BY_CLASS, setFields, type CamlibField, type CutterType, type GeometryKind, fieldNames } from './opSpecs';
import { freeOpId, readProgram, type CamOp, type CamProgramModel, type Outline } from './pyCode';
import {
  deleteOp, duplicateOp, FormError, missingOf, newOp, newProgramCode, readOp, readSetup, reorderOps, setupContext, writeOp, writeSetup, type Geometry, type OpDraft, type SetupDraft,
} from './forms';

const PROGRAM = 'program.py';

// ── The program as its code says ─────────────────────────────────────────

const outlines = new Map<string, Promise<Outline>>();
/** The outline of program.py's code (cached by exact text). Nothing runs. */
export function parseProgram(code: string): Promise<Outline> {
  let pending = outlines.get(code);
  if (!pending) {
    pending = api.outline(code);
    pending.catch(() => outlines.delete(code));
    outlines.set(code, pending);
    while (outlines.size > 12) outlines.delete(outlines.keys().next().value!);
  }
  return pending;
}

interface ProgramState {
  /** program.py as the forms read it (its saved text). Null: not read yet, or the project has none. */
  model: CamProgramModel | null;
  /** Why the forms can't read it (a syntax error, or code they don't know). */
  problem: string | null;
  /** The saved text the model was read from. */
  code: string | null;
}
export const useProgram = create<ProgramState>(() => ({ model: null, problem: null, code: null }));

let reading = 0;
/** Reads program.py's saved text into the model (after a project opens and whenever program.py is saved). */
export async function refreshProgram() {
  const { project, files } = useApp.getState();
  const ticket = ++reading;
  if (!project?.program) { useProgram.setState({ model: null, problem: null, code: null }); return; }
  let code = files[PROGRAM]?.saved;
  if (code === undefined || files[PROGRAM]?.loading) {
    try { code = await api.file(project.name, PROGRAM); } catch { return; }
  }
  if (ticket !== reading) return;
  try {
    await ensureFields();
    const outline = await parseProgram(code);
    if (ticket !== reading) return;
    if (!outline.ok) { useProgram.setState({ model: null, code, problem: `program.py doesn’t parse (line ${outline.error?.line}: ${outline.error?.message}).` }); return; }
    const model = readProgram(outline);
    useProgram.setState({ model, code, problem: model?.setups.length ? null : model?.program ? 'The program has no setups the forms can read.' : null });
  } catch (error) {
    if (ticket === reading) useProgram.setState({ problem: error instanceof Error ? error.message : String(error) });
  }
}

// Read again when the project or program.py's saved text changes (no import of this module in state.ts).
useApp.subscribe((state, previous) => {
  const name = state.project?.name, before = previous.project?.name;
  const saved = state.files[PROGRAM]?.saved, savedBefore = previous.files[PROGRAM]?.saved;
  const modified = state.project?.files.find((file) => file.name === PROGRAM)?.modified;
  const modifiedBefore = previous.project?.files.find((file) => file.name === PROGRAM)?.modified;
  if (name !== before || saved !== savedBefore || modified !== modifiedBefore || state.project?.program !== previous.project?.program) void refreshProgram();
});

let fieldsLoading: Promise<void> | null = null;
/** camlib's operation fields, from the installed camlib (once). */
export function ensureFields(): Promise<void> {
  if (fieldsLoaded()) return Promise.resolve();
  fieldsLoading ??= api.operationFields().then((fields) => setFields(fields as Record<string, CamlibField[]>)).catch((error) => { fieldsLoading = null; throw error; });
  return fieldsLoading;
}

/** program.py's code and model now, to edit: refused while it has unsaved edits in the editor (save them first). */
async function programNow(): Promise<{ code: string; model: CamProgramModel } | string> {
  const { project, files } = useApp.getState();
  if (!project) return 'Open a project first.';
  const open = files[PROGRAM];
  if (open && !open.loading && open.text !== open.saved) return 'program.py has unsaved changes in the editor: save them (Ctrl+S) first.';
  let code: string;
  try { code = await api.file(project.name, PROGRAM); } catch { return 'The project has no program.py.'; }
  await ensureFields();
  const outline = await parseProgram(code);
  if (!outline.ok) return `program.py doesn’t parse (line ${outline.error?.line}): fix it in the code editor.`;
  const model = readProgram(outline);
  if (!model) return 'program.py isn’t a program the forms can read: edit it in the code editor.';
  return { code, model };
}

/** Writes program.py (and the editor's copy of it), then builds it in full when asked. */
async function saveProgram(code: string, build: boolean): Promise<string | null> {
  const { project } = useApp.getState();
  if (!project) return 'Open a project first.';
  try {
    const described = await api.writeFile(project.name, PROGRAM, code);
    useApp.setState((state) => ({
      project: { ...described, builds: state.project?.builds },
      files: state.files[PROGRAM] ? { ...state.files, [PROGRAM]: { ...state.files[PROGRAM], text: code, saved: code } } : state.files,
    }));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  await refreshProgram();
  if (build) void startBuild('full');
  return null;
}

// ── The shop's machines and tools ─────────────────────────────────────────

interface ShopRecord { key: string; kind: string; definition: Record<string, unknown> }
export interface ShopTool { key: string; name: string; cutter: CutterType | null; diameter: number | null; number: number | null; register: number | null; cutterKey: string | null; flutes: number | null }
export interface ShopChoice { key: string; name: string; hint?: string }

export const useShopRecords = create<{ records: ShopRecord[]; error: string | null; project: string | null }>(() => ({ records: [], error: null, project: null }));

/** The project's shop records (shop.py run once per text, on the server). */
export async function ensureShop(force = false) {
  const project = useApp.getState().project?.name;
  if (!project || (!force && useShopRecords.getState().project === project && !useShopRecords.getState().error)) return;
  try {
    const data = await api.shop(project);
    useShopRecords.setState({ records: data.records as ShopRecord[], error: null, project });
  } catch (error) {
    useShopRecords.setState({ records: [], error: error instanceof Error ? error.message : String(error), project });
  }
}

const records = () => useShopRecords.getState().records;
const ref = (value: unknown) => (value && typeof value === 'object' && '$ref' in (value as object) ? String((value as { $ref: unknown }).$ref) : null);
const byKey = (key: string | null) => (key ? records().find((record) => record.key === key) ?? null : null);
const ofKind = (kind: string) => records().filter((record) => record.kind === kind);
const nameOf = (record: ShopRecord) => String(record.definition.name ?? record.key);

/** The tools a tool setup loads (with their T numbers and length registers), from the shop. */
export function toolsOf(tooling: string | null): ShopTool[] {
  const setup = byKey(tooling);
  const assignments = (setup?.definition.assignments as { assembly?: unknown; tool_number?: number; offsets?: { length_register?: number } }[] | undefined) ?? [];
  return assignments.flatMap((assignment) => {
    const assembly = byKey(ref(assignment.assembly));
    if (!assembly) return [];
    const cutter = byKey(ref(assembly.definition.cutter));
    const d = (cutter?.definition ?? {}) as { cutter_type?: CutterType; diameter_mm?: number; flute_count?: number };
    return [{ key: assembly.key, name: nameOf(assembly), cutter: d.cutter_type ?? null, diameter: d.diameter_mm ?? null, number: assignment.tool_number ?? null,
      register: assignment.offsets?.length_register ?? assignment.tool_number ?? null, cutterKey: cutter?.key ?? null, flutes: d.flute_count ?? null }];
  });
}

/** Cutting presets the shop holds for a cutter (the speeds and feeds they allow). */
export function presetsOf(cutterKey: string | null) {
  return ofKind('cutting_preset').filter((record) => ref(record.definition.cutter) === cutterKey).map((record) => ({
    key: record.key, name: nameOf(record), material: String(byKey(ref(record.definition.material))?.definition.name ?? ''),
    rpm: record.definition.maximum_spindle_rpm as number | undefined, speed: record.definition.maximum_nominal_surface_speed_m_min as number | undefined,
    perTooth: record.definition.maximum_feed_per_tooth_mm as number | undefined,
  }));
}

/** The shop's machines (with their controllers) and tool setups. */
export function machinesOf(): ShopChoice[] {
  return ofKind('machine_instance').map((record) => {
    const controller = byKey(ref(record.definition.controller));
    return { key: record.key, name: nameOf(record), hint: controller ? nameOf(controller) : undefined };
  });
}
export const dialectOf = (machine: string | null) => (byKey(ref(byKey(machine)?.definition.controller))?.definition.dialect as string | undefined) ?? null;
export const toolSetupsOf = (): ShopChoice[] => ofKind('tool_setup').map((record) => ({ key: record.key, name: nameOf(record) }));

// ── The open form ─────────────────────────────────────────────────────────

/**
 * A new setup waiting for its first operation (camlib's setups hold at least one): the setup form's values and the code
 * with the setup written in (a new program's whole program.py, or the program's code with the setup added).
 */
export interface Pending { setup: SetupDraft; code: string }

/**
 * Values a new operation's form fills in from what the program already says, so nobody types them again: per tool,
 * the feeds, speed and coolant of the last operation that uses it; and the height the setup's material starts at (the
 * floor of its last facing operation, else the stock's top). Every one is shown filled and can be changed. Nothing is
 * invented: a tool the program hasn't used yet has no feeds here.
 */
export interface Known { byTool: Record<string, Record<string, string>>; top: string | null }
const TOOL_VALUES = ['feed_mm_min', 'plunge_mm_min', 'spindle_rpm', 'coolant'];

export type ProgramForm =
  | {
      mode: 'op'; setup: string; editing: string | null; draft: OpDraft; tooling: string | null; workOffset: number; prefilled: string[]; pending: Pending | null; base: string;
      /** What the program already says, for filling a new operation's fields (see `Known`). */
      known: Known;
    }
  | { mode: 'setup'; editing: string | null; draft: SetupDraft; newProgram: boolean; base: string }
  | { mode: 'first'; pending: Pending; base: string };

interface EditorState {
  form: ProgramForm | null;
  /** The geometry field viewport picks go into. */
  picking: string | null;
  saving: boolean;
  message: string | null;
}

export const useEditor = create<EditorState>(() => ({ form: null, picking: null, saving: false, message: null }));
const set = useEditor.setState;
const get = useEditor.getState;

const firstGeometry = (cls: string) => Object.entries(OP_BY_CLASS[cls]?.geometry ?? {}).find(([, kind]) => kind !== 'surface' && kind !== 'point')?.[0] ?? null;

/** Opens a form: the right panel shows it (and the stock steps aside so the part can be picked). */
function open(form: ProgramForm, picking: string | null) {
  set({ form, picking, message: null, saving: false });
  useApp.setState({ panelOpen: true, picked: null });
}

/** The setup a new operation goes into: the one selected (or the selected operation's), else the program's last. */
function targetSetup(model: CamProgramModel): string | null {
  const selected = useApp.getState().selected;
  const setup = selected?.startsWith('setup:') ? selected.slice(6) : selected?.startsWith('operation:') ? selected.slice(10).split('/')[0] : null;
  return (setup && model.setups.some((item) => item.id === setup) ? setup : null) ?? model.setups.at(-1)?.id ?? null;
}

/** Fills an operation's empty feeds, speed and coolant (and the ones filled this way before) from its tool's last use. */
function fillFromTool(draft: OpDraft, known: Known, prefilled: string[]) {
  const names = fieldNames(draft.cls);
  for (const key of TOOL_VALUES) {
    if (!names.includes(key) || (draft.values[key] && !prefilled.includes(key))) continue;
    const value = draft.tool ? known.byTool[draft.tool]?.[key] : undefined;
    if (value) { draft.values[key] = value; if (!prefilled.includes(key)) prefilled.push(key); }
    else if (prefilled.includes(key)) { delete draft.values[key]; prefilled.splice(prefilled.indexOf(key), 1); }
  }
}

/** Chooses an operation's tool, and fills what the program already says about cutting with it. */
export function setOpTool(key: string | null) {
  const form = get().form;
  if (form?.mode !== 'op') return;
  const draft = { ...form.draft, tool: key, values: { ...form.draft.values } };
  const prefilled = [...form.prefilled];
  if (!form.editing) fillFromTool(draft, form.known, prefilled);
  set({ form: { ...form, draft, prefilled }, message: null });
}

/**
 * Fills a new operation's heights from the flat faces picked for it: its floor is their height (the lowest, when they
 * differ), and it starts at the height the setup's material stands at. Only empty fields and ones filled this way.
 */
function fillHeights(key: string) {
  const form = get().form;
  const mesh = useApp.getState().part.mesh;
  if (form?.mode !== 'op' || form.editing || !mesh) return;
  const names = fieldNames(form.draft.cls);
  const picked = form.draft.geometry[key]?.names ?? [];
  const heights = picked.map((name) => mesh.faces.find((face) => face.name === name || face.names.includes(name))?.center?.[2]).filter((z): z is number => typeof z === 'number');
  const draft = { ...form.draft, values: { ...form.draft.values } };
  const prefilled = [...form.prefilled];
  const fill = (field: string, value: string | null) => {
    if (!names.includes(field) || (draft.values[field] && !prefilled.includes(field))) return;
    if (value) { draft.values[field] = value; if (!prefilled.includes(field)) prefilled.push(field); }
    else if (prefilled.includes(field)) { delete draft.values[field]; prefilled.splice(prefilled.indexOf(field), 1); }
  };
  fill('floor_z_mm', heights.length ? String(round(Math.min(...heights))) : null);
  fill('top_z_mm', heights.length ? form.known.top : null);
  set({ form: { ...form, draft, prefilled } });
}

/** The form of a new operation of `cls`, in `setupId` (else the selected or last setup). */
export async function openNewOp(cls: string, setupId: string | null = null) {
  const waiting = get().form;
  const pending = waiting?.mode === 'first' ? waiting.pending : waiting?.mode === 'op' && !waiting.editing ? waiting.pending : null;
  const read = pending ? await pendingProgram(pending) : await programNow();
  if (typeof read === 'string') { toast(read, 'info'); return; }
  const target = pending ? pending.setup.id.trim() : setupId ?? targetSetup(read.model);
  const setup = read.model.setups.find((item) => item.id === target);
  if (!setup) { toast('Add a setup first (Setups → New setup).', 'info'); return; }
  await ensureShop();
  const spec = OP_BY_CLASS[cls];
  const draft = newOp(cls, freeOpId(read.model, spec.prefix));
  const { tooling, workOffset } = setupContext(setup);
  const tools = toolsOf(tooling).filter((tool) => tool.cutter && spec.cutters.includes(tool.cutter));
  const prefilled: string[] = [];
  if (tools.length === 1) draft.tool = tools[0].key;
  // The clearance height every operation of the setup shares, shown filled (the person sees and can change it).
  const drafts = setup.operations.map((op) => readOp(read.model, op).draft).filter((item): item is OpDraft => !!item);
  const last = drafts.at(-1);
  if (last?.values.clearance_z_mm) { draft.values.clearance_z_mm = last.values.clearance_z_mm; prefilled.push('clearance_z_mm'); }
  const known: Known = { byTool: {}, top: null };
  for (const item of drafts) {
    if (item.tool) known.byTool[item.tool] = { ...known.byTool[item.tool], ...Object.fromEntries(TOOL_VALUES.filter((key) => item.values[key]).map((key) => [key, item.values[key]])) };
    if (item.cls === 'Facing' && item.values.floor_z_mm) known.top = item.values.floor_z_mm;
  }
  known.top ??= readSetup(read.model, setup).draft?.stockMax[2] || null;
  if (draft.tool) fillFromTool(draft, known, prefilled);
  // A pending setup's operation is written into program.py as it was when the setup's form opened.
  const base = pending && waiting ? waiting.base : read.code;
  open({ mode: 'op', setup: setup.id, editing: null, draft, tooling, workOffset, prefilled, pending, base, known }, firstGeometry(cls));
}

/** The form of an operation of the program, or why it's edited in code. */
export async function openEditOp(operation: string) {
  const read = await programNow();
  if (typeof read === 'string') { toast(read, 'info'); return; }
  const op = read.model.setups.flatMap((setup) => setup.operations).find((item) => item.id === operation);
  if (!op) { toast(`program.py has no operation ${operation} the forms can find: edit it in code.`, 'info'); return; }
  const { draft, problems } = readOp(read.model, op);
  if (!draft) { toast(`${operation} is edited in code: ${problems.slice(0, 2).join('; ')}.`, 'info', { label: 'Edit code', run: () => void showInCode(operation) }); return; }
  await ensureShop();
  const setup = read.model.setups.find((item) => item.id === op.setup)!;
  const { tooling, workOffset } = setupContext(setup);
  open({ mode: 'op', setup: op.setup, editing: operation, draft, tooling, workOffset, prefilled: [], pending: null, base: read.code, known: { byTool: {}, top: null } }, null);
}

/** Shows an operation's or setup's definition in program.py. */
export async function showInCode(id: string) {
  const line = await findDefinition(PROGRAM, id);
  await revealIn(PROGRAM, line ?? 1, false);
}

/** A pending setup's program: its code (the new setup written in) as the forms read it. */
async function pendingProgram(pending: Pending): Promise<{ code: string; model: CamProgramModel } | string> {
  const outline = await parseProgram(pending.code);
  const model = outline.ok ? readProgram(outline) : null;
  return model ? { code: pending.code, model } : 'The new setup’s code doesn’t read back.';
}

/** program.py holds no program yet: nothing but its docstring, imports and comments (a new project's). */
const emptyProgram = (outline: Outline) => outline.ok && outline.statements.every((statement) => statement.kind === 'import' || statement.kind === 'docstring');

/** The setup form: a new setup of the program, a new program's first setup (program.py has none yet), or a setup edited. */
export async function openSetup(setupId: string | null = null) {
  const { project, part } = useApp.getState();
  if (!project) return;
  const open_ = useApp.getState().files[PROGRAM];
  if (open_ && !open_.loading && open_.text !== open_.saved) { toast('program.py has unsaved changes in the editor: save them (Ctrl+S) first.', 'info'); return; }
  await Promise.all([ensureShop(), ensureFields()]);
  let code = '';
  try { code = await api.file(project.name, PROGRAM); } catch { /* none yet: a new program */ }
  const outline = await parseProgram(code);
  if (!outline.ok) { toast(`program.py doesn’t parse (line ${outline.error?.line}): fix it in the code editor.`, 'info'); return; }
  const model = readProgram(outline);
  const bounds = part.mesh?.bounds ?? null;
  const fit = (value: number) => String(Math.round(value * 1000) / 1000);
  const one = <T extends { key: string }>(items: T[]) => (items.length === 1 ? items[0].key : null);
  const fresh: SetupDraft = {
    id: 'top', machine: one(machinesOf()), tooling: one(toolSetupsOf()), cell: '0.5', workOffset: '1', stockContact: true, material: false, premises: {},
    stockMin: bounds ? [fit(bounds.min[0] - 2), fit(bounds.min[1] - 2), fit(bounds.min[2])] : ['', '', ''],
    stockMax: bounds ? [fit(bounds.max[0] + 2), fit(bounds.max[1] + 2), fit(bounds.max[2] + 1)] : ['', '', ''],
    start: bounds ? [fit(bounds.min[0]), fit(bounds.min[1]), fit(bounds.max[2] + 40)] : ['', '', ''],
  };
  if (!model?.program) {
    if (!emptyProgram(outline)) { toast('program.py has code but no `program = Program(...)` the forms can add a setup to: add it in code.', 'info'); return; }
    open({ mode: 'setup', editing: null, draft: fresh, newProgram: true, base: code }, null);
    return;
  }
  if (setupId) {
    const setup = model.setups.find((item) => item.id === setupId);
    const result = setup ? readSetup(model, setup) : null;
    if (!result?.draft) {
      toast(`${setupId} is edited in code: ${(result?.problems ?? ['It isn’t a setup the forms can find']).slice(0, 2).join('; ')}.`, 'info', { label: 'Edit code', run: () => void showInCode(setupId) });
      return;
    }
    open({ mode: 'setup', editing: setupId, draft: result.draft, newProgram: false, base: code }, null);
    return;
  }
  // A further setup starts from the last one's machine, tools and machine values.
  const last = model.setups.at(-1);
  const previous = last ? readSetup(model, last).draft : null;
  const ids = new Set(model.setups.map((setup) => setup.id));
  let n = model.setups.length + 1;
  while (ids.has(`setup_${n}`)) n++;
  const draft: SetupDraft = { ...fresh, ...(previous ? { machine: previous.machine, tooling: previous.tooling, premises: previous.premises, workOffset: previous.workOffset } : {}), id: `setup_${n}` };
  open({ mode: 'setup', editing: null, draft, newProgram: false, base: code }, null);
}

export function closeForm() { set({ form: null, picking: null, message: null, saving: false }); }

export function updateOp(change: (draft: OpDraft) => OpDraft) {
  const form = get().form;
  if (form?.mode !== 'op') return;
  set({ form: { ...form, draft: change(form.draft) }, message: null });
}
export function updateSetup(change: (draft: SetupDraft) => SetupDraft) {
  const form = get().form;
  if (form?.mode !== 'setup') return;
  set({ form: { ...form, draft: change(form.draft) }, message: null });
}

/** What OK can't do yet (null: it can). */
export function okProblem(form: ProgramForm | null): string | null {
  if (!form) return null;
  if (form.mode === 'first') return 'Choose the setup’s first operation.';
  if (form.mode === 'op') { const missing = missingOf(form.draft); return missing.length ? `Needed: ${missing.join(', ')}.` : null; }
  const d = form.draft;
  if (!d.machine || !d.tooling) return 'Pick the machine and its tool setup.';
  if (d.material && !useApp.getState().project?.part) return 'Checking the stock against the part needs a part file.';
  const required = ['work_to_machine', 'flood', 'mist', 'planes', 'arcs', 'helices', 'max_sweep_rad', 'max_tool_number', 'max_length_register', 'tool_change_position_mode'];
  const missing = required.filter((key) => !(d.premises[key] ?? '').trim());
  return missing.length ? `The machine needs: ${missing.map((key) => key.replace(/_/g, ' ')).join(', ')}.` : null;
}

/** OK: the form's code written into program.py, saved and built. A new setup asks for its first operation next. */
export async function commitForm() {
  const form = get().form;
  if (!form || get().saving) return;
  const problem = okProblem(form);
  if (problem) { set({ message: problem }); return; }
  set({ saving: true, message: null });
  try {
    if (form.mode === 'first') return;
    // A new setup: camlib's setups hold at least one operation, so its first operation's form comes next and saves both.
    if (form.mode === 'setup' && !form.editing) {
      const draft = { ...form.draft, id: form.draft.id.trim() };
      let code: string;
      if (form.newProgram) code = newProgramCode(useApp.getState().project?.name ?? 'program', draft, !!useApp.getState().project?.part);
      else {
        const read = await programNow();
        if (typeof read === 'string') { set({ message: read }); return; }
        if (read.code !== form.base) { set({ message: 'program.py changed meanwhile: close this and open it again.' }); return; }
        code = writeSetup(read.code, read.model, draft, null);
      }
      set({ form: { mode: 'first', pending: { setup: draft, code }, base: form.base }, picking: null, message: null });
      return;
    }
    // Everything else writes program.py from the code the form was opened on (refused if it changed since).
    const now = await programNow();
    if (typeof now === 'string') { set({ message: now }); return; }
    if (now.code !== form.base) { set({ message: 'program.py changed meanwhile: close this and open it again.' }); return; }
    let code: string;
    if (form.mode === 'op' && form.pending) {
      const read = await pendingProgram(form.pending);
      if (typeof read === 'string') { set({ message: read }); return; }
      code = writeOp(read.code, read.model, form.setup, { ...form.draft, id: form.draft.id.trim() });
    } else if (form.mode === 'op') {
      const op = form.editing ? now.model.setups.flatMap((setup) => setup.operations).find((item) => item.id === form.editing) ?? null : null;
      code = writeOp(now.code, now.model, form.setup, { ...form.draft, id: form.draft.id.trim() }, op);
    } else {
      const setup = now.model.setups.find((item) => item.id === form.editing) ?? null;
      code = writeSetup(now.code, now.model, form.draft, setup);
    }
    const error = await saveProgram(code, true);
    if (error) { set({ message: error }); return; }
    useApp.setState({ selected: form.mode === 'op' ? `operation:${form.setup}/${form.draft.id.trim()}` : `setup:${form.draft.id.trim()}` });
    closeForm();
  } catch (error) {
    set({ message: error instanceof FormError ? error.message : (error as Error).message });
  } finally { set({ saving: false }); }
}

// ── Picking geometry on the part ──────────────────────────────────────────

const pickingKind = (state: EditorState): GeometryKind | null => (state.form?.mode === 'op' && state.picking ? OP_BY_CLASS[state.form.draft.cls]?.geometry[state.picking] ?? null : null);
export const usePickingKind = () => useEditor((state) => pickingKind(state));

export function startPicking(key: string | null) {
  set({ picking: get().picking === key ? null : key });
  useApp.setState({ picked: null });
}

const along = (v: number[] | undefined, axis: 2) => !!v && Math.abs(Math.abs(v[axis]) - 1) < 1e-6;
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * A face's or edge's name to write: the name the part file gives it when that name is its own (it selects this face
 * alone), else its number (`face12`).
 */
function nameFor(items: { name: string; names: string[] }[], index: number): string {
  const item = items[index];
  const own = item.names.find((name) => items.filter((other) => other.names.includes(name)).length === 1);
  return own ?? item.name;
}

/** The edge nearest a point on the part (its polylines), within `within` mm, or -1. */
function nearestEdge(mesh: PartMesh, point: [number, number, number], within: number): number {
  let best = -1, distance = within;
  mesh.edges.forEach((line, index) => {
    for (let i = 3; i < line.length; i += 3) {
      const ax = line[i - 3], ay = line[i - 2], az = line[i - 1], bx = line[i], by = line[i + 1], bz = line[i + 2];
      const dx = bx - ax, dy = by - ay, dz = bz - az, length = dx * dx + dy * dy + dz * dz;
      const t = length ? Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy + (point[2] - az) * dz) / length)) : 0;
      const d = Math.hypot(ax + t * dx - point[0], ay + t * dy - point[1], az + t * dz - point[2]);
      if (d < distance) { distance = d; best = index; }
    }
  });
  return best;
}

/**
 * A click on the part while a form waits for geometry: toggled into the field (true: the form took the click). Faces
 * (`face`: 1-based) and the point clicked; an edge is the one nearest the point.
 */
export function pickIntoForm(face: number, point: [number, number, number]): boolean {
  const state = get();
  const kind = pickingKind(state);
  if (!kind || state.form?.mode !== 'op') return false;
  const mesh = useApp.getState().part.mesh;
  if (!mesh) return true;
  const key = state.picking!;
  const info = mesh.faces[face - 1];
  const toggle = (name: string) => updateOp((draft) => {
    const current = draft.geometry[key]?.names ?? [];
    const names = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
    const geometry: Geometry = { names, keep: draft.geometry[key]?.keep };
    return { ...draft, geometry: { ...draft.geometry, [key]: geometry } };
  });
  if (kind === 'region') {
    if (!info || info.type !== 'PLANE' || !along(info.normal, 2)) { toast('Not a face it takes: pick flat faces facing up or down (along Z).', 'info'); return true; }
    toggle(nameFor(mesh.faces, face - 1));
    fillHeights(key);
    return true;
  }
  if (kind === 'holes' || kind === 'point') {
    if (!info || info.type !== 'CYLINDER' || !along(info.axis, 2)) { toast('Not a hole wall: pick a hole’s round wall (a cylinder along Z).', 'info'); return true; }
    if (kind === 'point') {
      updateOp((draft) => ({ ...draft, values: { ...draft.values, [key]: `(${round(info.center![0])}, ${round(info.center![1])})` } }));
      set({ picking: null });
      return true;
    }
    toggle(nameFor(mesh.faces, face - 1));
    // A bore's diameter is the picked hole's, shown filled when it's still empty.
    updateOp((draft) => (draft.cls === 'Bore' && !draft.values.diameter_mm ? { ...draft, values: { ...draft.values, diameter_mm: String(round(info.radius! * 2)) } } : draft));
    return true;
  }
  if (kind === 'paths' || kind === 'path') {
    const size = Math.hypot(...mesh.bounds.max.map((v, i) => v - mesh.bounds.min[i]));
    const edge = nearestEdge(mesh, point, Math.max(0.5, size * 0.015));
    const info2 = edge >= 0 ? mesh.edge_info?.[edge] : null;
    if (info2?.flat) { toggle(nameFor(mesh.edge_info!, edge)); return true; }
    // Paths: a flat face for its outline (all its edges).
    if (kind === 'paths' && info?.type === 'PLANE' && along(info.normal, 2)) { toggle(nameFor(mesh.faces, face - 1)); return true; }
    toast(info2 ? 'Not an edge it takes: pick straight edges or circular arcs lying flat (in XY).' : 'Click on an edge of the part.', 'info');
    return true;
  }
  return false;
}

/** The faces and edges named (a geometry field's picks), as indices (0-based) into the part's faces and edges. */
export function pickedGeometry(mesh: PartMesh | null, names: string[]): { faces: Set<number>; edges: Set<number> } {
  const out = { faces: new Set<number>(), edges: new Set<number>() };
  if (!mesh) return out;
  for (const name of names) {
    const face = mesh.faces.findIndex((item) => item.name === name || item.names.includes(name));
    if (face >= 0) { mesh.faces.forEach((item, i) => { if (item.name === name || item.names.includes(name)) out.faces.add(i); }); continue; }
    mesh.edge_info?.forEach((item, i) => { if (item.name === name || item.names.includes(name)) out.edges.add(i); });
  }
  return out;
}

// ── The tree's actions ───────────────────────────────────────────────────

async function treeEdit(what: string, edit: (code: string, model: CamProgramModel) => string, undo = true) {
  const read = await programNow();
  if (typeof read === 'string') { toast(read, 'info'); return; }
  let code: string;
  try { code = edit(read.code, read.model); } catch (error) { toast((error as Error).message, 'info'); return; }
  const error = await saveProgram(code, false);
  if (error) { toast(`${what}: not saved. ${error}`); return; }
  const before = read.code;
  toast(`${what}. Build to see it.`, 'info', undo ? { label: 'Undo', run: () => void saveProgram(before, false) } : undefined);
}

const findOp = (model: CamProgramModel, id: string): CamOp => {
  const op = model.setups.flatMap((setup) => setup.operations).find((item) => item.id === id);
  if (!op) throw new FormError(`program.py has no operation ${id}.`);
  return op;
};

export const deleteProgramOp = (id: string) => treeEdit(`Deleted ${id}`, (code, model) => deleteOp(code, model, findOp(model, id)));
export const duplicateProgramOp = (id: string) => treeEdit(`Duplicated ${id}`, (code, model) => duplicateOp(code, model, findOp(model, id)).code);
/** Moves an operation to `index` within its setup (a drag in the tree, or Move up/down). */
export const moveProgramOp = (id: string, index: number) => treeEdit(`Moved ${id}`, (code, model) => {
  const op = findOp(model, id);
  const setup = model.setups.find((item) => item.id === op.setup)!;
  const order = setup.operations.map((_, i) => i).filter((i) => i !== op.index);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, op.index);
  return reorderOps(code, model, setup.id, order);
});

