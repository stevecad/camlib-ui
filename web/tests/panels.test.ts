/**
 * The side panels' widths (src/shell/panelWidths.ts) and the layout rule that keeps them from widening the top bar
 * (src/styles.css): a drag of a panel's edge resizes that panel and the 3D view, never the window's column.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beside, dragged, INITIAL, kept, LIMITS, RAIL, shown, VIEW_MIN, widest, type Open, type Widths } from '../src/shell/panelWidths.ts';

const BOTH: Open = { left: true, right: true };
const WINDOWS = [1100, 1280, 1400, 1700, 1920, 2560];

test('a drag moves the edge with the pointer: the left panel grows to the right, the right one to the left', () => {
  assert.equal(dragged('left', 264, 100, 1700, 384), 364);
  assert.equal(dragged('left', 264, -40, 1700, 384), 224);
  assert.equal(dragged('right', 384, -300, 1700, 264), 684);
  assert.equal(dragged('right', 384, 50, 1700, 264), 334);
});

test('a drag stops at the panel’s least width and where the view would have less than its least', () => {
  for (const windowWidth of WINDOWS) {
    for (const side of ['left', 'right'] as const) {
      const other = side === 'left' ? INITIAL.right : INITIAL.left;
      const start = INITIAL[side];
      const far = side === 'left' ? 5000 : -5000;
      const widestDrag = dragged(side, start, far, windowWidth, other);
      assert.equal(widestDrag, widest(side, windowWidth, other));
      assert.ok(widestDrag <= LIMITS[side].max);
      assert.ok(windowWidth - other - widestDrag >= VIEW_MIN, `${side} at ${windowWidth}: the view keeps ${windowWidth - other - widestDrag}`);
      assert.equal(dragged(side, start, -far, windowWidth, other), LIMITS[side].min);
    }
  }
  // The old rule let the right panel take all but 420 px of the window whatever the left panel took: at 1700 that left
  // the view 1700 − 264 − 1280 = 156 px.
  assert.equal(dragged('right', 384, -5000, 1700, 264), 1700 - 264 - VIEW_MIN);
  // The other side collapsed to its rail: its room goes to the panel dragged.
  assert.equal(dragged('right', 384, -5000, 1700, RAIL), 1700 - RAIL - VIEW_MIN);
  assert.equal(dragged('left', 264, 5000, 1700, 384), LIMITS.left.max);
});

test('whatever was asked for, the panels and the view fit the window (1100 to 2560 px)', () => {
  const asks: Widths[] = [INITIAL, { left: 560, right: 2000 }, { left: 200, right: 320 }, { left: 9999, right: 9999 }, { left: 1, right: 1 }];
  const opens: Open[] = [BOTH, { left: false, right: true }, { left: true, right: false }, { left: false, right: false }];
  for (const windowWidth of WINDOWS) for (const asked of asks) for (const open of opens) {
    const now = shown(asked, open, windowWidth);
    const where = `${JSON.stringify(asked)} ${JSON.stringify(open)} at ${windowWidth}`;
    assert.ok(now.left + now.right + VIEW_MIN <= windowWidth, `${where}: ${JSON.stringify(now)} leaves the view too little`);
    assert.equal(now.left, open.left ? now.left : RAIL);
    assert.equal(now.right, open.right ? now.right : RAIL);
    if (open.left) assert.ok(now.left >= LIMITS.left.min && now.left <= LIMITS.left.max, where);
    if (open.right) assert.ok(now.right >= LIMITS.right.min, where);
  }
});

test('a narrow window takes from the right panel first and a wide one gives the asked widths back', () => {
  const asked: Widths = { left: 400, right: 900 };
  assert.deepEqual(shown(asked, BOTH, 2560), asked);
  assert.deepEqual(shown(asked, BOTH, 1400), { left: 400, right: 1400 - 400 - VIEW_MIN });
  assert.deepEqual(shown(asked, BOTH, 1100), { left: 400, right: 1100 - 400 - VIEW_MIN });
  // Narrower still: the right panel is at its least, and the left gives the rest.
  assert.deepEqual(shown(asked, BOTH, 1000), { left: 1000 - LIMITS.right.min - VIEW_MIN, right: LIMITS.right.min });
  assert.deepEqual(shown(asked, BOTH, 2560), asked);
});

test('collapsing a panel keeps its width for when it opens again', () => {
  const asked: Widths = { left: 300, right: 700 };
  assert.deepEqual(shown(asked, { left: false, right: false }, 1700), { left: RAIL, right: RAIL });
  assert.deepEqual(shown(asked, BOTH, 1700), asked);
  assert.equal(beside('left', shown(asked, { left: true, right: false }, 1700)), RAIL);
  assert.equal(beside('right', shown(asked, BOTH, 1700)), 300);
});

test('a kept width is read back within the panel’s bounds; anything else is the first width', () => {
  assert.equal(kept('right', '684'), 684);
  assert.equal(kept('left', '300'), 300);
  assert.equal(kept('right', '12'), LIMITS.right.min);
  assert.equal(kept('left', '4000'), LIMITS.left.max);
  for (const text of [null, undefined, '', '  ', 'wide', 'NaN', '-5', '0', 'Infinity']) {
    assert.equal(kept('right', text), LIMITS.right.initial, String(text));
    assert.equal(kept('left', text), LIMITS.left.initial, String(text));
  }
});

// The layout rule itself. The measured behaviour (a drag in a browser) is recorded in the commit that added this; here
// the declarations it rests on are pinned, so the cause can't come back unnoticed.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function rule(selector: string): Record<string, string> {
  const found = new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*{([^}]*)}`, 'm').exec(css);
  assert.ok(found, `styles.css has no rule for ${selector}`);
  return Object.fromEntries(found[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => { const at = part.indexOf(':'); return [part.slice(0, at).trim(), part.slice(at + 1).trim()]; }));
}

test('the top bar and the ribbon are sized by the window, not by the panels', () => {
  // The implicit `auto` column grew to the body's content (panels + canvas), taking the top bar and ribbon with it.
  assert.equal(rule('.app')['grid-template-columns'], 'minmax(0, 1fr)');
  assert.equal(rule('.app > *')['min-width'], '0');
  assert.equal(rule('.body').overflow, 'hidden');
  // The view shrinks when a panel grows: no content-sized minimum, and its canvas is clipped.
  for (const selector of ['.center', '.stage']) {
    assert.equal(rule(selector)['min-width'], '0', selector);
    assert.equal(rule(selector).overflow, 'hidden', selector);
  }
  // The panels take exactly their width, from shell/panels.ts: no CSS width or minimum to disagree with it.
  for (const selector of ['.sidebar', '.right-panel']) {
    assert.equal(rule(selector).flex, 'none', selector);
    assert.equal(rule(selector).width, undefined, selector);
    assert.equal(rule(selector)['min-width'], undefined, selector);
  }
});
