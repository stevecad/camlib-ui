/**
 * The app's state (zustand) and what changes it: the project open, its files as the editor holds them, its builds
 * (polled while they run), the part, and the player of a full build's playback stream.
 */
import { create } from 'zustand';
import { api, rangeFetch, type Build, type BuildSummary, type Info, type PartMesh, type ProgramDescription, type Project } from './api';
import { PlaybackStream, type StreamSetup } from './cam/stream';
import { operationBands, streamMotion, toolNumbers, type Band } from './cam/playback';
import type { Motion } from './cam/motion';

export interface OpenFile { text: string; saved: string; loading: boolean; error: string | null }

export interface PlayerSource {
  build: string;
  stream: PlaybackStream;
  setup: number;
  header: StreamSetup;
  motion: Motion;
  times: Float64Array;
  bands: Band[];
  numbers: number[];
}

interface AppState {
  info: Info | null;
  projects: Project[];
  project: Project | null;
  files: Record<string, OpenFile>;
  active: string | null;
  builds: BuildSummary[];
  /** The build shown (its result, its stream). */
  build: Build | null;
  /** A build being started or polled. */
  busy: string | null;
  part: { status: 'none' | 'loading' | 'ready' | 'error'; mesh: PartMesh | null; error: string | null; revision: number };
  player: { status: 'none' | 'loading' | 'ready' | 'error'; message: string | null; source: PlayerSource | null; setup: string | null };
  /** The right panel's tab: the code, the build's result, or the posted G-code (following playback). */
  tab: 'code' | 'result' | 'gcode';
  toast: { text: string; tone: 'error' | 'info'; action?: { label: string; run: () => void } } | null;
  /** A file and line to show in the editor (an error's, marked; a definition's, not), with a nonce to show the same again. */
  reveal: { file: string; line: number; nonce: number; error: boolean } | null;
  /** The face picked on the part. */
  picked: { face: number; point: [number, number, number] } | null;
  /** The dialog open over everything (the command palette, the shortcuts, settings, a new project). */
  dialog: 'palette' | 'shortcuts' | 'settings' | 'new' | null;
  /** What the command palette opens with typed in. */
  paletteQuery: string;
  /** The left (the browser) and right (code and result) panels. */
  sidebarOpen: boolean;
  panelOpen: boolean;
  /** The browser's selected row (its handle: `setup:top`, `operation:top/pocket`, `body:part`, …). */
  selected: string | null;
  /** The program as the latest build that ran it described it (a later build that failed keeps it). */
  described: { build: string; program: ProgramDescription } | null;
  /** The code panel's file switcher (Ctrl+P). */
  switcherOpen: boolean;
}

export const useApp = create<AppState>(() => ({
  info: null, projects: [], project: null, files: {}, active: null, builds: [], build: null, busy: null,
  part: { status: 'none', mesh: null, error: null, revision: 0 },
  player: { status: 'none', message: null, source: null, setup: null },
  tab: 'code', toast: null, reveal: null, picked: null,
  dialog: null, paletteQuery: '', sidebarOpen: true, panelOpen: true, selected: null, described: null, switcherOpen: false,
}));

export interface PlayerState {
  position: number;
  playing: boolean;
  speed: number;
  /** `grid`: show camlib's own stock grid (the checks') instead of the fine display stock. */
  show: { toolpath: boolean; stock: 'solid' | 'translucent' | 'off'; tool: boolean; part: boolean; fixtures: boolean; grid: boolean };
  /** The finding in focus (its index in the machine's findings). */
  focus: number | null;
  stockError: string | null;
  /** The display stock's field, and where it has got to while it catches up with a seek (null: at the position). */
  stockStatus: { cell: number; nx: number; ny: number; cutting: number | null } | null;
}

export const usePlayer = create<PlayerState>(() => ({
  position: 0, playing: false, speed: 20,
  show: { toolpath: true, stock: 'solid', tool: true, part: false, fixtures: true, grid: false },
  focus: null, stockError: null, stockStatus: null,
}));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const toast = (text: string, tone: 'error' | 'info' = 'error', action?: { label: string; run: () => void }) => useApp.setState({ toast: { text, tone, action } });

const DEFAULT_FILES = ['program.py', 'shop.py', 'part.py'];
const LAST = 'camlib-ui:project';

let booted = false;

export async function boot() {
  if (booted) return;
  booted = true;
  try {
    const [info, projects] = await Promise.all([api.info(), api.projects()]);
    useApp.setState({ info, projects });
    const wanted = new URLSearchParams(location.search).get('project') ?? localStorage.getItem(LAST);
    const first = projects.find((item) => item.name === wanted) ?? projects[0];
    if (first) await openProject(first.name);
  } catch (error) {
    toast(`camlib-ui's server didn't answer: ${message(error)}`);
  }
}

export async function refreshProjects() {
  useApp.setState({ projects: await api.projects() });
}

let polling: { build: string; timer: number } | null = null;

export async function openProject(name: string) {
  if (polling) { clearTimeout(polling.timer); polling = null; }
  closePlayer();
  useApp.setState({
    project: null, files: {}, active: null, builds: [], build: null, busy: null, picked: null, selected: null, described: null,
    part: { status: 'none', mesh: null, error: null, revision: 0 },
  });
  const project = await api.project(name);
  localStorage.setItem(LAST, name);
  history.replaceState(null, '', `?project=${encodeURIComponent(name)}`);
  useApp.setState({ project, builds: project.builds ?? [] });
  const first = DEFAULT_FILES.find((file) => project.files.some((item) => item.name === file));
  if (first) await openFile(first);
  void loadPart();
  const latest = (project.builds ?? [])[0];
  if (latest) await showBuild(latest.id);
  // The browser's setups come from the latest build that described the program: if the latest failed, an earlier one.
  if (!useApp.getState().described) await describeFromHistory(name);
}

/** Finds the latest build that described the program (newest first, at most a few) for the browser. */
async function describeFromHistory(project: string) {
  for (const summary of useApp.getState().builds.filter((item) => item.status === 'done' && item.ok).slice(0, 5)) {
    try {
      const build = await api.build(project, summary.id);
      if (useApp.getState().project?.name !== project || useApp.getState().described) return;
      if (build.metadata?.program) { useApp.setState({ described: { build: build.id, program: build.metadata.program } }); return; }
    } catch { /* gone: try the one before */ }
  }
}

/** Opens a project file in the editor at a line: an error's (marked) or a definition's. */
export async function revealIn(file: string, line: number, error: boolean) {
  useApp.setState({ panelOpen: true });
  await openFile(file);
  useApp.setState((state) => ({ tab: 'code', reveal: { file, line, nonce: (state.reveal?.nonce ?? 0) + 1, error } }));
}

/** Where `id` is first defined in a project file as a quoted string (an operation's or setup's id), or null. */
export async function findDefinition(file: string, id: string): Promise<number | null> {
  const project = useApp.getState().project;
  if (!project) return null;
  let text = useApp.getState().files[file]?.text;
  if (text === undefined) {
    try { text = await api.file(project.name, file); } catch { return null; }
  }
  const pattern = new RegExp(`["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
  const lines = text.split('\n');
  const at = lines.findIndex((line) => pattern.test(line) && !line.trimStart().startsWith('#'));
  return at >= 0 ? at + 1 : null;
}

/** Opens a project file in the editor (its text once). */
export async function openFile(name: string) {
  const project = useApp.getState().project;
  if (!project) return;
  useApp.setState({ active: name });
  if (useApp.getState().files[name]) return;
  if (!/\.(py|txt|md|json)$/i.test(name)) {
    useApp.setState((state) => ({ files: { ...state.files, [name]: { text: '', saved: '', loading: false, error: 'A binary file: it isn’t edited here.' } } }));
    return;
  }
  useApp.setState((state) => ({ files: { ...state.files, [name]: { text: '', saved: '', loading: true, error: null } } }));
  try {
    const text = await api.file(project.name, name);
    useApp.setState((state) => ({ files: { ...state.files, [name]: { text, saved: text, loading: false, error: null } } }));
  } catch (error) {
    useApp.setState((state) => ({ files: { ...state.files, [name]: { text: '', saved: '', loading: false, error: message(error) } } }));
  }
}


export const editFile = (name: string, text: string) => useApp.setState((state) => ({ files: { ...state.files, [name]: { ...state.files[name], text } } }));

export const dirtyFiles = () => Object.entries(useApp.getState().files).filter(([, file]) => !file.loading && !file.error && file.text !== file.saved).map(([name]) => name);

/** Saves the open files that changed; true when every one was saved. */
export async function saveAll(): Promise<boolean> {
  const project = useApp.getState().project;
  if (!project) return false;
  let ok = true, part = false;
  for (const name of dirtyFiles()) {
    const text = useApp.getState().files[name].text;
    try {
      const described = await api.writeFile(project.name, name, text);
      useApp.setState((state) => ({ project: { ...described, builds: state.project?.builds }, files: { ...state.files, [name]: { ...state.files[name], saved: text } } }));
      if (/^part\./i.test(name)) part = true;
    } catch (error) {
      ok = false;
      toast(`${name} wasn't saved: ${message(error)}`);
    }
  }
  if (part) void loadPart();
  return ok;
}

export async function uploadFile(file: File, as?: string) {
  const project = useApp.getState().project;
  if (!project) return;
  const name = as ?? file.name;
  try {
    const described = await api.writeFile(project.name, name, file);
    useApp.setState((state) => {
      const files = { ...state.files };
      delete files[name];
      return { project: { ...described, builds: state.project?.builds }, files };
    });
    if (/^part\./i.test(name)) void loadPart();
    toast(`${name} uploaded.`, 'info');
  } catch (error) {
    toast(`${name} wasn't uploaded: ${message(error)}`);
  }
}

export async function newFile(name: string) {
  const project = useApp.getState().project;
  if (!project) return;
  if (project.files.some((file) => file.name === name)) { await openFile(name); return; }
  try {
    const described = await api.writeFile(project.name, name, '');
    useApp.setState((state) => ({ project: { ...described, builds: state.project?.builds } }));
    await openFile(name);
  } catch (error) {
    toast(message(error));
  }
}

export async function deleteFile(name: string) {
  const project = useApp.getState().project;
  if (!project || !confirm(`Delete ${name} from ${project.name}? This can't be undone.`)) return;
  try {
    const described = await api.deleteFile(project.name, name);
    useApp.setState((state) => {
      const files = { ...state.files };
      delete files[name];
      const names = Object.keys(files);
      return { project: { ...described, builds: state.project?.builds }, files, active: state.active === name ? names[0] ?? null : state.active };
    });
    if (/^part\./i.test(name)) void loadPart();
  } catch (error) {
    toast(message(error));
  }
}

export async function loadPart() {
  const project = useApp.getState().project;
  if (!project) return;
  if (!project.part) { useApp.setState((state) => ({ part: { status: 'none', mesh: null, error: null, revision: state.part.revision + 1 }, picked: null })); return; }
  useApp.setState((state) => ({ part: { ...state.part, status: 'loading', error: null } }));
  try {
    const mesh = await api.part(project.name);
    if (useApp.getState().project?.name !== project.name) return;
    useApp.setState((state) => ({ part: { status: 'ready', mesh, error: null, revision: state.part.revision + 1 }, picked: null }));
  } catch (error) {
    useApp.setState((state) => ({ part: { status: 'error', mesh: null, error: message(error), revision: state.part.revision + 1 } }));
  }
}

// ── Builds ─────────────────────────────────────────────────────────────────

export const running = (build: BuildSummary | null | undefined) => !!build && (build.status === 'queued' || build.status === 'running');

/** Saves what changed, then builds: a preview (describe) or full (plan, check, post, release). */
export async function startBuild(mode: 'preview' | 'full') {
  const project = useApp.getState().project;
  if (!project || useApp.getState().busy) return;
  useApp.setState({ busy: 'saving' });
  if (!(await saveAll())) { useApp.setState({ busy: null }); return; }
  try {
    const started = await api.startBuild(project.name, mode);
    useApp.setState((state) => ({ builds: [started, ...state.builds.filter((item) => item.id !== started.id)], tab: 'result', panelOpen: true }));
    await showBuild(started.id);
  } catch (error) {
    useApp.setState({ busy: null });
    toast(message(error));
  }
}

export async function cancelBuild() {
  const { project, build } = useApp.getState();
  if (!project || !build || !running(build)) return;
  try { await api.cancelBuild(project.name, build.id); } catch (error) { toast(message(error)); }
}

/** Shows a build (its result; its playback stream once it is a done full build), polling it while it runs. */
export async function showBuild(id: string) {
  const project = useApp.getState().project;
  if (!project) return;
  if (polling) { clearTimeout(polling.timer); polling = null; }
  if (useApp.getState().player.source?.build !== id) closePlayer();
  let build: Build;
  try {
    build = await api.build(project.name, id);
  } catch (error) {
    useApp.setState({ busy: null });
    toast(message(error));
    return;
  }
  if (useApp.getState().project?.name !== project.name) return;
  useApp.setState((state) => ({
    build, busy: running(build) ? build.status : null,
    builds: state.builds.map((item) => (item.id === build.id ? { ...item, ...build } : item)),
    // A build that ran the program describes it; one that didn't leaves the browser as it was.
    described: build.metadata?.program ? { build: build.id, program: build.metadata.program } : state.described,
  }));
  if (running(build)) {
    polling = { build: id, timer: window.setTimeout(() => void showBuild(id), 800) };
    return;
  }
  if (build.status === 'done' && build.mode === 'full' && build.files['cam-playback.bin']) {
    const setups = build.metadata?.setups ?? [];
    const wanted = useApp.getState().player.setup;
    await openPlayer(setups.find((setup) => setup.id === wanted)?.id ?? setups[0]?.id ?? null);
  }
}

// ── Player ─────────────────────────────────────────────────────────────────

let opening = 0;

export function closePlayer() {
  opening++;
  usePlayer.setState({ playing: false, position: 0, focus: null, stockError: null });
  useApp.setState((state) => ({ player: { status: 'none', message: null, source: null, setup: state.player.setup } }));
}

/** Opens the shown build's playback stream at a setup: its header, then every chunk of moves (stock is read on demand). */
export async function openPlayer(setupId: string | null) {
  const build = useApp.getState().build;
  const url = build?.files['cam-playback.bin'];
  if (!build || !url || !setupId) return;
  const ticket = ++opening;
  usePlayer.setState({ playing: false, position: 0, focus: null, stockError: null });
  useApp.setState({ player: { status: 'loading', message: 'Reading the playback stream…', source: null, setup: setupId } });
  try {
    const stream = await PlaybackStream.open(rangeFetch(url), { chunks: 16, keyframes: 6 });
    const s = stream.header.setups.findIndex((setup) => setup.id === setupId);
    if (s < 0) throw new Error(`The stream has no setup ${setupId}.`);
    const header = stream.header.setups[s];
    const played = streamMotion(stream, s);
    for (let c = 0; c < header.chunks.length; c++) {
      await played.load(c);
      if (ticket !== opening) return;
      if (header.chunks.length > 4) useApp.setState({ player: { status: 'loading', message: `Reading moves: ${c + 1} of ${header.chunks.length} chunks…`, source: null, setup: setupId } });
    }
    const source: PlayerSource = {
      build: build.id, stream, setup: s, header, motion: played.motion, times: played.times,
      bands: operationBands(played.motion, header), numbers: toolNumbers(header),
    };
    useApp.setState({ player: { status: 'ready', message: null, source, setup: setupId } });
  } catch (error) {
    if (ticket === opening) useApp.setState({ player: { status: 'error', message: message(error), source: null, setup: setupId } });
  }
}

/** Goes to a move (0-based): the stock as it is once that move is done, the tool at its end. */
export function seekMove(move: number, focus: number | null = null) {
  const source = useApp.getState().player.source;
  if (!source) return;
  usePlayer.setState({ position: Math.min(source.motion.count, Math.max(0, move + 1)), playing: false, focus });
}
