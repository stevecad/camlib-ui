/**
 * An operation's planning report, as camlib gave it (camlib_ui/build/run.py keeps each operation's report in the build's
 * result): rows the result panel lists, whatever the report's shape. Nothing is interpreted away: every value camlib
 * reported shows under its own name, a report this file has never seen included; a few figures worth reading first
 * (the engagement an adaptive clearing proved, wall passes, loops left without a tab) are also said in words.
 *
 * No imports, so it runs under plain Node (tests/).
 */

export interface ReportRow {
  /** Nesting (0: the report's own values). */
  depth: number;
  label: string;
  /** Null: a heading (an object or a list whose rows follow). */
  value: string | null;
  /** A row to notice: camlib's diagnostics and what it left out. */
  tone?: 'warn';
}

/** The marker camlib_ui/build/run.py leaves where it cut a long report short ({"…": "12 more"}). */
export const CUT = '…';

const words = (key: string) => key.replace(/_/g, ' ').trim();
/** A number as it reads: whole numbers whole, others to 6 significant digits. */
export function figure(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}
const scalar = (value: unknown): string | null => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return figure(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  return null;
};
const isScalar = (value: unknown) => scalar(value) !== null;
/** Keys whose values are messages to notice. */
const NOTICE = new Set(['diagnostics', 'warnings', CUT]);

/**
 * A report as rows, in camlib's order: a value per row; an object or a list of objects as a heading with its rows
 * under it; a short list of numbers on one row. At most `limit` rows: the rest are counted in a last row, never dropped
 * silently.
 */
export function reportRows(report: unknown, limit = 600): ReportRow[] {
  const rows: ReportRow[] = [];
  let skipped = 0;
  const push = (row: ReportRow) => { if (rows.length < limit) rows.push(row); else skipped++; };
  const walk = (label: string, value: unknown, depth: number, tone?: 'warn') => {
    const text = scalar(value);
    if (text !== null) { push({ depth, label, value: text, tone }); return; }
    if (Array.isArray(value)) {
      if (!value.length) { push({ depth, label, value: 'none' }); return; }
      if (value.every(isScalar) && value.every((item) => typeof item !== 'string') && value.length <= 8) { push({ depth, label, value: value.map((item) => scalar(item)).join(', '), tone }); return; }
      push({ depth, label: `${label} (${value.length})`, value: null, tone });
      value.forEach((item, index) => walk(isScalar(item) ? '·' : String(index + 1), item, depth + 1, tone));
      return;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (label) push({ depth, label, value: entries.length ? null : 'none', tone });
      for (const [key, item] of entries) walk(words(key) || key, item, label ? depth + 1 : depth, NOTICE.has(key) ? 'warn' : tone);
      return;
    }
    push({ depth, label, value: String(value), tone });
  };
  walk('', report ?? {}, 0);
  if (skipped) rows.push({ depth: 0, label: CUT, value: `${skipped} more values aren’t listed`, tone: 'warn' });
  return rows;
}

const numbers = (values: unknown[]) => values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
/** Every value under `key`, anywhere in the report (a level's clearing report holds its own). */
function collect(report: unknown, key: string, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > 12 || report === null || typeof report !== 'object') return out;
  if (Array.isArray(report)) { for (const item of report) collect(item, key, out, depth + 1); return out; }
  for (const [name, value] of Object.entries(report as Record<string, unknown>)) {
    if (name === key) out.push(value);
    else collect(value, key, out, depth + 1);
  }
  return out;
}

/**
 * What to read first in a report, in words: only figures camlib reported under these names (camlib docs/operations.md),
 * each said as what it is. A report without them has no headlines; its rows still show everything.
 */
export function reportHeadlines(report: unknown): { text: string; tone?: 'warn' }[] {
  const out: { text: string; tone?: 'warn' }[] = [];
  if (!report || typeof report !== 'object') return out;
  const top = report as Record<string, unknown>;
  const sum = (key: string) => { const found = numbers(collect(report, key)); return found.length ? found.reduce((x, y) => x + y, 0) : null; };
  const most = (key: string) => { const found = numbers(collect(report, key)); return found.length ? Math.max(...found) : null; };
  const proven = most('proven_max_engagement_deg');
  if (proven !== null) {
    const limit = most('engagement_limit_deg') ?? most('max_engagement_deg');
    const strokes = sum('engagement_proved_strokes');
    out.push({ text: `Engagement proven${strokes !== null ? ` on ${figure(strokes)} strokes` : ''}: at most ${figure(proven)}°${limit !== null ? ` (limit ${figure(limit)}°)` : ''}` });
  }
  // Confined material (a place barely wider than the cutter) is cut as entry moves, outside that limit: said, not hidden.
  const confined = sum('confined_strokes');
  if (confined) {
    const length = sum('confined_stroke_mm'), angle = most('confined_max_engagement_deg');
    out.push({ text: `${figure(confined)} ${confined === 1 ? 'stroke' : 'strokes'} in confined material cut as entry moves at the entry feed, not within that limit`
      + `${length !== null ? `: ${figure(length)} mm` : ''}${angle !== null ? `, up to ${figure(angle)}°` : ''}` });
  }
  const layers = Array.isArray(top.layers) ? top.layers.length : null;
  const walls = sum('wall_passes');
  if (walls !== null) out.push({ text: `${figure(walls)} wall ${walls === 1 ? 'pass' : 'passes'}${layers !== null ? ` over ${layers} ${layers === 1 ? 'level' : 'levels'}` : ''}` });
  if (typeof top.shadow_error_mm === 'number') out.push({ text: `Shadow error at most ${figure(top.shadow_error_mm)} mm (the cutter’s flat against the levels cut)` });
  // A plasma or laser cut: what the sheet takes, as camlib counted it (times at the programmed feeds, without acceleration or rapids).
  if (top.strategy === 'thermal_cut' && typeof top.pierces === 'number' && typeof top.cut_length_mm === 'number') {
    out.push({ text: `${figure(top.pierces)} ${top.pierces === 1 ? 'pierce' : 'pierces'}, ${figure(top.cut_length_mm)} mm of cut`
      + `${typeof top.rapid_length_mm === 'number' ? `, ${figure(top.rapid_length_mm)} mm of travel between cuts` : ''}` });
    if (typeof top.feed_seconds === 'number' && typeof top.dwell_seconds === 'number') {
      out.push({ text: `About ${figure((top.feed_seconds + top.dwell_seconds) / 60)} min cutting at the programmed feeds${top.dwell_seconds ? ` (${figure(top.dwell_seconds)} s of it pierce delays)` : ''}; travel and the controller’s own height moves come on top` });
    }
    if (typeof top.crop_length_mm === 'number') out.push({ text: `Crop cut last: ${figure(top.crop_length_mm)} mm` });
  }
  // camlib's diagnostics, each once (every level of a clearing repeats its own).
  const diagnostics = [...new Set(collect(report, 'diagnostics').flatMap((item) => (Array.isArray(item) ? item : [item])).filter((item): item is string => typeof item === 'string' && !!item))];
  for (const message of diagnostics.slice(0, 12)) out.push({ text: message, tone: 'warn' });
  if (diagnostics.length > 12) out.push({ text: `${diagnostics.length - 12} more diagnostics are in the report below`, tone: 'warn' });
  return out;
}
