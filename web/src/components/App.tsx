/**
 * The layout: the top bar (project, the command palette, Check and Build), the project's files and program, the 3D view
 * with its player and the posted G-code, and the code and result panel. Keys go through the command table
 * (commands.ts), as in STEVE Studio.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, Code2, FileCode, FolderPlus, Hammer, ListChecks, PanelRightClose, ScanSearch, Search, Square, X } from 'lucide-react';
import { boot, cancelBuild, openProject, running, startBuild, useApp, usePlayer } from '../state';
import { displayShortcut, handleShortcut } from '../commands';
import Sidebar from './Sidebar';
import Viewport from './Viewport';
import Player, { GcodePanel } from './Player';
import dock from '../shell/Dock.module.css';
import CodePanel from './CodePanel';
import ResultPanel, { outcome } from './ResultPanel';
import Dialogs, { Shortcut } from './Dialogs';
import PanelRail from './PanelRail';
import Ribbon from './Ribbon';
import ProgramForm from './ProgramForm';
import { closeForm, startPicking, useEditor } from '../cam/programEditor';

function TopBar() {
  const info = useApp((state) => state.info);
  const projects = useApp((state) => state.projects);
  const project = useApp((state) => state.project);
  const build = useApp((state) => state.build);
  const busy = useApp((state) => state.busy);
  const active = running(build);
  return (
    <header className="topbar">
      <div className="brand"><ScanSearch size={17} /><b>camlib</b><span>ui</span></div>
      <select className="project-pick" aria-label="Project" value={project?.name ?? ''} onChange={(event) => void openProject(event.target.value)}>
        {!project && <option value="">No project</option>}
        {projects.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>
      <button type="button" className="icon-button" title="New project (Alt+N)" aria-label="New project" onClick={() => useApp.setState({ dialog: 'new' })}><FolderPlus size={15} /></button>
      <button type="button" className="palette-button" id="palette-button" title="Command palette" onClick={() => useApp.setState({ dialog: 'palette', paletteQuery: '' })}>
        <Search size={13} /><span>Commands, projects, files…</span><Shortcut keys={displayShortcut('Mod+K')!} />
      </button>
      <span className="spacer" />
      {build && <span className="build-state" data-status={build.status}>{build.mode === 'full' ? 'Build' : 'Check'}: {outcome(build)}</span>}
      {active
        ? <button type="button" className="button small" id="cancel-build" onClick={() => void cancelBuild()}><Square size={12} />Cancel</button>
        : <>
          <button type="button" className="button small" id="check" disabled={!project?.program || !!busy} title="Run the program and describe it: setups, stock, tools, operations (nothing is planned)"
            onClick={() => void startBuild('preview')}><ListChecks size={13} />Check</button>
          <button type="button" className="button primary small" id="build" disabled={!project?.program || !!busy} title={`Plan every setup, check every move, post, and release the G-code camlib clears (${displayShortcut('Mod+Enter')})`}
            onClick={() => void startBuild('full')}><Hammer size={13} />Build</button>
        </>}
      <span className="camlib-version" title={info ? `camlib ${info.camlib ?? 'not installed'} · posts: ${info.posts ?? 'none (LinuxCNC only)'} · projects: ${info.projects}` : ''}>
        {info?.camlib ? `camlib ${info.camlib}` : 'camlib —'}
        {info && !info.posts_found && <AlertTriangle size={12} />}
      </span>
    </header>
  );
}

/** The right panel's width, dragged at its left edge (kept between visits). */
function useWidth(key: string, initial: number): [number, (event: ReactPointerEvent) => void] {
  const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || initial);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => { localStorage.setItem(key, String(Math.round(width))); }, [key, width]);
  const start = (event: ReactPointerEvent) => {
    drag.current = { x: event.clientX, width };
    const move = (e: PointerEvent) => { if (drag.current) setWidth(Math.min(window.innerWidth - 420, Math.max(320, drag.current.width + drag.current.x - e.clientX))); };
    const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return [width, start];
}

function RightPanel() {
  const tab = useApp((state) => state.tab);
  const build = useApp((state) => state.build);
  const form = useEditor((state) => !!state.form);
  const [width, start] = useWidth('camlib-ui:dock-width', 384);
  // An operation's or setup's form takes the panel while it's open (as the studio's feature dialogs do).
  if (form) {
    return (
      <section className="right-panel" style={{ width }} id="right-panel">
        <div className="resizer" onPointerDown={start} role="separator" aria-orientation="vertical" aria-label="Resize the panel" />
        <ProgramForm />
      </section>
    );
  }
  const tone = !build || running(build) ? null : build.status !== 'done' || build.program_error ? 'failed' : build.mode === 'full' ? ((build.refused ?? 0) > 0 ? 'failed' : 'passed') : null;
  const tabs: { id: 'code' | 'result' | 'gcode'; label: string; icon: typeof Code2; title: string }[] = [
    { id: 'code', label: 'Code', icon: Code2, title: `The project's code (${displayShortcut('Mod+E')})` },
    { id: 'result', label: 'Result', icon: ListChecks, title: 'camlib’s verdict for each setup and machine' },
    { id: 'gcode', label: 'G-code', icon: FileCode, title: 'The posted G-code, following playback' },
  ];
  return (
    <section className="right-panel" style={{ width }} id="right-panel">
      <div className="resizer" onPointerDown={start} role="separator" aria-orientation="vertical" aria-label="Resize the panel" />
      <div className={dock.tabs} role="tablist" aria-label="Inspector panels">
        {tabs.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button key={item.id} type="button" role="tab" aria-selected={active} data-tab={item.id} className={dock.tab} data-active={active} title={item.title} onClick={() => useApp.setState({ tab: item.id })}>
              {active && <span className={dock.tabThumb} />}
              <Icon size={14} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === 'result' && tone && <i className="dot" data-tone={tone} />}
              {item.id === 'result' && running(build) && <span className="spinner" />}
            </button>
          );
        })}
        <span className={dock.close}>
          <button type="button" className="icon-button small" title={`Hide panel (${displayShortcut('Mod+.')})`} aria-label="Hide the panel" onClick={() => useApp.setState({ panelOpen: false })}><PanelRightClose size={14} /></button>
        </span>
      </div>
      <div className="tab-body" hidden={tab !== 'code'}><CodePanel /></div>
      <div className="tab-body scroll" hidden={tab !== 'result'}><ResultPanel /></div>
      <div className="tab-body" hidden={tab !== 'gcode'}><GcodePanel /></div>
    </section>
  );
}

function Toast() {
  const current = useApp((state) => state.toast);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => useApp.setState({ toast: null }), current.tone === 'error' || current.action ? 9000 : 3000);
    return () => clearTimeout(timer);
  }, [current]);
  if (!current) return null;
  return (
    <div className="toast" data-tone={current.tone} role={current.tone === 'error' ? 'alert' : 'status'}>
      <span>{current.text}</span>
      {current.action && <button type="button" className="button small" id="toast-action" onClick={() => { useApp.setState({ toast: null }); current.action!.run(); }}>{current.action.label}</button>}
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => useApp.setState({ toast: null })}><X size={13} /></button>
    </div>
  );
}

/** Esc, as in the studio: closes what's open, else stops playing, else clears the pick. */
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest('.cm-editor, input, textarea, select')) return false;
  const state = useApp.getState();
  if (state.dialog) { useApp.setState({ dialog: null }); return true; }
  const editor = useEditor.getState();
  if (editor.picking) { startPicking(null); return true; }
  if (editor.form) { closeForm(); return true; }
  if (usePlayer.getState().playing) { usePlayer.setState({ playing: false }); return true; }
  if (state.picked) { useApp.setState({ picked: null }); return true; }
  return false;
}

export default function App() {
  const project = useApp((state) => state.project);
  const projects = useApp((state) => state.projects);
  const sidebarOpen = useApp((state) => state.sidebarOpen);
  const panelOpen = useApp((state) => state.panelOpen);
  useEffect(() => { void boot(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (escape(event)) { event.preventDefault(); return; }
      handleShortcut(event);
    };
    // Leaving with unsaved changes asks first.
    const onLeave = (event: BeforeUnloadEvent) => {
      const files = Object.values(useApp.getState().files);
      if (files.some((file) => file.text !== file.saved)) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave); };
  }, []);
  useEffect(() => { document.title = project ? `${project.name} · camlib-ui` : 'camlib-ui'; }, [project]);
  return (
    <div className="app">
      <TopBar />
      <Ribbon />
      <main className="body">
        {sidebarOpen ? <Sidebar /> : <PanelRail side="left" />}
        <section className="center">
          <div className="stage">
            <Viewport />
            <Player />
          </div>
          {!project && projects.length === 0 && <div className="viewport-note">No projects yet: make one with the folder button.</div>}
        </section>
        {panelOpen ? <RightPanel /> : <PanelRail side="right" />}
      </main>
      <Dialogs />
      <Toast />
    </div>
  );
}
