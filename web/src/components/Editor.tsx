/**
 * A Python editor (CodeMirror 6): the file's text, kept in step with the app's state; Ctrl/Cmd+S saves, Ctrl/Cmd+Enter
 * saves and builds. A line of a traceback can be marked and scrolled to.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
import { globalCompletion, localCompletionSource, python } from '@codemirror/lang-python';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, type DecorationSet,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

const External = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'var(--tok-kw)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--tok-str)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--tok-num)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--tok-fn)' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.function(tags.variableName))], color: 'var(--tok-fn)' },
  { tag: tags.className, color: 'var(--tok-bi)' },
  { tag: tags.comment, color: 'var(--tok-cm)', fontStyle: 'italic' },
  { tag: tags.propertyName, color: 'var(--tok-prop)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--tok-op)' },
  { tag: tags.meta, color: 'var(--tok-dec)' },
  { tag: tags.self, color: 'var(--tok-kw)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--code-bg)', color: 'var(--text-1)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--mint)' },
  '.cm-cursor': { borderLeftColor: 'var(--mint)' },
  '.cm-gutters': { backgroundColor: 'var(--code-gutter)', color: 'var(--text-4)', border: 'none', borderRight: '1px solid var(--line-1)' },
  '.cm-activeLine': { backgroundColor: 'var(--code-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-line)', color: 'var(--text-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgb(83 182 255 / 0.25) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgb(143 220 192 / 0.12)' },
  '.cm-matchingBracket': { backgroundColor: 'rgb(255 255 255 / 0.08)', outline: '1px solid var(--line-3)' },
  '.cm-errorLine': { backgroundColor: 'var(--danger-soft)', boxShadow: 'inset 2px 0 0 var(--danger)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-4)', border: '1px solid var(--line-3)', color: 'var(--text-1)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--sel-soft)', color: 'var(--text-1)' },
  '.cm-panels': { backgroundColor: 'var(--bg-3)', color: 'var(--text-1)', borderBottom: '1px solid var(--line-2)' },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'rgb(238 192 119 / 0.25)' },
}, { dark: true });

/** The marked error line (1-based; 0 clears it). */
const setErrorLine = StateEffect.define<number>();
const errorLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    // An edit clears the mark (the line it named may be fixed).
    if (transaction.docChanged) value = Decoration.none;
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorLine)) continue;
      const line = effect.value;
      value = line > 0 && line <= transaction.state.doc.lines
        ? Decoration.set([Decoration.line({ class: 'cm-errorLine' }).range(transaction.state.doc.line(line).from)])
        : Decoration.none;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function minimalChange(a: string, b: string) {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onBuild: () => void;
  readOnly?: boolean;
  python?: boolean;
  /** A line to show (1-based), marked when it's an error's, with a nonce to show the same line again. */
  reveal?: { line: number; nonce: number; error: boolean } | null;
}

export default function Editor({ value, onChange, onSave, onBuild, readOnly = false, python: isPython = true, reveal }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave, onBuild });
  useLayoutEffect(() => { handlers.current = { onChange, onSave, onBuild }; });

  useLayoutEffect(() => {
    const commands = Prec.highest(keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true; } },
      { key: 'Mod-Enter', preventDefault: true, run: () => { handlers.current.onBuild(); return true; } },
    ]));
    const extensions: Extension[] = [
      commands, lineNumbers(), foldGutter(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(),
      EditorState.tabSize.of(4), indentUnit.of('    '), indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(),
      highlightSelectionMatches(), search({ top: true }), syntaxHighlighting(highlight), theme, errorLine,
      ...(isPython ? [python(), autocompletion({ override: [localCompletionSource, globalCompletion] })] : []),
      EditorState.readOnly.of(readOnly),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ 'aria-label': 'Code', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((tr) => tr.annotation(External))) return;
        handlers.current.onChange(update.state.doc.toString());
      }),
    ];
    const created = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions }) });
    view.current = created;
    return () => { created.destroy(); view.current = null; };
    // The view is made once per file (the parent keys it); later values are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const current = view.current;
    if (!current) return;
    const text = current.state.doc.toString();
    if (text === value) return;
    current.dispatch({ changes: minimalChange(text, value), annotations: [External.of(true), isolateHistory.of('full')] });
  }, [value]);

  useEffect(() => {
    const current = view.current;
    if (!current || !reveal) return;
    const line = Math.min(Math.max(1, reveal.line), current.state.doc.lines);
    const at = current.state.doc.line(line).from;
    current.dispatch({ selection: { anchor: at }, effects: [setErrorLine.of(reveal.error ? line : 0), EditorView.scrollIntoView(at, { y: 'center' })] });
    current.focus();
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className="editor-host" />;
}
