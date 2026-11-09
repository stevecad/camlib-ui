/** The slim strip a collapsed side panel leaves behind (from STEVE Studio's PanelRail): one click brings any of its tabs back. */
import { Code2, ListChecks, ListTree, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { useApp } from '../state';
import { displayShortcut } from '../commands';

export default function PanelRail({ side }: { side: 'left' | 'right' }) {
  const tab = useApp((state) => state.tab);
  const failed = useApp((state) => !!state.build && (state.build.status === 'failed' || !!state.build.program_error));
  const left = side === 'left';
  const Expand = left ? PanelLeftOpen : PanelRightOpen;
  const open = (which?: 'code' | 'result') => useApp.setState(left ? { sidebarOpen: true } : { panelOpen: true, ...(which ? { tab: which } : {}) });
  const items = left
    ? [{ id: 'model', label: 'Model browser', icon: ListTree, run: () => open() }]
    : [{ id: 'code', label: 'Code', icon: Code2, run: () => open('code') }, { id: 'result', label: 'Result', icon: ListChecks, run: () => open('result') }];
  return (
    <nav className="rail" data-side={side} aria-label={left ? 'Browser panels' : 'Inspector panels'}>
      <button type="button" className="rail-button" data-rail-open={side} aria-label="Show panel" title={`Show panel (${displayShortcut(left ? 'Mod+B' : 'Mod+.')})`} onClick={() => open()}><Expand size={16} /></button>
      <span className="rail-rule" />
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.id} type="button" className="rail-button" data-rail-tab={item.id} data-last={(left || item.id === tab) || undefined} aria-label={item.label} title={item.label} onClick={item.run}>
            <Icon size={16} />
            {item.id === 'result' && failed && <span className="rail-badge" data-tone="danger" />}
          </button>
        );
      })}
    </nav>
  );
}
