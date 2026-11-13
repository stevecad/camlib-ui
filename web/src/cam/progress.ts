/**
 * A running build's progress in words (the API's `progress`, camlib_ui/build/progress.py): the header's status, the
 * result panel's list of operations and the model tree's marks. Only what the build and camlib said is shown: an
 * operation's fraction is camlib's own count (depth levels, finishing passes, or the area of an adaptive clearing) and
 * an operation camlib counts nothing for has none. Nothing here estimates time or a share of the whole build.
 */

export type ProgressStage = 'program' | 'describe' | 'planning' | 'checking' | 'playback' | 'release' | 'files';
export type ProgressBasis = 'layers' | 'passes' | 'area';
export type OperationState = 'pending' | 'planning' | 'done';

export interface OperationProgress {
  id: string; kind: string | null; state: OperationState;
  /** Planning: how long so far. Done: how long it took (null: camlib didn't say when it began). */
  seconds: number | null;
  /** Done: the moves camlib planned for it. */
  moves: number | null;
  /** Planning, where camlib counts something: what `fraction` (0 to 1) counts, and the levels or passes done of those planned. */
  basis: ProgressBasis | null; fraction: number | null; done: number | null; total: number | null;
}
export interface RunProgress {
  setup: string | null; machine: string | null;
  /** This run's place (0-based) among the build's runs: its setups on each of their machines. */
  index: number | null; count: number | null;
  /** Whether this camlib says which operation it is planning and how far (false: only which are done). */
  engine_progress: boolean;
  operations: OperationProgress[];
}
export interface BuildProgress { stage: ProgressStage; stage_seconds: number | null; run: RunProgress | null }

const STAGE_WORDS: Record<ProgressStage, string> = {
  program: 'running the program',
  describe: 'reading the program',
  planning: 'planning',
  checking: 'posting and checking',
  playback: 'writing the playback',
  release: 'deciding the release',
  files: 'checking the files',
};

/** The stage in a few words, lower case ("posting and checking"). */
export const stageWords = (stage: ProgressStage): string => STAGE_WORDS[stage] ?? 'running';

/** A fraction as a whole percentage, rounded down: 100% only once camlib says it is all done. */
export function percent(fraction: number): number {
  return Math.min(100, Math.max(0, Math.floor(fraction * 100 + 1e-9)));
}

/** Seconds as the list shows them: "4 s", "1 min 05 s". */
export function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, '0')} s`;
}

/** How long a done operation took: tenths under ten seconds ("0.4 s"), then as elapsed(). */
export const took = (seconds: number): string => (seconds < 9.95 ? `${Math.max(0, seconds).toFixed(1)} s` : elapsed(seconds));

const BASIS_OF: Record<ProgressBasis, string> = { layers: 'of levels', passes: 'of passes', area: 'by area' };

/** What camlib counted, short: "42% of levels", "42% of passes", "42% by area" (null: it counts nothing for this operation). */
export function fractionWords(op: Pick<OperationProgress, 'basis' | 'fraction'>): string | null {
  if (op.basis === null || op.fraction === null || !(op.basis in BASIS_OF)) return null;
  return `${percent(op.fraction)}% ${BASIS_OF[op.basis]}`;
}

/** The levels or passes done of those planned: "level 2 of 3", "pass 12 of 40" (the one being planned), null when not counted. */
export function countWords(op: Pick<OperationProgress, 'basis' | 'done' | 'total'>): string | null {
  if (op.basis === null || op.done === null || op.total === null || op.total <= 0) return null;
  const unit = op.basis === 'passes' ? 'pass' : 'level';
  return op.done >= op.total ? `${op.total} of ${op.total} ${unit}${op.total === 1 ? '' : unit === 'pass' ? 'es' : 's'}` : `${unit} ${op.done + 1} of ${op.total}`;
}

/** The run in words when the build has several ("top on mill (2 of 3)"), else null. */
export function runWords(run: RunProgress): string | null {
  if (run.count === null || run.count <= 1 || run.index === null) return null;
  const name = [run.setup, run.machine].filter(Boolean).join(' on ');
  return `${name || 'program'} (${run.index + 1} of ${run.count})`;
}

/**
 * The header's status of a running build: "Building: pocket (1 of 3) · 42% by area". Without camlib's planning
 * progress, the stage and how many operations are done; before any progress is there, as before ("Building: running…").
 */
export function runningStatus(mode: 'preview' | 'full', status: 'queued' | 'running', progress: BuildProgress | null | undefined): string {
  const head = mode === 'full' ? 'Building' : 'Checking';
  if (status === 'queued') return `${head}: waiting`;
  if (!progress) return `${head}: running…`;
  const run = progress.run;
  if (progress.stage !== 'planning' || !run) {
    const of = run ? runWords(run) : null;
    return `${head}: ${[of, stageWords(progress.stage)].filter(Boolean).join(' · ')}`;
  }
  const parts: string[] = [];
  const of = runWords(run);
  if (of) parts.push(of);
  const at = run.operations.findIndex((op) => op.state === 'planning');
  if (at >= 0) {
    const op = run.operations[at];
    parts.push(`${op.id} (${at + 1} of ${run.operations.length})`);
    const fraction = fractionWords(op);
    if (fraction) parts.push(fraction);
  } else {
    const done = run.operations.filter((op) => op.state === 'done').length;
    parts.push('planning', `${done} of ${run.operations.length} operations done`);
  }
  return `${head}: ${parts.join(' · ')}`;
}

/**
 * One row of the result panel's list. `bar`: 'fraction' draws `percent` of a bar, 'busy' an indeterminate one (camlib
 * is planning it and counts nothing), 'none' no bar (pending, done).
 */
export interface ProgressRow { id: string; kind: string | null; state: OperationState; bar: 'none' | 'fraction' | 'busy'; percent: number | null; detail: string }

export function operationRows(run: RunProgress): ProgressRow[] {
  return run.operations.map((op): ProgressRow => {
    if (op.state === 'done') {
      const detail = [op.moves === null ? null : `${op.moves.toLocaleString('en-US')} move${op.moves === 1 ? '' : 's'}`, op.seconds === null ? null : took(op.seconds)];
      return { id: op.id, kind: op.kind, state: 'done', bar: 'none', percent: null, detail: detail.filter(Boolean).join(' · ') || 'done' };
    }
    if (op.state === 'planning') {
      const fraction = fractionWords(op);
      const detail = [fraction ?? 'planning', countWords(op), op.seconds === null ? null : elapsed(op.seconds)];
      return { id: op.id, kind: op.kind, state: 'planning', bar: fraction ? 'fraction' : 'busy', percent: fraction ? percent(op.fraction!) : null, detail: detail.filter(Boolean).join(' · ') };
    }
    return { id: op.id, kind: op.kind, state: 'pending', bar: 'none', percent: null, detail: '' };
  });
}

/** The list's heading: "Setup top on mill · 1 of 3 operations done", with the run's place when the build has several. */
export function runHeading(run: RunProgress): string {
  const done = run.operations.filter((op) => op.state === 'done').length;
  const name = [run.setup, run.machine].filter(Boolean).join(' on ');
  const place = run.count !== null && run.count > 1 && run.index !== null ? ` (${run.index + 1} of ${run.count})` : '';
  return `${name ? `Setup ${name}` : 'Setup'}${place} · ${done} of ${run.operations.length} operations done`;
}

/**
 * An operation's row of the running build, for the model tree: the same row the list shows (state, the bar, how far,
 * and in words). Null: this setup isn't the one being built, the operation isn't in the run, or there is no progress.
 */
export function treeRow(progress: BuildProgress | null | undefined, setup: string, operation: string): ProgressRow | null {
  const run = progress?.run;
  if (!run || run.setup !== setup) return null;
  return operationRows(run).find((row) => row.id === operation) ?? null;
}

/** What a setup's row says while it is built: the stage ("planning", "posting and checking"); null for another setup. */
export function treeStage(progress: BuildProgress | null | undefined, setup: string): string | null {
  const run = progress?.run;
  if (!progress || !run || run.setup !== setup) return null;
  return stageWords(progress.stage);
}

/** An operation's state in the running build, for the model tree (null: this setup isn't the one being built, or no progress). */
export function treeState(progress: BuildProgress | null | undefined, setup: string, operation: string): OperationState | null {
  const run = progress?.run;
  if (!run || run.setup !== setup) return null;
  return run.operations.find((op) => op.id === operation)?.state ?? null;
}
