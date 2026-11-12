/**
 * Which operations' toolpaths the 3D view draws: what the browser's eyes change (hide and show one, show only one and
 * back, a whole setup at once), what is kept of it between visits, and which of the drawn lines each operation owns.
 *
 * A display choice only. The playback, the tool, the simulated stock, the timeline and the move counter cover every
 * operation whatever is hidden here, and camlib's checks never see it.
 *
 * The rule for the moves between operations (camlib gives them no operation): a connecting move belongs to the
 * operation it leads to, so hiding an operation hides the rapids and links that bring the tool to it, and the moves
 * that leave a hidden operation for a shown one stay drawn. Moves after the last operation (the final retract) have
 * nothing to lead to: they belong to the operation before them. A move camlib gives an operation is that operation's.
 *
 * No runtime imports beyond the motion model, so it runs under plain Node (tests/paths.test.ts).
 */
import { UNASSIGNED } from './motion.ts';

// ── What is hidden ──────────────────────────────────────────────────────────

/**
 * One setup's hidden toolpaths, by operation id. `solo`: the operation shown alone, and what was hidden before it was
 * (what showing only it again goes back to).
 */
export interface SetupPaths { hidden: string[]; solo: { operation: string; before: string[] } | null }
/** A project's hidden toolpaths, by setup id. A setup with nothing hidden has no entry. */
export type ProjectPaths = Record<string, SetupPaths>;

const NOTHING: SetupPaths = { hidden: [], solo: null };
const unique = (ids: string[]) => [...new Set(ids)];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

export const pathHidden = (paths: SetupPaths | undefined, operation: string) => !!paths?.hidden.includes(operation);

/** How many of a setup's operations (`all`: the ones with a toolpath) are hidden. */
export const hiddenCount = (paths: SetupPaths | undefined, all: string[]) => (paths ? unique(all).filter((id) => paths.hidden.includes(id)).length : 0);

/** Hides a shown operation's toolpath, shows a hidden one's. A change by hand ends "only this one". */
export function toggled(paths: SetupPaths | undefined, operation: string): SetupPaths {
  const hidden = paths?.hidden ?? [];
  return { hidden: hidden.includes(operation) ? hidden.filter((id) => id !== operation) : [...hidden, operation], solo: null };
}

/**
 * Shows only `operation` of the setup's `all`; the same again puts back what was hidden before. Going from one
 * operation alone to another keeps what the first one remembered. An operation that is already the only one shown
 * (by hand) has nothing to go back to: all are shown.
 */
export function soloed(paths: SetupPaths | undefined, operation: string, all: string[]): SetupPaths {
  const now = paths ?? NOTHING;
  const ids = unique(all);
  const others = ids.filter((id) => id !== operation);
  const shownAlone = (id: string) => same(now.hidden.filter((item) => ids.includes(item)), ids.filter((item) => item !== id));
  if (now.solo?.operation === operation && shownAlone(operation)) return { hidden: now.solo.before.filter((id) => ids.includes(id)), solo: null };
  if (!now.solo && others.length > 0 && shownAlone(operation)) return NOTHING;
  // `solo` is there only while its operation is the one shown alone (a change by hand ends it), bar a new operation.
  const before = now.solo ? now.solo.before : now.hidden;
  return { hidden: others, solo: { operation, before } };
}

/** A setup's toolpaths as its row says them: all shown, all hidden, or some of each. */
export function setupState(paths: SetupPaths | undefined, all: string[]): 'shown' | 'hidden' | 'mixed' {
  const count = hiddenCount(paths, all), total = unique(all).length;
  return count === 0 ? 'shown' : count === total ? 'hidden' : 'mixed';
}

/** The setup's eye: every toolpath shown hides them all; any hidden (some or all) shows them all. */
export function setupToggled(paths: SetupPaths | undefined, all: string[]): SetupPaths {
  return setupState(paths, all) === 'shown' && all.length > 0 ? { hidden: unique(all), solo: null } : NOTHING;
}

// ── Kept between visits ─────────────────────────────────────────────────────

/** Where a project's hidden toolpaths are kept (localStorage); inside, by setup id then operation id. */
export const storageKey = (project: string) => `camlib-ui:toolpaths:${project}`;

const idList = (value: unknown): string[] => (Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === 'string' && item !== '')) : []);

/** What was kept (localStorage's text), read back: anything that isn't what `stored` writes is nothing hidden. */
export function parseStored(text: string | null | undefined): ProjectPaths {
  let value: unknown;
  try { value = JSON.parse(text ?? ''); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ProjectPaths = {};
  for (const [setup, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { hidden, solo } = entry as { hidden?: unknown; solo?: unknown };
    const kept: SetupPaths = { hidden: idList(hidden), solo: null };
    if (solo && typeof solo === 'object' && !Array.isArray(solo)) {
      const { operation, before } = solo as { operation?: unknown; before?: unknown };
      if (typeof operation === 'string' && operation !== '') kept.solo = { operation, before: idList(before) };
    }
    if (kept.hidden.length || kept.solo) out[setup] = kept;
  }
  return out;
}

/** The text to keep: only the setups with something hidden (or an "only this one" to go back from). */
export function stored(paths: ProjectPaths): string {
  const out: ProjectPaths = {};
  for (const [setup, entry] of Object.entries(paths)) if (entry.hidden.length || entry.solo) out[setup] = entry;
  return JSON.stringify(out);
}

/**
 * What is kept, against the program as it was just built: a setup or an operation that is no longer there is dropped
 * (an operation with the same id built again is the same one; a new one was never hidden, so it is shown).
 */
export function pruned(paths: ProjectPaths, setups: { id: string; operations: string[] }[]): ProjectPaths {
  const out: ProjectPaths = {};
  for (const setup of setups) {
    const entry = paths[setup.id];
    if (!entry) continue;
    const there = (id: string) => setup.operations.includes(id);
    const kept: SetupPaths = {
      hidden: entry.hidden.filter(there),
      solo: entry.solo && there(entry.solo.operation) ? { operation: entry.solo.operation, before: entry.solo.before.filter(there) } : null,
    };
    if (kept.hidden.length || kept.solo) out[setup.id] = kept;
  }
  return out;
}

/** True when two project states hide the same things (so nothing needs writing). */
export const samePaths = (a: ProjectPaths, b: ProjectPaths) => stored(a) === stored(b);

// ── Which lines are whose ───────────────────────────────────────────────────

/**
 * The operation each move is drawn with (its index in the setup's operations): its own, or for a move of no operation
 * the one it leads to (the rule above). UNASSIGNED only when no move has an operation: such a path is always drawn.
 */
export function moveOwners(operation: ArrayLike<number>, count: number = operation.length): Uint32Array {
  const owners = new Uint32Array(count);
  let next = UNASSIGNED;
  for (let i = count - 1; i >= 0; i--) {
    if (operation[i] !== UNASSIGNED) next = operation[i];
    owners[i] = next;
  }
  // After the last operation: nothing to lead to, so the operation before.
  let previous = UNASSIGNED;
  for (let i = 0; i < count; i++) {
    if (owners[i] === UNASSIGNED) owners[i] = previous; else previous = owners[i];
  }
  return owners;
}

/** Moves [first, end) drawn with one operation. */
export interface OwnerRun { owner: number; first: number; end: number }

/** The moves as runs of one owner, in order (a handful per operation however many moves there are). */
export function ownerRuns(owners: ArrayLike<number>): OwnerRun[] {
  const runs: OwnerRun[] = [];
  for (let i = 0; i < owners.length; i++) {
    const last = runs.at(-1);
    if (last && last.owner === owners[i]) last.end = i + 1;
    else runs.push({ owner: owners[i], first: i, end: i + 1 });
  }
  return runs;
}

/** The setup's operations (ids, in the stream's order) that are hidden, as their indexes. */
export function hiddenOwners(operations: string[], hidden: string[] | undefined): Set<number> {
  const out = new Set<number>();
  if (hidden?.length) operations.forEach((id, index) => { if (hidden.includes(id)) out.add(index); });
  return out;
}

/** Vertices [start, start + count) of the toolpath's line geometry. */
export interface DrawRange { start: number; count: number }

/**
 * What to draw: the vertex ranges of the runs whose owner isn't hidden, neighbours joined (one range when nothing is
 * hidden, none when everything is). `firstVertex[i]` is move i's first vertex, with one more entry for the end
 * (toolpathLines' `first`). Only the runs are walked, never the moves: a toggle costs the same on any program.
 */
export function drawRanges(runs: OwnerRun[], firstVertex: ArrayLike<number>, hidden: ReadonlySet<number>): DrawRange[] {
  const out: DrawRange[] = [];
  for (const run of runs) {
    if (hidden.has(run.owner)) continue;
    const start = firstVertex[run.first], count = firstVertex[run.end] - start;
    if (count <= 0) continue;
    const last = out.at(-1);
    if (last && last.start + last.count === start) last.count += count;
    else out.push({ start, count });
  }
  return out;
}
