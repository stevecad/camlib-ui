/**
 * Every command, with its keyboard shortcut (as in STEVE Studio: the same keys for the same things), its availability
 * and what it does. The keyboard, the command palette (Mod+K) and the shortcuts list (?) all read this one table.
 */
import type { ComponentType } from 'react';
import {
  Box, Code2, Eye, FilePlus2, FileSearch, Library, FolderOpen, Focus, Grid3x3, Hammer, Keyboard, ListChecks, Maximize2, Move3d, PanelLeft, PanelRight, Pause,
  Save, ScanSearch, Settings, SkipBack, SkipForward, Square, StepBack, StepForward,
} from 'lucide-react';
import * as THREE from 'three';
import { cancelBuild, dirtyFiles, openPlayer, revealIn, running, saveAll, showAllPaths, startBuild, useApp, usePaths, usePlayer } from './state';
import { openNewOp, openSetup, useProgram } from './cam/programEditor';
import { availableSpecs, fieldsLoaded, OP_SPECS } from './cam/opSpecs';
import { opIconOf, PostIcon, SetupIcon, SimulateToolIcon, ToolpathIcon } from './icons';
import { setting, updateSetting } from './settings';
import { useView, viewer, type DisplayStyle, type StandardView } from './viewport/viewer';

export type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export interface Command {
  id: string;
  label: string;
  /** The ribbon's shorter label ("Pocket" for "2D Pocket"). */
  short?: string;
  description?: string;
  icon: IconType;
  /** As shown: "Mod+S", "Shift+H", "?" ("Mod" is Ctrl, or ⌘ on a Mac). */
  shortcut?: string;
  /** As matched (eventKey): "mod+s", "shift+h", "?". */
  keys?: string[];
  category: string;
  run: () => void;
  /** true when available, otherwise why it isn't. */
  enabled?: () => true | string;
  active?: () => boolean;
}

const app = () => useApp.getState();

/** The setup the browser has selected (or holds the selected operation), else the program's first. */
function chosenSetup(): string | null {
  const selected = app().selected;
  const id = selected?.startsWith('setup:') ? selected.slice(6) : selected?.startsWith('operation:') ? selected.slice(10).split('/')[0] : null;
  const ids = useProgram.getState().model?.setups.map((setup) => setup.id) ?? app().described?.program.setups.map((setup) => setup.id) ?? [];
  return id && ids.includes(id) ? id : ids[0] ?? null;
}
const playable = () => { const build = app().build; return !!build?.files['cam-playback.bin'] && build.status === 'done'; };
const releasedFor = (setup: string | null) => (app().build?.mode === 'full' ? app().build?.metadata?.setups?.find((item) => item.id === setup)?.machines.find((machine) => machine.gcode) ?? null : null);
function downloadGcode() {
  const build = app().build, setup = chosenSetup(), machine = releasedFor(setup);
  if (!build || !machine?.gcode) return;
  const a = document.createElement('a');
  a.href = build.files[machine.gcode];
  a.download = `${build.metadata?.program.id ?? 'program'}-${setup}-${machine.machine}.nc`;
  a.click();
}
const needsProgramFile = () => (app().project ? true : 'Open or create a project first.');
/** An operation's form: camlib has it, and the program has a setup to put it in. */
const opReason = (cls: string) => () => {
  if (!app().project) return 'Open or create a project first.';
  if (fieldsLoaded() && !availableSpecs().some((spec) => spec.cls === cls)) return 'The installed camlib doesn’t have this operation.';
  return useProgram.getState().model?.setups.length ? true : useProgram.getState().problem ?? 'Add a setup first (Setup).';
};
const needsProject = () => !!app().project || 'Open or create a project first.';
const needsProgram = () => (!app().project ? 'Open or create a project first.' : app().project!.program ? true : 'The project has no program.py.');
const needsIdle = () => !app().busy || 'Wait for the build to finish.';
const needsModel = () => !viewer.bounds().isEmpty() || 'There’s nothing to show yet.';
const needsPlayer = () => (app().player.status === 'ready' ? true : 'Build the program to play it back.');
const all = (...checks: (() => true | string)[]) => () => {
  for (const check of checks) { const result = check(); if (result !== true) return result; }
  return true as const;
};

const viewCommand = (view: StandardView, label: string, key: string): Command => ({
  id: `view.${view}`, label: `${label} view`, icon: Box, category: 'View', shortcut: key, keys: [key],
  run: () => viewer.setView(view), enabled: needsModel, active: () => useView.getState().view === view,
});

const STYLE_ORDER: DisplayStyle[] = ['shaded-edges', 'shaded', 'hidden-line', 'wireframe', 'xray'];
const styleCommand = (style: DisplayStyle, label: string, description: string): Command => ({
  id: `view.style.${style}`, label, icon: Box, category: 'Display', description,
  run: () => useView.setState({ style }), active: () => useView.getState().style === style,
});

/** Settings → Navigation's "Keep Z up when orbiting", from a key: nothing on screen shows the mode, so it says which is on. */
function toggleKeepZUp() {
  const on = !setting('viewport.lockZUp');
  updateSetting('viewport.lockZUp', on);
  useApp.setState({ toast: { text: on ? 'Z stays up when you orbit' : 'Orbit turns freely again', tone: 'info' } });
}

/** The picked face's bounds (Zoom to selection). */
function selectionBox(): THREE.Box3 | null {
  const { picked, part } = app();
  const mesh = part.mesh;
  if (!picked || !mesh) return null;
  const box = new THREE.Box3(), point = new THREE.Vector3();
  mesh.triangle_faces.forEach((face, t) => {
    if (face !== picked.face) return;
    for (let k = 0; k < 3; k++) { const v = mesh.indices[t * 3 + k] * 3; box.expandByPoint(point.set(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2])); }
  });
  return box.isEmpty() ? null : box;
}

/** Shows the right panel at a tab, or hides it when that tab is already showing. */
function togglePanelTab(tab: 'code' | 'result' | 'gcode') {
  const state = app();
  if (state.panelOpen && state.tab === tab) useApp.setState({ panelOpen: false });
  else useApp.setState({ panelOpen: true, tab });
}

const step = (delta: number) => {
  const source = app().player.source;
  if (!source) return;
  usePlayer.setState((state) => ({ playing: false, position: Math.min(source.motion.count, Math.max(0, Math.floor(state.position) + delta)) }));
};

export const fullscreenAvailable = () => typeof document !== 'undefined' && !!document.fullscreenEnabled;
function toggleFullscreen() {
  if (!fullscreenAvailable()) return;
  const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  request.catch(() => { /* Refused (not a user gesture, or blocked): nothing to do. */ });
}

export const commands: Command[] = [
  // Document
  { id: 'doc.new', label: 'New project', icon: FilePlus2, category: 'Document', shortcut: 'Alt+N', keys: ['alt+n'], description: 'Start a project: a blank program or an example.', run: () => useApp.setState({ dialog: 'new' }) },
  { id: 'doc.open', label: 'Open project…', icon: FolderOpen, category: 'Document', shortcut: 'Mod+O', keys: ['mod+o'], description: 'Switch to another project.', run: () => useApp.setState({ dialog: 'palette', paletteQuery: 'open ' }) },
  { id: 'doc.save', label: 'Save', icon: Save, category: 'Document', shortcut: 'Mod+S', keys: ['mod+s'], description: 'Save every file you changed.', run: () => { void saveAll(); },
    enabled: all(needsProject, () => dirtyFiles().length > 0 || 'Nothing to save.') },
  { id: 'file.goto', label: 'Go to file…', icon: FileSearch, category: 'Document', shortcut: 'Mod+P', keys: ['mod+p'], description: 'Open one of the project’s files in the code editor.',
    run: () => useApp.setState({ panelOpen: true, tab: 'code', switcherOpen: true }), enabled: needsProject },
  { id: 'create.source', label: 'Code editor', icon: Code2, category: 'Create', shortcut: 'Mod+E', keys: ['mod+e'], description: 'Show or hide the project’s code.', run: () => togglePanelTab('code'),
    active: () => app().panelOpen && app().tab === 'code', enabled: needsProject },
  { id: 'create.update', label: 'Build', icon: Hammer, category: 'Create', shortcut: 'Mod+Enter', keys: ['mod+enter'],
    description: 'Save, then have camlib plan every setup, check every move, post, and release the G-code it clears.', run: () => { void startBuild('full'); }, enabled: all(needsProgram, needsIdle) },
  { id: 'create.check', label: 'Check', icon: ListChecks, category: 'Create', description: 'Save, then run the program and describe it (setups, stock, tools, operations): nothing is planned.',
    run: () => { void startBuild('preview'); }, enabled: all(needsProgram, needsIdle) },
  { id: 'create.stop', label: 'Cancel build', icon: Square, category: 'Create', description: 'Stop the build in progress.', run: () => { void cancelBuild(); },
    enabled: () => running(app().build) || 'No build is running.' },
  { id: 'result.show', label: 'Result', icon: ListChecks, category: 'Create', description: 'Show the build’s result: camlib’s verdict for each setup and machine.', run: () => togglePanelTab('result'),
    active: () => app().panelOpen && app().tab === 'result', enabled: needsProject },

  // Simulation
  { id: 'sim.play', label: 'Play / pause', icon: Pause, category: 'Simulation', shortcut: 'Space', keys: ['space'], description: 'Play the posted program on the stock, or pause it.', enabled: needsPlayer,
    run: () => usePlayer.setState((state) => { const count = app().player.source?.motion.count ?? 0; return { playing: !state.playing, position: !state.playing && state.position >= count ? 0 : state.position }; }) },
  { id: 'sim.next', label: 'Next move', icon: StepForward, category: 'Simulation', shortcut: '→', keys: ['arrowright'], run: () => step(1), enabled: needsPlayer },
  { id: 'sim.previous', label: 'Previous move', icon: StepBack, category: 'Simulation', shortcut: '←', keys: ['arrowleft'], run: () => step(-1), enabled: needsPlayer },
  { id: 'sim.start', label: 'Back to the start', icon: SkipBack, category: 'Simulation', run: () => usePlayer.setState({ position: 0, playing: false }), enabled: needsPlayer },
  { id: 'sim.end', label: 'To the end', icon: SkipForward, category: 'Simulation', run: () => usePlayer.setState({ position: app().player.source?.motion.count ?? 0, playing: false }), enabled: needsPlayer },
  { id: 'sim.gcode', label: 'G-code', icon: Code2, category: 'Simulation', description: 'The posted G-code (its tab in the right panel), following playback; a click on a line goes to its move.',
    run: () => togglePanelTab('gcode'), active: () => app().panelOpen && app().tab === 'gcode', enabled: needsProject },
  { id: 'sim.grid', label: 'camlib’s check grid', icon: Grid3x3, category: 'Simulation', description: 'Show the stock camlib checked (its own grid) instead of the fine display stock.',
    run: () => usePlayer.setState((state) => ({ show: { ...state.show, grid: !state.show.grid } })), active: () => usePlayer.getState().show.grid, enabled: needsPlayer },
  { id: 'sim.showPaths', label: 'Show all toolpaths', icon: Eye, category: 'Simulation', description: 'Show again the toolpaths hidden with the eye on an operation’s row in the browser (the playing setup’s).',
    run: () => { const setup = app().player.source?.header.id; if (setup) showAllPaths(setup); },
    enabled: () => { const setup = app().player.source?.header.id; return setup && usePaths.getState().setups[setup]?.hidden.length ? true : 'No toolpath is hidden.'; } },

  // View
  { id: 'inspect.zoomSelection', label: 'Zoom to selection', icon: ScanSearch, category: 'View', shortcut: 'Z', keys: ['z'], description: 'Frame the picked face.',
    run: () => { const box = selectionBox(); if (box) viewer.zoomTo(box); }, enabled: () => !!app().picked || 'Pick a face on the part first.' },
  { id: 'view.fit', label: 'Fit all', icon: Focus, category: 'View', shortcut: 'F', keys: ['f'], run: () => viewer.fit(), enabled: needsModel },
  viewCommand('iso', 'Isometric', '0'),
  viewCommand('front', 'Front', '1'),
  viewCommand('back', 'Back', '2'),
  viewCommand('left', 'Left', '3'),
  viewCommand('right', 'Right', '4'),
  viewCommand('top', 'Top', '5'),
  viewCommand('bottom', 'Bottom', '6'),
  styleCommand('shaded-edges', 'Shaded with edges', 'Solid shading with crisp B-rep edges.'),
  styleCommand('shaded', 'Shaded', 'Solid shading without edges.'),
  styleCommand('hidden-line', 'Hidden line', 'Line drawing: the edges you can see.'),
  styleCommand('wireframe', 'Wireframe', 'All edges, no faces.'),
  styleCommand('xray', 'X-ray', 'Translucent faces reveal what’s inside.'),
  { id: 'view.cycleStyle', label: 'Cycle display style', icon: Box, category: 'Display', shortcut: 'V', keys: ['v'],
    run: () => useView.setState((state) => ({ style: STYLE_ORDER[(STYLE_ORDER.indexOf(state.style) + 1) % STYLE_ORDER.length] })) },
  { id: 'view.projection', label: 'Toggle perspective', icon: Box, category: 'View', shortcut: 'P', keys: ['p'],
    run: () => useView.setState((state) => ({ projection: state.projection === 'orthographic' ? 'perspective' : 'orthographic' })), active: () => useView.getState().projection === 'perspective' },
  { id: 'view.ortho', label: 'Orthographic', icon: Box, category: 'View', run: () => useView.setState({ projection: 'orthographic' }), active: () => useView.getState().projection === 'orthographic' },
  { id: 'view.lockZUp', label: 'Keep Z up when orbiting', icon: Move3d, category: 'View', shortcut: 'U', keys: ['u'],
    description: 'Orbit without rolling or going over the top, with Z always pointing up. Press again to turn freely.', run: toggleKeepZUp, active: () => setting('viewport.lockZUp') },
  { id: 'view.grid', label: 'Toggle grid', icon: Grid3x3, category: 'Display', shortcut: 'G', keys: ['g'], run: () => useView.setState((state) => ({ showGrid: !state.showGrid })), active: () => useView.getState().showGrid },
  { id: 'view.origin', label: 'Toggle origin', icon: Move3d, category: 'Display', shortcut: 'O', keys: ['o'], description: 'The work coordinates’ origin and axes (the G-code’s zero).',
    run: () => useView.setState((state) => ({ showOrigin: !state.showOrigin })), active: () => useView.getState().showOrigin },
  { id: 'view.part', label: 'Show the part during playback', icon: Eye, category: 'Display', run: () => usePlayer.setState((state) => ({ show: { ...state.show, part: !state.show.part } })),
    active: () => usePlayer.getState().show.part },

  // Manufacture (the studio's manufacture/commands.ts): the setup, the shop, every camlib milling operation's form, and
  // generate, simulate and post.
  { id: 'cam.setup.milling', label: 'Setup', icon: SetupIcon as IconType, category: 'Manufacture', run: () => void openSetup(),
    description: 'A new setup: the machine and its tools, the stock, program zero and the checks for 3-axis milling. Operations are then added to it.', enabled: needsProgramFile },
  { id: 'cam.shop', label: 'Shop', icon: Library, category: 'Manufacture', run: () => void revealIn('shop.py', 1, false),
    description: 'Your shop as code (shop.py): machines, controllers, tools, tool setups and fixtures.', enabled: () => (app().project?.shop === 'shop.py' ? true : app().project?.shop ? 'This project uses the projects folder’s shop.py.' : 'The project has no shop.py.') },
  ...OP_SPECS.map((spec): Command => ({
    id: `cam.code.${spec.cls}`, label: spec.label, icon: opIconOf(spec.cls) as IconType, category: 'Manufacture', description: spec.about,
    run: () => void openNewOp(spec.cls), enabled: opReason(spec.cls),
  })),
  { id: 'cam.generate', label: 'Generate toolpaths', short: 'Generate', icon: ToolpathIcon as IconType, category: 'Manufacture', run: () => { void startBuild('full'); },
    description: 'Plan every setup, check every move, post, and release the G-code camlib clears.', enabled: all(needsProgram, needsIdle) },
  { id: 'cam.simulate', label: 'Simulate', icon: SimulateToolIcon as IconType, category: 'Manufacture', run: () => void openPlayer(chosenSetup() ?? ''),
    description: 'Play back the posted program on the stock: the tool, the stock as cut, camlib’s findings.', enabled: () => (playable() ? true : 'Generate the toolpaths first.') },
  { id: 'cam.post', label: 'Post process', short: 'Post', icon: PostIcon as IconType, category: 'Manufacture', run: downloadGcode,
    description: 'Download the machine file camlib released for the selected setup (a refused setup has none).', enabled: () => (releasedFor(chosenSetup()) ? true : 'Nothing released yet: generate the toolpaths (camlib releases the G-code it clears).') },

  // App
  { id: 'app.palette', label: 'Command palette', icon: Keyboard, category: 'App', shortcut: 'Mod+K', keys: ['mod+k'], run: () => useApp.setState((state) => ({ dialog: state.dialog === 'palette' ? null : 'palette', paletteQuery: '' })) },
  { id: 'app.settings', label: 'Settings', icon: Settings, category: 'App', shortcut: 'Mod+,', keys: ['mod+,'], description: 'Navigation: mouse style, orbit, zoom.', run: () => useApp.setState({ dialog: 'settings' }) },
  { id: 'app.shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, category: 'App', shortcut: '?', keys: ['?'], run: () => useApp.setState({ dialog: 'shortcuts' }) },
  { id: 'app.fullscreen', label: 'Toggle full screen', icon: Maximize2, category: 'App', description: 'Fill the screen, like a desktop CAD app. Esc leaves full screen.', run: toggleFullscreen,
    enabled: () => fullscreenAvailable() || 'This browser doesn’t allow full screen here.' },
  { id: 'app.browser', label: 'Toggle browser panel', icon: PanelLeft, category: 'App', shortcut: 'Mod+B', keys: ['mod+b'], description: 'The project’s files and program.',
    run: () => useApp.setState((state) => ({ sidebarOpen: !state.sidebarOpen })), active: () => app().sidebarOpen },
  { id: 'app.dock', label: 'Toggle inspector panel', icon: PanelRight, category: 'App', shortcut: 'Mod+.', keys: ['mod+.'], description: 'The code and the build’s result.',
    run: () => useApp.setState((state) => ({ panelOpen: !state.panelOpen })), active: () => app().panelOpen },
];

const byId = new Map(commands.map((command) => [command.id, command]));
export const command = (id: string) => {
  const found = byId.get(id);
  if (!found) throw new Error(`Unknown command ${id}`);
  return found;
};

export const availability = (cmd: Command): true | string => (cmd.enabled ? cmd.enabled() : true);

export function runCommand(id: string) {
  const cmd = command(id);
  if (availability(cmd) === true) cmd.run();
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const displayShortcut = (shortcut?: string) => shortcut?.replace('Mod', isMac ? '⌘' : 'Ctrl');

/** Normalizes a key event to strings like "mod+s", "shift+h", "alt+1" or "?". */
export function eventKey(event: KeyboardEvent) {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  let key = event.key;
  // Alt changes the produced character on some layouts; use the physical key instead.
  if (event.altKey && /^Digit\d$/.test(event.code)) key = event.code.slice(5);
  if (event.altKey && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  key = key.toLowerCase();
  if (event.shiftKey && (key.length > 1 || /[a-z]/.test(key))) parts.push('shift');
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

/** Runs the command a key event names, when there is one (as the studio's: typing only takes Mod keys). */
export function handleShortcut(event: KeyboardEvent): boolean {
  const key = eventKey(event);
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || !!target.closest('.cm-editor'));
  if (typing && !key.startsWith('mod+')) return false;
  // The editor handled it (Ctrl+S saves, Ctrl+Enter builds).
  if (typing && event.defaultPrevented && target?.closest('.cm-editor')) return false;
  // Space and Enter press a focused button; only the playback takes Space from the canvas and the page.
  const pressable = key === 'space' ? target?.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="slider"]') : null;
  if (pressable && pressable.getAttribute('role') !== 'slider') return false;
  const state = app();
  if (state.dialog && state.dialog !== 'palette' && key !== 'mod+k') return false;
  const cmd = commands.find((candidate) => candidate.keys?.includes(key));
  if (!cmd) return false;
  if (typing && cmd.id === 'create.update' && target?.closest('.cm-editor')) return false;
  // An unavailable Space or arrow keeps its native meaning (scrolling, a focused control).
  if ((key === 'space' || key.startsWith('arrow')) && availability(cmd) !== true) return false;
  event.preventDefault();
  if (availability(cmd) === true) cmd.run();
  return true;
}
