/**
 * The Manufacture ribbon under the top bar (from STEVE Studio's Ribbon.tsx and manufacture/commands.ts): Setup, the
 * shop, the operations of the setup being worked on, then Generate, Simulate and Post. The operations follow the
 * setup (`setupKind`): a mill's are camlib's milling operations grouped 2D, Holes and 3D; a lathe's its turning
 * operations grouped Turning, Grooving, Holes and Threading; a sheet's (plasma, laser) Cut and Mark.
 * Each button is a
 * command (commands.ts): its label, why it's unavailable (on hover), what it does. Too narrow for every group, the
 * lowest priority groups fold into one button with a menu; narrower still, the ribbon scrolls sideways.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { availability, command, displayShortcut, setupKind } from '../commands';
import { useApp } from '../state';
import { useEditor, useProgram } from '../cam/programEditor';
import { OP_SPECS } from '../cam/opSpecs';
import { PointMenu, type Entry } from './TreeRow';
import styles from '../shell/Ribbon.module.css';

/** The studio's ribbon priorities (ribbonPriority.ts): lower folds first. */
const KEEP = 100, HIGH = 80, MID = 60, LOW = 40;

interface Group { title: string; priority: number; items: string[] }

const ops = (classes: string[]) => classes.filter((cls) => OP_SPECS.some((spec) => spec.cls === cls)).map((cls) => `cam.code.${cls}`);
const ACTIONS: Group = { title: 'Actions', priority: KEEP, items: ['cam.generate', 'cam.simulate', 'cam.post'] };
const START: Group[] = [{ title: 'Setup', priority: KEEP, items: ['cam.setup.milling'] }, { title: 'Shop', priority: HIGH, items: ['cam.shop'] }];

/** The ribbon's groups for what the setup machines. */
export function groupsFor(kind: 'mill' | 'lathe' | 'sheet'): Group[] {
  if (kind === 'lathe') {
    return [
      ...START,
      { title: 'Turning', priority: MID, items: ops(['TurnFace', 'TurnRough', 'TurnFinish']) },
      { title: 'Grooving', priority: MID, items: ops(['TurnGroove', 'TurnPartOff', 'TurnFaceGroove']) },
      { title: 'Holes', priority: MID, items: ops(['TurnDrill', 'TurnBoreRough', 'TurnBoreFinish']) },
      { title: 'Threading', priority: LOW, items: ops(['TurnThread']) },
      ACTIONS,
    ];
  }
  if (kind === 'sheet') {
    return [...START, { title: 'Sheet', priority: HIGH, items: ['cam.sheet.import', 'cam.sheet.nest', 'cam.sheet.remnant'] },
      { title: 'Cutting', priority: MID, items: ops(['ThermalCut', 'ThermalMark']) }, ACTIONS];
  }
  return [
    ...START,
    ...(['2D', 'Holes', '3D'] as const).map((group): Group => ({ title: group, priority: MID, items: OP_SPECS.filter((spec) => spec.group === group).map((spec) => `cam.code.${spec.cls}`) })),
    ACTIONS,
  ];
}

/** Re-render when what commands read changes (the project, its build, the program, an open form). */
function useCommandEpoch() {
  useApp((state) => state.project);
  useApp((state) => state.build);
  useApp((state) => state.busy);
  useApp((state) => state.selected);
  useApp((state) => state.described);
  useProgram((state) => state.model);
  useProgram((state) => state.problem);
  useEditor((state) => state.form);
}

const tip = (id: string, reason: true | string) => {
  const cmd = command(id);
  const shortcut = displayShortcut(cmd.shortcut);
  return [`${cmd.label}${shortcut ? ` (${shortcut})` : ''}`, cmd.description, reason === true ? null : reason].filter(Boolean).join('\n');
};

function RibbonButton({ id }: { id: string }) {
  const cmd = command(id);
  const reason = availability(cmd);
  const enabled = reason === true;
  const Icon = cmd.icon;
  return (
    <button type="button" className={styles.button} data-command={cmd.id} data-active={cmd.active?.() || undefined} aria-disabled={!enabled} aria-label={cmd.label}
      title={tip(id, reason)} onClick={() => { if (availability(cmd) === true) cmd.run(); }}>
      <span className={styles.icon}><Icon size={20} strokeWidth={1.55} /></span>
      <span className={styles.label}>{cmd.short ?? cmd.label}</span>
    </button>
  );
}

/** A group folded into one button (its title and its first command's icon) that opens a menu of its commands. */
function GroupMenu({ group }: { group: Group }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const Icon = command(group.items[0]).icon;
  const anyEnabled = group.items.some((id) => availability(command(id)) === true);
  const lines: Entry[] = group.items.map((id) => {
    const cmd = command(id);
    const reason = availability(cmd);
    const ItemIcon = cmd.icon;
    return { label: cmd.label, icon: <ItemIcon size={15} />, reason: reason === true ? null : reason, shortcut: displayShortcut(cmd.shortcut), title: cmd.description, run: cmd.run };
  });
  return (
    <>
      <button type="button" className={`${styles.button} ${styles.menuButton}`} data-group={group.title} data-collapsed="" aria-disabled={!anyEnabled} aria-haspopup="menu"
        aria-expanded={!!at} title={`${group.title}: ${group.items.map((id) => command(id).short ?? command(id).label).join(' · ')}`}
        onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: box.left, y: box.bottom + 4 }); }}>
        <span className={styles.icon}><Icon size={20} strokeWidth={1.55} /></span>
        <span className={styles.label}>{group.title}<ChevronDown size={10} strokeWidth={2.2} /></span>
      </button>
      {at && <PointMenu at={at} lines={lines} onClose={() => setAt(null)} />}
    </>
  );
}

function RibbonGroup({ group, collapsed }: { group: Group; collapsed: boolean }) {
  return (
    <div className={styles.group} data-group={group.title}>
      <div className={styles.items}>{collapsed ? <GroupMenu group={group} /> : group.items.map((id) => <RibbonButton key={id} id={id} />)}</div>
      {/* A folded group's button already carries its title. */}
      <div className={styles.groupTitle}>{collapsed ? '' : group.title}</div>
    </div>
  );
}

/** A button's footprint without its behaviour, for measuring (same classes, icon box and label). */
function Footprint({ label, chevron }: { label: string; chevron?: boolean }) {
  return (
    <span className={`${styles.button}${chevron ? ` ${styles.menuButton}` : ''}`}>
      <span className={styles.icon} />
      <span className={styles.label}>{label}{chevron && <ChevronDown size={10} strokeWidth={2.2} />}</span>
    </span>
  );
}

function GroupFootprint({ group, collapsed }: { group: Group; collapsed: boolean }) {
  return (
    <div className={styles.group} data-footprint={collapsed ? 'collapsed' : 'expanded'}>
      <div className={styles.items}>
        {collapsed ? <Footprint label={group.title} chevron /> : group.items.map((id) => <Footprint key={id} label={command(id).short ?? command(id).label} />)}
      </div>
      <div className={styles.groupTitle}>{collapsed ? '' : group.title}</div>
    </div>
  );
}

/** Groups unfold again only once there's this much more room than they need, so a resize near an edge doesn't flicker. */
const HYSTERESIS = 32;

export default function Ribbon() {
  useCommandEpoch();
  const kind = setupKind();
  const GROUPS = useMemo(() => groupsFor(kind), [kind]);
  const ribbon = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<string[]>([]);
  // Fold lowest priority first (the later group first among equals) until the rest fit; widths come from the hidden
  // footprints, never from the drawn ribbon, so folding can't feed back into the measurement.
  const fit = useCallback(() => {
    const bar = ribbon.current, sizes = measure.current;
    if (!bar || !sizes) return;
    const style = getComputedStyle(bar);
    const room = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const width = (index: number, kind: 'expanded' | 'collapsed') => (sizes.children[index]?.querySelector(`[data-footprint="${kind}"]`) as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    const full = GROUPS.map((_, index) => width(index, 'expanded'));
    const small = GROUPS.map((_, index) => width(index, 'collapsed'));
    const order = GROUPS.map((group, index) => ({ group, index })).sort((a, b) => a.group.priority - b.group.priority || b.index - a.index).map(({ index }) => index)
      .filter((index) => small[index] < full[index] - 1);
    const widthWith = (fold: Set<number>) => full.reduce((sum, value, index) => sum + (fold.has(index) ? small[index] : value), 0);
    const solve = (space: number) => {
      const fold = new Set<number>();
      for (const index of order) { if (widthWith(fold) <= space) break; fold.add(index); }
      for (const index of [...order].reverse()) { if (!fold.has(index)) continue; fold.delete(index); if (widthWith(fold) > space) fold.add(index); }
      return fold;
    };
    setFolded((previous) => {
      const current = new Set(previous.map((title) => GROUPS.findIndex((group) => group.title === title)).filter((index) => index >= 0));
      let fold = solve(room);
      if (widthWith(current) <= room) { const roomier = solve(room - HYSTERESIS); fold = widthWith(roomier) > widthWith(current) ? roomier : current; }
      const next = order.filter((index) => fold.has(index)).map((index) => GROUPS[index].title);
      return next.join('\n') === previous.join('\n') ? previous : next;
    });
  }, [GROUPS]);
  useLayoutEffect(() => {
    fit();
    const observer = new ResizeObserver(() => fit());
    if (ribbon.current) observer.observe(ribbon.current);
    // Footprints change size when the font arrives.
    for (const child of Array.from(measure.current?.children ?? [])) observer.observe(child);
    return () => observer.disconnect();
  }, [fit]);
  // Whatever still doesn't fit scrolls sideways, its hidden end faded; a mouse wheel scrolls it.
  const [more, setMore] = useState('');
  const edges = useCallback(() => {
    const bar = ribbon.current;
    if (!bar) return;
    const start = bar.scrollLeft > 1, end = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
    setMore(start && end ? 'both' : start ? 'start' : end ? 'end' : '');
  }, []);
  useLayoutEffect(() => {
    const bar = ribbon.current;
    if (!bar) return;
    const observer = new ResizeObserver(edges);
    observer.observe(bar);
    bar.addEventListener('scroll', edges, { passive: true });
    return () => { observer.disconnect(); bar.removeEventListener('scroll', edges); };
  }, [edges]);
  useLayoutEffect(edges, [edges, folded]);
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    if (bar.scrollWidth <= bar.clientWidth + 1 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    bar.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bar.clientWidth : 1);
  };
  return (
    <div ref={ribbon} className={styles.ribbon} role="toolbar" aria-label="Manufacture" id="ribbon" data-kind={kind} data-more={more || undefined} data-folded={folded.join(',') || undefined} onWheel={wheel}>
      <div className={styles.groups}>
        {GROUPS.map((group) => <RibbonGroup key={group.title} group={group} collapsed={folded.includes(group.title)} />)}
      </div>
      <div ref={measure} className={styles.measure} aria-hidden inert>
        {GROUPS.map((group) => (
          <div key={group.title} className={styles.footprints}>
            <GroupFootprint group={group} collapsed={false} />
            <GroupFootprint group={group} collapsed />
          </div>
        ))}
      </div>
      <div className={styles.accent} />
    </div>
  );
}

