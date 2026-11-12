/**
 * The side panels' widths, kept in this browser between visits: each panel is dragged at the edge it shares with the 3D
 * view (double-click: its first width again). The arithmetic is shell/panelWidths.ts; a collapsed panel keeps its
 * width, so it comes back as wide as it was.
 */
import { useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';
import { useApp } from '../state';
import { beside, dragged, INITIAL, kept, LIMITS, shown, widest, type Side, type Widths } from './panelWidths';

const KEYS: Record<Side, string> = { left: 'camlib-ui:sidebar-width', right: 'camlib-ui:dock-width' };

function read(side: Side): number {
  try { return kept(side, localStorage.getItem(KEYS[side])); } catch { return INITIAL[side]; }
}
function write(side: Side, width: number) {
  try { localStorage.setItem(KEYS[side], String(Math.round(width))); } catch { /* private mode: kept for this visit */ }
}

interface PanelState { asked: Widths; windowWidth: number; dragging: Side | null }
const usePanels = create<PanelState>(() => ({
  asked: { left: read('left'), right: read('right') },
  windowWidth: typeof window === 'undefined' ? 1600 : window.innerWidth,
  dragging: null,
}));

/** What each side takes now (a collapsed side: its rail). */
function drawn(): Widths {
  const { asked, windowWidth } = usePanels.getState();
  const app = useApp.getState();
  return shown(asked, { left: app.sidebarOpen, right: app.panelOpen }, windowWidth);
}

function ask(side: Side, width: number) {
  usePanels.setState((state) => (state.asked[side] === width ? state : { asked: { ...state.asked, [side]: width } }));
  write(side, width);
}

/** A drag of a panel's edge: the pointer is followed on the window (it leaves the 6 px edge at once) until it lifts. */
function startDrag(side: Side, event: ReactPointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const from = event.clientX;
  const start = drawn()[side];
  const move = (e: PointerEvent) => ask(side, dragged(side, start, e.clientX - from, window.innerWidth, beside(side, drawn())));
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('blur', end);
    document.body.style.cursor = '';
    usePanels.setState({ dragging: null });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', end);
  document.body.style.cursor = 'col-resize';
  usePanels.setState({ dragging: side });
}

/** The window's width, followed while the layout is shown (the panels give way when it narrows). */
export function useWindowWidth() {
  useEffect(() => {
    const update = () => usePanels.setState((state) => (state.windowWidth === window.innerWidth ? state : { windowWidth: window.innerWidth }));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
}

/** An open panel's drawn width, and what its edge (a `separator`) needs. */
export function usePanelWidth(side: Side) {
  const asked = usePanels((state) => state.asked);
  const windowWidth = usePanels((state) => state.windowWidth);
  const dragging = usePanels((state) => state.dragging === side);
  const sidebarOpen = useApp((state) => state.sidebarOpen);
  const panelOpen = useApp((state) => state.panelOpen);
  const now = shown(asked, { left: sidebarOpen, right: panelOpen }, windowWidth);
  return {
    width: now[side],
    edge: {
      className: 'resizer',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': side === 'left' ? 'Resize the browser' : 'Resize the panel',
      'aria-valuemin': LIMITS[side].min,
      'aria-valuemax': widest(side, windowWidth, beside(side, now)),
      'aria-valuenow': now[side],
      title: 'Drag to resize (double-click: the default width)',
      'data-side': side,
      'data-dragging': dragging || undefined,
      onPointerDown: (event: ReactPointerEvent) => startDrag(side, event),
      onDoubleClick: () => ask(side, INITIAL[side]),
    } as const,
  };
}
