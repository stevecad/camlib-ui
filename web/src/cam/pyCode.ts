/**
 * A program's code as its forms read and write it (from STEVE Studio's camlibCode.ts): the code is the program. The
 * server reads program.py into an outline (camlib_ui/forms.py: every top-level name with its value as syntax, UTF-16
 * spans, literal values); this module reads the program's setups and operations from it and edits the code by replacing
 * exactly the spans an edit touches (an operation's call, an item of a tuple, a keyword, an import), so the person's
 * other code stays byte for byte as it was. Nothing here parses Python itself.
 */

export type Span = [number, number];
export interface Kw { key: string | null; s: Span; value: Py }
/** One expression of the outline: kind, span, its source and (when it has one) its literal value. */
export interface Py {
  k: 'num' | 'str' | 'bool' | 'none' | 'name' | 'attr' | 'call' | 'tuple' | 'list' | 'starred' | 'dict' | 'expr' | 'code';
  s: Span; src: string; v?: unknown; name?: string; f?: string | null; a?: Py[]; kw?: Kw[]; items?: Py[]; item?: Py;
  keys?: (Py | null)[]; values?: Py[];
}
export interface Statement {
  index: number; s: Span; line: number; end_line: number; kind: 'import' | 'docstring' | 'assign' | 'other';
  module?: string | null; names?: ({ name: string; as: string | null } | string)[]; value?: Py;
}
export interface Outline {
  version: 1; ok: boolean; error?: { message: string; line: number };
  statements: Statement[]; imports: Statement[]; bindings: Record<string, { statement: number; value: Py; unpacked?: boolean }>;
  parameters: Record<string, number>;
}

/** camlib-ui's program helpers' module (region, hole_centers, tool, slot, machine, Program, …). */
export const HELPERS = 'camlib_ui.program';

export const OP_CLASSES = new Set(['Facing', 'Pocket', 'RestPocket', 'AdaptivePocket', 'Roughing', 'RestRoughing', 'Contour', 'Chamfer', 'VCarve', 'Trace',
  'TrochoidalSlot', 'Drilling', 'Bore', 'Reaming', 'Tapping', 'ThreadMilling', 'Parallel', 'Waterline', 'Flat', 'Scallop', 'Pencil', 'Spiral', 'Radial',
  'Project', 'Morph',
  // A lathe setup's (camlib.turning).
  'TurnFace', 'TurnRough', 'TurnFinish', 'TurnGroove', 'TurnPartOff', 'TurnThread', 'TurnDrill', 'TurnBoreRough', 'TurnBoreFinish', 'TurnFaceGroove',
  // A sheet setup's (plasma, laser).
  'ThermalCut', 'ThermalMark']);

/** Full precision, shortest round-trip form. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Can't write ${value} as code.`);
  if (Object.is(value, -0)) return '0';
  return String(value);
}

export function pyString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// ── Reading ──────────────────────────────────────────────────────────────

/** The last part of a dotted name: `camlib.Pocket` → Pocket. */
export const base = (name: string | null | undefined) => (name ?? '').split('.').pop() ?? '';

/** Python's own order of names (code units: capitals first), as isort sorts imports. */
export const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A name's value (followed through other names), or the value itself. */
export function resolve(outline: Outline, value: Py | undefined | null, depth = 0): Py | null {
  if (!value) return null;
  if (value.k === 'name' && depth < 8) {
    const bound = outline.bindings[value.name!];
    return bound ? resolve(outline, bound.value, depth + 1) : value;
  }
  return value;
}

/** A call's argument by keyword or position. */
export function argOf(call: Py, key: string, position: number): Py | undefined {
  const named = call.kw?.find((item) => item.key === key);
  if (named) return named.value;
  return position >= 0 ? call.a?.[position] : undefined;
}

export interface CamOp {
  setup: string;
  /** Its place in the setup's operations tuple. */
  index: number;
  /** The tuple's item (a call, a name bound to one, an OperationNode, a starred helper). */
  element: Py;
  /** The operation's own call (null when the item isn't one the forms know). */
  call: Py | null;
  cls: string | null;
  id: string | null;
}

export interface CamSetup {
  variable: string | null;
  id: string;
  call: Py;
  /** The Setup statement (a top-level `name = Setup(...)`). */
  statement: Statement | null;
  /** Its tools and operations tuples, resolved (null: not a tuple the forms can edit). */
  tools: Py | null;
  ops: Py | null;
  operations: CamOp[];
  /** Its machine(...) call in the program (the first one, when it is posted for several). */
  machine: Py | null;
  /** A lathe setup (Setup(..., turning=...)): its operations are camlib's Turn* ones, its tools turret stations. */
  turning: boolean;
  /** A lathe setup's shop turret, from its tools' `station(shop.<turret>, tool)` (null: none, or more than one). */
  turret: string | null;
  /** A sheet setup (a plasma or laser table's): its tools are a `head(shop.<machine>, shop.<recipe>)`, its operations camlib's Thermal* ones. */
  sheet: boolean;
}

/** A cutting head the program makes: `torch = head(shop.<machine>, shop.<recipe>)`. */
export interface CamHead { machine: string; recipe: string }

export interface CamProgramModel {
  outline: Outline;
  setups: CamSetup[];
  job: Py | null;
  program: Py | null;
  /** Tool variables: name → shop key (`mill = tool(shop.t_em10)`). */
  tools: Record<string, string>;
  /** Cutting head variables: name → its shop machine and cutting recipe (`torch = head(shop.table, shop.steel6)`). */
  heads: Record<string, CamHead>;
  /** The aliases the links are imported as (`from links import part, shop`). */
  part: string;
  shop: string;
}

const statementOf = (outline: Outline, name: string | null) => (name && outline.bindings[name] ? outline.statements[outline.bindings[name].statement] ?? null : null);
const isTuple = (value: Py | null): boolean => !!value && (value.k === 'tuple' || value.k === 'list');

/** The shop key a `tool(shop.<key>)` call names. */
export function toolKeyOf(value: Py | null, shop = 'shop'): string | null {
  if (!value || value.k !== 'call' || base(value.f) !== 'tool' || value.a?.length !== 1 || value.kw?.length) return null;
  const item = value.a[0];
  return item.k === 'attr' && item.name?.startsWith(`${shop}.`) && item.name.split('.').length === 2 ? item.name.split('.')[1] : null;
}

/** The shop machine and recipe a `head(shop.<machine>, shop.<recipe>)` call names (null: not that call, or one with a head= choice). */
export function headOf(value: Py | null, shop = 'shop'): CamHead | null {
  if (!value || value.k !== 'call' || base(value.f) !== 'head' || value.a?.length !== 2 || value.kw?.length) return null;
  const keys = value.a.map((item) => (item.k === 'attr' && item.name?.startsWith(`${shop}.`) && item.name.split('.').length === 2 ? item.name.split('.')[1] : null));
  return keys[0] && keys[1] ? { machine: keys[0], recipe: keys[1] } : null;
}

/** A lathe setup's tool: `station(shop.<turret>, <tool variable>)` as its turret's key and the variable (null: not that call). */
export function stationOf(value: Py | null, shop = 'shop'): { turret: string; variable: string } | null {
  if (!value || value.k !== 'call' || base(value.f) !== 'station' || value.a?.length !== 2 || value.kw?.length) return null;
  const [turret, tool] = value.a;
  if (turret.k !== 'attr' || !turret.name?.startsWith(`${shop}.`) || turret.name.split('.').length !== 2 || tool.k !== 'name') return null;
  return { turret: turret.name.split('.')[1], variable: tool.name! };
}

/** The program's setups, operations, tools and links as its code says (null: it isn't a program the forms read). */
export function readProgram(outline: Outline): CamProgramModel | null {
  if (!outline.ok) return null;
  const links = outline.imports.find((item) => item.module === 'links');
  const aliases = (links?.names ?? []).map((item) => (typeof item === 'string' ? item : item.as ?? item.name));
  const part = aliases.includes('part') ? 'part' : aliases.find((name) => name !== 'shop') ?? 'part';
  const shop = 'shop';
  const tools: Record<string, string> = {};
  const heads: Record<string, CamHead> = {};
  for (const [name, bound] of Object.entries(outline.bindings)) {
    const key = toolKeyOf(bound.value, shop);
    if (key) tools[name] = key;
    const head = headOf(bound.value, shop);
    if (head) heads[name] = head;
  }
  const program = resolve(outline, outline.bindings.program?.value);
  const programCall = program?.k === 'call' && base(program.f) === 'Program' ? program : null;
  const job = programCall ? resolve(outline, argOf(programCall, 'job', 0)) : null;
  const jobCall = job?.k === 'call' && base(job.f) === 'Job' ? job : null;
  const machines = programCall ? resolve(outline, argOf(programCall, 'machines', 1)) : null;
  // The setups in the job's order; else every Setup the code binds.
  const listed = jobCall ? resolve(outline, argOf(jobCall, 'setups', 2)) : null;
  const items: { value: Py; variable: string | null }[] = isTuple(listed)
    ? listed!.items!.map((item) => ({ value: resolve(outline, item)!, variable: item.k === 'name' ? item.name! : null }))
    : Object.entries(outline.bindings).filter(([, bound]) => bound.value.k === 'call' && base(bound.value.f) === 'Setup').map(([name, bound]) => ({ value: bound.value, variable: name }));
  const setups: CamSetup[] = [];
  for (const { value, variable } of items) {
    if (value?.k !== 'call' || base(value.f) !== 'Setup') continue;
    const id = argOf(value, 'id', 0)?.v;
    if (typeof id !== 'string') continue;
    const toolsArg = argOf(value, 'tools', 2), opsArg = argOf(value, 'operations', 3);
    const toolsTuple = resolve(outline, toolsArg), opsTuple = resolve(outline, opsArg);
    const operations = isTuple(opsTuple) ? opsTuple!.items!.map((element, index) => opOf(outline, id, element, index)) : [];
    const turrets = new Set((isTuple(toolsTuple) ? toolsTuple!.items! : []).map((item) => stationOf(resolve(outline, item), shop)?.turret).filter((key): key is string => !!key));
    setups.push({ variable, id, call: value, statement: statementOf(outline, variable), tools: isTuple(toolsTuple) ? toolsTuple : null, ops: isTuple(opsTuple) ? opsTuple : null,
      operations, machine: machineOf(outline, machines, id), turning: !!value.kw?.some((kw) => kw.key === 'turning'), turret: turrets.size === 1 ? [...turrets][0] : null,
      sheet: isTuple(toolsTuple) && toolsTuple!.items!.length > 0 && toolsTuple!.items!.every((item) => item.k === 'name' && !!heads[item.name!]) });
  }
  return { outline, setups, job: jobCall, program: programCall, tools, heads, part, shop };
}

function opOf(outline: Outline, setup: string, element: Py, index: number): CamOp {
  let call = resolve(outline, element);
  if (call?.k === 'call' && base(call.f) === 'OperationNode') call = resolve(outline, argOf(call, 'operation', 0));
  const id = call?.k === 'call' ? argOf(call, 'id', 0)?.v : undefined;
  // An operation the forms have no form for (camlib's SuppliedToolpath, Deburr, …) keeps its own id (camlib's operations
  // take it first), so the tree names it and shows its build figures; it is edited in code.
  if (call?.k !== 'call' || !OP_CLASSES.has(base(call.f))) return { setup, index, element, call: null, cls: call?.k === 'call' ? base(call.f) : null, id: typeof id === 'string' ? id : null };
  return { setup, index, element, call, cls: base(call.f), id: typeof id === 'string' ? id : null };
}

/** A setup's machine(...) call: the program's one machine, or its entry for the setup in a {setup id: machine} dict. */
function machineOf(outline: Outline, machines: Py | null, id: string): Py | null {
  const first = (value: Py | null): Py | null => {
    const item = resolve(outline, value);
    if (isTuple(item)) return first(item!.items![0] ?? null);
    return item?.k === 'call' && base(item.f) === 'machine' ? item : null;
  };
  if (!machines) return null;
  if (machines.k === 'dict') {
    const at = (machines.keys ?? []).findIndex((key) => key?.v === id);
    return at >= 0 ? first(machines.values![at]) : null;
  }
  return first(machines);
}

// ── Editing ──────────────────────────────────────────────────────────────

/** A replacement of `at` (UTF-16 offsets of the code it was made on) by `text`. */
export interface Edit { at: Span; text: string }

/** Applies edits made on the same code; they must not overlap (a bug if they do). */
export function applyEdits(code: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.at[0] - a.at[0] || b.at[1] - a.at[1]);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].at[1] > sorted[i - 1].at[0]) throw new Error('Overlapping code edits.');
  }
  let out = code;
  for (const edit of sorted) out = out.slice(0, edit.at[0]) + edit.text + out.slice(edit.at[1]);
  return out;
}

/** The column (UTF-16 units from the line's start) of an offset. */
export const columnOf = (code: string, offset: number) => offset - (code.lastIndexOf('\n', offset - 1) + 1);

/** The tuple's inner text split into separators and items: sep[0] item[0] sep[1] item[1] … item[n-1] trailer. */
function pieces(code: string, tuple: Py) {
  const delimited = /^[([]/.test(tuple.src);
  const open = delimited ? tuple.s[0] + 1 : tuple.s[0], close = delimited ? tuple.s[1] - 1 : tuple.s[1];
  const items = tuple.items ?? [];
  const seps = items.map((item, i) => code.slice(i ? items[i - 1].s[1] : open, item.s[0]));
  const texts = items.map((item) => code.slice(item.s[0], item.s[1]));
  const trailer = items.length ? code.slice(items[items.length - 1].s[1], close) : code.slice(open, close);
  return { delimited, open, close, seps, texts, trailer };
}

function joinTuple(tuple: Py, delimited: boolean, seps: string[], texts: string[], trailer: string, inner: Span): Edit {
  let tail = trailer;
  // A parenthesized one-item tuple keeps its comma; an empty one has no separators left.
  if (tuple.k === 'tuple' && texts.length === 1 && !tail.includes(',')) tail = `,${tail}`;
  // A one-line tuple's comma that only marked it as a tuple of one goes once it has more.
  if (texts.length > 1 && tail.trim() === ',' && !tail.includes('\n') && !seps.some((sep) => sep.includes('\n'))) tail = tail.replace(',', '');
  if (!texts.length) return { at: delimited ? inner : tuple.s, text: delimited ? '' : '()' };
  const text = texts.map((item, i) => seps[i] + item).join('') + tail;
  return { at: delimited ? inner : tuple.s, text: delimited ? text : `(${text})` };
}

/** The separator a new item gets: the tuple's own between items, or a line of its own when its first item has one. */
function separator(code: string, tuple: Py, seps: string[]): string {
  if (seps.length > 1) {
    const sep = seps[1].includes(',') ? seps[1] : `,${seps[1]}`;
    // A comment written between the first two items is the second item's own, not every new item's.
    if (!sep.includes('#')) return sep;
    return sep.includes('\n') ? `,\n${' '.repeat(columnOf(code, tuple.items![1].s[0]))}` : ', ';
  }
  const items = tuple.items ?? [];
  if (items.length && seps[0].includes('\n')) return `,\n${' '.repeat(columnOf(code, items[0].s[0]))}`;
  return ', ';
}

const lineIndent = (code: string, offset: number) => code.slice(code.lastIndexOf('\n', offset - 1) + 1).match(/^ */)![0].length;

/**
 * The column a new item of the tuple starts at (to format its text for): its items' column when they stand on lines of
 * their own, an empty tuple's when `ownLines` (one indent deeper than its line), else -1 (it follows the item before it).
 */
export function itemColumn(code: string, tuple: Py, ownLines = false): number {
  const items = tuple.items ?? [];
  if (!items.length) return ownLines ? lineIndent(code, tuple.s[0]) + 4 : -1;
  return pieces(code, tuple).seps[0].includes('\n') ? columnOf(code, items[0].s[0]) : -1;
}

/** Inserts `text` as the tuple's item at `index` (its end by default); into an empty tuple on a line of its own when `ownLines`. */
export function insertItem(code: string, tuple: Py, text: string, index = (tuple.items ?? []).length, ownLines = false): Edit {
  const { delimited, open, close, seps, texts, trailer } = pieces(code, tuple);
  const sep = separator(code, tuple, seps);
  if (!texts.length) {
    const indent = lineIndent(code, tuple.s[0]);
    const body = ownLines ? `\n${' '.repeat(indent + 4)}${text},\n${' '.repeat(indent)}` : `${text},`;
    return { at: delimited ? [open, close] : tuple.s, text: delimited ? body : `(${body})` };
  }
  const nextTexts = [...texts];
  nextTexts.splice(index, 0, text);
  const nextSeps = index === 0 ? [seps[0], sep, ...seps.slice(1)] : [...seps.slice(0, index), sep, ...seps.slice(index)];
  return joinTuple(tuple, delimited, nextSeps, nextTexts, trailer, [open, close]);
}

/** Removes the tuple's item at `index`. */
export function removeItem(code: string, tuple: Py, index: number): Edit {
  const { delimited, open, close, seps, texts, trailer } = pieces(code, tuple);
  const nextTexts = texts.filter((_, i) => i !== index);
  const nextSeps = [...seps];
  nextSeps.splice(index === 0 && seps.length > 1 ? 1 : index, 1);
  return joinTuple(tuple, delimited, nextSeps, nextTexts, trailer, [open, close]);
}

/** The tuple's items in a new order (`order[i]`: the old index of the new i-th item); separators stay where they were. */
export function reorderItems(code: string, tuple: Py, order: number[]): Edit {
  const { delimited, open, close, seps, texts, trailer } = pieces(code, tuple);
  return joinTuple(tuple, delimited, seps, order.map((i) => texts[i]), trailer, [open, close]);
}

/** Sets a call's keyword (`text`: its new value's source) or removes it (null); a positional one is replaced in place. */
export function setKeyword(call: Py, key: string, text: string | null, position = -1): Edit | null {
  const kw = call.kw?.find((item) => item.key === key);
  if (kw) {
    if (text !== null) return { at: kw.value.s, text };
    const all = [...(call.a ?? []).map((item) => item.s), ...(call.kw ?? []).map((item) => item.s)].sort((a, b) => a[0] - b[0]);
    const at = all.findIndex((s) => s[0] === kw.s[0]);
    return at > 0 ? { at: [all[at - 1][1], kw.s[1]], text: '' } : { at: [kw.s[0], all[1]?.[0] ?? kw.s[1]], text: '' };
  }
  const positional = position >= 0 ? call.a?.[position] : undefined;
  if (positional) return text === null ? null : { at: positional.s, text };
  if (text === null) return null;
  const last = [...(call.a ?? []), ...(call.kw ?? []).map((item) => ({ s: item.s }))].sort((a, b) => b.s[1] - a.s[1])[0];
  if (last) return { at: [last.s[1], last.s[1]], text: `, ${key}=${text}` };
  return { at: [call.s[1] - 1, call.s[1] - 1], text: `${key}=${text}` };
}

/** A call written within `width` columns: on one line, or its arguments wrapped under its opening parenthesis. */
export function formatCall(name: string, parts: string[], column: number, width = 118): string {
  const one = `${name}(${parts.join(', ')})`;
  if (column + one.length <= width && !one.includes('\n')) return one;
  const indent = ' '.repeat(column + name.length + 1);
  const lines: string[] = [];
  let line = '';
  for (const [i, part] of parts.entries()) {
    const piece = part + (i < parts.length - 1 ? ',' : ')');
    if (line && (line.length + 1 + piece.length + (lines.length ? indent.length : column + name.length + 1) > width)) {
      lines.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  }
  lines.push(line);
  return `${name}(${lines.join(`\n${indent}`)}`;
}

/** The import edits that make `names` importable from each module (each statement rewritten in place, or added). */
export function importEdits(outline: Outline, needs: Record<string, string[]>): Edit[] {
  const edits: Edit[] = [];
  const last = outline.imports.at(-1);
  const added: string[] = [];
  for (const [module, names] of Object.entries(needs)) {
    if (!names.length) continue;
    const statement = outline.imports.find((item) => item.module === module);
    const have = (statement?.names ?? []).map((item) => (typeof item === 'string' ? item : item.as ? null : item.name)).filter((name): name is string => !!name);
    const missing = [...new Set(names)].filter((name) => !have.includes(name) && !(module === 'camlib' && outline.bindings[name]));
    if (!missing.length) continue;
    if (statement && !(statement.names ?? []).some((item) => typeof item !== 'string' && item.as)) {
      const sorted = have.every((name, i) => !i || have[i - 1] <= name);
      const all = sorted ? [...have, ...missing].sort(byCode) : [...have, ...missing];
      edits.push({ at: statement.s, text: `${importLine(module, all)}\n` });
    } else added.push(importLine(module, missing));
  }
  if (added.length) {
    const at = last ? last.s[1] : (outline.statements[0]?.kind === 'docstring' ? outline.statements[0].s[1] : 0);
    edits.push({ at: [at, at], text: `${added.join('\n')}\n` });
  }
  return edits;
}

function importLine(module: string, names: string[]): string {
  const line = `from ${module} import ${names.join(', ')}`;
  if (line.length <= 118) return line;
  const rows: string[] = [];
  let row = '';
  for (const name of names) {
    if (row && row.length + name.length + 2 > 114) { rows.push(row); row = ''; }
    row = row ? `${row} ${name},` : `${name},`;
  }
  rows.push(row);
  return `from ${module} import (\n${rows.map((item) => `    ${item}`).join('\n')}\n)`;
}

/** A free name for a new variable, from `want` (letters, digits and _ only). */
export function freeName(outline: Outline, want: string, taken: Iterable<string> = []): string {
  const used = new Set([...Object.keys(outline.bindings), ...taken, 'part', 'shop', 'program', 'job', 'math']);
  const name = want.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'item';
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name}_${n}`)) return `${name}_${n}`;
}

/** A free operation id in the program, from `prefix`. */
export function freeOpId(model: CamProgramModel, prefix: string, taken: string[] = []): string {
  const ids = new Set([...model.setups.flatMap((setup) => setup.operations.map((op) => op.id ?? '')), ...taken]);
  if (!ids.has(prefix)) return prefix;
  for (let n = 2; ; n++) if (!ids.has(`${prefix}_${n}`)) return `${prefix}_${n}`;
}
