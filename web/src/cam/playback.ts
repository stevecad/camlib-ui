/**
 * A full build's playback stream as the player's motion (filled chunk by chunk), camlib's findings in a few words, each
 * setup and machine's verdict, and each tool's profile for drawing.
 *
 * Only reads and words what camlib decided: whether G-code is released is camlib's, never this file's. No runtime
 * imports beyond the stream reader and the motion model.
 */
import type { Finding, MachineResult, ToolSummary } from '../api';
import { isTurned, NONE, type PlaybackStream, type StreamSetup } from './stream.ts';
import { alongMove, ARC_PLANES, moveStart, UNASSIGNED, type Motion } from './motion.ts';
import { cellSizeFor, profileOf, type CutterProfile, type SimMoves } from './heightfield.ts';

/** The stream's move kinds as the player colours them (motion.ts MOVE_KINDS; taps, threads and others draw as cuts). */
const KIND_INDEX: Record<string, number> = { rapid: 0, cut: 1, plunge: 2, lead: 3, link: 4, retract: 5 };
const CURVE_INDEX: Record<string, number> = { line: 0, arc: 1, helix: 2 };

export interface StreamMotion {
  motion: Motion;
  /** Cumulative nominal seconds: times[i] is when move i starts (the header's chunk starts until a chunk is read). */
  times: Float64Array;
  /** Reads chunk `c` into the columns (once). */
  load: (c: number) => Promise<void>;
  /** Chunks not read yet. */
  missing: () => number;
}

/** Each tool's number (from the operations using it), by its index in the stream's tools. */
export function toolNumbers(setup: StreamSetup): number[] {
  return setup.tools.map((tool, index) => setup.operations.find((op) => op.tool === tool.id && op.tool_number != null)?.tool_number ?? index + 1);
}

/**
 * The player's motion for setup `s`: columns the size of the whole program, filled as chunks are read (`pending` marks
 * the moves not read yet). `motion.tool` holds each move's tool index in the stream's tools; `motion.operation` its
 * operation index (UNASSIGNED between operations).
 */
export function streamMotion(stream: PlaybackStream, s: number): StreamMotion {
  const header = stream.header, setup = header.setups[s];
  const count = setup.moves;
  const motion: Motion = {
    first: 0, count, start: [setup.initial_position_mm[0], setup.initial_position_mm[1], setup.initial_position_mm[2]],
    // Where a tool change leaves the new tool's tip, when that isn't where the last move ended.
    restarts: new Map((setup.restarts ?? []).map(([move, x, y, z]) => [move, [x, y, z]])),
    end: new Float32Array(count * 3), kind: new Uint8Array(count), operation: new Uint32Array(count).fill(UNASSIGNED), tool: new Uint32Array(count),
    rpm: new Float32Array(count), feed: new Float32Array(count), line: new Uint32Array(count),
    arcs: { curve: new Uint8Array(count), center: new Float32Array(count * 3), sweep: new Float32Array(count), plane: new Uint8Array(count) },
    pending: new Uint8Array(count).fill(1),
  };
  const times = new Float64Array(count + 1);
  setup.chunks.forEach((chunk, c) => {
    const end = setup.chunks[c + 1]?.start_s ?? setup.seconds;
    for (let i = 0; i <= chunk.moves; i++) times[chunk.first_move + i] = chunk.start_s + ((end - chunk.start_s) * i) / Math.max(1, chunk.moves);
  });
  const kinds = header.kinds.map((kind) => KIND_INDEX[kind] ?? 1);
  const curves = header.curves.map((curve) => CURVE_INDEX[curve] ?? 0);
  const planes = header.planes.map((plane) => Math.max(0, ARC_PLANES.indexOf(plane as (typeof ARC_PLANES)[number])));
  const loading = new Map<number, Promise<void>>();
  let read = 0;
  const load = (c: number) => {
    if (c < 0 || c >= setup.chunks.length) return Promise.resolve();
    let done = loading.get(c);
    if (done) return done;
    done = stream.chunk(s, c).then((chunk) => {
      let t = setup.chunks[c].start_s;
      for (let m = 0; m < chunk.count; m++) {
        const i = chunk.first + m;
        for (let a = 0; a < 3; a++) { motion.end[i * 3 + a] = chunk.end[m * 3 + a]; motion.arcs!.center[i * 3 + a] = chunk.center[m * 3 + a]; }
        motion.kind[i] = kinds[chunk.kind[m]];
        motion.arcs!.curve[i] = curves[chunk.curve[m]];
        motion.arcs!.sweep[i] = chunk.sweep[m];
        motion.arcs!.plane[i] = planes[chunk.plane[m]] ?? 0;
        const op = chunk.operation[m] !== NONE ? setup.operations[chunk.operation[m]] : undefined;
        motion.operation[i] = op ? chunk.operation[m] : UNASSIGNED;
        // Moves of no tool (between operations) keep the tool before them.
        motion.tool[i] = chunk.tool[m] !== NONE ? chunk.tool[m] : i > 0 ? motion.tool[i - 1] : 0;
        motion.rpm[i] = op?.spindle_rpm ?? (i > 0 ? motion.rpm[i - 1] : 0);
        motion.feed[i] = Number.isNaN(chunk.feed[m]) ? 0 : chunk.feed[m];
        motion.line[i] = chunk.line[m];
        motion.pending![i] = 0;
        times[i] = t;
        t += chunk.seconds[m];
      }
      if (c === setup.chunks.length - 1) times[count] = Math.max(t, times[count - 1] ?? 0);
      read++;
    }).catch((error) => { loading.delete(c); throw error; });
    loading.set(c, done);
    return done;
  };
  return { motion, times, load, missing: () => setup.chunks.length - read };
}

export interface Band { operation: string; index: number; first: number; last: number }

/** Contiguous runs of one operation (the timeline's bands). */
export function operationBands(motion: Motion, setup: StreamSetup): Band[] {
  const out: Band[] = [];
  for (let i = 0; i < motion.count; i++) {
    if (motion.pending?.[i]) continue;
    const index = motion.operation[i];
    if (index === UNASSIGNED) continue;
    const last = out.at(-1);
    if (last && last.index === index && last.last >= i - 8) { last.last = i; continue; }
    out.push({ operation: setup.operations[index]?.id ?? String(index), index, first: i, last: i });
  }
  return out;
}

// ── Tools ─────────────────────────────────────────────────────────────────

/** A tool's outline as (radius, height above the tip) points from the tip up, and where its holder starts. */
export function toolProfile(tool: ToolSummary): { cutter: [number, number][]; shank: [number, number][]; holders: [number, number][][] } {
  const r = tool.diameter_mm / 2, cut = Math.max(tool.cutting_length_mm || 0, r), shape = tool.shape ?? { kind: 'flat' };
  const cutter: [number, number][] = [];
  if (shape.kind === 'ball' || (shape.kind === 'bull' && shape.corner_radius_mm)) {
    const corner = shape.kind === 'ball' ? r : Math.min(r, shape.corner_radius_mm!);
    cutter.push([0, 0]);
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * (Math.PI / 2);
      cutter.push([r - corner + corner * Math.sin(a), corner - corner * Math.cos(a)]);
    }
  } else if (shape.kind === 'drill' && shape.point_angle_rad) {
    cutter.push([0, 0], [r, Math.min(cut, r / Math.tan(shape.point_angle_rad / 2))]);
  } else if (shape.kind === 'chamfer' && shape.included_angle_rad) {
    const tip = (shape.tip_diameter_mm ?? 0) / 2;
    cutter.push([0, 0], [tip, 0], [r, Math.min(cut, (r - tip) / Math.tan(shape.included_angle_rad / 2))]);
  } else cutter.push([0, 0], [r, 0]);
  cutter.push([r, cut], [0, cut]);
  const holderStart = Math.min(...tool.holders.map((holder) => holder.z_min_mm), tool.stickout_mm || Infinity);
  const shankTop = Number.isFinite(holderStart) ? holderStart : tool.overall_length_mm;
  const rs = (tool.shank_diameter_mm || tool.diameter_mm) / 2;
  const shank: [number, number][] = shankTop > cut ? [[0, cut], [rs, cut], [rs, shankTop], [0, shankTop]] : [];
  const holders = tool.holders.map((h): [number, number][] => [[0, h.z_min_mm], [h.radius_min_mm, h.z_min_mm], [h.radius_max_mm, h.z_max_mm], [0, h.z_max_mm]]);
  return { cutter, shank, holders };
}

// ── The display stock ──────────────────────────────────────────────────────

/** Chords per radian of an arc or helix when it is cut (a 7.5° chord sags 0.2 % of the radius). */
const CHORDS_PER_RAD = 24 / Math.PI;

export interface SimPlan {
  moves: SimMoves;
  cutters: CutterProfile[];
  /** The display field's cell (mm): about a hundredth of the smallest cutter, 0.05–0.1 mm, coarser for big stock. */
  cell: number;
  /** Where each player move starts among the sim's moves (arcs and helices are several chords): count + 1 entries. */
  starts: Float64Array;
}

/**
 * The display simulation's input for a setup: its moves as straight pieces with each one's cutter (the tool's own
 * profile below its flutes' top) and tag (its operation band + 1, for the tint). Null when a tool has no cutter shape.
 */
export function simPlan(source: { header: StreamSetup; motion: Motion; bands: Band[] }): SimPlan | null {
  const { header, motion, bands } = source;
  // A lathe setup shows camlib's own turned stock (the stream's): there is no height field of it to cut.
  if (isTurned(header.stock) || header.tools.some((tool) => tool.turning)) return null;
  // A torch or a laser head cuts the sheet through from above it: no cutter sweeps the stock. camlib's own grid, where
  // every kerf is cut through, is what is shown.
  if (header.tools.some((tool) => tool.shape?.kind === 'beam')) return null;
  const cutters: CutterProfile[] = [];
  for (const tool of header.tools) {
    const profile = profileOf([toolProfile(tool).cutter]);
    if (!profile) return null;
    cutters.push(profile);
  }
  const tags = new Uint8Array(motion.count).fill(255);
  bands.forEach((band, b) => tags.fill(Math.min(254, b + 1), band.first, Math.min(motion.count, band.last + 1)));
  const chords = new Int32Array(motion.count);
  const starts = new Float64Array(motion.count + 1);
  for (let i = 0; i < motion.count; i++) {
    chords[i] = motion.arcs?.curve[i] ? Math.max(1, Math.min(256, Math.ceil(Math.abs(motion.arcs.sweep[i]) * CHORDS_PER_RAD - 1e-6))) : 1;
    starts[i + 1] = starts[i] + chords[i];
  }
  const count = starts[motion.count];
  const start = new Float64Array(count * 3), end = new Float64Array(count * 3), cutter = new Int16Array(count), tag = new Uint8Array(count);
  const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [0, 0, 0], from: [number, number, number] = [0, 0, 0];
  for (let i = 0, s = 0; i < motion.count; i++) {
    moveStart(motion, i, from);
    a[0] = from[0]; a[1] = from[1]; a[2] = from[2];
    for (let k = 1; k <= chords[i]; k++, s++) {
      alongMove(motion, i, from, k / chords[i], b);
      start.set(a, s * 3);
      end.set(b, s * 3);
      cutter[s] = motion.tool[i] < cutters.length ? motion.tool[i] : -1;
      tag[s] = tags[i];
      a[0] = b[0]; a[1] = b[1]; a[2] = b[2];
    }
  }
  const { min_mm: min, max_mm: max } = header.stock;
  const smallest = Math.min(...cutters.map((profile) => profile.radius * 2));
  return { moves: { count, start, end, cutter, tag }, cutters, cell: cellSizeFor(max[0] - min[0], max[1] - min[1], smallest), starts };
}

/** A player position (move units) as the display sim's position (its chords). */
export function simPosition(starts: Float64Array, t: number): number {
  const count = starts.length - 1;
  if (t <= 0 || count <= 0) return 0;
  if (t >= count) return starts[count];
  const m = Math.floor(t);
  return starts[m] + (t - m) * (starts[m + 1] - starts[m]);
}

// ── Findings and verdicts ─────────────────────────────────────────────────

export const words = (value: unknown) => String(value ?? '').replace(/_/g, ' ').trim();
const definite = (assessment: unknown) => typeof assessment === 'string' && assessment.startsWith('definite');
const capital = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

/** What a finding is, in a few words. */
export function findingWords(finding: Finding): string {
  const detail = finding.details?.[0] ?? {};
  if (detail.kind === 'material') {
    if (detail.gouge && detail.gouge !== 'clear' && detail.gouge !== 'none') return definite(detail.gouge) ? 'Cuts into the part' : 'May cut into the part';
    return definite(detail.residual) ? 'Leaves stock on the part' : 'May leave stock on the part';
  }
  if (finding.severity === 'unchecked_machine' || detail.kind === 'unchecked_machine') return "The machine's own bodies aren't checked";
  const what = words(detail.kind) || (finding.severity === 'violation' ? 'A problem' : 'Not decided');
  const object = words(detail.object_id);
  const depth = typeof detail.depth_mm === 'number' ? ` · ${Number(detail.depth_mm.toFixed(3))} mm` : '';
  return `${capital(what)}${object ? ` · ${object}` : ''}${depth}`;
}

/** What camlib said of a finding, when it said more than its kind. */
export const findingDetail = (finding: Finding) => finding.details.map((detail) => detail.message ?? detail.detail ?? '').filter(Boolean).join(' ');

/**
 * The move (0-based) a finding is at, or null when it is about the whole program: it is attributed to the moves done, so
 * the move that made it is one before.
 */
export const findingMove = (finding: Finding): number | null => (finding.move == null ? null : Math.max(0, finding.move - 1));

/** How a finding's severity reads: a definite problem, undecided, or a check that couldn't run. */
export const severityOf = (finding: Finding): 'violation' | 'uncertain' | 'unchecked' =>
  finding.severity === 'violation' ? 'violation' : finding.severity === 'uncertain' ? 'uncertain' : 'unchecked';

/** What wasn't checked, in plain words. */
const UNCHECKED_WORDS: Record<string, string> = {
  machine: "the machine's own bodies (the shop declares no crash model)",
  scene: 'the machine and fixtures',
  material: 'the finished part against the design',
  'fixtures (no fixtures declared)': 'fixtures (the program places none)',
};
export const uncheckedWords = (item: string) => UNCHECKED_WORDS[item] ?? words(item);

export type Tone = 'passed' | 'uncertain' | 'failed';
export interface Verdict { released: boolean; tone: Tone; verdict: string; next: string | null; unchecked: string[] }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A setup on a machine, as the result panel says it: released or refused, and what to do. */
export function verdictOf(machine: MachineResult): Verdict {
  const counts = machine.finding_counts ?? {};
  const findings = machine.findings ?? [];
  const count = (status: string) => counts[status] ?? findings.filter((f) => f.severity === status).length;
  const violations = count('violation'), uncertain = count('uncertain');
  // Other statuses are checks camlib couldn't run (unchecked_machine: the shop declares no crash model).
  const other = Object.entries(counts).filter(([status]) => status !== 'violation' && status !== 'uncertain').reduce((sum, [, n]) => sum + n, 0)
    || findings.filter((f) => f.severity !== 'violation' && f.severity !== 'uncertain').length;
  const total = violations + uncertain + other;
  const unchecked = (machine.unchecked ?? []).filter(Boolean).map(uncheckedWords);
  if (machine.gcode) {
    return total
      ? { released: true, tone: 'uncertain', unchecked, verdict: `Released with ${plural(total, 'finding', 'findings')} accepted on purpose`, next: 'The program accepts these; check each one before you run it.' }
      : { released: true, tone: 'passed', unchecked, verdict: 'Released: every move checked', next: 'Prove it out on the machine as you would any program.' };
  }
  const parts = [
    violations ? plural(violations, 'problem', 'problems') : null,
    uncertain ? plural(uncertain, 'undecided finding', 'undecided findings') : null,
    other ? plural(other, 'check that couldn’t run', 'checks that couldn’t run') : null,
  ].filter(Boolean);
  const what = parts.length ? parts.join(' and ') : 'the checks';
  return {
    released: false, tone: violations || (!uncertain && !other) ? 'failed' : 'uncertain', unchecked, verdict: `Refused: ${what}`,
    next: 'Fix what each finding names (or accept that kind on purpose in the program), then build again. No G-code until then.',
  };
}
