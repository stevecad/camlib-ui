/**
 * The project's code (from STEVE Studio's source panel): where you are as a breadcrumb, `project › file ▾`, whose menu
 * lists the project's files by what they are (the program, the part, the shop, helpers, other files), with search and
 * the keyboard (Ctrl/Cmd+P opens it); new file, upload and delete are in its footer. Save, and save-and-build.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, ChevronDown, ChevronRight, FileCode, FileCog, FilePlus2, FileText, FileUp, Save, Search, Trash2, Wrench } from 'lucide-react';
import { deleteFile, editFile, newFile, openFile, saveAll, startBuild, uploadFile, useApp } from '../state';
import { displayShortcut } from '../commands';
import Editor from './Editor';

type Group = 'Program' | 'Part' | 'Shop' | 'Helpers' | 'Other';
const ORDER: Group[] = ['Program', 'Part', 'Shop', 'Helpers', 'Other'];
const ICONS: Record<Group, typeof FileCode> = { Program: FileCode, Part: Box, Shop: Wrench, Helpers: FileCog, Other: FileText };
/** The files the project can't do without: kept out of delete's reach here (the files list's own owner, the browser, can't either). */
const CORE = new Set(['program.py', 'shop.py']);

function groupOf(name: string, part: string | null): Group {
  if (name === 'program.py') return 'Program';
  if (name === part) return 'Part';
  if (name === 'shop.py') return 'Shop';
  return name.endsWith('.py') ? 'Helpers' : 'Other';
}

function FileSwitcher() {
  const project = useApp((state) => state.project);
  const active = useApp((state) => state.active);
  const open = useApp((state) => state.switcherOpen);
  const files = useApp((state) => state.files);
  const setOpen = (value: boolean) => useApp.setState({ switcherOpen: value });
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => (project?.files ?? [])
    .map((file) => ({ name: file.name, group: groupOf(file.name, project?.part ?? null) }))
    .sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || a.name.localeCompare(b.name)), [project]);
  const shown = entries.filter((entry) => !query.trim() || entry.name.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    if (!open) return;
    setQuery(''); setAdding(null);
    setIndex(Math.max(0, entries.findIndex((entry) => entry.name === active)));
    setTimeout(() => input.current?.focus(), 0);
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setIndex((at) => Math.min(at, Math.max(0, shown.length - 1))), [shown.length]);
  if (!project) return null;
  const choose = (name: string) => { void openFile(name); setOpen(false); };
  const commit = () => {
    const name = (adding ?? '').trim();
    setAdding(null);
    if (name) { void newFile(name.includes('.') ? name : `${name}.py`); setOpen(false); }
  };
  const Icon = ICONS[groupOf(active ?? '', project.part)];
  const dirty = active ? files[active] && files[active].text !== files[active].saved : false;
  return (
    <div className="crumbs" id="source-breadcrumb" ref={box}>
      <span className="crumb-doc" title={project.name}>{project.name}</span>
      <ChevronRight size={12} className="crumb-sep" />
      <button type="button" className="crumb-file" id="source-file" aria-haspopup="listbox" aria-expanded={open} data-file={active ?? undefined}
        title={`${active ?? 'No file'} · Go to file (${displayShortcut('Mod+P')})`} onClick={() => setOpen(!open)}>
        <Icon size={12} /><span>{active ?? 'Choose a file'}</span>{dirty && <i className="dirty">●</i>}<ChevronDown size={12} />
      </button>
      {open && (
        <div className="file-popover" role="dialog" aria-label="Go to file" id="file-switcher"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
          <label className="file-search">
            <Search size={13} />
            <input ref={input} value={query} placeholder="Go to file…" aria-label="Search files" spellCheck={false}
              onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((at) => Math.min(shown.length - 1, at + 1)); }
                if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((at) => Math.max(0, at - 1)); }
                if (event.key === 'Enter' && shown[index]) { event.preventDefault(); choose(shown[index].name); }
              }} />
          </label>
          <div className="file-list" role="listbox" aria-label="Project files">
            {ORDER.map((group) => {
              const items = shown.filter((entry) => entry.group === group);
              if (!items.length) return null;
              return (
                <div key={group} className="file-group">
                  <div className="file-group-title">{group}</div>
                  {items.map((entry) => {
                    const at = shown.indexOf(entry);
                    const ItemIcon = ICONS[entry.group];
                    const changed = files[entry.name] && files[entry.name].text !== files[entry.name].saved;
                    return (
                      <div key={entry.name} className="file-option" role="option" aria-selected={at === index} data-file={entry.name}
                        data-active={at === index || undefined} data-current={entry.name === active || undefined} onMouseEnter={() => setIndex(at)} onClick={() => choose(entry.name)}>
                        <ItemIcon size={13} /><span className="file-option-label">{entry.name}</span>{changed && <i className="dirty">●</i>}
                        {!CORE.has(entry.name) && (
                          <button type="button" className="file-delete" title={`Delete ${entry.name}`} aria-label={`Delete ${entry.name}`}
                            onClick={(event) => { event.stopPropagation(); void deleteFile(entry.name); }}><Trash2 size={12} /></button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {!shown.length && <div className="file-empty">No file matches “{query}”.</div>}
          </div>
          <div className="file-footer">
            {adding === null ? <>
              <button type="button" className="add-file" id="new-file" onClick={() => setAdding('')}><FilePlus2 size={12} />New file</button>
              <button type="button" className="add-file" id="upload-file" title="Upload a file: a STEP file or CadQuery .py named part.* becomes the part"
                onClick={() => upload.current?.click()}><FileUp size={12} />Upload…</button>
              <input ref={upload} type="file" hidden accept=".py,.step,.stp,.txt,.md,.json" onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) { void uploadFile(file); setOpen(false); }
              }} />
              <span className="file-hint">↑↓ choose · ↵ open</span>
            </> : (
              <span className="new-file">
                <input autoFocus value={adding} placeholder="helpers.py" aria-label="New file name" spellCheck={false}
                  onChange={(event) => setAdding(event.target.value)} onBlur={commit}
                  onKeyDown={(event) => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') { event.stopPropagation(); setAdding(null); } }} />
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CodePanel() {
  const files = useApp((state) => state.files);
  const active = useApp((state) => state.active);
  const reveal = useApp((state) => state.reveal);
  const file = active ? files[active] : null;
  const dirty = Object.values(files).some((item) => item.text !== item.saved);
  return (
    <div className="code-panel">
      <div className="code-head">
        <FileSwitcher />
        <span className="spacer" />
        <button type="button" className="button small" disabled={!dirty} title={`Save every changed file (${displayShortcut('Mod+S')})`} onClick={() => void saveAll()}><Save size={13} />Save</button>
      </div>
      {file && active ? (
        file.loading ? <div className="panel-note">Reading {active}…</div>
          : file.error ? <div className="panel-note" data-tone="danger">{file.error}</div>
            : <Editor key={active} value={file.text} python={active.endsWith('.py')} onChange={(text) => editFile(active, text)}
                onSave={() => void saveAll()} onBuild={() => void startBuild('full')}
                reveal={reveal && reveal.file === active ? { line: reveal.line, nonce: reveal.nonce, error: reveal.error } : null} />
      ) : <div className="panel-note">Choose a file from the breadcrumb above ({displayShortcut('Mod+P')}).</div>}
      <div className="code-foot"><kbd>{displayShortcut('Mod')}</kbd>+<kbd>S</kbd> save · <kbd>{displayShortcut('Mod')}</kbd>+<kbd>Enter</kbd> save and build · <kbd>{displayShortcut('Mod')}</kbd>+<kbd>P</kbd> go to file</div>
    </div>
  );
}
