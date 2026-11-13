/**
 * The left panel: the model browser (from STEVE Studio's LeftPanel, Browser and manufacture SetupTree). The project,
 * its Origin, its part (Bodies), the fixtures the program places, then the program's Setups, each with its operations
 * in the order they run and its verdict in a word. Click selects (an operation plays from its start), double-click
 * shows its definition in the code, right-click has the rest. Collapse all and hide (Ctrl+B) are in the tab row.
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import * as THREE from 'three';
import {
  ArrowDown, ArrowUp, Box, ChevronsDownUp, Code2, Copy, Download, Eye, EyeOff, Focus, Hammer, Layers, ListChecks, ListTree, PanelLeftClose, Pencil, Play, Plus,
  ShieldAlert, Trash2, Upload, Wrench,
} from 'lucide-react';
import { openPlayer, revealIn, running, showAllPaths, soloPath, startBuild, togglePath, toggleSetupPaths, useApp, usePaths, usePlayer, uploadFile } from '../state';
import { hiddenCount, pathHidden, setupState } from '../cam/pathVisibility';
import { deleteProgramOp, duplicateProgramOp, moveProgramOp, openEditOp, openNewOp, openSetup, showInCode, useProgram } from '../cam/programEditor';
import { availableSpecs } from '../cam/opSpecs';
import type { CamOp, CamSetup } from '../cam/pyCode';
import { displayShortcut } from '../commands';
import { OpIcon, OriginIcon, SetupIcon } from '../icons';
import { useView, viewer } from '../viewport/viewer';
import type { OperationSummary, SceneBody, SetupDescription } from '../api';
import TreeRow, { type Entry, type Line, type TreeRowProps } from './TreeRow';
import styles from '../shell/Browser.module.css';
import dock from '../shell/Dock.module.css';
import { usePanelWidth } from '../shell/panels';
import { clock } from './Player';
import { treeState } from '../cam/progress';

const I = { size: 15 };
const num = (value: number | null | undefined, digits = 2) => (value == null ? '—' : Number(value.toFixed(digits)).toLocaleString());

/** Which groups are open, by handle (kept while the project is open; Collapse all closes them). */
const useOpen = create<Record<string, boolean>>(() => ({}));
const useGroupOpen = (item: string, initial: boolean): [boolean, (open: boolean) => void] => {
  const open = useOpen((state) => state[item]) ?? initial;
  return [open, (value) => useOpen.setState({ [item]: value })];
};
const collapseAll = () => {
  const closed: Record<string, boolean> = {};
  for (const handle of ['group:origin', 'group:bodies', 'group:fixtures', 'group:setups']) closed[handle] = false;
  useOpen.setState(closed);
};

const select = (handle: string | null) => useApp.setState({ selected: handle });

/** A group: its label folds it, unless it has its own `onClick` (then only the chevron does). */
function BrowserGroup({ title, icon, children, actions, defaultOpen = true, count, depth = 0, menu, item, tooltip }: {
  title: string; icon: ReactNode; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean; count?: number; depth?: number;
  menu?: () => Line[]; item: string; tooltip?: string;
}) {
  const [open, setOpen] = useGroupOpen(item, defaultOpen);
  return (
    <div className={styles.group}>
      <TreeRow depth={depth} icon={icon} label={<span className={styles.groupLabel}>{title}</span>} meta={count} expanded={open} onToggle={() => setOpen(!open)}
        onClick={() => setOpen(!open)} title={tooltip} actions={actions} menu={menu} item={item} />
      {open && children}
    </div>
  );
}

/**
 * A row's eye. `mixed`: some of what it stands for is hidden (a setup with some toolpaths hidden). `onAlt`: what an
 * Alt-click does instead (an operation: show only its toolpath). `hint`: more for the tooltip.
 */
function EyeButton({ shown, name, onToggle, mixed, onAlt, hint, label }: {
  shown: boolean; name: string; onToggle: () => void; mixed?: boolean; onAlt?: () => void; hint?: string; label?: string;
}) {
  const says = label ?? `${shown ? 'Hide' : 'Show'} ${name}`;
  return (
    <button type="button" className={styles.eye} data-hidden={(!shown && !mixed) || undefined} data-mixed={mixed || undefined} aria-label={says}
      aria-pressed={mixed ? 'mixed' : shown} title={hint ? `${says}\n${hint}` : says} onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); if (event.altKey && onAlt) onAlt(); else onToggle(); }}>
      {shown || mixed ? <Eye size={13} /> : <EyeOff size={13} />}
    </button>
  );
}

/** What hiding a toolpath does not do, for the tooltips. */
const STILL_RUNS = 'Only its lines in the view: the playback, the tool and the stock still run every operation.';

function OriginGroup() {
  const show = useView((state) => state.showOrigin);
  const toggle = () => useView.setState({ showOrigin: !show });
  return (
    <BrowserGroup title="Origin" icon={<OriginIcon {...I} />} defaultOpen={false} depth={1} item="group:origin" tooltip="The work coordinates’ zero: where the G-code’s X0 Y0 Z0 is"
      actions={<EyeButton shown={show} name="origin" onToggle={toggle} />}
      menu={() => [{ label: show ? 'Hide origin' : 'Show origin', icon: show ? <EyeOff {...I} /> : <Eye {...I} />, shortcut: 'O', run: toggle }]}>
      {([['XY', '#5aa9ff'], ['XZ', '#7ed47c'], ['YZ', '#ff6b6b']] as const).map(([plane, color]) => (
        <TreeRow key={plane} depth={2} icon={<span className={styles.planeSwatch} style={{ borderColor: color, background: `${color}22` }} />} label={`${plane} plane`}
          dimmed={!show} onClick={toggle} item={`origin:${plane}`} />
      ))}
    </BrowserGroup>
  );
}

function partBox() {
  const mesh = useApp.getState().part.mesh;
  return mesh ? new THREE.Box3(new THREE.Vector3(...mesh.bounds.min), new THREE.Vector3(...mesh.bounds.max)) : null;
}

function BodiesGroup() {
  const project = useApp((state) => state.project);
  const part = useApp((state) => state.part);
  const selected = useApp((state) => state.selected);
  const hidden = useView((state) => state.partHidden);
  const toggle = () => useView.setState({ partHidden: !hidden });
  const zoom = () => { const box = partBox(); if (box) viewer.zoomTo(box); };
  const pickUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.step,.stp,.py';
    input.onchange = () => {
      const file = input.files?.[0];
      const suffix = file?.name.toLowerCase().match(/\.(step|stp|py)$/)?.[1];
      if (file && suffix) void uploadFile(file, `part.${suffix}`);
    };
    input.click();
  };
  const name = project?.part ?? null;
  const size = part.mesh ? part.mesh.bounds.max.map((v, i) => num(v - part.mesh!.bounds.min[i], 1)).join(' × ') : null;
  return (
    <BrowserGroup title="Bodies" icon={<Layers {...I} />} count={name ? 1 : 0} depth={1} item="group:bodies"
      menu={() => [{ label: name ? 'Replace the part…' : 'Upload a part…', icon: <Upload {...I} />, run: pickUpload }]}>
      {name ? (
        <TreeRow depth={2} icon={<Box {...I} />} label={name.replace(/\.(step|stp|py)$/i, '')} item="body:part" selected={selected === 'body:part'} dimmed={hidden}
          meta={part.status === 'loading' ? <span className={styles.metaText}>reading…</span> : part.status === 'error' ? <span className={styles.metaText} data-tone="danger">error</span> : undefined}
          title={part.status === 'error' ? `${name}: ${part.error}` : `${name}${size ? ` · ${size} mm` : ''} · ${part.mesh?.faces.length ?? 0} faces. Double-click to zoom to it.`}
          error={part.status === 'error'} onClick={() => select('body:part')} onDoubleClick={zoom} onContextSelect={() => select('body:part')}
          actions={<EyeButton shown={!hidden} name="the part" onToggle={toggle} />}
          menu={() => [
            { label: 'Zoom to it', icon: <Focus {...I} />, reason: part.mesh ? null : 'The part isn’t read yet.', run: zoom },
            { label: hidden ? 'Show' : 'Hide', icon: hidden ? <Eye {...I} /> : <EyeOff {...I} />, run: toggle },
            'sep',
            { label: `Edit ${name}`, icon: <Code2 {...I} />, reason: name.endsWith('.py') ? null : 'A STEP file isn’t edited here.', run: () => void revealIn(name, 1, false) },
            { label: 'Replace the part…', icon: <Upload {...I} />, run: pickUpload },
          ]} />
      ) : (
        <TreeRow depth={2} icon={<Box {...I} />} label={<span className={styles.metaText}>No part yet</span>} item="body:none" onClick={pickUpload}
          title="Upload a STEP file, or write a CadQuery part.py: the program imports it with “from links import part”" />
      )}
    </BrowserGroup>
  );
}

function bodyBox(body: SceneBody) {
  const box = new THREE.Box3();
  for (const outline of body.outlines) for (const [x, y] of outline) {
    box.expandByPoint(new THREE.Vector3(x, y, body.z_min_mm));
    box.expandByPoint(new THREE.Vector3(x, y, body.z_max_mm));
  }
  return box;
}

function FixturesGroup({ setup }: { setup: SetupDescription | null }) {
  const selected = useApp((state) => state.selected);
  const shown = usePlayer((state) => state.show.fixtures);
  const bodies = setup?.machines[0]?.scene.bodies ?? [];
  if (!bodies.length) return null;
  const toggle = () => usePlayer.setState((state) => ({ show: { ...state.show, fixtures: !state.show.fixtures } }));
  return (
    <BrowserGroup title="Fixtures" icon={<Wrench {...I} />} count={bodies.length} depth={1} item="group:fixtures"
      tooltip="What the program places on the table: every move is checked against these"
      actions={<EyeButton shown={shown} name="fixtures" onToggle={toggle} />}
      menu={() => [{ label: shown ? 'Hide fixtures' : 'Show fixtures', icon: shown ? <EyeOff {...I} /> : <Eye {...I} />, run: toggle }]}>
      {bodies.map((body) => {
        const handle = `fixture:${body.id}`;
        const zoom = () => viewer.zoomTo(bodyBox(body));
        return (
          <TreeRow key={body.id} depth={2} icon={body.role === 'fixture' ? <Wrench size={14} /> : <ShieldAlert size={14} />} label={body.id} item={handle}
            meta={body.role === 'fixture' ? undefined : <span className={styles.metaText}>protected</span>} dimmed={!shown} selected={selected === handle}
            title={`${body.id}: ${body.role === 'fixture' ? 'a fixture' : 'protected: no move may touch it'}, Z ${num(body.z_min_mm)} to ${num(body.z_max_mm)} mm. Double-click to zoom to it.`}
            onClick={() => select(handle)} onDoubleClick={zoom} onContextSelect={() => select(handle)}
            menu={() => [{ label: 'Zoom to it', icon: <Focus {...I} />, run: zoom }]} />
        );
      })}
    </BrowserGroup>
  );
}

/**
 * A setup's verdict in a word: building, not built, released, refused (camlib's, for every machine), or changed
 * (program.py was saved after the build shown: build it again to see the verdict of what's there now).
 */
function setupStatus(setupId: string): { s: string; label: string; title?: string } {
  const { build, project } = useApp.getState();
  if (running(build)) return { s: 'running', label: build!.mode === 'full' ? 'building' : 'checking' };
  const programs = build?.mode === 'full' && build.status === 'done' ? (build.metadata?.programs ?? []).filter((item) => item.setup === setupId) : [];
  if (!programs.length) return { s: 'none', label: 'not built' };
  const saved = project?.files.find((file) => file.name === 'program.py')?.modified ?? 0;
  if (build && saved > build.created + 1) return { s: 'changed', label: 'changed', title: 'program.py changed since this build: build it again for its verdict.' };
  return programs.every((item) => item.artifact) ? { s: 'released', label: 'released' } : { s: 'refused', label: 'refused' };
}

/** A setup as the browser shows it: from program.py's code (the forms edit it), else from the last build's description (read only). */
interface SetupView { id: string; code: CamSetup | null; described: SetupDescription | null; ops: { id: string; cls: string | null; kind: string | null; op: CamOp | null; summary: OperationSummary | null }[] }

const addLines = (setupId: string, group: '2D' | 'Holes' | '3D' | 'Turning'): Entry[] => availableSpecs().filter((spec) => spec.group === group)
  .map((spec) => ({ label: spec.label, icon: <OpIcon kind={spec.cls} size={15} />, title: spec.about, run: () => { select(`setup:${setupId}`); void openNewOp(spec.cls, setupId); } }));

const downloadLines = (setupId: string): Line[] => {
  const build = useApp.getState().build;
  const released = build?.mode === 'full' ? (build.metadata?.setups?.find((item) => item.id === setupId)?.machines ?? []).filter((machine) => machine.gcode) : [];
  return released.map((machine): Line => ({
    label: released.length > 1 ? `Download G-code (${machine.machine})` : 'Download G-code', icon: <Download {...I} />,
    run: () => { const a = document.createElement('a'); a.href = build!.files[machine.gcode!]; a.download = `${build!.metadata?.program.id ?? 'program'}-${setupId}-${machine.machine}.nc`; a.click(); },
  }));
};

/** Delete, F2 and Ctrl/Cmd+D on a selected operation's row (as the studio's tree). */
const rowKeys = (actions: { remove: () => void; edit: () => void; duplicate: () => void }) => (event: KeyboardEvent<HTMLButtonElement>) => {
  if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) { event.preventDefault(); actions.remove(); }
  else if (event.key === 'F2') { event.preventDefault(); actions.edit(); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); event.stopPropagation(); actions.duplicate(); }
};

/** `locked`: why the forms can't change this setup (null: they can). */
function SetupRows({ view, locked }: { view: SetupView; locked: string | null }) {
  const selected = useApp((state) => state.selected);
  const build = useApp((state) => state.build);
  const player = useApp((state) => state.player);
  useApp((state) => state.busy);  // setupStatus reads it: re-render when a build starts or ends.
  useApp((state) => state.project?.files);
  const [drop, setDrop] = useState<{ op: string; at: 'before' | 'after' } | null>(null);
  const handle = `setup:${view.id}`;
  const status = setupStatus(view.id);
  const stats = useMemo(() => new Map((build?.metadata?.setups?.find((item) => item.id === view.id)?.operations ?? []).map((op) => [op.id, op])), [build, view.id]);
  const playable = !!build?.files['cam-playback.bin'] && !!build.metadata?.setups?.some((item) => item.id === view.id);
  const playing = player.status === 'ready' && player.source?.header.id === view.id ? player.source : null;
  const play = () => void openPlayer(view.id);
  const stock = view.described?.stock;
  const lathe = view.code?.turning ?? view.described?.process === 'turning';
  // The operations with a toolpath to show: the ones the build shown planned (the tree may be ahead of it).
  const built = useMemo(() => (playable ? [...stats.keys()] : []), [playable, stats]);
  const paths = usePaths((state) => state.setups[view.id]);
  const pathState = setupState(paths, built);
  const hiddenPaths = hiddenCount(paths, built);
  const togglePaths = () => toggleSetupPaths(view.id, built);
  const lines = (): Line[] => [
    { label: 'Edit setup', icon: <Pencil {...I} />, reason: locked, run: () => void openSetup(view.id) },
    // A lathe setup takes camlib's turning operations, any other its milling ones.
    ...(lathe
      ? [{ label: 'Add turning operation', icon: <Plus {...I} />, id: 'add-turning', reason: locked, items: addLines(view.id, 'Turning') }]
      : [{ label: 'Add 2D operation', icon: <Plus {...I} />, id: 'add-2d', reason: locked, items: addLines(view.id, '2D') },
        { label: 'Add hole operation', icon: <Plus {...I} />, id: 'add-holes', reason: locked, items: addLines(view.id, 'Holes') },
        { label: 'Add 3D operation', icon: <Plus {...I} />, id: 'add-3d', reason: locked, items: addLines(view.id, '3D') }]),
    'sep',
    { label: 'Build', icon: <Hammer {...I} />, shortcut: displayShortcut('Mod+Enter'), reason: useApp.getState().busy ? 'A build is running.' : null, run: () => void startBuild('full') },
    { label: 'Simulate this setup', icon: <Play {...I} />, reason: playable ? null : 'Build the program first.', run: play },
    ...downloadLines(view.id),
    { label: 'Edit code', icon: <Code2 {...I} />, run: () => void showInCode(view.id) },
    'sep',
    pathState === 'shown'
      ? { label: 'Hide all toolpaths', icon: <EyeOff {...I} />, reason: built.length ? null : 'Build the program first.', run: togglePaths }
      : { label: 'Show all toolpaths', icon: <Eye {...I} />, run: () => showAllPaths(view.id) },
    'sep',
    { label: 'New setup', icon: <SetupIcon {...I} />, reason: locked, run: () => void openSetup() },
  ];
  const ids = view.ops.map((op) => op.id);
  return (
    <div data-setup-row={view.id}>
      <TreeRow depth={1} icon={<SetupIcon size={14} />} label={view.id} item={handle} selected={selected === handle}
        meta={<span className={styles.status} data-status={status.s} title={status.title ?? status.label}>{status.label}</span>}
        title={[
          stock?.kind === 'turned' ? `Bar ⌀ ${num(stock.outer_radius_mm * 2)} × ${num(stock.z_max_mm - stock.z_min_mm)} mm${stock.bore_radius_mm ? `, bored ⌀ ${num(stock.bore_radius_mm * 2)}` : ''}, checked in ${num(stock.cell_mm, 3)} mm bins along Z`
            : stock ? `Stock ${stock.max_mm.map((v, i) => num(v - stock.min_mm[i])).join(' × ')} mm on a ${num(stock.cell_size_mm, 3)} mm check grid` : null,
          ...(view.described?.machines ?? []).map((machine) => `${machine.machine} · ${machine.post} post`),
          `${view.ops.length} operations. Double-click to edit it; right-click to add an operation.`,
        ].filter(Boolean).join('\n')}
        onClick={() => { select(handle); if (playable && !playing) play(); }} onDoubleClick={() => { if (locked) void showInCode(view.id); else void openSetup(view.id); }}
        onContextSelect={() => select(handle)} menu={lines}
        actions={built.length > 0 && (
          <EyeButton shown={pathState === 'shown'} mixed={pathState === 'mixed'} name={`the toolpaths of ${view.id}`} onToggle={togglePaths}
            label={`${pathState === 'shown' ? 'Hide' : 'Show'} all the toolpaths of ${view.id}`}
            hint={`${pathState === 'mixed' ? `${hiddenPaths} of ${built.length} are hidden. ` : pathState === 'hidden' ? 'All are hidden. ' : ''}${STILL_RUNS}`} />
        )} />
      {view.ops.map((op, index) => (
        <OperationRow key={`${op.id}:${index}`} setup={view} op={op} index={index} stat={stats.get(op.id)} playable={playable} locked={locked} built={built}
          dropAt={drop?.op === op.id ? drop.at : null}
          drag={locked || !op.op ? undefined : {
            draggable: true,
            onDragStart: (event) => { event.dataTransfer.setData('text/x-camlib-op', `${view.id}\n${op.id}`); event.dataTransfer.effectAllowed = 'move'; },
            onDragOver: (event) => {
              if (!event.dataTransfer.types.includes('text/x-camlib-op')) return;
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              setDrop({ op: op.id, at: event.clientY < box.top + box.height / 2 ? 'before' : 'after' });
            },
            onDragLeave: () => setDrop((current) => (current?.op === op.id ? null : current)),
            onDragEnd: () => setDrop(null),
            onDrop: (event) => {
              const [from, moved] = event.dataTransfer.getData('text/x-camlib-op').split('\n');
              const at = drop?.at ?? 'after';
              setDrop(null);
              if (from !== view.id || !moved || moved === op.id || !ids.includes(moved)) return;
              event.preventDefault();
              // Its new place among the others (the moved one taken out first).
              const rest = ids.filter((id) => id !== moved);
              void moveProgramOp(moved, rest.indexOf(op.id) + (at === 'after' ? 1 : 0));
            },
          }} />
      ))}
    </div>
  );
}

function OperationRow({ setup, op, index, stat, playable, locked, built, drag, dropAt }: {
  setup: SetupView; op: SetupView['ops'][number]; index: number; stat?: { moves: number; seconds: number }; playable: boolean; locked: string | null;
  /** The setup's operations that have a toolpath (in the build shown). */
  built: string[];
  drag?: TreeRowProps['drag']; dropAt: 'before' | 'after' | null;
}) {
  const selected = useApp((state) => state.selected);
  // Its toolpath in the 3D view: there once the build shown planned it; hidden or shown from its eye.
  const paths = usePaths((state) => state.setups[setup.id]);
  const hasPath = built.includes(op.id);
  const pathShown = !pathHidden(paths, op.id);
  const alone = hasPath && built.length > 1 && hiddenCount(paths, built) === built.length - 1 && pathShown;
  const noPath = hasPath ? null : 'Build the program first.';
  const solo = () => soloPath(setup.id, op.id, built);
  // While a build runs: whether camlib has planned this operation, or is planning it now.
  const building = useApp((state) => (running(state.build) ? treeState(state.build?.progress, setup.id, op.id) : null));
  const handle = `operation:${setup.id}/${op.id}`;
  const summary = op.summary;
  const tool = summary ? setup.described?.tools.find((item) => item.id === summary.tool) : null;
  const known = !locked && !!op.op?.call;
  const why = locked ?? (known ? null : 'It isn’t an operation the forms know: edit it in code.');
  const count = setup.ops.length;
  /** Plays the setup from where this operation starts. */
  const playFrom = async () => {
    const player = useApp.getState().player;
    if (!(player.status === 'ready' && player.source?.header.id === setup.id)) await openPlayer(setup.id);
    const band = useApp.getState().player.source?.bands.find((item) => item.operation === op.id);
    if (band) usePlayer.setState({ position: band.first, playing: false, focus: null });
  };
  const edit = () => { if (known) void openEditOp(op.id); else void showInCode(op.id); };
  return (
    <div data-operation-row={op.id}>
      <TreeRow depth={2} icon={<OpIcon kind={op.cls ?? op.kind} size={14} />} label={op.id} item={handle} selected={selected === handle} drag={drag} dropAt={dropAt}
        meta={building === 'planning' ? <span className={styles.status} data-status="running" data-building="planning" title="camlib is planning it"><span className="spinner" />planning</span>
          : building === 'done' ? <span className={styles.status} data-building="done" title="Planned in the build running now">planned</span>
          : summary?.tool_number != null ? <span className={styles.metaText}>T{summary.tool_number}</span> : undefined}
        title={[
          op.cls ?? summary?.kind, tool ? `T${summary?.tool_number ?? '?'} ${tool.name}` : summary?.tool, summary?.spindle_rpm ? `S${num(summary.spindle_rpm, 0)}` : null,
          summary?.feed_mm_min ? `F${num(summary.feed_mm_min, 0)}` : null, stat ? `${num(stat.moves, 0)} moves · ${clock(stat.seconds)}` : null,
        ].filter(Boolean).join(' · ') + `\n${playable ? 'Click to play from its start; d' : 'D'}ouble-click to edit it${known ? '' : ' in code'}; drag to reorder.`}
        onClick={() => { select(handle); if (playable) void playFrom(); }} onDoubleClick={edit} onContextSelect={() => select(handle)}
        onKeyDown={known ? rowKeys({ remove: () => void deleteProgramOp(op.id), edit, duplicate: () => void duplicateProgramOp(op.id) }) : undefined}
        dimmed={hasPath && !pathShown}
        actions={hasPath && (
          <EyeButton shown={pathShown} name={`the toolpath of ${op.id}`} onToggle={() => togglePath(setup.id, op.id)} onAlt={solo}
            hint={`Alt-click: ${alone ? 'show the others again' : 'show only this one'}.\n${STILL_RUNS}`} />
        )}
        menu={() => [
          { label: 'Edit', icon: <Pencil {...I} />, reason: why, run: () => void openEditOp(op.id) },
          { label: 'Duplicate', icon: <Copy {...I} />, shortcut: displayShortcut('Mod+D'), reason: why, run: () => void duplicateProgramOp(op.id) },
          'sep',
          { label: 'Move up', icon: <ArrowUp {...I} />, reason: why ?? (index === 0 ? 'It runs first in its setup.' : null), run: () => void moveProgramOp(op.id, index - 1) },
          { label: 'Move down', icon: <ArrowDown {...I} />, reason: why ?? (index === count - 1 ? 'It runs last in its setup.' : null), run: () => void moveProgramOp(op.id, index + 1) },
          'sep',
          { label: 'Play from here', icon: <Play {...I} />, reason: playable ? null : 'Build the program first.', run: () => void playFrom() },
          { label: pathShown ? 'Hide toolpath' : 'Show toolpath', icon: pathShown ? <EyeOff {...I} /> : <Eye {...I} />, reason: noPath, run: () => togglePath(setup.id, op.id) },
          { label: alone ? 'Show the other toolpaths again' : 'Show only this toolpath', icon: <Focus {...I} />, shortcut: 'Alt+click', reason: noPath ?? (built.length > 1 ? null : 'It is the setup’s only toolpath.'), run: solo },
          ...downloadLines(setup.id),
          { label: 'Edit code', icon: <Code2 {...I} />, run: () => void showInCode(op.id) },
          'sep',
          { label: 'Delete', icon: <Trash2 {...I} />, danger: true, shortcut: 'Del', reason: why ?? (count === 1 ? 'A setup holds at least one operation.' : null), run: () => void deleteProgramOp(op.id) },
        ]} />
    </div>
  );
}

function SetupsGroup({ described }: { described: SetupDescription[] | null }) {
  const busy = useApp((state) => state.busy);
  const hasProgram = useApp((state) => !!state.project?.program);
  const model = useProgram((state) => state.model);
  const problem = useProgram((state) => state.problem);
  // From the code when the forms read it (current without a build), else as the last build described it.
  const views: SetupView[] | null = model?.setups.length
    ? model.setups.map((setup) => {
      const desc = described?.find((item) => item.id === setup.id) ?? null;
      return { id: setup.id, code: setup, described: desc, ops: setup.operations.map((op, index) => {
        const id = op.id ?? `${op.cls ?? 'item'} ${index + 1}`;
        return { id, cls: op.cls, kind: null, op, summary: desc?.operations.find((item) => item.id === id) ?? null };
      }) };
    })
    : described?.map((setup) => ({ id: setup.id, code: null, described: setup, ops: setup.operations.map((op) => ({ id: op.id, cls: null, kind: op.kind, op: null, summary: op })) })) ?? null;
  const locked = model?.setups.length ? null : problem ?? 'program.py isn’t a program the forms can read: edit it in code.';
  return (
    <BrowserGroup title="Setups" icon={<SetupIcon {...I} />} count={views?.length} item="group:setups"
      menu={() => [
        { label: 'New setup', icon: <SetupIcon {...I} />, reason: hasProgram ? null : 'The project has no program.py.', run: () => void openSetup() },
        'sep',
        { label: 'Build', icon: <Hammer {...I} />, shortcut: displayShortcut('Mod+Enter'), reason: busy ? 'A build is running.' : null, run: () => void startBuild('full') },
        { label: 'Check', icon: <ListChecks {...I} />, reason: busy ? 'A build is running.' : null, run: () => void startBuild('preview') },
        { label: 'Edit program.py', icon: <Code2 {...I} />, run: () => void revealIn('program.py', 1, false) },
      ]}>
      {views?.map((view) => <SetupRows key={view.id} view={view} locked={view.code ? null : locked} />)}
      {problem && views && <p className={styles.emptyHint} data-tone="warn" title={problem}>{problem} The tree shows the last build.</p>}
      {!views?.length && problem && <p className={styles.emptyHint} data-tone="warn">{problem}</p>}
      {hasProgram && (
        <TreeRow depth={1} icon={<Plus size={14} />} label={<span className={styles.addLabel}>New setup…</span>} item="add:setup"
          title="A setup: the machine and its tools, the stock, where the tool starts, then its first operation" onClick={() => void openSetup()} />
      )}
    </BrowserGroup>
  );
}

function Browser() {
  const project = useApp((state) => state.project);
  const described = useApp((state) => state.described);
  const player = useApp((state) => state.player);
  const program = described?.program ?? null;
  const shown = program?.setups.find((setup) => setup.id === player.setup) ?? program?.setups[0] ?? null;
  return (
    <div className={styles.browser}>
      <div className={styles.scroll} id="model-tree">
        {!project && <p className={styles.empty}>No project open</p>}
        {project && <>
          <TreeRow depth={0} icon={<Box {...I} />} label={project.name} item="document"
            meta={program ? <span className={styles.metaText} title={`Program ${program.id}, revision ${program.revision}`}>{program.id}</span> : undefined}
            menu={() => [
              { label: 'Build', icon: <Hammer {...I} />, shortcut: displayShortcut('Mod+Enter'), reason: useApp.getState().busy ? 'A build is running.' : project.program ? null : 'The project has no program.py.', run: () => void startBuild('full') },
              { label: 'Check', icon: <ListChecks {...I} />, reason: useApp.getState().busy ? 'A build is running.' : null, run: () => void startBuild('preview') },
              'sep',
              { label: 'Go to file…', icon: <Code2 {...I} />, shortcut: displayShortcut('Mod+P'), run: () => useApp.setState({ panelOpen: true, tab: 'code', switcherOpen: true }) },
              { label: 'Zoom to fit', icon: <Focus {...I} />, shortcut: 'F', run: () => viewer.fit() },
            ]} />
          <OriginGroup />
          <BodiesGroup />
          <FixturesGroup setup={shown} />
          <SetupsGroup described={program?.setups ?? null} />
        </>}
      </div>
    </div>
  );
}

/** The left panel (STEVE Studio's LeftPanel): the browser as its Model tab, Collapse all and Hide in the tab row. */
export default function Sidebar() {
  // Dragged at its right edge (shell/panels.ts).
  const { width, edge } = usePanelWidth('left');
  return (
    <nav className="sidebar" aria-label="Browser" style={{ width }}>
      <div {...edge} />
      <div className={dock.dock}>
        <div className={dock.tabs} role="tablist" aria-label="Browser panels">
          <button type="button" role="tab" aria-selected data-tab="model" className={dock.tab} data-active="true">
            <span className={dock.tabThumb} />
            <ListTree size={14} strokeWidth={1.7} />
            <span>Model</span>
          </button>
          <span className={dock.close}>
            <button type="button" className="icon-button small" title="Collapse all" aria-label="Collapse all" onClick={collapseAll}><ChevronsDownUp size={14} /></button>
            <button type="button" className="icon-button small" title={`Hide panel (${displayShortcut('Mod+B')})`} aria-label="Hide panel" onClick={() => useApp.setState({ sidebarOpen: false })}><PanelLeftClose size={14} /></button>
          </span>
        </div>
        <div className={dock.body}><div className={dock.pane}><Browser /></div></div>
      </div>
    </nav>
  );
}
