/**
 * The floating view bar (from STEVE Studio's NavBar and ViewTools): fit, the standard views, the display style with the
 * grid and origin, perspective or orthographic, keep Z up, and the shortcuts and navigation settings.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { Box, ChevronDown, Focus, Grid3x3, Keyboard, Move3d, Scissors, Settings } from 'lucide-react';
import { displayShortcut, runCommand } from '../commands';
import { useApp } from '../state';
import { useSetting } from '../settings';
import { useView, viewer, VIEW_LABELS, type DisplayStyle, type StandardView } from './viewer';

const STYLES: { value: DisplayStyle; label: string }[] = [
  { value: 'shaded-edges', label: 'Shaded with edges' },
  { value: 'shaded', label: 'Shaded' },
  { value: 'hidden-line', label: 'Hidden line' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'xray', label: 'X-ray' },
];
const VIEWS: { value: StandardView; key: string }[] = [
  { value: 'iso', key: '0' }, { value: 'front', key: '1' }, { value: 'back', key: '2' }, { value: 'left', key: '3' },
  { value: 'right', key: '4' }, { value: 'top', key: '5' }, { value: 'bottom', key: '6' },
];

/** A button that opens a small menu above it; a choice or a click elsewhere closes it. */
function Menu({ label, icon, children, id }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode; id: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  return (
    <div className="nav-menu" ref={box}>
      <button type="button" className="nav-button" aria-label={label} title={label} aria-expanded={open} id={id} onClick={() => setOpen(!open)}>{icon}<ChevronDown size={10} /></button>
      {open && <div className="nav-menu-list" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function Item({ label, shortcut, checked, onSelect }: { label: string; shortcut?: string; checked?: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={!!checked} className="nav-menu-item" data-on={checked || undefined} onClick={onSelect}>
      <span className="check">{checked ? '✓' : ''}</span><span>{label}</span>{shortcut && <kbd>{displayShortcut(shortcut)}</kbd>}
    </button>
  );
}

/** Whether a cut along an axis is flipped so the half taken away is the one towards the camera: the cut face is what's seen. */
function flipFor(axis: 'x' | 'y' | 'z') {
  if (!viewer.camera) return false;
  const away = viewer.camera.getWorldDirection(new THREE.Vector3());
  return away[axis] > 0;
}

export default function NavBar({ disabled }: { disabled: boolean }) {
  const { view, style, projection, showGrid, showOrigin, section } = useView();
  const cut = (patch: Partial<typeof section>) => useView.setState({ section: { ...section, ...patch } });
  const lockZUp = useSetting('viewport.lockZUp');
  return (
    <div className="navbar" role="toolbar" aria-label="View tools" data-disabled={disabled || undefined} id="navbar">
      <button type="button" className="nav-button" title="Fit all (F)" aria-label="Fit all" id="fit" onClick={() => viewer.fit()}><Focus size={16} /></button>
      <Menu label="Standard views" icon={<Box size={16} />} id="views-menu">
        {(close) => <>
          <div className="nav-menu-label">Standard views</div>
          {VIEWS.map((item) => <Item key={item.value} label={VIEW_LABELS[item.value]} shortcut={item.key} checked={view === item.value} onSelect={() => { viewer.setView(item.value); close(); }} />)}
        </>}
      </Menu>
      <span className="nav-sep" />
      <Menu label="Display style (V)" icon={<Grid3x3 size={16} />} id="style-menu">
        {(close) => <>
          <div className="nav-menu-label">Visual style</div>
          {STYLES.map((item) => <Item key={item.value} label={item.label} checked={style === item.value} onSelect={() => { useView.setState({ style: item.value }); close(); }} />)}
          <div className="nav-menu-sep" />
          <div className="nav-menu-label">Environment</div>
          <Item label="Ground grid" shortcut="G" checked={showGrid} onSelect={() => useView.setState({ showGrid: !showGrid })} />
          <Item label="Origin" shortcut="O" checked={showOrigin} onSelect={() => useView.setState({ showOrigin: !showOrigin })} />
        </>}
      </Menu>
      <button type="button" className="nav-button nav-text" data-on={projection === 'perspective' || undefined} id="projection"
        title="Toggle between orthographic and perspective projection (P)" onClick={() => runCommand('view.projection')}>{projection === 'orthographic' ? 'Ortho' : 'Persp'}</button>
      <button type="button" className="nav-button" data-on={lockZUp || undefined} title="Keep Z up when orbiting (U)" aria-label="Keep Z up when orbiting" id="lock-z" onClick={() => runCommand('view.lockZUp')}><Move3d size={16} /></button>
      <button type="button" className="nav-button" data-on={section.enabled || undefined} title="Section view: cut everything shown with a plane; drag the plane to move it"
        aria-label="Section view" aria-pressed={section.enabled} id="section" onClick={() => cut(section.enabled ? { enabled: false } : { enabled: true, flip: flipFor(section.axis) })}><Scissors size={16} /></button>
      {section.enabled && <>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <button key={axis} type="button" className="nav-button nav-axis" data-on={section.axis === axis || undefined} aria-pressed={section.axis === axis}
            title={`Cut along ${axis.toUpperCase()}`} id={`section-${axis}`} onClick={() => cut({ axis, offset: 0.5, flip: flipFor(axis) })}>{axis.toUpperCase()}</button>
        ))}
        <button type="button" className="nav-button nav-text" data-on={section.flip || undefined} aria-pressed={section.flip} title="Show the other side of the cut" id="section-flip"
          onClick={() => cut({ flip: !section.flip })}>Flip</button>
      </>}
      <span className="nav-sep" />
      <button type="button" className="nav-button" title="Navigation settings (Mod+,)" aria-label="Navigation settings" onClick={() => useApp.setState({ dialog: 'settings' })}><Settings size={16} /></button>
      <button type="button" className="nav-button" title="Keyboard and mouse (?)" aria-label="Keyboard and mouse" onClick={() => useApp.setState({ dialog: 'shortcuts' })}><Keyboard size={16} /></button>
    </div>
  );
}
