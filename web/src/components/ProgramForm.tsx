/**
 * The form of an operation or a setup (from STEVE Studio's CamlibEditor.tsx), in the right panel like a CAD feature
 * dialog: an operation (its tool from the setup's tool setup, the geometry picked on the part, every value camlib takes,
 * required ones marked) or a setup (machine and tools, stock, where the tool starts, work offset, checks, and what camlib
 * needs of the machine that the shop doesn't hold). OK writes exactly that code into program.py, saves it and builds it;
 * the verdict then shows in the result.
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Code2, Crosshair, X } from 'lucide-react';
import { OpIcon, SetupIcon } from '../icons';
import { availableSpecs, fieldsOf, nestedOf, notTaken, OP_BY_CLASS, type FieldInfo, type Section as SectionKey } from '../cam/opSpecs';
import { changesInPlace, emptyNested, pointsSource, pointsText, type Nested, type OpDraft, type SetupDraft } from '../cam/forms';
import {
  closeForm, commitForm, dialectOf, machinesOf, okProblem, openNewOp, presetsOf, setOpTool, showInCode, startPicking, toolSetupsOf, toolsOf, updateOp, updateSetup, useEditor,
  useShopRecords,
} from '../cam/programEditor';
import { displayShortcut } from '../commands';

const SECTIONS: [SectionKey, string, boolean][] = [['geometry', 'Geometry', true], ['heights', 'Heights', true], ['passes', 'Passes', true], ['cutting', 'Feeds and speeds', true],
  ['options', 'Options', true], ['advanced', 'Advanced', false]];
const DEFAULT = '__default__';
const unquote = (src: string) => (/^["'].*["']$/.test(src) ? src.slice(1, -1) : src);
const fieldId = (key: string) => `form-field-${key}`;

// ── The form's parts ────────────────────────────────────────────────────

function Row({ label, field, children, sub, error, stack }: { label: string; field: string; children: ReactNode; sub?: string; error?: boolean; stack?: boolean }) {
  return (
    <div className="form-row" data-field={field} data-error={error || undefined} data-stack={stack || undefined}>
      <label htmlFor={fieldId(field)}>{label}</label>
      <div className="form-control">{children}{sub && <small>{sub}</small>}</div>
    </div>
  );
}

function Section({ title, id, defaultOpen = true, children }: { title: string; id: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="form-section" id={id} data-open={open || undefined}>
      <button type="button" className="form-section-head" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronRight size={13} />{title}</button>
      {open && <div className="form-section-body">{children}</div>}
    </section>
  );
}

function Select({ id, value, options, onChange, ariaLabel }: { id: string; value: string; options: { value: string; label: string; hint?: string }[]; onChange: (value: string) => void; ariaLabel: string }) {
  return (
    <select id={id} aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}{option.hint ? ` · ${option.hint}` : ''}</option>)}
    </select>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <span className="segmented">
      {options.map((option) => <button key={option.value} type="button" data-on={value === option.value || undefined} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </span>
  );
}

/** A list of (x, y) points as typed; kept as typed while they aren't points yet (OK waits for them). */
function PointsInput({ field, value, onChange }: { field: FieldInfo; value: string; onChange: (src: string) => void }) {
  const [text, setText] = useState(() => pointsText(value));
  return <input id={fieldId(field.key)} aria-label={field.label} placeholder="(x, y), (x, y), …" spellCheck={false} value={text}
    onChange={(event) => { setText(event.target.value); onChange(pointsSource(event.target.value) ?? event.target.value); }} />;
}

/** One value as Python source: a number (or an expression the code has), Yes/No, a choice, text, a point. */
function ValueInput({ field, value, onChange }: { field: FieldInfo; value: string; onChange: (src: string) => void }) {
  const placeholder = field.initial && field.initial !== 'None' ? `${unquote(field.initial)}` : field.required ? 'required' : 'off';
  if (field.kind === 'bool') {
    const options = [{ value: DEFAULT, label: field.required ? '—' : `Default${field.initial && field.initial !== 'None' ? ` (${field.initial === 'True' ? 'yes' : 'no'})` : ''}` }, { value: 'True', label: 'Yes' }, { value: 'False', label: 'No' }];
    return <Segmented value={value || DEFAULT} options={options} onChange={(next) => onChange(next === DEFAULT ? '' : next)} />;
  }
  if (field.kind === 'choice') {
    const options = [...(field.required ? [] : [{ value: DEFAULT, label: `Default (${field.choices!.find(([key]) => key === unquote(field.initial ?? ''))?.[1] ?? 'none'})` }]),
      ...field.choices!.map(([key, label]) => ({ value: `"${key}"`, label }))];
    return <Select ariaLabel={field.label} id={fieldId(field.key)} value={(value.replace(/'/g, '"') || (field.required ? '' : DEFAULT)) as string} options={field.required && !value ? [{ value: '', label: 'Choose…' }, ...options] : options}
      onChange={(next) => onChange(next === DEFAULT ? '' : next)} />;
  }
  if (field.kind === 'point') {
    const parts = value.replace(/^[([]|[)\]]$/g, '').split(',').map((item) => item.trim());
    const set = (i: number, text: string) => { const next = [parts[0] ?? '', parts[1] ?? '']; next[i] = text; onChange(next.every((item) => !item) ? '' : `(${next[0] || '0'}, ${next[1] || '0'})`); };
    return (
      <div className="form-xyz">
        {['X', 'Y'].map((axis, i) => <input key={axis} id={`${fieldId(field.key)}${i ? `-${axis.toLowerCase()}` : ''}`} aria-label={`${field.label} ${axis}`} placeholder={axis} inputMode="decimal"
          value={parts[i] ?? ''} onChange={(event) => set(i, event.target.value.trim())} />)}
      </div>
    );
  }
  if (field.kind === 'points') return <PointsInput field={field} value={value} onChange={onChange} />;
  const numeric = field.kind === 'number' || field.kind === 'integer';
  return <input id={fieldId(field.key)} aria-label={field.label} placeholder={placeholder} inputMode={numeric ? 'decimal' : undefined} spellCheck={false}
    value={field.kind === 'text' ? unquote(value) : value} onChange={(event) => { const text = event.target.value; onChange(field.kind === 'text' && text.trim() ? JSON.stringify(text) : text.trim()); }} />;
}

const label = (field: FieldInfo) => `${field.label}${field.unit ? ` (${field.unit})` : ''}${field.required ? ' *' : ''}`;
const badValue = (field: FieldInfo, value: string) => (field.kind === 'number' || field.kind === 'integer') && !!value && !/^-?[\d.]+(e-?\d+)?$/i.test(value) && !/[a-z_(]/i.test(value);
/**
 * A field the chosen path doesn't take (opSpecs notTaken): not shown while empty; one that holds a value is shown marked,
 * with why, so it can be cleared (camlib refuses the program otherwise, and says so).
 */
const refusedNote = (why: string) => `${why}: camlib refuses this value. Clear it.`;

/** An option object (an entry, the clearing, tabs, fine boring): its kind, then its own values. */
function NestedField({ field, owner, nested, onChange }: { field: FieldInfo; owner: string; nested: Nested | undefined; onChange: (next: Nested | undefined) => void }) {
  const choice = nestedOf(owner, field.key)!;
  // What this operation takes; a class the code already holds stays listed (camlib says so if it refuses it).
  const classes = nested?.cls && !choice.classes.includes(nested.cls) ? [...choice.classes, nested.cls] : choice.classes;
  const options = [...(field.required ? [] : [{ value: DEFAULT, label: field.initial && field.initial !== 'None' ? 'Default' : choice.none ?? 'None' }]), ...(choice.none && !field.required && field.initial !== 'None' ? [{ value: 'None', label: choice.none }] : []),
    ...classes.map((cls) => ({ value: cls, label: choice.classes.includes(cls) ? choice.label(cls) : `${choice.label(cls)} (set in code)` }))];
  const value = nested === undefined ? DEFAULT : nested.cls ?? 'None';
  const unused = notTaken(nested?.cls, nested?.values ?? {});
  return (
    <>
      <Row label={label(field)} field={field.key}>
        <Select ariaLabel={field.label} id={fieldId(field.key)} value={field.required && !nested ? '' : value} options={field.required && !nested ? [{ value: '', label: 'Choose…' }, ...options] : options}
          onChange={(next) => onChange(next === DEFAULT ? undefined : next === 'None' ? emptyNested(null) : emptyNested(next))} />
      </Row>
      {nested?.cls && fieldsOf(nested.cls).filter((inner) => !unused.has(inner.key) || (nested.values[inner.key] ?? '').trim()).map((inner) => (inner.kind === 'nested'
        ? <NestedField key={inner.key} field={inner} owner={nested.cls!} nested={nested.nested[inner.key]} onChange={(next) => { const all = { ...nested.nested }; if (next) all[inner.key] = next; else delete all[inner.key]; onChange({ ...nested, nested: all }); }} />
        : (
          <Row key={inner.key} label={`· ${label(inner)}`} field={`${field.key}.${inner.key}`} error={unused.has(inner.key)} sub={unused.has(inner.key) ? refusedNote(unused.get(inner.key)!) : inner.help}>
            <ValueInput field={inner} value={nested.values[inner.key] ?? ''} onChange={(src) => onChange({ ...nested, values: { ...nested.values, [inner.key]: src } })} />
          </Row>
        )))}
    </>
  );
}

function GeometryField({ field, draft }: { field: FieldInfo; draft: OpDraft }) {
  const picking = useEditor((state) => state.picking);
  const geometry = draft.geometry[field.key];
  const kind = OP_BY_CLASS[draft.cls].geometry[field.key];
  if (kind === 'surface') {
    return <Row label={label(field)} field={field.key}><span className="form-ref" id={fieldId(field.key)}><span>{geometry?.src && !geometry.whole ? geometry.src : 'The whole part'}</span></span></Row>;
  }
  const active = picking === field.key;
  const prompt = { region: 'Click flat faces of the part', holes: 'Click hole walls, in order', paths: 'Click edges (or a flat face for its outline)', path: 'Click a chain of edges', point: '', surface: '' }[kind];
  const shown = geometry?.names?.length ? geometry.names.join(', ') : geometry?.points ? geometry.points.map(([x, y]) => `(${x}, ${y})`).join(' ') : geometry?.shown ?? geometry?.src ?? '';
  const empty = !shown;
  const clear = () => updateOp((d) => { const all = { ...d.geometry }; delete all[field.key]; return { ...d, geometry: all }; });
  return (
    <Row label={label(field)} field={field.key} stack>
      <div className="form-ref" data-empty={empty || undefined} data-picking={active || undefined} id={fieldId(field.key)}>
        <span title={shown}>{active ? `${prompt}…${shown ? ` ${shown}` : ''}` : shown || 'Nothing picked'}</span>
        {!empty && <button type="button" className="icon-button small" aria-label={`Clear ${field.label}`} title="Clear" onClick={clear}><X size={13} /></button>}
        <button type="button" className="icon-button small" id={`${fieldId(field.key)}-pick`} data-on={active || undefined} aria-label={active ? 'Done picking' : `Pick ${field.label.toLowerCase()}`}
          title={active ? 'Done picking' : 'Pick on the part'} onClick={() => startPicking(field.key)}><Crosshair size={13} /></button>
      </div>
    </Row>
  );
}

// ── An operation ────────────────────────────────────────────────────────

function OpForm({ draft, tooling, workOffset }: { draft: OpDraft; tooling: string | null; workOffset: number }) {
  useShopRecords((state) => state.records);
  const shopError = useShopRecords((state) => state.error);
  const spec = OP_BY_CLASS[draft.cls];
  const all = toolsOf(tooling);
  const fits = all.filter((tool) => tool.cutter && spec.cutters.includes(tool.cutter));
  const tool = all.find((item) => item.key === draft.tool);
  const fields = fieldsOf(draft.cls).filter((field) => !['id', 'tool', 'tool_number', 'length_register', 'work_offset'].includes(field.key));
  const presets = presetsOf(tool?.cutterKey ?? null);
  const set = (key: string) => (src: string) => updateOp((d) => ({ ...d, values: { ...d.values, [key]: src } }));
  const takesFeed = fields.some((field) => field.key === 'feed_mm_min');
  const unused = notTaken(draft.cls, draft.values);
  return (
    <>
      <p className="form-note">{spec.about}</p>
      <div className="form-head-fields">
        <Row label="Name *" field="id"><input id={fieldId('id')} aria-label="Name" value={draft.id} onChange={(event) => updateOp((d) => ({ ...d, id: event.target.value }))} /></Row>
        <Row label="Tool *" field="tool" sub={tool ? `T${tool.number ?? '?'} H${tool.register ?? '?'}${tool.diameter ? ` · Ø${tool.diameter} mm` : ''}${workOffset !== 1 ? ` · work offset ${workOffset}` : ''}` : undefined}>
          <Select ariaLabel="Tool" id={fieldId('tool')} value={draft.tool ?? ''} onChange={(key) => setOpTool(key || null)}
            options={[{ value: '', label: fits.length ? 'Choose a tool…' : 'No tool of this kind in the tool setup' },
              ...fits.map((item) => ({ value: item.key, label: `T${item.number ?? '?'} ${item.name}`, hint: item.diameter ? `Ø${item.diameter}` : undefined })),
              ...(draft.tool && !tool ? [{ value: draft.tool, label: `${draft.tool} (not in the tool setup)` }] : [])]} />
        </Row>
        {!tooling && <p className="form-hint" data-tone="warn">The setup’s machine has no tool setup: set it in the setup.</p>}
        {shopError && <p className="form-hint" data-tone="warn">The shop couldn’t be read: {shopError}</p>}
      </div>
      {SECTIONS.map(([section, title, open]) => {
        const mine = fields.filter((field) => field.section === section && (!unused.has(field.key) || (draft.values[field.key] ?? '').trim()));
        if (!mine.length) return null;
        return (
          <Section key={section} title={title} defaultOpen={open || mine.some((field) => field.required)} id={`form-section-${section}`}>
            {section === 'cutting' && takesFeed && presets.length > 0 && tool && (
              <p className="form-note" id="form-presets">
                {presets.map((preset) => {
                  const rpm = preset.speed && tool.diameter ? Math.min(preset.rpm ?? Infinity, Math.floor((1000 * preset.speed) / (Math.PI * tool.diameter))) : preset.rpm;
                  const feed = rpm && preset.perTooth && tool.flutes ? Math.floor(rpm * preset.perTooth * tool.flutes) : null;
                  return (
                    <button key={preset.key} type="button" className="chip" title={`The most ${preset.name} allows${preset.material ? ` in ${preset.material}` : ''}`}
                      onClick={() => updateOp((d) => ({ ...d, values: { ...d.values, ...(rpm ? { spindle_rpm: String(rpm) } : {}), ...(feed ? { feed_mm_min: String(feed) } : {}) } }))}>
                      Use {preset.name}{preset.material ? ` (${preset.material})` : ''}: {rpm ? `S${rpm}` : ''}{feed ? ` F${feed}` : ''}
                    </button>
                  );
                })}
              </p>
            )}
            {mine.map((field) => (field.kind === 'geometry' ? <GeometryField key={field.key} field={field} draft={draft} />
              : field.kind === 'nested' ? <NestedField key={field.key} field={field} owner={draft.cls} nested={draft.nested[field.key]} onChange={(next) => updateOp((d) => { const nested = { ...d.nested }; if (next) nested[field.key] = next; else delete nested[field.key]; return { ...d, nested }; })} />
                : (
                  <Row key={field.key} label={label(field)} field={field.key} error={unused.has(field.key) || badValue(field, draft.values[field.key] ?? '')}
                    sub={unused.has(field.key) ? refusedNote(unused.get(field.key)!) : field.help}>
                    <ValueInput field={field} value={draft.values[field.key] ?? ''} onChange={set(field.key)} />
                  </Row>
                )))}
          </Section>
        );
      })}
    </>
  );
}

// ── A setup ─────────────────────────────────────────────────────────────

const PLANES = ['xy', 'xz', 'yz'];
const yesNo = [{ value: '', label: '—' }, { value: 'True', label: 'Yes' }, { value: 'False', label: 'No' }];

function SetupForm({ draft, isNew }: { draft: SetupDraft; isNew: boolean }) {
  useShopRecords((state) => state.records);
  const shopError = useShopRecords((state) => state.error);
  const machines = machinesOf(), toolSetups = toolSetupsOf();
  const patch = (change: Partial<SetupDraft>) => updateSetup((d) => ({ ...d, ...change }));
  const premise = (key: string) => (src: string) => updateSetup((d) => ({ ...d, premises: { ...d.premises, [key]: src } }));
  const xyz = (key: 'stockMin' | 'stockMax' | 'start', name: string) => (
    <Row label={name} field={key}>
      <div className="form-xyz">
        {['X', 'Y', 'Z'].map((axis, i) => <input key={axis} id={i ? `form-${key}-${axis.toLowerCase()}` : fieldId(key)} aria-label={`${name} ${axis}`} placeholder={axis} inputMode="decimal" value={draft[key][i]}
          onChange={(event) => { const next = [...draft[key]]; next[i] = event.target.value.trim(); patch({ [key]: next } as Partial<SetupDraft>); }} />)}
      </div>
    </Row>
  );
  const planes = (draft.premises.planes ?? '').match(/"(\w+)"/g)?.map((item) => item.slice(1, -1)) ?? [];
  const iso = dialectOf(draft.machine) === 'iso_declared_milling_v1';
  const zeroMatch = /^WorkFrame\(\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+)\)\)$/.exec(draft.premises.work_to_machine ?? '');
  const zero = zeroMatch ? zeroMatch.slice(1, 4).map((item) => item.trim()) : ['', '', ''];
  const zeroInCode = !!draft.premises.work_to_machine && !zeroMatch;
  return (
    <>
      <div className="form-head-fields">
        <Row label="Name *" field="id"><input id={fieldId('id')} aria-label="Setup name" value={draft.id} onChange={(event) => patch({ id: event.target.value })} /></Row>
        <Row label="Machine *" field="machine">
          <Select ariaLabel="Machine" id={fieldId('machine')} value={draft.machine ?? ''} onChange={(key) => patch({ machine: key || null })}
            options={[{ value: '', label: machines.length ? 'Choose…' : 'No machine in shop.py' }, ...machines.map((item) => ({ value: item.key, label: item.name, hint: item.hint }))]} />
        </Row>
        <Row label="Tool setup *" field="tooling">
          <Select ariaLabel="Tool setup" id={fieldId('tooling')} value={draft.tooling ?? ''} onChange={(key) => patch({ tooling: key || null })}
            options={[{ value: '', label: toolSetups.length ? 'Choose…' : 'No tool setup in shop.py' }, ...toolSetups.map((item) => ({ value: item.key, label: item.name }))]} />
        </Row>
        {iso && <Row label="Post *" field="post"><Select ariaLabel="Post" id={fieldId('post')} value={draft.premises.post ?? ''} onChange={premise('post')} options={[{ value: '', label: 'Choose…' }, { value: '"haas_ngc"', label: 'Haas NGC' }, { value: '"fanuc_0i_mb"', label: 'FANUC 0i-MB' }]} /></Row>}
        {shopError && <p className="form-hint" data-tone="warn">The shop couldn’t be read: {shopError}</p>}
      </div>
      <Section title="Stock" id="form-section-stock">
        {xyz('stockMin', 'Lowest corner (mm)')}
        {xyz('stockMax', 'Highest corner (mm)')}
        <Row label="Grid (mm)" field="cell" sub="camlib checks the stock on cells of this size"><input id={fieldId('cell')} aria-label="Stock grid" placeholder="0.1" inputMode="decimal" value={draft.cell} onChange={(event) => patch({ cell: event.target.value.trim() })} /></Row>
        <p className="form-note">The part’s own coordinates are the program’s: its origin is the G-code’s zero.</p>
        {xyz('start', 'Tool starts at (mm)')}
        <Row label="Work offset *" field="workOffset" sub="1 is G54"><input id={fieldId('workOffset')} aria-label="Work offset" inputMode="numeric" value={draft.workOffset} onChange={(event) => patch({ workOffset: event.target.value.trim() })} /></Row>
      </Section>
      <Section title="Checks" id="form-section-checks">
        <label className="form-check"><input type="checkbox" id="form-stock-contact" checked={draft.stockContact} onChange={(event) => patch({ stockContact: event.target.checked })} />Every move against the stock (no rapid into material)</label>
        <label className="form-check"><input type="checkbox" id="form-material" checked={draft.material} onChange={(event) => patch({ material: event.target.checked })} />The finished stock against the part (gouges)</label>
        {draft.material && <p className="form-hint" data-tone="warn">This check can’t yet decide the stock along walls the program cuts: a part with such walls comes out uncertain and its G-code isn’t released.</p>}
        {draft.read && (draft.read.material || draft.read.stockContact) && draft.stockContact === draft.read.stockContact && draft.material === draft.read.material
          && <p className="form-note">The checks’ own options in the code stay as they are.</p>}
      </Section>
      <Section title="Machine" id="form-section-premises">
        <p className="form-note">What the program needs to know of the machine that shop.py doesn’t hold: ask the machinist.</p>
        <Row label="Work zero on the machine (mm) *" field="work_to_machine" sub="The work offset's X Y Z: where the part's origin sits in machine coordinates">
          <div className="form-xyz">
            {['X', 'Y', 'Z'].map((axis, i) => <input key={axis} id={i ? `form-zero-${axis.toLowerCase()}` : fieldId('work_to_machine')} aria-label={`Work zero ${axis}`} placeholder={axis} inputMode="decimal"
              value={zero[i] ?? ''} onChange={(event) => { const next = [zero[0] ?? '', zero[1] ?? '', zero[2] ?? '']; next[i] = event.target.value.trim(); premise('work_to_machine')(next.every((item) => item) ? `WorkFrame((${next.join(', ')}))` : next.some((item) => item) ? `WorkFrame((${next.map((item) => item || '0').join(', ')}))` : ''); }} />)}
          </div>
        </Row>
        {zeroInCode && <p className="form-hint">Set in code: {draft.premises.work_to_machine}</p>}
        <Row label="Flood coolant *" field="flood"><Select ariaLabel="Flood coolant" id={fieldId('flood')} value={draft.premises.flood ?? ''} options={yesNo} onChange={premise('flood')} /></Row>
        <Row label="Mist coolant *" field="mist"><Select ariaLabel="Mist coolant" id={fieldId('mist')} value={draft.premises.mist ?? ''} options={yesNo} onChange={premise('mist')} /></Row>
        <Row label="Arc planes *" field="planes">
          <div className="form-planes">
            {PLANES.map((plane) => <label key={plane}><input type="checkbox" id={`form-plane-${plane}`} checked={planes.includes(plane)}
              onChange={(event) => { const next = PLANES.filter((item) => (item === plane ? event.target.checked : planes.includes(item))); premise('planes')(next.length ? `(${next.map((item) => `"${item}"`).join(', ')}${next.length === 1 ? ',' : ''})` : '()'); }} /> {plane.toUpperCase()}</label>)}
          </div>
        </Row>
        <Row label="Arcs (G2/G3) *" field="arcs"><Select ariaLabel="Arcs" id={fieldId('arcs')} value={draft.premises.arcs ?? ''} options={yesNo} onChange={premise('arcs')} /></Row>
        <Row label="Helices *" field="helices"><Select ariaLabel="Helices" id={fieldId('helices')} value={draft.premises.helices ?? ''} options={yesNo} onChange={premise('helices')} /></Row>
        <Row label="Longest arc *" field="max_sweep_rad"><Select ariaLabel="Longest arc" id={fieldId('max_sweep_rad')} value={draft.premises.max_sweep_rad ?? ''} onChange={premise('max_sweep_rad')}
          options={[{ value: '', label: 'Choose…' }, { value: 'math.tau', label: 'Full circle' }, { value: 'math.pi', label: 'Half circle' }, { value: 'math.pi / 2', label: 'Quarter circle' },
            ...(draft.premises.max_sweep_rad && !['math.tau', 'math.pi', 'math.pi / 2'].includes(draft.premises.max_sweep_rad) ? [{ value: draft.premises.max_sweep_rad, label: draft.premises.max_sweep_rad }] : [])]} /></Row>
        <Row label="Highest tool number *" field="max_tool_number"><input id={fieldId('max_tool_number')} aria-label="Highest tool number" inputMode="numeric" value={draft.premises.max_tool_number ?? ''} onChange={(event) => premise('max_tool_number')(event.target.value.trim())} /></Row>
        <Row label="Highest length register *" field="max_length_register"><input id={fieldId('max_length_register')} aria-label="Highest length register" inputMode="numeric" value={draft.premises.max_length_register ?? ''} onChange={(event) => premise('max_length_register')(event.target.value.trim())} /></Row>
        <Row label="At a tool change *" field="tool_change_position_mode">
          <Select ariaLabel="At a tool change" id={fieldId('tool_change_position_mode')} value={draft.premises.tool_change_position_mode ?? ''} onChange={premise('tool_change_position_mode')}
            options={[{ value: '', label: 'Choose…' }, { value: '"preserve_tip"', label: 'The tip returns where it was' }, { value: '"preserve_spindle"', label: 'In place: the spindle stays where it was' },
              ...(draft.premises.tool_change_position_mode && !['"preserve_tip"', '"preserve_spindle"'].includes(draft.premises.tool_change_position_mode) ? [{ value: draft.premises.tool_change_position_mode, label: `${unquote(draft.premises.tool_change_position_mode)} (set in code)` }] : [])]} />
        </Row>
        {changesInPlace(draft) && <p className="form-note">No axis moves at a tool change: the new tool’s tip is the old one’s, moved along Z by the difference of their gauge lengths. The setup is planned that way (tool_change=ToolChangeInPlace()).</p>}
        <Row label="Arcs in the G-code" field="lowering" sub="On a control of few decimals some arcs can’t be written exactly">
          <Select ariaLabel="Arcs in the G-code" id={fieldId('lowering')} value={draft.premises.lowering ?? ''} onChange={premise('lowering')}
            options={[{ value: '', label: 'The post’s own way' }, { value: 'LoweringOptions(native_arcs=True)', label: 'Arcs where exact, else checked lines' }, { value: 'LoweringOptions()', label: 'Checked lines only' },
              ...(draft.premises.lowering && !['LoweringOptions(native_arcs=True)', 'LoweringOptions()'].includes(draft.premises.lowering) ? [{ value: draft.premises.lowering, label: 'Set in code' }] : [])]} />
        </Row>
      </Section>
      {isNew && <p className="form-note">Next: its first operation. The setup is saved with it.</p>}
    </>
  );
}

/** A new setup's first operation: what to add (camlib's setups hold at least one); the setup is saved with it. */
function FirstOperation() {
  return (
    <div id="form-first">
      <p className="form-note">Choose the setup’s first operation: the setup is saved with it.</p>
      {(['2D', 'Holes', '3D'] as const).map((group) => (
        <Section key={group} title={group} id={`form-first-${group}`}>
          <div className="form-op-grid">
            {availableSpecs().filter((spec) => spec.group === group).map((spec) => (
              <button key={spec.cls} type="button" className="button small" id={`form-first-${spec.cls}`} title={spec.about} onClick={() => void openNewOp(spec.cls)}>
                <OpIcon kind={spec.cls} size={14} />{spec.label}
              </button>
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

export default function ProgramForm() {
  const form = useEditor((state) => state.form);
  const saving = useEditor((state) => state.saving);
  const message = useEditor((state) => state.message);
  const picking = useEditor((state) => state.picking);
  useEffect(() => () => { useEditor.setState({ picking: null }); }, []);
  if (!form) return null;
  const first = form.mode === 'first';
  const problem = okProblem(form);
  const newProgram = form.mode === 'setup' && form.newProgram;
  const title = form.mode === 'op' ? `${form.editing ? 'Edit' : 'New'} ${OP_BY_CLASS[form.draft.cls].label.toLowerCase()}` : first ? 'First operation'
    : newProgram ? 'New program' : form.editing ? 'Edit setup' : 'New setup';
  const next = form.mode === 'setup' && !form.editing;
  const okTitle = next ? 'Next: the setup’s first operation' : form.mode === 'op' ? 'Write the operation into program.py and build it' : 'Write the setup into program.py and build it';
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (picking) startPicking(null); else closeForm();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (!first) void commitForm();
    }
  };
  return (
    <section className="program-form" id="program-form" data-mode={form.mode} data-class={form.mode === 'op' ? form.draft.cls : undefined} onKeyDown={onKey}>
      <header className="form-title">
        {form.mode === 'op' ? <OpIcon kind={form.draft.cls} size={16} /> : <SetupIcon size={16} />}
        <h3>{title}</h3>
        {form.mode !== 'first' && !newProgram && (
          <button type="button" className="icon-button small" title="The program’s code" aria-label="Edit code"
            onClick={() => { const id = form.mode === 'op' ? form.editing : form.editing; closeForm(); void showInCode(id ?? 'program'); }}><Code2 size={14} /></button>
        )}
        <button type="button" className="icon-button small" aria-label="Close" title="Close (Esc)" onClick={closeForm}><X size={14} /></button>
      </header>
      <div className="form-body">
        {form.mode === 'op' ? <OpForm draft={form.draft} tooling={form.tooling} workOffset={form.workOffset} />
          : form.mode === 'setup' ? <SetupForm draft={form.draft} isNew={next} /> : <FirstOperation />}
        {(message || (problem && !first)) && (
          <div className="form-message" data-tone={message ? 'danger' : undefined} role={message ? 'alert' : undefined} id="form-message">
            {message && <AlertTriangle size={13} />}<span>{message ?? problem}</span>
          </div>
        )}
      </div>
      <footer className="form-footer">
        <button type="button" className="button" id="form-cancel" onClick={closeForm}>Cancel</button>
        {!first && (
          <button type="button" className="button primary" id="form-ok" disabled={!!problem || saving} title={problem ?? `${okTitle} (${displayShortcut('Mod+Enter')})`} onClick={() => void commitForm()}>
            {saving ? <span className="spinner" /> : null}{next ? 'Next' : 'OK'}
          </button>
        )}
      </footer>
    </section>
  );
}
