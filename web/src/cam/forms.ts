/**
 * The program's forms as code (from STEVE Studio's camlibForm.ts): an operation's or a setup's form values read from its
 * call and written back as camlib code (cam/pyCode.ts edits the spans). A form edits what it can show; a call with code
 * it can't (a computed value, a geometry it doesn't know) reads as "edit in code", never rewritten. Values are kept as
 * the Python source they were read from, so an unchanged expression stays an expression, and an unchanged part of a
 * setup (its checks, its machine) isn't rewritten at all.
 */
import { CUTTING_KEYS, fieldNames, fieldsOf, HIDDEN, KIND_NAMES, KIND_OPS, kindOfSpec, NESTED, OP_BY_CLASS, RECIPE_FIELDS, THERMAL_HIDDEN, type GeometryKind, type SetupKind } from './opSpecs.ts';
import {
  applyEdits, argOf, base, byCode, columnOf, formatCall, freeName, freeOpId, HELPERS, importEdits, insertItem, itemColumn, pyString, removeItem, reorderItems,
  resolve, setKeyword, stationOf, type CamOp, type CamProgramModel, type CamSetup, type Edit, type Outline, type Py,
} from './pyCode.ts';

/**
 * Geometry picked on the part (face or edge names), typed points, or the code it was read from, unchanged (`src`).
 * `keep`: a helper call's own keywords (`name="pocket"`), written again when the picks change. `shown`: what the code
 * is, for the form to show, when it isn't picked faces or edges (the call a variable holds).
 */
export interface Geometry { names?: string[]; points?: [number, number][]; whole?: boolean; src?: string; keep?: string[]; shown?: string }
export interface Nested { cls: string | null; values: Record<string, string>; nested: Record<string, Nested> }
export interface OpDraft {
  cls: string;
  id: string;
  /** The shop tool's key (`tool(shop.<key>)`); a sheet operation's: the program's head variable (`torch = head(shop.…, shop.…)`). */
  tool: string | null;
  /** Python source per field (empty: left out, camlib's default). */
  values: Record<string, string>;
  geometry: Record<string, Geometry>;
  nested: Record<string, Nested>;
}

export const emptyNested = (cls: string | null): Nested => ({ cls, values: {}, nested: {} });

/** A new operation's draft: every field empty (required ones must be filled). */
export function newOp(cls: string, id: string): OpDraft {
  return { cls, id, tool: null, values: {}, geometry: {}, nested: {} };
}

// ── Reading ──────────────────────────────────────────────────────────────

function readNested(outline: Outline, value: Py, classes: string[], problems: string[], label: string): Nested | null {
  const call = resolve(outline, value);
  if (call?.k === 'none') return emptyNested(null);
  if (call?.k !== 'call' || !classes.includes(base(call.f))) { problems.push(`${label} is code the form can’t show`); return null; }
  const cls = base(call.f);
  const names = fieldNames(cls);
  const out = emptyNested(cls);
  const each = (key: string, item: Py) => {
    if (NESTED[key]) { const inner = readNested(outline, item, NESTED[key].classes, problems, label); if (inner) out.nested[key] = inner; return; }
    if (item.k === 'code' || (item.v === undefined && item.k !== 'none')) { problems.push(`${label}: ${key} is code the form can’t show`); return; }
    out.values[key] = item.src;
  };
  (call.a ?? []).forEach((item, i) => (names[i] ? each(names[i], item) : problems.push(`${label} has an extra argument`)));
  for (const kw of call.kw ?? []) {
    if (!kw.key || !names.includes(kw.key)) problems.push(`${label} has an argument the form doesn’t know`);
    else each(kw.key, kw.value);
  }
  return out;
}

/** The helpers' own keywords a call may carry (kept as they are). */
const HELPER_KEYWORDS = new Set(['name', 'max_error_mm', 'tolerance_mm']);

/** The names of a helper call on the part, and its own keywords: `region(part, "a", "b", name="x")` (null: not that call). */
function helperCall(call: Py | null, helper: string, part: string): { names: string[]; keep: string[] } | null {
  if (call?.k !== 'call' || base(call.f) !== helper) return null;
  if ((call.kw ?? []).some((kw) => !kw.key || !HELPER_KEYWORDS.has(kw.key))) return null;
  const [first, ...rest] = call.a ?? [];
  if (first?.k !== 'name' || first.name !== part || rest.some((item) => item.k !== 'str')) return null;
  return { names: rest.map((item) => item.v as string), keep: (call.kw ?? []).map((kw) => `${kw.key}=${kw.value.src}`) };
}

function readGeometry(model: CamProgramModel, value: Py, kind: GeometryKind): Geometry | null {
  const call = resolve(model.outline, value);
  if (!call) return null;
  const src = value.src;
  if (kind === 'region') {
    const read = helperCall(call, 'region', model.part);
    if (read) return { ...read, src };
    // The part's outline at a depth, silhouette(part, z, max_error_mm=...): kept as its code (picking faces replaces it).
    const outline = call.k === 'call' && base(call.f) === 'silhouette' && call.a?.[0]?.k === 'name' && call.a[0].name === model.part;
    return outline ? { src, shown: call.src } : null;
  }
  if (kind === 'surface') {
    const read = helperCall(call, 'surface', model.part);
    return read && !read.names.length ? { whole: true, keep: read.keep, src } : null;
  }
  if (kind === 'holes') {
    const read = helperCall(call, 'hole_centers', model.part);
    if (read) return { ...read, src };
    const points = Array.isArray(call.v) && call.v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number')) ? call.v as [number, number][] : null;
    return points ? { points, src } : null;
  }
  if (kind === 'paths' || kind === 'path') {
    const read = helperCall(call, kind, model.part);
    return read ? { ...read, src } : null;
  }
  return null;
}

/** What a setup machines. */
export const setupKindOf = (setup: CamSetup): SetupKind => (setup.turning ? 'lathe' : setup.sheet ? 'sheet' : 'mill');

/**
 * A call's keywords with its `**` arguments opened: `**plan` where plan is a dict(...) of keywords (and theirs), and
 * the one `**cutting(shop.<recipe>, shop.<machine>, ...)` that gives a cut its recipe's values.
 */
function openKeywords(outline: Outline, call: Py, problems: string[], depth = 0): { plain: { key: string; value: Py }[]; cutting: Py | null } {
  const out: { plain: { key: string; value: Py }[]; cutting: Py | null } = { plain: [], cutting: null };
  for (const kw of call.kw ?? []) {
    if (kw.key !== null) { out.plain.push({ key: kw.key, value: kw.value }); continue; }
    const value = resolve(outline, kw.value);
    if (value?.k === 'call' && base(value.f) === 'cutting' && !out.cutting) { out.cutting = value; continue; }
    if (value?.k === 'call' && base(value.f) === 'dict' && !(value.a ?? []).length && depth < 4) {
      const inner = openKeywords(outline, value, problems, depth + 1);
      out.plain.push(...inner.plain);
      if (inner.cutting && !out.cutting) out.cutting = inner.cutting; else if (inner.cutting) problems.push('It has two cutting(...) recipes');
      continue;
    }
    problems.push('It has a ** argument the form doesn’t know');
  }
  return out;
}

/** A plasma or laser operation's call as its form's draft. */
function readThermal(model: CamProgramModel, op: CamOp): { draft: OpDraft | null; problems: string[]; tooling: string | null } {
  const cls = op.cls!, call = op.call!;
  const names = fieldNames(cls);
  const problems: string[] = [];
  const draft = newOp(cls, op.id ?? '');
  const labelOf = (key: string) => fieldsOf(cls).find((field) => field.key === key)?.label ?? key;
  const each = (key: string, value: Py) => {
    if (key === 'id') { if (value.k !== 'str') problems.push('Its id is code'); return; }
    if (key === 'tool') {
      if (value.k === 'name' && model.heads[value.name!]) draft.tool = value.name!;
      else problems.push('Its head isn’t a head(shop.…, shop.…) of the program');
      return;
    }
    if (key === 'parts') { if (value.k === 'none') problems.push('It has no parts'); else draft.values.parts = value.src; return; }
    if (cls === 'ThermalCut' && RECIPE_FIELDS.has(key)) { problems.push(`${key} is set in the code (a form takes it from the shop’s cutting recipe)`); return; }
    if (NESTED[key]) { const nested = readNested(model.outline, value, NESTED[key].classes, problems, labelOf(key)); if (nested) draft.nested[key] = nested; return; }
    if (key === 'paths') { draft.values.paths = resolve(model.outline, value)?.src ?? value.src; return; }
    if (value.k === 'code' || (value.v === undefined && value.k !== 'none')) { problems.push(`${labelOf(key)} is code the form can’t show`); return; }
    draft.values[key] = value.src;
  };
  (call.a ?? []).forEach((value, i) => (names[i] ? each(names[i], value) : problems.push('It has an extra argument')));
  const { plain, cutting } = openKeywords(model.outline, call, problems);
  for (const kw of plain) { if (names.includes(kw.key)) each(kw.key, kw.value); else problems.push(`${kw.key} isn’t one of its fields`); }
  if (cls === 'ThermalCut') {
    const head = draft.tool ? model.heads[draft.tool] : null;
    const key = (value: Py | undefined) => (value?.k === 'attr' && value.name?.startsWith(`${model.shop}.`) ? value.name.split('.')[1] : null);
    if (!cutting) problems.push('Its feed, heights and leads aren’t a cutting(shop.<recipe>, shop.<machine>, …) of the shop');
    else {
      if (head && (key(cutting.a?.[0]) !== head.recipe || key(cutting.a?.[1]) !== head.machine)) problems.push('Its cutting(...) recipe or machine isn’t its head’s');
      for (const kw of cutting.kw ?? []) {
        if (!kw.key || !CUTTING_KEYS.includes(kw.key) || kw.value.v === undefined) problems.push('Its cutting(...) has an argument the form doesn’t know');
        else draft.values[kw.key] = kw.value.src;
      }
    }
  }
  return { draft: problems.length ? null : draft, problems, tooling: null };
}

/** An operation's call as its form's draft, and what the form can't show (then it's edited in code). */
export function readOp(model: CamProgramModel, op: CamOp): { draft: OpDraft | null; problems: string[]; tooling: string | null } {
  if (!op.call || !op.cls || !OP_BY_CLASS[op.cls]) return { draft: null, problems: ['It isn’t an operation the forms know'], tooling: null };
  const spec = OP_BY_CLASS[op.cls];
  if (spec.thermal) return readThermal(model, op);
  const names = fieldNames(op.cls);
  const problems: string[] = [];
  const draft = newOp(op.cls, op.id ?? '');
  let tooling: string | null = null;
  const each = (key: string, value: Py) => {
    const label = fieldsOf(op.cls!).find((field) => field.key === key)?.label ?? key;
    if (key === 'id') { if (value.k !== 'str') problems.push('Its id is code'); return; }
    if (key === 'tool' && spec.turning) {
      // A turning operation names its tool by id: the shop key of a tool(shop.…) the program makes.
      if (value.k === 'str' && Object.values(model.tools).includes(value.v as string)) draft.tool = value.v as string;
      else problems.push('Its tool isn’t the id of a tool(shop.…) of the program');
      return;
    }
    if (key === 'tool') {
      const name = value.k === 'name' ? value.name! : null;
      if (name && model.tools[name]) draft.tool = model.tools[name];
      else problems.push('Its tool isn’t a tool(shop.…) of the program');
      return;
    }
    if (key === 'tool_number' || key === 'length_register' || key === 'work_offset') return;   // from slot() and the setup
    if (spec.geometry[key] && spec.geometry[key] !== 'point') {
      const geometry = readGeometry(model, value, spec.geometry[key]);
      if (geometry) draft.geometry[key] = geometry; else problems.push(`${label} is code the form can’t show`);
      return;
    }
    if (NESTED[key]) { const nested = readNested(model.outline, value, NESTED[key].classes, problems, label); if (nested) draft.nested[key] = nested; return; }
    if (value.k === 'code' || (value.v === undefined && value.k !== 'none')) { problems.push(`${label} is code the form can’t show`); return; }
    draft.values[key] = value.src;
  };
  (op.call.a ?? []).forEach((value, i) => (names[i] ? each(names[i], value) : problems.push('It has an extra argument')));
  for (const kw of op.call.kw ?? []) {
    if (kw.key === null) {
      const slot = kw.value;
      const shop = slot.k === 'call' && base(slot.f) === 'slot' ? slot.a?.[0] : null;
      if (shop?.k === 'attr' && shop.name?.startsWith(`${model.shop}.`)) tooling = shop.name.split('.')[1];
      else problems.push('It has a ** argument the form doesn’t know');
      continue;
    }
    if (!names.includes(kw.key)) { problems.push(`${kw.key} isn’t one of its fields`); continue; }
    each(kw.key, kw.value);
  }
  return { draft: problems.length ? null : draft, problems, tooling };
}

// ── Writing ──────────────────────────────────────────────────────────────

/** What a form's value is missing: the labels of required fields left empty (camlib requires them). */
export function missingOf(draft: OpDraft): string[] {
  const out: string[] = [];
  if (!draft.id.trim()) out.push('Name');
  const thermal = !!OP_BY_CLASS[draft.cls]?.thermal;
  if (!draft.tool) out.push(thermal ? 'Head' : 'Tool');
  if (thermal && !(draft.values.parts ?? '').trim()) out.push('Parts');
  for (const field of fieldsOf(draft.cls)) {
    if ((thermal ? THERMAL_HIDDEN : HIDDEN).has(field.key) || !field.required) continue;
    if (field.kind === 'geometry') { const g = draft.geometry[field.key]; if (!g || (!g.src && !g.whole && !g.names?.length && !g.points?.length)) out.push(field.label); continue; }
    if (field.kind === 'nested') { if (!draft.nested[field.key]?.cls) out.push(field.label); continue; }
    if (!(draft.values[field.key] ?? '').trim()) out.push(field.label);
  }
  for (const [key, nested] of Object.entries(draft.nested)) out.push(...missingNested(nested, fieldsOf(draft.cls).find((f) => f.key === key)?.label ?? key));
  return out;
}

// A list of (x, y) points (tabs at positions) as the form shows it: the points, without the brackets around them.
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const POINT = String.raw`\(\s*${NUMBER}\s*,\s*${NUMBER}\s*\)`;
const POINT_LIST = new RegExp(String.raw`^\s*${POINT}(?:\s*,\s*${POINT})*\s*,?\s*$`);

/** Typed points, `(10, 0), (90, 0)`, as Python source (a tuple of them); null when they aren't (x, y) points of numbers. */
/** What a lines field holds while its text isn't lines yet: the text, marked (never written: the form's OK refuses it). */
export const BAD_LINES = '#lines:';

export const pointsSource = (text: string): string | null => (!text.trim() ? '' : POINT_LIST.test(text) ? `(${text.trim().replace(/,$/, '')},)` : null);
/** A point list's source as the form shows it: without its outer brackets (anything else, a name or an expression, as it is). */
export function pointsText(src: string): string {
  const inner = /^\s*[([]([\s\S]*)[)\]]\s*$/.exec(src)?.[1];
  return inner !== undefined && POINT_LIST.test(inner) ? inner.trim().replace(/,$/, '') : src;
}
/** Whether a point list's source is one: literal (x, y) points, or code the program already had (a name, an expression). */
const pointsOk = (src: string) => !src.trim() || pointsText(src) !== src || /^[A-Za-z_][\w.]*$/.test(src.trim());

/**
 * Lines typed one per row as their points, `(0, 0), (40, 0)`, as Python source: a tuple of camlib-ui polyline(...)
 * paths. Null when a row isn't at least two (x, y) points of numbers.
 */
export function linesSource(text: string): string | null {
  const rows = text.split('\n').map((row) => row.trim()).filter(Boolean);
  if (!rows.length) return '';
  const POINTS = new RegExp(String.raw`^${POINT}(?:\s*,\s*${POINT})+\s*,?$`);
  if (!rows.every((row) => POINTS.test(row))) return null;
  return `(${rows.map((row) => `polyline(${row.replace(/,$/, '').replace(/\s+/g, ' ')})`).join(', ')},)`;
}
/** A tuple of polyline(...) paths as the form shows it, one per row (null: other code, kept and shown as it is). */
export function linesText(src: string): string | null {
  const inner = /^\s*[([]([\s\S]*)[)\]]\s*$/.exec(src)?.[1];
  if (inner === undefined) return null;
  const rows: string[] = [];
  let at = 0;
  while (at < inner.length) {
    const rest = inner.slice(at);
    const lead = /^[\s,]*/.exec(rest)![0].length;
    if (lead === rest.length) break;
    if (!rest.startsWith('polyline(', lead)) return null;
    // To the parenthesis that closes this polyline( (its points hold one level of their own).
    let depth = 0, end = -1;
    for (let i = lead + 'polyline'.length; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) { end = i; break; }
    }
    if (end < 0) return null;
    rows.push(rest.slice(lead + 'polyline('.length, end).trim());
    at += end + 1;
  }
  return rows.length && linesSource(rows.join('\n')) !== null ? rows.join('\n') : null;
}

/** Values a form holds that camlib couldn't read: point lists that aren't (x, y) points (labels, for the OK button). */
export function invalidOf(draft: OpDraft): string[] {
  const out: string[] = [];
  const check = (cls: string, values: Record<string, string>, prefix: string) => {
    for (const field of fieldsOf(cls)) if (field.kind === 'points' && !pointsOk(values[field.key] ?? '')) out.push(`${prefix}${field.label}`);
    for (const field of fieldsOf(cls)) if (field.kind === 'lines' && (values[field.key] ?? '').startsWith(BAD_LINES)) out.push(`${prefix}${field.label}`);
  };
  check(draft.cls, draft.values, '');
  const nested = (item: Nested, label: string) => { if (item.cls) { check(item.cls, item.values, `${label}: `); Object.values(item.nested).forEach((inner) => nested(inner, label)); } };
  for (const [key, item] of Object.entries(draft.nested)) nested(item, fieldsOf(draft.cls).find((f) => f.key === key)?.label ?? key);
  return out;
}

function missingNested(nested: Nested, label: string): string[] {
  if (!nested.cls) return [];
  const out = fieldsOf(nested.cls).filter((field) => field.required && field.kind !== 'nested' && !(nested.values[field.key] ?? '').trim()).map((field) => `${label}: ${field.label}`);
  for (const inner of Object.values(nested.nested)) out.push(...missingNested(inner, label));
  return out;
}

function emitNested(nested: Nested): string {
  if (!nested.cls) return 'None';
  const parts: string[] = [];
  for (const field of fieldsOf(nested.cls)) {
    if (NESTED[field.key] && nested.nested[field.key]) { parts.push(`${field.key}=${emitNested(nested.nested[field.key])}`); continue; }
    const value = (nested.values[field.key] ?? '').trim();
    if (value) parts.push(`${field.key}=${value}`);
  }
  return `${nested.cls}(${parts.join(', ')})`;
}

const HELPER: Record<string, string> = { region: 'region', holes: 'hole_centers', paths: 'paths', path: 'path', surface: 'surface' };

function emitGeometry(geometry: Geometry, kind: GeometryKind, part: string): string {
  if (geometry.src !== undefined) return geometry.src;
  const keep = geometry.keep ?? [];
  if (kind === 'surface') return `surface(${[part, ...keep].join(', ')})`;
  if (kind === 'holes' && geometry.points) return `(${geometry.points.map(([x, y]) => `(${x}, ${y})`).join(', ')}${geometry.points.length === 1 ? ',' : ''})`;
  return `${HELPER[kind]}(${[part, ...(geometry.names ?? []).map(pyString), ...keep].join(', ')})`;
}

/** The camlib classes and camlib-ui helpers an operation's code uses (for its imports). */
export function usesOf(draft: OpDraft): { camlib: string[]; helpers: string[] } {
  if (OP_BY_CLASS[draft.cls]?.turning) return { camlib: [draft.cls], helpers: [] };
  const thermal = !!OP_BY_CLASS[draft.cls]?.thermal;
  const camlib = [draft.cls], helpers = thermal ? [] : ['slot', 'tool'];
  const nested = (item: Nested) => { if (item.cls) camlib.push(item.cls); Object.values(item.nested).forEach(nested); };
  Object.values(draft.nested).forEach(nested);
  if (thermal) {
    if (draft.cls === 'ThermalCut') helpers.push('cutting');
    if (/\bpolyline\(/.test(draft.values.paths ?? '')) helpers.push('polyline');
    return { camlib, helpers };
  }
  const spec = OP_BY_CLASS[draft.cls];
  for (const [key, geometry] of Object.entries(draft.geometry)) {
    const kind = spec?.geometry[key];
    if (kind && kind !== 'point' && geometry.src === undefined && !(kind === 'holes' && geometry.points)) helpers.push(HELPER[kind]);
  }
  return { camlib, helpers };
}

/** The operation's call as code, at `column` (wrapped under its parenthesis past 118 columns). */
export function emitOp(draft: OpDraft, ctx: { toolVar: string; tooling: string; part: string; shop: string; workOffset: number; column: number; head?: { machine: string; recipe: string } | null }): string {
  const spec = OP_BY_CLASS[draft.cls];
  if (spec.turning) {
    // camlib's turning operations name their tool by its id (the shop key); its station and offset are the setup's.
    const values = fieldsOf(draft.cls).filter((field) => !HIDDEN.has(field.key) && (draft.values[field.key] ?? '').trim()).map((field) => `${field.key}=${draft.values[field.key].trim()}`);
    return formatCall(draft.cls, [pyString(draft.id.trim()), pyString(draft.tool ?? ''), ...values], Math.max(0, ctx.column));
  }
  if (spec.thermal) {
    // Its head is the program's head(...) variable; a cut's process values are the shop's recipe of that head.
    const parts = [pyString(draft.id.trim()), draft.tool ?? '', (draft.values.parts ?? '').trim()];
    for (const field of fieldsOf(draft.cls)) {
      if (THERMAL_HIDDEN.has(field.key) || (draft.cls === 'ThermalCut' && CUTTING_KEYS.includes(field.key))) continue;
      // An option left off is left out: camlib's own default (a part order is never None).
      if (field.kind === 'nested') { const nested = draft.nested[field.key]; if (nested?.cls) parts.push(`${field.key}=${emitNested(nested)}`); continue; }
      const value = (draft.values[field.key] ?? '').trim();
      if (value) parts.push(`${field.key}=${value}`);
    }
    if ((draft.values.work_offset ?? '').trim()) parts.push(`work_offset=${draft.values.work_offset.trim()}`);
    parts.push(`tool_number=${(draft.values.tool_number ?? '').trim() || '1'}`, `length_register=${(draft.values.length_register ?? '').trim() || '1'}`);
    if (draft.cls === 'ThermalCut' && ctx.head) {
      const own = [`height_mode=${(draft.values.height_mode ?? '').trim() || '"fixed"'}`, ...['lead_in_radius_mm', 'lead_out_radius_mm'].map((key) => `${key}=${(draft.values[key] ?? '').trim()}`)];
      parts.push(`**cutting(${ctx.shop}.${ctx.head.recipe}, ${ctx.shop}.${ctx.head.machine}, ${own.join(', ')})`);
    }
    return formatCall(draft.cls, parts, Math.max(0, ctx.column));
  }
  const parts = [pyString(draft.id.trim()), ctx.toolVar];
  for (const field of fieldsOf(draft.cls)) {
    if (HIDDEN.has(field.key)) continue;
    if (field.kind === 'geometry') {
      const geometry = draft.geometry[field.key];
      if (geometry) parts.push(`${field.key}=${emitGeometry(geometry, spec.geometry[field.key], ctx.part)}`);
      continue;
    }
    if (field.kind === 'nested') { const nested = draft.nested[field.key]; if (nested) parts.push(`${field.key}=${emitNested(nested)}`); continue; }
    const value = (draft.values[field.key] ?? '').trim();
    if (value) parts.push(`${field.key}=${value}`);
  }
  if (ctx.workOffset !== 1) parts.push(`work_offset=${ctx.workOffset}`);
  parts.push(`**slot(${ctx.shop}.${ctx.tooling}, ${ctx.toolVar})`);
  return formatCall(draft.cls, parts, Math.max(0, ctx.column));
}

// ── Program edits ────────────────────────────────────────────────────────

/** What a setup's operations are written with: its tool setup and work offset, from its machine(...) call. */
export function setupContext(setup: CamSetup): { tooling: string | null; workOffset: number } {
  // A lathe setup's tools are its own turret stations (station(shop.<turret>, tool)); its machine takes no tooling.
  if (setup.turning) return { tooling: setup.turret, workOffset: 1 };
  const tooling = setup.machine?.kw?.find((kw) => kw.key === 'tooling')?.value;
  const offset = setup.machine?.kw?.find((kw) => kw.key === 'work_offset')?.value.v;
  return { tooling: tooling?.k === 'attr' ? tooling.name!.split('.').pop()! : null, workOffset: typeof offset === 'number' ? offset : 1 };
}

const statementAt = (outline: Outline, offset: number) => outline.statements.find((item) => item.s[0] <= offset && offset < item.s[1]) ?? null;

/** The edits that give the program a tool variable for a shop tool (and the setup's tools tuple the tool). */
function toolEdits(code: string, model: CamProgramModel, setup: CamSetup, key: string): { edits: Edit[]; variable: string } {
  const edits: Edit[] = [];
  let variable = Object.entries(model.tools).find(([, item]) => item === key)?.[0] ?? null;
  if (!variable) {
    variable = freeName(model.outline, key);
    // Before the statement that holds the setup's operations (they use it).
    const before = statementAt(model.outline, setup.ops?.s[0] ?? setup.call.s[0]) ?? setup.statement;
    const at = before?.s[0] ?? 0;
    edits.push({ at: [at, at], text: `${variable} = tool(${model.shop}.${key})\n` });
  }
  if (setup.tools && !(setup.tools.items ?? []).some((item) => item.k === 'name' && item.name === variable)) edits.push(insertItem(code, setup.tools, variable));
  return { edits, variable };
}

/**
 * The edits that give a lathe setup a turret tool: the program's `<variable> = tool(shop.<key>)` and the setup's
 * `station(shop.<turret>, <variable>)` in its tools.
 */
function stationEdits(code: string, model: CamProgramModel, setup: CamSetup, key: string, turret: string): Edit[] {
  const edits: Edit[] = [];
  let variable = Object.entries(model.tools).find(([, item]) => item === key)?.[0] ?? null;
  if (!variable) {
    variable = freeName(model.outline, key);
    const before = statementAt(model.outline, setup.ops?.s[0] ?? setup.call.s[0]) ?? setup.statement;
    const at = Math.min(before?.s[0] ?? 0, setup.statement?.s[0] ?? Infinity);
    edits.push({ at: [at, at], text: `${variable} = tool(${model.shop}.${key})\n` });
  }
  const held = (setup.tools?.items ?? []).some((item) => stationOf(resolve(model.outline, item), model.shop)?.variable === variable);
  if (!held) {
    if (!setup.tools) throw new FormError('This setup’s tools are code the forms can’t change: add the tool’s station(...) in code.');
    edits.push(insertItem(code, setup.tools, `station(${model.shop}.${turret}, ${variable})`));
  }
  return edits;
}

export class FormError extends Error {}

/** The code with an operation added to a setup (at `index`, its end by default) or rewritten in place (`op`). */
export function writeOp(code: string, model: CamProgramModel, setupId: string, draft: OpDraft, op: CamOp | null = null, index?: number): string {
  const setup = model.setups.find((item) => item.id === setupId);
  if (!setup) throw new FormError(`The program has no setup ${setupId}.`);
  if (!setup.ops) throw new FormError('This setup’s operations are code the forms can’t change: edit it in code.');
  const { tooling, workOffset } = setupContext(setup);
  const turning = !!OP_BY_CLASS[draft.cls]?.turning;
  const kind = kindOfSpec(OP_BY_CLASS[draft.cls]);
  if (kind !== setupKindOf(setup)) throw new FormError(`${draft.cls} is a ${KIND_OPS[kind]} operation: ${setup.id} is ${KIND_NAMES[setupKindOf(setup)]}.`);
  if (kind === 'sheet') return writeThermal(code, model, setup, draft, op, index);
  if (!tooling) throw new FormError(turning ? 'This setup’s tools name no one turret (station(shop.<turret>, tool)): add the tool in code.' : 'This setup’s machine has no tool setup (tooling=shop.…): set it in the setup.');
  if (!draft.tool) throw new FormError('Pick a tool.');
  const others = model.setups.flatMap((item) => item.operations).filter((item) => item !== op).map((item) => item.id);
  if (others.includes(draft.id.trim())) throw new FormError(`Another operation is already called ${draft.id.trim()}.`);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(draft.id.trim())) throw new FormError('A name is letters, digits and _ . : - only.');
  const { edits, variable } = turning ? { edits: stationEdits(code, model, setup, draft.tool, tooling), variable: '' } : toolEdits(code, model, setup, draft.tool);
  const uses = usesOf(draft);
  // A tool new to the program brings the helpers that make it and seat it.
  const added = turning && edits.length ? ['station', 'tool'] : [];
  edits.push(...importEdits(model.outline, { camlib: uses.camlib, [HELPERS]: [...uses.helpers, ...added] }));
  if (op?.call) {
    const text = emitOp(draft, { toolVar: variable, tooling, part: model.part, shop: model.shop, workOffset, column: columnOf(code, op.call.s[0]) });
    edits.push({ at: op.call.s, text });
  } else {
    const column = itemColumn(code, setup.ops, true);
    const text = emitOp(draft, { toolVar: variable, tooling, part: model.part, shop: model.shop, workOffset, column });
    edits.push(insertItem(code, setup.ops, text, index, true));
  }
  return applyEdits(code, edits);
}

/** A plasma or laser operation added to a sheet setup, or rewritten in place. */
function writeThermal(code: string, model: CamProgramModel, setup: CamSetup, draft: OpDraft, op: CamOp | null, index?: number): string {
  const head = draft.tool ? model.heads[draft.tool] : null;
  if (!draft.tool || !head) throw new FormError('Pick the cutting head.');
  if (!(setup.tools?.items ?? []).some((item) => item.k === 'name' && item.name === draft.tool)) throw new FormError(`${draft.tool} isn’t one of this setup’s tools: a sheet setup cuts with its own head.`);
  if (!(draft.values.parts ?? '').trim()) throw new FormError('Choose the parts.');
  const others = model.setups.flatMap((item) => item.operations).filter((item) => item !== op).map((item) => item.id);
  if (others.includes(draft.id.trim())) throw new FormError(`Another operation is already called ${draft.id.trim()}.`);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(draft.id.trim())) throw new FormError('A name is letters, digits and _ . : - only.');
  const uses = usesOf(draft);
  const edits = importEdits(model.outline, { camlib: uses.camlib, [HELPERS]: uses.helpers });
  const ctx = { toolVar: draft.tool, tooling: '', part: model.part, shop: model.shop, workOffset: 1, head };
  if (op?.call) edits.push({ at: op.call.s, text: emitOp(draft, { ...ctx, column: columnOf(code, op.call.s[0]) }) });
  else edits.push(insertItem(code, setup.ops!, emitOp(draft, { ...ctx, column: itemColumn(code, setup.ops!, true) }), index, true));
  return applyEdits(code, edits);
}

// ── The nest ─────────────────────────────────────────────────────────────

/** One NestPart of the nest: its region as the code names it, how many, the rotations it may take, whether it may be turned over. */
export interface NestPartDraft { region: string; quantity: string; rotations: string; mirror: boolean }
/** The program's `Nest.for_cut(cut, sheet, parts=(NestPart(...), ...), ...)` as a form: Python source per value. */
export interface NestDraft { variable: string; sheet: string; parts: NestPartDraft[]; values: Record<string, string> }
export const NEST_KEYS = ['part_spacing_mm', 'edge_margin_mm', 'resolution_mm', 'start_corner', 'fill_axis', 'search_iterations', 'part_in_part', 'allow_unplaced'];

/** The program's nest: the top-level name bound to a `Nest.for_cut(...)` call (null: the program has none the form can read). */
function nestCall(model: CamProgramModel): { variable: string; call: Py } | null {
  for (const [variable, bound] of Object.entries(model.outline.bindings)) {
    const value = bound.value;
    if (value.k === 'call' && (value.f === 'Nest.for_cut' || value.f === 'camlib.Nest.for_cut')) return { variable, call: value };
  }
  return null;
}

/** The nest as its form's draft, and what the form can't show. */
export function readNest(model: CamProgramModel): { draft: NestDraft | null; problems: string[] } {
  const found = nestCall(model);
  if (!found) return { draft: null, problems: ['The program has no `<name> = Nest.for_cut(cut, sheet, parts=(...), ...)` (then `<name>.run()`): write the nest that way to edit it here'] };
  const { variable, call } = found;
  const problems: string[] = [];
  const parts = resolve(model.outline, argOf(call, 'parts', 2));
  const draft: NestDraft = { variable, sheet: argOf(call, 'sheet', 1)?.src ?? '', parts: [], values: {} };
  if (!parts || (parts.k !== 'tuple' && parts.k !== 'list')) problems.push('Its parts aren’t a tuple of NestPart(...)');
  for (const item of parts?.items ?? []) {
    const part = item.k === 'call' && base(item.f) === 'NestPart' ? item : null;
    const region = part ? argOf(part, 'region', 0) : undefined, quantity = part ? argOf(part, 'quantity', 1) : undefined, rotations = part ? argOf(part, 'rotations_deg', 2) : undefined;
    const mirror = part ? argOf(part, 'mirror', 3) : undefined;
    if (!part || !region || !quantity || !rotations || (mirror && typeof mirror.v !== 'boolean')) { problems.push('One of its parts isn’t a NestPart(region, quantity=, rotations_deg=) the form can read'); continue; }
    draft.parts.push({ region: region.src, quantity: quantity.src, rotations: rotations.src, mirror: mirror?.v === true });
  }
  for (const kw of call.kw ?? []) {
    if (kw.key && NEST_KEYS.includes(kw.key)) draft.values[kw.key] = kw.value.src;
  }
  return { draft: problems.length ? null : draft, problems };
}

/** What a nest's form is missing or holds that isn't a value (labels). */
export function nestProblems(draft: NestDraft): string[] {
  const out: string[] = [];
  for (const key of ['part_spacing_mm', 'edge_margin_mm', 'resolution_mm']) if (!(draft.values[key] ?? '').trim()) out.push(key.replace(/_mm$/, '').replace(/_/g, ' '));
  draft.parts.forEach((part) => {
    if (!/^\d+$/.test(part.quantity.trim()) && !/^[A-Za-z_]\w*$/.test(part.quantity.trim())) out.push(`${part.region}: a whole quantity`);
    if (!/^\(\s*-?[\d.]+\s*(,\s*-?[\d.]+\s*)*,?\s*\)$/.test(part.rotations.trim()) && !/^[A-Za-z_]\w*$/.test(part.rotations.trim())) out.push(`${part.region}: rotations like (0, 90)`);
  });
  return out;
}

/** The code with the nest's values and parts as the form has them: only what changed is rewritten. */
export function writeNest(code: string, model: CamProgramModel, draft: NestDraft): string {
  const found = nestCall(model);
  if (!found) throw new FormError('The program has no Nest.for_cut(...) to change.');
  const { call } = found;
  const before = readNest(model).draft;
  if (!before || before.parts.length !== draft.parts.length) throw new FormError('The nest’s parts changed in the code meanwhile: close this and open it again.');
  const edits: Edit[] = [];
  for (const key of NEST_KEYS) {
    const value = (draft.values[key] ?? '').trim();
    if (value === (before.values[key] ?? '').trim()) continue;
    const edit = setKeyword(call, key, value || null);
    if (edit) edits.push(edit);
  }
  const parts = resolve(model.outline, argOf(call, 'parts', 2))!;
  draft.parts.forEach((part, i) => {
    const was = before.parts[i];
    if (part.quantity.trim() === was.quantity.trim() && part.rotations.trim() === was.rotations.trim() && part.mirror === was.mirror) return;
    const text = `NestPart(${part.region}, quantity=${part.quantity.trim()}, rotations_deg=${part.rotations.trim()}${part.mirror ? ', mirror=True' : ''})`;
    edits.push({ at: parts.items![i].s, text });
  });
  return applyEdits(code, edits);
}

/** The code without an operation. */
export function deleteOp(code: string, model: CamProgramModel, op: CamOp): string {
  const setup = model.setups.find((item) => item.id === op.setup);
  if (!setup?.ops) throw new FormError('This setup’s operations are code the forms can’t change: edit it in code.');
  if (setup.operations.length === 1) throw new FormError('It’s the setup’s only operation: a setup holds at least one. Add another first, or remove the setup in code.');
  return applyEdits(code, [removeItem(code, setup.ops, op.index)]);
}

/** The code with a setup's operations in a new order (`order`: old indices in their new order). */
export function reorderOps(code: string, model: CamProgramModel, setupId: string, order: number[]): string {
  const setup = model.setups.find((item) => item.id === setupId);
  if (!setup?.ops) throw new FormError('This setup’s operations are code the forms can’t change: edit it in code.');
  return applyEdits(code, [reorderItems(code, setup.ops, order)]);
}

/** The code with a copy of an operation right after it, under a new id. */
export function duplicateOp(code: string, model: CamProgramModel, op: CamOp): { code: string; id: string } {
  const setup = model.setups.find((item) => item.id === op.setup);
  if (!setup?.ops || !op.call) throw new FormError('Only an operation the forms know can be duplicated here: copy it in code.');
  const id = freeOpId(model, op.id ?? 'operation');
  const idArg = argOf(op.call, 'id', 0)!;
  const text = code.slice(op.call.s[0], idArg.s[0]) + pyString(id) + code.slice(idArg.s[1], op.call.s[1]);
  return { code: applyEdits(code, [insertItem(code, setup.ops, text, op.index + 1, true)]), id };
}

// ── Setups ───────────────────────────────────────────────────────────────

/**
 * A setup's form: its id, the shop machine and tool setup, box stock and its grid, where the tool starts, the work offset,
 * the checks, and what camlib needs of the machine that the shop doesn't hold (`premises`: Python source per machine()
 * keyword; empty ones are left out and camlib refuses the machine naming them). `read`: the values as they were read
 * (an edited setup), so what didn't change isn't rewritten.
 */
export interface SetupDraft {
  id: string;
  machine: string | null;
  tooling: string | null;
  stockMin: string[];
  stockMax: string[];
  cell: string;
  start: string[];
  workOffset: string;
  stockContact: boolean;
  material: boolean;
  premises: Record<string, string>;
  read?: { stockContact: boolean; material: boolean; machine: string };
}

/** machine() keywords the setup form shows: the machine values camlib requires that the shop doesn't hold. */
export const PREMISES = ['work_to_machine', 'flood', 'mist', 'planes', 'arcs', 'helices', 'max_sweep_rad', 'max_tool_number', 'max_length_register', 'tool_change_position_mode', 'lowering', 'post'];

const points = (value: Py | undefined): string[] | null => (value?.k === 'tuple' || value?.k === 'list') && value.items?.length === 3 && value.items.every((item) => item.v !== undefined)
  ? value.items.map((item) => item.src) : null;

/** The parts of a setup's machine(...) the form writes, as one string (to see whether they changed). */
const machineKey = (draft: SetupDraft) => JSON.stringify([draft.machine, draft.tooling, draft.workOffset, PREMISES.map((key) => (draft.premises[key] ?? '').trim())]);

/** A setup's call (and its machine) as the form's draft, and what it can't show. */
export function readSetup(model: CamProgramModel, setup: CamSetup): { draft: SetupDraft | null; problems: string[] } {
  const problems: string[] = [];
  const stock = resolve(model.outline, argOf(setup.call, 'stock', 1));
  const stockOk = stock?.k === 'call' && base(stock.f) === 'StockSpec';
  const min = stockOk ? points(resolve(model.outline, argOf(stock!, 'min_mm', 0)) ?? undefined) : null;
  const max = stockOk ? points(resolve(model.outline, argOf(stock!, 'max_mm', 1)) ?? undefined) : null;
  const cell = stockOk ? argOf(stock!, 'cell_size_mm', 2) : undefined;
  if (!min || !max) problems.push('Its stock is code the form can’t show');
  const start = points(resolve(model.outline, argOf(setup.call, 'initial_position_mm', 4)) ?? undefined);
  if (!start) problems.push('Where the tool starts is code the form can’t show');
  const verification = resolve(model.outline, argOf(setup.call, 'verification', 8));
  let stockContact = false, material = false;
  if (verification && verification.k !== 'none') {
    if (verification.k !== 'call' || base(verification.f) !== 'StreamChecks') problems.push('Its checks are code the form can’t show');
    else {
      for (const kw of verification.kw ?? []) {
        if (kw.key === 'stock_contact') stockContact = kw.value.k !== 'none';
        else if (kw.key === 'material') material = (kw.value.items ?? []).length > 0 || kw.value.k === 'name';
        else problems.push('Its checks have code the form can’t show');
      }
    }
  }
  const machine = setup.machine;
  if (!machine) problems.push('Its machine(...) is code the form can’t show');
  const first = machine?.a?.[0];
  const premises: Record<string, string> = {};
  for (const kw of machine?.kw ?? []) if (kw.key && PREMISES.includes(kw.key)) premises[kw.key] = kw.value.src;
  const { tooling, workOffset } = setupContext(setup);
  if (problems.length) return { draft: null, problems };
  const draft: SetupDraft = {
    id: setup.id, machine: first?.k === 'attr' ? first.name!.split('.').pop()! : null, tooling, stockMin: min!, stockMax: max!, cell: cell?.src ?? '',
    start: start!, workOffset: String(workOffset), stockContact, material, premises,
  };
  draft.read = { stockContact, material, machine: machineKey(draft) };
  return { draft, problems };
}

function stockText(draft: SetupDraft): string {
  return `StockSpec((${draft.stockMin.join(', ')}), (${draft.stockMax.join(', ')})${draft.cell.trim() ? `, ${draft.cell.trim()}` : ''})`;
}

function checksText(draft: SetupDraft, part: string): string | null {
  const parts = [draft.stockContact ? 'stock_contact=StockContactOptions()' : null, draft.material ? `material=(MaterialCheck(part_target(${part})),)` : null].filter(Boolean);
  return parts.length ? `StreamChecks(${parts.join(', ')})` : null;
}

function machineText(draft: SetupDraft, model: Pick<CamProgramModel, 'shop'>, variable: string, column: number, keep: string[] = []): string {
  const parts = [`${model.shop}.${draft.machine}`, variable, `tooling=${model.shop}.${draft.tooling}`];
  for (const key of PREMISES) if ((draft.premises[key] ?? '').trim()) parts.push(`${key}=${draft.premises[key].trim()}`);
  if (Number(draft.workOffset) !== 1) parts.push(`work_offset=${Number(draft.workOffset)}`);
  parts.push(...keep);
  return formatCall('machine', parts, column);
}

/**
 * A tool change that moves no axis (the machine's tool_change_position_mode "preserve_spindle": the spindle stays, the
 * tip moves by the difference of the gauge lengths) is planned with Setup(tool_change=ToolChangeInPlace()); camlib
 * refuses the pair when only one of them says so.
 */
const IN_PLACE = 'ToolChangeInPlace()';
export const changesInPlace = (draft: SetupDraft) => (draft.premises.tool_change_position_mode ?? '').replace(/'/g, '"').trim() === '"preserve_spindle"';
const setupParts = (draft: SetupDraft, ops: string, checks: string | null) => [pyString(draft.id.trim()), stockText(draft), '()', ops, `(${draft.start.join(', ')})`,
  ...(checks ? [`verification=${checks}`] : []), ...(changesInPlace(draft) ? [`tool_change=${IN_PLACE}`] : [])];

/** What a setup's code imports. */
function setupImports(draft: SetupDraft, checks: boolean): Record<string, string[]> {
  return {
    camlib: ['Job', 'Setup', 'StockSpec', ...(changesInPlace(draft) ? ['ToolChangeInPlace'] : [])],
    'camlib.motion': /\bWorkFrame\(/.test(draft.premises.work_to_machine ?? '') ? ['WorkFrame'] : [],
    'camlib.post': /\bLoweringOptions\(/.test(draft.premises.lowering ?? '') ? ['LoweringOptions'] : [],
    'camlib.verification': checks ? [...(draft.stockContact || draft.material ? ['StreamChecks'] : []), ...(draft.stockContact ? ['StockContactOptions'] : []), ...(draft.material ? ['MaterialCheck'] : [])] : [],
    [HELPERS]: ['Program', 'machine', ...(checks && draft.material ? ['part_target'] : [])],
  };
}

export function checkSetup(draft: SetupDraft, model: CamProgramModel | null, editing: CamSetup | null): string | null {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(draft.id.trim())) return 'A setup’s name is letters, digits and _ . : - only.';
  if (model?.setups.some((item) => item !== editing && item.id === draft.id.trim())) return `Another setup is already called ${draft.id.trim()}.`;
  if (!draft.machine) return 'Pick the machine.';
  if (!draft.tooling) return 'Pick the tool setup.';
  if ([...draft.stockMin, ...draft.stockMax, ...draft.start].some((value) => !value.trim() || !Number.isFinite(Number(value)))) return 'The stock and where the tool starts need every coordinate.';
  if (draft.stockMin.some((value, axis) => Number(value) >= Number(draft.stockMax[axis]))) return 'The stock’s largest corner must be past its smallest on every axis.';
  if (!/^\d+$/.test(draft.workOffset.trim()) || Number(draft.workOffset) < 1) return 'The work offset is a number from 1.';
  return null;
}

/**
 * A new program's program.py: its first setup, the job and the program. `part`: whether the project has a part file
 * (the program imports it). Its operations tuple is empty: the setup's first operation is written into it next.
 */
export function newProgramCode(name: string, draft: SetupDraft, part: boolean): string {
  const variable = (draft.id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'setup');
  const ops = `${variable}_ops`;
  const imports = setupImports(draft, true);
  const checks = checksText(draft, 'part');
  const head = `${variable} = `;
  const setup = formatCall('Setup', setupParts(draft, ops, checks), head.length);
  const machineCall = machineText(draft, { shop: 'shop' }, variable, 'program = Program(job, {'.length + pyString(draft.id).length + 2);
  const jobId = name.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 64) || 'program';
  const lines = [
    `"""${name.replace(/"""/g, '')}: machined from the project's part."""`,
    'import math',
    '',
    `from links import ${part ? 'part, shop' : 'shop'}`,
    ...Object.entries(imports).filter(([, names]) => names.length).map(([module, names]) => `from ${module} import ${[...new Set(names)].sort(byCode).join(', ')}`),
    '',
    `${ops} = ()`,
    `${head}${setup}`,
    `job = Job(${pyString(jobId)}, "1", (${variable},))`,
    `program = Program(job, {${pyString(draft.id)}: ${machineCall}})`,
    '',
  ];
  return lines.join('\n');
}

/** The code with a new setup (after the program's others) or a setup changed (`setup`: the one edited). */
export function writeSetup(code: string, model: CamProgramModel, draft: SetupDraft, setup: CamSetup | null): string {
  const problem = checkSetup(draft, model, setup);
  if (problem) throw new FormError(problem);
  // Checks are written when they're new or changed (an edited setup's own MaterialCheck options stay as they are).
  const checksChanged = !setup || !draft.read || draft.stockContact !== draft.read.stockContact || draft.material !== draft.read.material;
  const machineChanged = !setup || !draft.read || machineKey(draft) !== draft.read.machine;
  const edits: Edit[] = [...importEdits(model.outline, setupImports(draft, checksChanged))];
  if (setup) {
    // In place: the id, stock, start and checks of the Setup call, its machine(...) call, and its operations' tool setup
    // and work offset when those changed.
    const id = argOf(setup.call, 'id', 0)!;
    if (id.v !== draft.id.trim()) {
      edits.push({ at: id.s, text: pyString(draft.id.trim()) });
      const machines = model.program ? resolve(model.outline, argOf(model.program, 'machines', 1)) : null;
      const key = machines?.k === 'dict' ? machines.keys?.find((item) => item?.v === setup.id) : null;
      if (key) edits.push({ at: key.s, text: pyString(draft.id.trim()) });
    }
    const stock = argOf(setup.call, 'stock', 1)!;
    const stockNow = stockText(draft);
    if (resolve(model.outline, stock)!.src.replace(/\s+/g, '') !== stockNow.replace(/\s+/g, '')) edits.push({ at: stock.s, text: stockNow });
    const start = argOf(setup.call, 'initial_position_mm', 4)!;
    const startNow = `(${draft.start.join(', ')})`;
    if (start.src.replace(/\s+/g, '') !== startNow.replace(/\s+/g, '')) edits.push({ at: start.s, text: startNow });
    if (checksChanged) {
      const checks = checksText(draft, model.part);
      const current = argOf(setup.call, 'verification', 8);
      if ((current?.src ?? null) !== checks) {
        const edit = setKeyword(setup.call, 'verification', checks, 8);
        if (edit) edits.push(edit);
      }
    }
    // The setup's own tool change follows the machine's: in place with "preserve_spindle"; one the form wrote is taken
    // out again with another mode (any other tool_change the code has stays as it is).
    const change = argOf(setup.call, 'tool_change', 9);
    if (machineChanged && changesInPlace(draft) !== (change?.src.replace(/\s+/g, '') === IN_PLACE) && (changesInPlace(draft) || change)) {
      const edit = setKeyword(setup.call, 'tool_change', changesInPlace(draft) ? IN_PLACE : null, 9);
      if (edit) edits.push(edit);
    }
    if (setup.machine && machineChanged) {
      const keep = (setup.machine.kw ?? []).filter((kw) => !kw.key || !['tooling', 'work_offset', ...PREMISES].includes(kw.key)).map((kw) => code.slice(kw.s[0], kw.s[1]));
      const extra = (setup.machine.a ?? []).slice(2).map((item) => item.src);
      const variable = setup.machine.a?.[1]?.src ?? setup.variable ?? 'setup';
      const text = machineText(draft, model, variable, columnOf(code, setup.machine.s[0]), [...extra, ...keep]);
      if (text !== setup.machine.src) edits.push({ at: setup.machine.s, text });
    }
    const before = setupContext(setup);
    for (const op of setup.operations) {
      if (!op.call) continue;
      if (draft.tooling !== before.tooling) {
        const slot = op.call.kw?.find((kw) => kw.key === null && kw.value.k === 'call' && base(kw.value.f) === 'slot')?.value.a?.[0];
        if (slot) edits.push({ at: slot.s, text: `${model.shop}.${draft.tooling}` });
      }
      if (Number(draft.workOffset) !== before.workOffset) {
        const edit = setKeyword(op.call, 'work_offset', Number(draft.workOffset) === 1 ? null : String(Number(draft.workOffset)));
        if (edit) edits.push(edit);
      }
    }
    return applyEdits(code, edits);
  }
  // A new setup: its statements before the job, in the job's setups and the program's machines.
  if (!model.job || !model.program) throw new FormError('The program’s Job(...) and Program(...) are code the forms can’t change: add the setup in code.');
  const setups = resolve(model.outline, argOf(model.job, 'setups', 2));
  if (setups?.k !== 'tuple' && setups?.k !== 'list') throw new FormError('The job’s setups are code the forms can’t change: add the setup in code.');
  const variable = freeName(model.outline, draft.id);
  const ops = freeName(model.outline, `${variable}_ops`, [variable]);
  const checks = checksText(draft, model.part);
  const head = `${variable} = `;
  const text = formatCall('Setup', setupParts(draft, ops, checks), head.length);
  const before = statementAt(model.outline, model.job.s[0]);
  const at = before?.s[0] ?? model.job.s[0];
  edits.push({ at: [at, at], text: `${ops} = ()\n${head}${text}\n` });
  edits.push(insertItem(code, setups, variable));
  const machines = argOf(model.program, 'machines', 1)!;
  const resolved = resolve(model.outline, machines)!;
  const entry = (column: number) => `${pyString(draft.id.trim())}: ${machineText(draft, model, variable, column + pyString(draft.id.trim()).length + 2)}`;
  if (resolved.k === 'dict') {
    const last = resolved.values?.at(-1);
    const column = last ? columnOf(code, resolved.keys!.at(-1)!.s[0]) : columnOf(code, resolved.s[0]) + 1;
    const separator = last && code.slice(resolved.keys![0]!.s[0] - 1, resolved.keys![0]!.s[0]) === '\n' ? `,\n${' '.repeat(column)}` : ', ';
    edits.push(last ? { at: [last.s[1], last.s[1]], text: `${separator}${entry(column)}` } : { at: [resolved.s[0] + 1, resolved.s[0] + 1], text: entry(column) });
  } else if (machines.k === 'call' || machines.k === 'name' || machines.k === 'list' || machines.k === 'tuple') {
    // The one setup's machine: a {setup: machine} dict now, the new setup with its own machine (for its own tools).
    if (model.setups.length !== 1) throw new FormError('Each setup needs its own machine(...) for its tools: give the program a {setup: machine(...)} dict in code first.');
    const column = columnOf(code, machines.s[0]) + 1;
    // Under the first entry when that one runs over several lines, else after it.
    const separator = machines.src.includes('\n') ? `,\n${' '.repeat(column)}` : ', ';
    edits.push({ at: machines.s, text: `{${pyString(model.setups[0].id)}: ${machines.src}${separator}${entry(column)}}` });
  } else throw new FormError('The program’s machines are code the forms can’t change: add the setup in code.');
  return applyEdits(code, edits);
}
