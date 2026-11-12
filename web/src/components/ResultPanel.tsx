/**
 * A build's result: which build (the project's latest ones), its status, and once done what camlib decided for each
 * setup on each machine: released (download the G-code) or refused, each finding a click away in the playback, what
 * wasn't checked, and the figures. A program that didn't run shows its traceback, each line of the project's files a
 * click away in the editor.
 */
import { AlertTriangle, CheckCircle2, CircleDashed, CircleHelp, Download, Play, XCircle } from 'lucide-react';
import type { Build, MachineResult, MaterialReport, OperationStats } from '../api';
import { reportHeadlines, reportRows } from '../cam/report';
import { openPlayer, revealIn, seekMove, showBuild, useApp, usePlayer } from '../state';
import { findingDetail, findingMove, findingWords, severityOf, verdictOf, words } from '../cam/playback';
import { clock } from './Player';

const num = (value: number | null | undefined, digits = 1) => (value == null ? '—' : Number(value.toFixed(digits)).toLocaleString());
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function outcome(build: Pick<Build, 'status' | 'mode' | 'ok' | 'released' | 'refused'>): string {
  if (build.status === 'queued') return 'waiting';
  if (build.status === 'running') return 'running…';
  if (build.status === 'cancelled') return 'cancelled';
  if (build.status === 'failed') return 'stopped';
  if (!build.ok) return 'program error';
  if (build.mode === 'preview') return 'described';
  return `${build.released ?? 0} released${build.refused ? `, ${build.refused} refused` : ''}`;
}

/** A traceback with the lines in the build's copy of a project file made links to that file in the editor. */
function Traceback({ text }: { text: string }) {
  const project = useApp((state) => state.project);
  const names = new Set(project?.files.map((file) => file.name) ?? []);
  const show = (file: string, line: number) => revealIn(file, line, true);
  return (
    <pre className="traceback" id="program-error">
      {text.split('\n').map((line, index) => {
        const match = /File "([^"]*\/src\/([^"/]+))", line (\d+)/.exec(line);
        if (match && names.has(match[2])) {
          return <span key={index}>{line.slice(0, match.index)}<button type="button" className="trace-link" onClick={() => void show(match[2], Number(match[3]))}>{match[2]}, line {match[3]}</button>{line.slice(match.index + match[0].length)}{'\n'}</span>;
        }
        return <span key={index}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

const ICON = { passed: CheckCircle2, uncertain: AlertTriangle, failed: XCircle };

function Material({ material }: { material: MaterialReport }) {
  const row = (label: string, assessment: MaterialReport['gouge']) => {
    if (!assessment) return null;
    const [low, high] = assessment.volume_mm3 ?? [0, 0];
    return (
      <span>{label} <b>{words(assessment.assessment)}</b>
        {assessment.volume_mm3 ? ` · ${num(low / 1000, 2)}–${num(high / 1000, 2)} cm³` : ''}
        {assessment.definite_cells != null ? ` · ${num(assessment.definite_cells, 0)} cells definite, ${num(assessment.possible_only_cells ?? 0, 0)} possible` : ''}</span>
    );
  };
  return (
    <>
      {row('Into the part (gouge):', material.gouge)}
      {row('Stock left on the part:', material.residual)}
    </>
  );
}

function MachineVerdict({ build, setup, machine, several }: { build: Build; setup: string; machine: MachineResult; several: boolean }) {
  const verdict = verdictOf(machine);
  const player = useApp((state) => state.player);
  const focus = usePlayer((state) => state.focus);
  const playing = player.status === 'ready' && player.source?.header.id === setup;
  const streamed = build.metadata?.setups?.find((item) => item.id === setup)?.machines[0]?.machine === machine.machine;
  const Icon = ICON[verdict.tone];
  const RANK = { violation: 0, uncertain: 1, unchecked: 2 };
  const findings = machine.findings.map((finding, index) => ({ finding, index }))
    .sort((a, b) => RANK[severityOf(a.finding)] - RANK[severityOf(b.finding)] || (findingMove(a.finding) ?? -1) - (findingMove(b.finding) ?? -1));
  const show = async (index: number) => {
    const move = findingMove(machine.findings[index]);
    if (move === null) return;
    if (!playing) await openPlayer(setup);
    seekMove(move, index);
  };
  const gcode = machine.gcode ? build.files[machine.gcode] : null;
  const total = Object.values(machine.finding_counts ?? {}).reduce((sum, n) => sum + n, 0);
  const SEVERITY_WORDS = { violation: 'definite', uncertain: 'undecided', unchecked: 'not checked' };
  return (
    <div className="card" data-setup={setup} data-machine={machine.machine} data-released={verdict.released || undefined}>
      {several && <div className="card-head"><b>{setup}</b> on {machine.machine}</div>}
      <div className="banner" data-tone={verdict.tone} id={`verdict-${setup}-${machine.machine}`}>
        <Icon size={15} />
        <span><b>{verdict.verdict}.</b> {verdict.next}</span>
      </div>
      <div className="card-actions">
        {gcode && <a className="button primary small" href={gcode} download={`${build.metadata?.program.id ?? 'program'}-${setup}-${machine.machine}.nc`}><Download size={13} />Download G-code</a>}
        {streamed && <button type="button" className="button small" onClick={() => void openPlayer(setup)} disabled={playing}><Play size={13} />{playing ? 'Playing' : 'Play'}</button>}
        {gcode && streamed && <button type="button" className="button ghost small" title="Show the G-code (its tab follows playback)"
          onClick={async () => { if (!playing) await openPlayer(setup); useApp.setState({ tab: 'gcode', panelOpen: true }); }}>View G-code</button>}
      </div>
      {findings.length > 0 && (
        <div className="findings" id={`findings-${setup}-${machine.machine}`}>
          {findings.map(({ finding, index }) => {
            const move = findingMove(finding), severity = severityOf(finding), detail = findingDetail(finding);
            return (
              <button key={index} type="button" className="finding" data-s={severity} data-on={focus === index && playing ? true : undefined} disabled={!streamed || move === null}
                title={move === null ? 'About the whole program' : 'Show it in the playback'} onClick={() => void show(index)}>
                {severity === 'violation' ? <XCircle size={13} /> : severity === 'uncertain' ? <CircleHelp size={13} /> : <CircleDashed size={13} />}
                <span><b>{findingWords(finding)}</b>
                  <small>{move === null ? 'whole program' : `move ${move + 1}`} · {SEVERITY_WORDS[severity]}{detail ? ` · ${detail}` : ''}</small></span>
              </button>
            );
          })}
          {total > machine.findings_listed && <p className="note">{total - machine.findings_listed} more findings aren’t listed (the first {machine.findings_listed} are).</p>}
        </div>
      )}
      {(machine.accepted?.length ?? 0) > 0 && <p className="note"><CheckCircle2 size={12} /> Accepted on purpose by the program: {machine.accepted!.map(words).join(', ')}.</p>}
      {verdict.unchecked.length > 0 && <p className="note"><CircleDashed size={12} /> Not checked: {verdict.unchecked.join('; ')}.</p>}
      {machine.refused && <p className="note" data-tone="danger"><AlertTriangle size={12} /> {machine.refused}</p>}
      <details className="figures">
        <summary>Figures</summary>
        <div className="spec">
          <span>Machine <b>{machine.machine}</b> · {machine.controller} · post <b>{machine.post}</b></span>
          <span>Moves <b>{num(machine.moves, 0)}</b> · G-code lines <b>{num(machine.lines, 0)}</b></span>
          <span>Time <b>{clock(machine.seconds)}</b> nominal (feeds and rapids, no tool changes)</span>
          {machine.stock_remaining_mm3 && <span>Stock left <b>{num(machine.stock_remaining_mm3.lower / 1000, 2)}–{num(machine.stock_remaining_mm3.upper / 1000, 2)} cm³</b></span>}
          {machine.arc_output && <span>Arcs written as arcs <b>{num(machine.arc_output.native ?? 0, 0)}</b></span>}
          {machine.checks?.progress && <span>Moves checked <b>{num(machine.checks.progress.through_completed, 0)}</b> · clear {num(machine.checks.progress.clear, 0)} · violation {num(machine.checks.progress.violation, 0)} · uncertain {num(machine.checks.progress.uncertain, 0)}</span>}
          {machine.material && <Material material={machine.material} />}
          <span>Planned and checked in <b>{num(machine.plan_s, 1)} s</b></span>
        </div>
      </details>
    </div>
  );
}

/**
 * A setup's operations as camlib planned them: each one's moves, lengths and time, then camlib's own report of it. What
 * is worth reading first is said in words (the engagement an adaptive clearing proved, its diagnostics); the whole
 * report follows, every value under camlib's own name, whatever its shape.
 */
function Operations({ setup, operations, several }: { setup: string; operations: OperationStats[]; several: boolean }) {
  return (
    <div className="card" id={`operations-${setup}`} data-setup={setup}>
      <div className="card-head"><b>Operations</b>{several ? ` of ${setup}` : ''} <span className="meta">as camlib planned them</span></div>
      {operations.map((op) => {
        const headlines = reportHeadlines(op.report);
        const rows = op.report ? reportRows(op.report) : [];
        return (
          <details key={op.id} className="figures op-report" data-operation={op.id}>
            <summary><b>{op.id}</b> · {num(op.moves, 0)} moves · {clock(op.seconds)} · cut {num(op.cut_mm, 0)} mm · rapid {num(op.rapid_mm, 0)} mm</summary>
            {headlines.length > 0 && <div className="spec">{headlines.map((line, index) => <span key={index} data-tone={line.tone}>{line.text}</span>)}</div>}
            {rows.length > 0 ? (
              <details className="figures">
                <summary>camlib’s report ({rows.length} values)</summary>
                <div className="report-rows">
                  {rows.map((row, index) => (
                    <div key={index} className="report-row" data-heading={row.value === null || undefined} data-tone={row.tone} style={{ paddingLeft: row.depth * 12 }}>
                      <span>{row.label}</span>{row.value !== null && <b>{row.value}</b>}
                    </div>
                  ))}
                </div>
              </details>
            ) : <p className="note">{op.report === undefined ? 'This build kept no report of it (build again).' : 'camlib gave no report of it.'}</p>}
          </details>
        );
      })}
    </div>
  );
}

function Status({ build }: { build: Build }) {
  if (build.status === 'queued' || build.status === 'running') {
    return <div className="banner" data-tone="info"><span className="spinner" /><span><b>{build.status === 'queued' ? 'Waiting to build' : build.mode === 'full' ? 'Building' : 'Checking'}…</b> {build.mode === 'full' ? 'camlib plans every setup, checks every move, posts and decides what to release.' : 'Running the program and describing it.'}</span></div>;
  }
  if (build.status === 'cancelled') return <div className="banner" data-tone="info"><CircleDashed size={15} /><span>Cancelled.</span></div>;
  if (build.status === 'failed') return <div className="banner" data-tone="failed"><XCircle size={15} /><span><b>The build stopped.</b> {build.error}</span></div>;
  if (build.program_error) return <div className="banner" data-tone="failed"><XCircle size={15} /><span><b>The program didn’t build.</b> Its error is below; lines of your files open in the editor.</span></div>;
  if (build.mode === 'preview') return <div className="banner" data-tone="passed"><CheckCircle2 size={15} /><span><b>The program runs.</b> It is described in the program tree. Build it to plan, check and post it.</span></div>;
  return null;
}

export default function ResultPanel() {
  const build = useApp((state) => state.build);
  const builds = useApp((state) => state.builds);
  if (!builds.length && !build) {
    return <div className="panel-note">No builds yet. <b>Check</b> runs the program and describes it; <b>Build</b> plans every setup, checks every move and posts the G-code camlib releases.</div>;
  }
  const metadata = build?.metadata;
  const pairs = (metadata?.setups ?? []).flatMap((setup) => setup.machines.map((machine) => ({ setup: setup.id, machine })));
  return (
    <div className="result-panel" id="result">
      <div className="build-pick">
        <select aria-label="Build" value={build?.id ?? ''} onChange={(event) => void showBuild(event.target.value)}>
          {builds.map((item) => <option key={item.id} value={item.id}>{when(item.created)} · {item.mode === 'full' ? 'build' : 'check'} · {outcome(item)}</option>)}
        </select>
      </div>
      {build && <Status build={build} />}
      {build?.program_error && <Traceback text={build.program_error} />}
      {build && pairs.map(({ setup, machine }) => <MachineVerdict key={`${setup}:${machine.machine}`} build={build} setup={setup} machine={machine} several={pairs.length > 1} />)}
      {(metadata?.setups ?? []).filter((setup) => setup.operations?.length).map((setup) => <Operations key={setup.id} setup={setup.id} operations={setup.operations} several={(metadata?.setups?.length ?? 0) > 1} />)}
      {(metadata?.warnings?.length ?? 0) > 0 && (
        <div className="card">
          <div className="card-head"><AlertTriangle size={13} /> Warnings</div>
          {metadata!.warnings.map((warning, index) => <p key={index} className="note"><b>{warning.kind}</b>: {warning.message}</p>)}
        </div>
      )}
      {metadata && (
        <p className="meta">camlib {metadata.camlib.version}{metadata.camlib.commit ? ` (${metadata.camlib.commit.slice(0, 8)})` : ''} · program {metadata.program.id} revision {metadata.program.revision.slice(0, 24)}
          {metadata.timings_ms ? ` · ${num((metadata.timings_ms.total ?? 0) / 1000, 1)} s` : ''}</p>
      )}
      {build && build.log.trim() && (
        <details className="figures">
          <summary>Log</summary>
          <pre className="log">{build.log}</pre>
        </details>
      )}
    </div>
  );
}
