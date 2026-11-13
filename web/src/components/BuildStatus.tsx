/**
 * A running build's status in the result panel: what it is doing now. Each operation's own progress is on its row of
 * the browser (the left panel), next to the toolpath it belongs to; the operations are listed here as well only while
 * that panel is hidden (`operations`).
 */
import { CheckCircle2, CircleDashed } from 'lucide-react';
import type { Build } from '../api';
import { operationRows, runHeading, runWords, stageWords, type BuildProgress } from '../cam/progress';

/**
 * What a running build is doing: its stage, and the setup's operations as camlib plans them, each pending, being
 * planned (a bar when camlib counts how far it is, a moving one when it counts nothing) or done.
 */
function Progress({ progress }: { progress: BuildProgress }) {
  const run = progress.run;
  if (!run) return null;
  const rows = operationRows(run);
  return (
    <div className="card" id="build-progress" data-stage={progress.stage}>
      <div className="card-head"><b>{runHeading(run)}</b></div>
      <ol className="progress-list">
        {rows.map((row, index) => (
          <li key={`${row.id}:${index}`} className="progress-row" data-state={row.state} data-operation={row.id}>
            <span className="progress-mark">{row.state === 'done' ? <CheckCircle2 size={13} /> : row.state === 'planning' ? <span className="spinner" /> : <CircleDashed size={13} />}</span>
            <span className="progress-name">{row.id}</span>
            <span className="progress-detail">{row.detail}</span>
            {row.bar !== 'none' && (
              <span className="progress-bar" data-bar={row.bar} role="progressbar" aria-label={`${row.id}: ${row.detail}`}
                aria-valuemin={row.bar === 'fraction' ? 0 : undefined} aria-valuemax={row.bar === 'fraction' ? 100 : undefined} aria-valuenow={row.percent ?? undefined}>
                <i style={row.bar === 'fraction' ? { width: `${row.percent}%` } : undefined} />
              </span>
            )}
          </li>
        ))}
      </ol>
      {!run.engine_progress && <p className="note">This camlib doesn’t say which operation it is planning: operations are marked as it finishes them.</p>}
    </div>
  );
}

/** The banner of a queued or running build, and its operations when asked for; nothing for any other build. */
export default function BuildStatus({ build, operations }: { build: Build | null; operations: boolean }) {
  if (!build || (build.status !== 'queued' && build.status !== 'running')) return null;
  const progress = build.status === 'running' ? build.progress : undefined;
  const doing = progress ? [progress.run ? runWords(progress.run) : null, stageWords(progress.stage)].filter(Boolean).join(' · ') : null;
  return (
    <>
      <div className="banner" data-tone="info"><span className="spinner" /><span><b>{build.status === 'queued' ? 'Waiting to build' : build.mode === 'full' ? 'Building' : 'Checking'}…</b>{' '}
        {doing ? <span id="build-stage">{doing[0].toUpperCase() + doing.slice(1)}.</span>
          : build.mode === 'full' ? 'camlib plans every setup, checks every move, posts and decides what to release.' : 'Running the program and describing it.'}</span></div>
      {operations && progress && <Progress progress={progress} />}
    </>
  );
}
