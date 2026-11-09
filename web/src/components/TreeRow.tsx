/**
 * A row of the browser tree and its right-click menu (from STEVE Studio's TreeRow and ItemMenu): chevron, icon, label,
 * meta, actions shown on hover; the Menu key or Shift+F10 opens the menu at the row, as a right click does.
 */
import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import styles from '../shell/Browser.module.css';

export interface Entry { label: string; icon?: ReactNode; shortcut?: string; reason?: string | null; danger?: boolean; title?: string; run: () => void }
/** A menu line: an item, a separator, or a submenu (`items`, opened beside it). */
export type Line = 'sep' | Entry | { label: string; icon?: ReactNode; id?: string; reason?: string | null; items: Entry[] };
type Item = Exclude<Line, 'sep'>;
const isSub = (item: Item): item is Extract<Line, { items: Entry[] }> => 'items' in item;

/**
 * A menu at a point: arrows move, Enter runs, → opens a submenu (← or Esc closes it), Esc or a click elsewhere closes.
 * Lines with a reason show it, greyed. `onBack`: a submenu's way back to its parent.
 */
export function PointMenu({ at, lines, onClose, onBack, focus = true }: { at: { x: number; y: number }; lines: Line[]; onClose: () => void; onBack?: () => void; focus?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const items = lines.filter((line): line is Item => line !== 'sep');
  const usable = (item: Item) => !item.reason && (!isSub(item) || item.items.length > 0);
  const [active, setActive] = useState(() => items.findIndex(usable));
  const [place, setPlace] = useState(at);
  const [sub, setSub] = useState<{ index: number; at: { x: number; y: number }; focus: boolean } | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    // Keep it on screen.
    const rect = element.getBoundingClientRect();
    setPlace({ x: Math.min(at.x, window.innerWidth - rect.width - 8), y: Math.min(at.y, window.innerHeight - rect.height - 8) });
    if (focus) element.focus();
    if (onBack) return;   // The top menu closes the whole stack on a click elsewhere.
    const away = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.('.menu')) onClose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', onClose); };
  }, [at, onClose, onBack, focus]);
  const openSub = (index: number, withFocus: boolean) => {
    const button = buttons.current[index];
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setSub({ index, at: { x: rect.right - 4, y: rect.top - 4 }, focus: withFocus });
  };
  const run = (item: Item, index: number) => {
    if (!usable(item)) return;
    if (isSub(item)) { openSub(index, true); return; }
    onClose();
    item.run();
  };
  const move = (step: number) => {
    if (!items.some(usable)) return;
    let next = active;
    do next = (next + step + items.length) % items.length; while (!usable(items[next]));
    setActive(next);
    setSub(null);
  };
  let index = -1;
  const current = sub ? items[sub.index] : null;
  return createPortal(
    <div ref={box} className="menu" role="menu" tabIndex={-1} style={{ left: place.x, top: place.y }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.target !== box.current) return;   // A submenu's own keys.
        if (event.key === 'Escape') { event.preventDefault(); (onBack ?? onClose)(); }
        else if (event.key === 'ArrowLeft' && onBack) { event.preventDefault(); onBack(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        else if (event.key === 'ArrowRight' && items[active] && isSub(items[active])) { event.preventDefault(); openSub(active, true); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (items[active]) run(items[active], active); }
      }}>
      {lines.map((line, at) => {
        if (line === 'sep') return at > 0 && at < lines.length - 1 && lines[at - 1] !== 'sep' ? <div key={`sep-${at}`} className="menu-sep" /> : null;
        const mine = ++index;
        const reason = line.reason ?? (isSub(line) && !line.items.length ? 'Nothing to choose.' : null);
        return (
          <button key={line.label} ref={(element) => { buttons.current[mine] = element; }} type="button" role="menuitem" className="menu-item"
            data-highlighted={mine === active || undefined} data-danger={(!isSub(line) && line.danger) || undefined} id={isSub(line) ? line.id : undefined}
            aria-haspopup={isSub(line) ? 'menu' : undefined} aria-expanded={isSub(line) ? sub?.index === mine : undefined} title={!isSub(line) ? line.title : undefined}
            aria-disabled={!!reason || undefined} data-reason={reason ? true : undefined}
            onMouseEnter={() => { setActive(mine); if (isSub(line) && usable(line)) openSub(mine, false); else setSub(null); }} onClick={() => run(line, mine)}>
            {line.icon}
            <span className="menu-text"><span>{line.label}</span>{reason && <small>{reason}</small>}</span>
            {isSub(line) ? <ChevronRight size={13} className="menu-more" /> : line.shortcut && <kbd>{line.shortcut}</kbd>}
          </button>
        );
      })}
      {sub && current && isSub(current) && (
        <PointMenu at={sub.at} lines={current.items} focus={sub.focus} onClose={onClose} onBack={() => { setSub(null); box.current?.focus(); }} />
      )}
    </div>,
    document.body,
  );
}

export interface TreeRowProps {
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  selected?: boolean;
  dimmed?: boolean;
  actions?: ReactNode;
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: () => void;
  title?: string;
  error?: boolean;
  /** The right-click menu's lines (made when it opens). */
  menu?: () => Line[];
  /** Right-clicking a row that isn't selected selects it first (as desktop CAD browsers do). */
  onContextSelect?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** A stable handle for the row (`setup:top`, `operation:pocket`, …). */
  item?: string;
  /** Drag and drop on the row (an operation reordered within its setup). */
  drag?: Pick<HTMLAttributes<HTMLDivElement>, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDragLeave' | 'onDrop' | 'onDragEnd'>;
  /** Where a drag over the row would drop it (shown as a line). */
  dropAt?: 'before' | 'after' | null;
}

export default function TreeRow({ depth, icon, label, meta, expanded, onToggle, selected, dimmed, actions, onClick, onDoubleClick, title, error, menu, onContextSelect, onKeyDown, item, drag, dropAt }: TreeRowProps) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className={styles.row} data-selected={selected || undefined} data-dimmed={dimmed || undefined} data-error={error || undefined} data-item={item} data-state={open ? 'open' : undefined}
      data-drop={dropAt ?? undefined} style={{ paddingLeft: 6 + depth * 14 }} {...drag}
      onContextMenu={menu ? (event) => { event.preventDefault(); if (!selected) onContextSelect?.(); setOpen({ x: event.clientX, y: event.clientY }); } : undefined}>
      {onToggle ? (
        <button type="button" className={styles.chevron} aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded} onClick={onToggle}>
          <span style={{ display: 'grid', transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 180ms cubic-bezier(0.2, 0, 0, 1)' }}>
            <ChevronRight size={13} strokeWidth={2} />
          </span>
        </button>
      ) : <span className={styles.chevronSpacer} />}
      <button type="button" className={styles.rowMain} title={title} aria-pressed={selected} aria-haspopup={menu ? 'menu' : undefined} onClick={onClick} onDoubleClick={onDoubleClick}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (menu && !event.defaultPrevented && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            setOpen({ x: box.left + Math.min(28, box.width / 2), y: box.bottom - 2 });
          }
        }}>
        <span className={styles.rowIcon}>{icon}</span>
        <span className={styles.rowLabel}>{label}</span>
        {meta !== undefined && meta !== null && meta !== false && <span className={styles.rowMeta}>{meta}</span>}
      </button>
      {actions && <span className={styles.rowActions}>{actions}</span>}
      {open && menu && <PointMenu at={open} lines={menu()} onClose={() => setOpen(null)} />}
    </div>
  );
}
