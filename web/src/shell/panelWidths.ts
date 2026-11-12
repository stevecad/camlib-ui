/**
 * The widths of the two side panels (the browser on the left, the code and result panel on the right): what a drag of
 * a panel's edge gives, and what is drawn when the window is too narrow for the widths asked for. Arithmetic only (no
 * DOM), so tests/panels.test.ts runs it as it is; shell/panels.ts keeps the widths and listens to the pointer.
 *
 * The rule: the 3D view between the panels keeps at least VIEW_MIN, each panel keeps its own least width, and the three
 * together are the window's width. Nothing here may ever ask for more than the window has.
 */
export type Side = 'left' | 'right';
export interface Widths { left: number; right: number }
export interface Open { left: boolean; right: boolean }

/** A collapsed panel's rail (styles.css .rail). */
export const RAIL = 40;
/** The least the 3D view keeps while a panel is dragged or the window narrows. */
export const VIEW_MIN = 360;
/** Each panel's least, widest and first width. The right panel's widest is whatever the window leaves. */
export const LIMITS: Record<Side, { min: number; max: number; initial: number }> = {
  left: { min: 200, max: 560, initial: 264 },
  right: { min: 320, max: Infinity, initial: 384 },
};
export const INITIAL: Widths = { left: LIMITS.left.initial, right: LIMITS.right.initial };

const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');
const within = (side: Side, width: number) => Math.min(LIMITS[side].max, Math.max(LIMITS[side].min, width));

/** A width kept from an earlier visit (localStorage's text), or the panel's first width when there is none or it isn't one. */
export function kept(side: Side, text: string | null | undefined): number {
  const value = text == null || text.trim() === '' ? NaN : Number(text);
  return Number.isFinite(value) && value > 0 ? within(side, Math.round(value)) : LIMITS[side].initial;
}

/** The widest `side` may be in a window this wide while the other side takes `beside` (its panel, or its rail). */
export function widest(side: Side, windowWidth: number, beside: number): number {
  return Math.max(LIMITS[side].min, Math.min(LIMITS[side].max, Math.floor(windowWidth - beside - VIEW_MIN)));
}

/**
 * What each side takes in a window this wide: an open panel its asked width, a collapsed one its rail. When they would
 * leave the view less than VIEW_MIN the right panel gives way first, then the left, each no further than its least
 * width (the asked widths are kept, so a wider window gives them back).
 */
export function shown(asked: Widths, open: Open, windowWidth: number): Widths {
  const result: Widths = { left: open.left ? within('left', asked.left) : RAIL, right: open.right ? within('right', asked.right) : RAIL };
  for (const side of ['right', 'left'] as const) {
    if (!open[side]) continue;
    const over = result.left + result.right + VIEW_MIN - windowWidth;
    if (over <= 0) break;
    result[side] = Math.max(LIMITS[side].min, Math.floor(result[side] - over));
  }
  return result;
}

/**
 * The width a panel is asked to have after its edge moved `dx` pixels (to the right is positive) from where the drag
 * began: the left panel's edge is its right one, so it grows with dx; the right panel's is its left one, so it shrinks.
 * `start` is that panel's drawn width when the drag began and `beside` what the other side takes.
 */
export function dragged(side: Side, start: number, dx: number, windowWidth: number, beside: number): number {
  const wanted = side === 'left' ? start + dx : start - dx;
  return Math.max(LIMITS[side].min, Math.min(widest(side, windowWidth, beside), Math.round(wanted)));
}

/** What the other side takes, for a drag of `side`. */
export function beside(side: Side, drawn: Widths): number {
  return drawn[other(side)];
}
