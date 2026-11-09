/**
 * The player over the viewport: transport and the nominal clock, a timeline coloured by move kind with each operation's
 * band and camlib's findings, the current move's readout, display toggles, and the posted G-code beside it (the current
 * line follows playback; click a line to go to its move). Verdicts are camlib's; this only draws and seeks.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileCode, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { api } from '../api';
import { openPlayer, seekMove, useApp, usePlayer, type PlayerSource } from '../state';
import { MOVE_KINDS, moveAt, moveForLine, positionAtTime, timeAtPosition, tipAt } from '../cam/motion';
import { findingMove, severityOf } from '../cam/playback';
import { KIND_COLORS, SEVERITY_COLORS } from './Viewport';
import { useEditor } from '../cam/programEditor';

const SPEEDS = [1, 5, 20, 100, 500];
const BAND_COLORS = ['#3b9eff', '#36cfc9', '#b37feb', '#ff7a45', '#7bd89d', '#e8bd84'];

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const num = (value: number, digits = 3) => Number(value.toFixed(digits)).toString();

/** Advances playback in nominal machine time while playing. */
function usePlayback(times: Float64Array | null) {
  useEffect(() => {
    if (!times) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const state = usePlayer.getState();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (state.playing) {
        const total = times[times.length - 1];
        const next = timeAtPosition(times, state.position) + dt * state.speed;
        if (next >= total) usePlayer.setState({ position: times.length - 1, playing: false });
        else usePlayer.setState({ position: positionAtTime(times, next) });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [times]);
}

function Timeline({ source }: { source: PlayerSource }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const position = usePlayer((state) => state.position);
  const machine = useApp((state) => state.build?.metadata?.setups?.find((item) => item.id === source.header.id)?.machines[0] ?? null);
  const { motion, times, bands } = source;
  const total = times[times.length - 1] || 1;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !width || !motion.count) return;
    const ratio = window.devicePixelRatio || 1, height = 30;
    element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
    const ctx = element.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Moves by kind, in machine time.
    for (let x = 0; x < width; x++) {
      const index = moveAt(motion, positionAtTime(times, ((x + 0.5) / width) * total));
      const kind = MOVE_KINDS[motion.kind[index]];
      ctx.fillStyle = KIND_COLORS[kind];
      ctx.globalAlpha = kind === 'rapid' || kind === 'retract' ? 0.5 : 0.85;
      ctx.fillRect(x, 8, 1, 12);
    }
    ctx.globalAlpha = 1;
    bands.forEach((band, index) => {
      const a = (timeAtPosition(times, band.first) / total) * width, b = (timeAtPosition(times, band.last + 1) / total) * width;
      ctx.fillStyle = BAND_COLORS[index % BAND_COLORS.length];
      ctx.fillRect(a, 1, Math.max(1, b - a), 4);
    });
    for (const finding of machine?.findings ?? []) {
      const move = findingMove(finding);
      if (move === null) continue;
      const x = (timeAtPosition(times, move + 0.5) / total) * width;
      ctx.fillStyle = SEVERITY_COLORS[severityOf(finding)];
      ctx.fillRect(Math.min(width - 2, Math.max(0, x - 1)), 22, 2, 7);
    }
  }, [width, motion, times, bands, total, machine]);
  const seekTo = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    usePlayer.setState({ position: positionAtTime(times, fraction * total), focus: null });
  };
  return (
    <div className="timeline-wrap">
      {bands.length > 0 && (
        <div className="bands" id="player-bands">
          {bands.map((band, index) => {
            const a = timeAtPosition(times, band.first) / total, b = timeAtPosition(times, band.last + 1) / total;
            return (
              <button key={`${band.operation}:${band.first}`} type="button" className="band" style={{ left: `${a * 100}%`, width: `${Math.max(0, b - a) * 100}%`, borderColor: BAND_COLORS[index % BAND_COLORS.length] }}
                title={`${band.operation}: moves ${band.first + 1}–${band.last + 1}. Go to its start.`} onClick={() => usePlayer.setState({ position: band.first, playing: false, focus: null })}>
                {band.operation}
              </button>
            );
          })}
        </div>
      )}
      <div ref={box} className="timeline" id="player-timeline" role="slider" aria-label="Playback position" aria-valuemin={0} aria-valuemax={motion.count} aria-valuenow={Math.round(position)} tabIndex={0}
        onPointerDown={(event) => { (event.target as HTMLElement).setPointerCapture?.(event.pointerId); usePlayer.setState({ playing: false }); seekTo(event.clientX); }}
        onPointerMove={(event) => { if (event.buttons & 1) seekTo(event.clientX); }}>
        <canvas ref={canvas} />
        <span className="playhead" style={{ left: `${(timeAtPosition(times, position) / total) * 100}%` }} />
      </div>
    </div>
  );
}

function Deck({ source }: { source: PlayerSource }) {
  const position = usePlayer((state) => state.position);
  const playing = usePlayer((state) => state.playing);
  const speed = usePlayer((state) => state.speed);
  const show = usePlayer((state) => state.show);
  const gcodeShown = useApp((state) => state.panelOpen && state.tab === 'gcode');
  const stockError = usePlayer((state) => state.stockError);
  const stockStatus = usePlayer((state) => state.stockStatus);
  const { motion, times, header } = source;
  const index = moveAt(motion, position);
  const tip = tipAt(motion, position);
  const kind = MOVE_KINDS[motion.kind[index]];
  const band = source.bands.find((item) => index >= item.first && index <= item.last) ?? null;
  const step = (delta: number) => usePlayer.setState({ playing: false, position: Math.min(motion.count, Math.max(0, Math.floor(position) + delta)) });
  const toggle = () => usePlayer.setState((state) => ({ playing: !state.playing, position: !state.playing && state.position >= motion.count ? 0 : state.position }));
  const setShow = (patch: Partial<typeof show>) => usePlayer.setState({ show: { ...show, ...patch } });
  const cell = header.stock.cell_mm;
  return (
    <div className="deck" id="player" role="toolbar" aria-label="Toolpath playback" data-moves={motion.count} data-position={position.toFixed(3)} data-line={motion.line[index]}>
      <div className="deck-top">
        <button type="button" className="icon-button" aria-label="Back to the start" title="Back to the start" onClick={() => usePlayer.setState({ position: 0, playing: false })}><SkipBack size={14} /></button>
        <button type="button" className="icon-button" aria-label="Previous move" title="Previous move (←)" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button type="button" className="play" id="player-play" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (space)' : 'Play (space)'} onClick={toggle}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
        <button type="button" className="icon-button" aria-label="Next move" title="Next move (→)" onClick={() => step(1)}><ChevronRight size={16} /></button>
        <button type="button" className="icon-button" aria-label="To the end" title="To the end" onClick={() => usePlayer.setState({ position: motion.count, playing: false })}><SkipForward size={14} /></button>
        <span className="clock" id="player-clock"><b>{clock(timeAtPosition(times, position))}</b> / {clock(times[times.length - 1])}</span>
        <select aria-label="Playback speed" value={speed} onChange={(event) => usePlayer.setState({ speed: Number(event.target.value) })}>
          {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
        <span className="readout" id="player-readout">
          <span className="op-name">{band ? band.operation : 'Between operations'}</span>
          <span>T<b>{source.numbers[motion.tool[index]] ?? '?'}</b></span>
          <span>Move <b>{index + 1}</b> / {motion.count}</span>
          <span className="kind"><i style={{ background: KIND_COLORS[kind] }} />{kind}</span>
          {motion.line[index] > 0 && <span>Line <b>{motion.line[index]}</b></span>}
          <span>X <b>{num(tip[0])}</b> Y <b>{num(tip[1])}</b> Z <b>{num(tip[2])}</b></span>
          {motion.feed[index] > 0 && <span>F <b>{num(motion.feed[index], 0)}</b></span>}
          {motion.rpm[index] > 0 && <span>S <b>{num(motion.rpm[index], 0)}</b></span>}
        </span>
        <button type="button" className="toggle gcode-toggle" data-on={gcodeShown || undefined} aria-label="Posted G-code" title="The posted G-code, in the right panel's G-code tab"
          onClick={() => useApp.setState(gcodeShown ? { tab: 'result' } : { tab: 'gcode', panelOpen: true })}><FileCode size={13} />G-code</button>
      </div>
      <Timeline source={source} />
      <div className="deck-foot">
        <span className="legend" aria-label="Toolpath colours">
          {(['feed', 'plunge', 'lead', 'rapid', 'retract'] as const).map((item) => <span key={item} className="kind"><i style={{ background: KIND_COLORS[item] }} />{item === 'feed' ? 'cut' : item}</span>)}
        </span>
        {show.grid || !stockStatus
          ? <span className="stock-note" id="stock-note" data-stock="grid"
              title={`camlib's own stock: the grid every check ran on, ${num(cell[0])} × ${num(cell[1])} mm cells (${header.stock.nx} × ${header.stock.ny}; the program's StockSpec sets the size). Shown as it is once the moves before the playing one are done: a move's cut appears at its end. Each cell shows the most material that may still be there.`}>
              Stock: <b>camlib’s check grid</b> ({num(cell[0])} mm cells){stockError ? ` · ${stockError}` : ''}
            </span>
          : <span className="stock-note" id="stock-note" data-stock="display" data-cell={stockStatus.cell.toFixed(4)}
              title={`What you see: the stock as a ${num(stockStatus.cell)} mm height field (${stockStatus.nx} × ${stockStatus.ny}), cut by each tool's own profile swept along the posted moves; walls are drawn where the cutter's side was. Surfaces are tinted by the operation that cut them. It is a display only: camlib's checks ran on its own ${num(cell[0])} mm grid and decide every pass and fail; "camlib grid" shows that stock.`}>
              Stock: <b>{stockStatus.cutting !== null ? 'cutting…' : 'as cut'}</b> ({num(stockStatus.cell)} mm display; camlib checks on {num(cell[0])} mm)
            </span>}
        <span className="toggles">
          <button type="button" className="toggle" data-on={show.toolpath || undefined} onClick={() => setShow({ toolpath: !show.toolpath })}>Toolpath</button>
          <span className="segmented">
            {(['solid', 'translucent', 'off'] as const).map((mode) => (
              <button key={mode} type="button" data-on={show.stock === mode || undefined} onClick={() => setShow({ stock: mode })}>{mode === 'solid' ? 'Stock' : mode === 'translucent' ? 'Clear' : 'Off'}</button>
            ))}
          </span>
          <button type="button" className="toggle" id="stock-grid" data-on={show.grid || undefined} title="Show camlib's own stock: the grid every check ran on, instead of the fine display stock"
            onClick={() => setShow({ grid: !show.grid })}>camlib grid</button>
          <button type="button" className="toggle" data-on={show.tool || undefined} onClick={() => setShow({ tool: !show.tool })}>Tool</button>
          <button type="button" className="toggle" data-on={show.part || undefined} onClick={() => setShow({ part: !show.part })}>Part</button>
          <button type="button" className="toggle" data-on={show.fixtures || undefined} onClick={() => setShow({ fixtures: !show.fixtures })}>Fixtures</button>
        </span>
      </div>
    </div>
  );
}

const ROW = 18;

/** The posted G-code, virtualised; the current move's line follows playback; a click goes to that line's move. */
function Gcode({ source, url }: { source: PlayerSource; url: string }) {
  const position = usePlayer((state) => state.position);
  const playing = usePlayer((state) => state.playing);
  const scroller = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });
  const { motion } = source;
  const current = motion.count ? motion.line[moveAt(motion, position)] ?? 0 : 0;
  useEffect(() => {
    let live = true;
    setLines(null); setError(null);
    api.text(url).then((text) => { if (live) setLines(text.replace(/\r/g, '').replace(/\n$/, '').split('\n')); }).catch((reason) => { if (live) setError(String(reason?.message ?? reason)); });
    return () => { live = false; };
  }, [url]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setScroll({ top: element.scrollTop, height: element.clientHeight });
    update();
    element.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { element.removeEventListener('scroll', update); observer.disconnect(); };
  }, [lines]);
  useEffect(() => {
    const element = scroller.current;
    if (!element || !current) return;
    const y = (current - 1) * ROW;
    if (y < element.scrollTop + ROW || y > element.scrollTop + element.clientHeight - 2 * ROW) element.scrollTop = Math.max(0, y - element.clientHeight / 3);
  }, [current, playing, lines]);
  if (error) return <div className="panel-note">The G-code couldn’t be read: {error}</div>;
  if (!lines) return <div className="panel-note">Reading the G-code…</div>;
  const first = Math.max(0, Math.floor(scroll.top / ROW) - 10), last = Math.min(lines.length, Math.ceil((scroll.top + scroll.height) / ROW) + 10);
  return (
    <div ref={scroller} className="gcode-scroll">
      <div className="gcode" id="player-gcode" style={{ height: lines.length * ROW }} data-current-line={current}>
        {lines.slice(first, last).map((text, offset) => {
          const line = first + offset + 1;
          return (
            <div key={line} className="gcode-line" style={{ top: (line - 1) * ROW }} data-line={line} data-on={line === current || undefined}
              onClick={() => { const move = moveForLine(motion, line); if (move >= 0) seekMove(move - 1); }}>
              <i>{line}</i>{highlight(text)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Player() {
  const player = useApp((state) => state.player);
  const source = player.status === 'ready' ? player.source : null;
  // Space plays and pauses, arrows step a move: commands.ts (sim.play, sim.next, sim.previous).
  usePlayback(source?.times ?? null);
  // A form open: the view is for picking on the part (the playback comes back when it closes).
  const formOpen = useEditor((state) => !!state.form);
  if (formOpen) return null;
  if (player.status === 'loading') return <div className="player-note" role="status">{player.message}</div>;
  if (player.status === 'error') return <div className="player-note" data-tone="danger" role="alert">The playback couldn’t be read: {player.message}</div>;
  if (!source) return null;
  return <Deck source={source} />;
}

/**
 * The posted G-code, as the right panel's G-code tab: the setup playing's file, following playback (a click on a line
 * goes to its move), with its download. Nothing playing: what to do to see it.
 */
export function GcodePanel() {
  const player = useApp((state) => state.player);
  const build = useApp((state) => state.build);
  const source = player.status === 'ready' ? player.source : null;
  const playable = !!build?.files['cam-playback.bin'] && build.status === 'done';
  if (!source || !build) {
    return (
      <div className="panel-note" id="gcode-empty">
        {player.status === 'loading' ? player.message
          : playable ? <>Simulate a setup to see its G-code here, following playback. <button type="button" className="button small" onClick={() => void openPlayer(build!.metadata?.setups?.[0]?.id ?? '')}>Simulate</button></>
            : <>Generate the toolpaths (<b>Build</b>) to see the posted G-code: camlib posts each setup and releases the files it clears.</>}
      </div>
    );
  }
  const machine = build.metadata?.setups?.find((item) => item.id === source.header.id)?.machines[0];
  const url = machine?.gcode ? build.files[machine.gcode] : undefined;
  return (
    <div className="gcode-panel" id="gcode-panel" aria-label="Posted G-code">
      <div className="side-head">
        <FileCode size={14} />
        <b>{machine?.gcode ?? 'G-code'}</b>
        <small>{machine ? `${source.header.id} on ${machine.machine} · ${machine.post}${machine.lines ? ` · ${machine.lines} lines` : ''}` : ''}</small>
        {url && machine?.gcode && (
          <a className="icon-button" href={url} download={`${build.metadata?.program.id ?? 'program'}-${source.header.id}-${machine.machine}.nc`} title="Download the G-code" aria-label="Download the G-code"><Download size={14} /></a>
        )}
      </div>
      {url ? <Gcode source={source} url={url} /> : <div className="panel-note">camlib refused this setup, so there is no G-code. The playback shows what it planned and checked.</div>}
    </div>
  );
}

/** A G-code line coloured by word: G and M codes, axis words, feed/speed/tool words, comments. Display only. */
function highlight(text: string) {
  const comment = text.search(/[;(]/);
  const code = comment >= 0 ? text.slice(0, comment) : text;
  const parts = code.split(/(\s+)/).map((word, index) => {
    const letter = word[0]?.toUpperCase();
    const kind = letter === 'G' ? 'g' : letter === 'M' ? 'm' : letter && 'XYZIJKRABC'.includes(letter) ? 'axis' : letter && 'FST'.includes(letter) ? 'fst' : letter && 'HDNPQL'.includes(letter) ? 'other' : null;
    return kind ? <span key={index} className={`gc-${kind}`}>{word}</span> : word;
  });
  return <>{parts}{comment >= 0 && <span className="gc-comment">{text.slice(comment)}</span>}</>;
}
