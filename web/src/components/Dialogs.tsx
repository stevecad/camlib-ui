/**
 * The dialogs over everything (as in STEVE Studio): the command palette (Mod+K: every command, the projects and the
 * project's files), the keyboard and mouse shortcuts (?), Settings → Navigation (Mod+,) and a new project (Alt+N).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, FileCode2, FolderOpen, Keyboard, Search, Settings, X } from 'lucide-react';
import { api } from '../api';
import { availability, commands, displayShortcut, type Command } from '../commands';
import { openFile, openProject, refreshProjects, useApp } from '../state';
import { DEFAULTS, resetSettings, updateSetting, useSettings, type Settings as SettingValues } from '../settings';
import { MOUSE_STYLES, mouseStyleInfo, ORBIT_ABOUT } from '../viewport/mouseStyle';

const close = () => useApp.setState({ dialog: null });

function Dialog({ title, icon, width = 520, children, id }: { title: string; icon: ReactNode; width?: number; children: ReactNode; id: string }) {
  return (
    <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="dialog" role="dialog" aria-label={title} style={{ width }} id={id}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
        <div className="dialog-head">{icon}<h2>{title}</h2><button type="button" className="icon-button" aria-label="Close" onClick={close}><X size={14} /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Shortcut({ keys }: { keys: string }) {
  // "Mod+Shift+H" as separate keys; a lone "+" stays a key.
  const parts = keys === '+' ? ['+'] : keys.split('+').filter(Boolean);
  return <span className="shortcut">{parts.map((part) => <kbd key={part}>{part}</kbd>)}</span>;
}

/** Ranks by how directly the query names the item; loose letter matches never outrank real words (the studio's). */
function score(query: string, label: string, extra = ''): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const text = label.toLowerCase();
  if (text === q) return 100;
  if (text.startsWith(q)) return 90;
  if (text.split(/[\s/·.-]+/).some((word) => word.startsWith(q))) return 70;
  if (text.includes(q)) return 50;
  if (extra.toLowerCase().includes(q)) return 25;
  const words = q.split(/\s+/);
  const labelWords = text.split(/[\s/·.-]+/);
  if (words.length > 1 && words.every((word) => labelWords.some((candidate) => candidate.startsWith(word)))) return 40;
  return 0;
}

interface Item { key: string; label: string; meta: string; icon: ReactNode; shortcut?: string; disabled?: string; run: () => void; group: string }

function Palette() {
  const projects = useApp((state) => state.projects);
  const project = useApp((state) => state.project);
  const [search, setSearch] = useState(() => useApp.getState().paletteQuery);
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo<Item[]>(() => {
    const fromCommand = (cmd: Command): Item => {
      const Icon = cmd.icon, available = availability(cmd);
      return { key: cmd.id, label: cmd.label, meta: available === true ? cmd.category : available, icon: <Icon size={16} />, shortcut: available === true ? cmd.shortcut : undefined,
        disabled: available === true ? undefined : available, run: cmd.run, group: cmd.category };
    };
    return [
      ...commands.map(fromCommand),
      ...projects.map((item) => ({ key: `project:${item.name}`, label: `Open ${item.name}`, meta: item.name === project?.name ? 'Project · open' : 'Project', icon: <FolderOpen size={16} />,
        run: () => void openProject(item.name), group: 'Projects' })),
      ...(project?.files ?? []).map((file) => ({ key: `file:${file.name}`, label: file.name, meta: 'Edit file', icon: <FileCode2 size={16} />,
        run: () => { useApp.setState({ panelOpen: true, tab: 'code' }); void openFile(file.name); }, group: 'Files' })),
    ];
  }, [projects, project]);
  const shown = search.trim()
    ? items.map((item) => ({ item, rank: score(search, item.label, `${item.group} ${item.meta}`) + (item.disabled ? 0 : 1) })).filter((entry) => entry.rank > 1)
      .sort((a, b) => b.rank - a.rank).slice(0, 30).map((entry) => entry.item)
    : items;
  useEffect(() => setIndex(0), [search]);
  useEffect(() => { list.current?.querySelector('[data-on]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const runAt = (at: number) => {
    const item = shown[at];
    if (!item || item.disabled) return;
    close();
    requestAnimationFrame(() => item.run());
  };
  let group = '';
  return (
    <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-label="Command palette" id="palette">
        <div className="palette-input">
          <Search size={17} />
          <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Type a command, a project or a file…" aria-label="Search commands"
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
              else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(shown.length - 1, value + 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)); }
              else if (event.key === 'Enter') { event.preventDefault(); runAt(index); }
            }} />
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {!shown.length && <div className="palette-empty">No results for “{search}”.</div>}
          {shown.map((item, at) => {
            const heading = !search.trim() && item.group !== group ? (group = item.group) : null;
            return (
              <div key={item.key}>
                {heading && <div className="palette-group">{heading}</div>}
                <button type="button" className="palette-item" role="option" aria-selected={at === index} data-on={at === index || undefined} disabled={!!item.disabled}
                  onMouseMove={() => setIndex(at)} onClick={() => runAt(at)} data-command={item.key}>
                  {item.icon}<span>{item.label}</span>
                  <span className="palette-meta">{item.disabled ?? item.meta}{item.shortcut && <Shortcut keys={displayShortcut(item.shortcut)!} />}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd><CornerDownLeft size={10} /></kbd> run</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}

const MOUSE = [
  ['Orbit', 'Left drag'], ['Pan', 'Right or middle drag'], ['Zoom to cursor', 'Scroll'], ['Pick a face', 'Click'],
  ['Rotation centre', 'Middle click (SOLIDWORKS style)'],
];

function Shortcuts() {
  // Orbit, pan and zoom follow Settings → Navigation's mouse style (MOUSE has the default's).
  const style = mouseStyleInfo(useSettings((state) => state.values['viewport.mouseStyle'])).mouse;
  const mouse = MOUSE.map(([label, keys]) => [label, style.find(([action]) => action === label)?.[1] ?? keys]);
  const withKeys = commands.filter((cmd) => cmd.shortcut);
  const groups = [...new Set(withKeys.map((cmd) => cmd.category))];
  return (
    <Dialog title="Keyboard and mouse" icon={<Keyboard size={17} />} width={680} id="shortcuts">
      <p className="note">Every command is also in the command palette (<Shortcut keys={displayShortcut('Mod+K')!} />).</p>
      <div className="shortcuts">
        <div className="shortcut-group">
          <h4>Mouse</h4>
          {mouse.map(([label, keys]) => <div key={label} className="shortcut-row"><span>{label}</span><span className="shortcut-text">{keys}</span></div>)}
        </div>
        {groups.map((name) => (
          <div key={name} className="shortcut-group">
            <h4>{name}</h4>
            {withKeys.filter((cmd) => cmd.category === name).map((cmd) => (
              <div key={cmd.id} className="shortcut-row" data-command={cmd.id}><span>{cmd.label}</span><Shortcut keys={displayShortcut(cmd.shortcut)!} /></div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function SettingsDialog() {
  const values = useSettings((state) => state.values);
  const set = <K extends keyof SettingValues>(key: K) => (value: SettingValues[K]) => updateSetting(key, value);
  const changed = (Object.keys(DEFAULTS) as (keyof SettingValues)[]).some((key) => values[key] !== DEFAULTS[key]);
  return (
    <Dialog title="Settings · Navigation" icon={<Settings size={17} />} width={540} id="settings">
      <label className="setting">
        <span><b>Mouse style</b><small>{mouseStyleInfo(values['viewport.mouseStyle']).summary}</small></span>
        <select value={values['viewport.mouseStyle']} onChange={(event) => set('viewport.mouseStyle')(event.target.value as SettingValues['viewport.mouseStyle'])} aria-label="Mouse style">
          {MOUSE_STYLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="setting">
        <span><b>Orbit about</b><small>What a drag turns the view around.</small></span>
        <select value={values['viewport.orbitAbout']} onChange={(event) => set('viewport.orbitAbout')(event.target.value as SettingValues['viewport.orbitAbout'])} aria-label="Orbit about">
          {ORBIT_ABOUT.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="setting">
        <span><b>Keep Z up when orbiting</b><small>No roll, no going over the top (U).</small></span>
        <input type="checkbox" checked={values['viewport.lockZUp']} onChange={(event) => set('viewport.lockZUp')(event.target.checked)} />
      </label>
      <label className="setting">
        <span><b>Zoom to the pointer</b><small>The wheel zooms towards what’s under the pointer.</small></span>
        <input type="checkbox" checked={values['viewport.zoomToCursor']} onChange={(event) => set('viewport.zoomToCursor')(event.target.checked)} />
      </label>
      <label className="setting">
        <span><b>Invert the wheel</b><small>The wheel zooms the other way.</small></span>
        <input type="checkbox" checked={values['viewport.invertWheel']} onChange={(event) => set('viewport.invertWheel')(event.target.checked)} />
      </label>
      <label className="setting">
        <span><b>Orbit speed</b><small>{values['viewport.orbitSpeed'].toFixed(2)}×</small></span>
        <input type="range" min={0.25} max={3} step={0.05} value={values['viewport.orbitSpeed']} onChange={(event) => set('viewport.orbitSpeed')(Number(event.target.value))} />
      </label>
      <label className="setting">
        <span><b>Zoom speed</b><small>{values['viewport.zoomSpeed'].toFixed(2)}×</small></span>
        <input type="range" min={0.25} max={3} step={0.05} value={values['viewport.zoomSpeed']} onChange={(event) => set('viewport.zoomSpeed')(Number(event.target.value))} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="button" disabled={!changed} onClick={resetSettings}>Restore defaults</button>
        <button type="button" className="button primary" onClick={close}>Done</button>
      </div>
    </Dialog>
  );
}

function NewProject() {
  const examples = useApp((state) => state.info?.examples ?? []);
  const [name, setName] = useState('');
  const [example, setExample] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      const project = await api.createProject(name.trim(), example || null);
      await refreshProjects();
      close();
      await openProject(project.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <Dialog title="New project" icon={<FolderOpen size={17} />} width={400} id="new-project">
      <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="bracket" pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*" required /></label>
        <label>Start from
          <select value={example} onChange={(event) => setExample(event.target.value)}>
            <option value="">A blank program</option>
            {examples.map((item) => <option key={item} value={item}>The {item} example</option>)}
          </select>
        </label>
        {error && <p className="note" data-tone="danger">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={close}>Cancel</button>
          <button type="submit" className="button primary" disabled={!name.trim()}>Create</button>
        </div>
      </form>
    </Dialog>
  );
}

export default function Dialogs() {
  const dialog = useApp((state) => state.dialog);
  if (dialog === 'palette') return <Palette />;
  if (dialog === 'shortcuts') return <Shortcuts />;
  if (dialog === 'settings') return <SettingsDialog />;
  if (dialog === 'new') return <NewProject />;
  return null;
}
