/** CAD glyphs drawn on lucide's 24px grid with matching stroke weight (from STEVE Studio's icons/cad.tsx). */
import type { ReactNode, SVGProps } from 'react';

export type CadIconProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

const make = (paths: ReactNode, displayName: string) => {
  const Icon = ({ size = 24, strokeWidth = 1.6, ...props }: CadIconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props}>
      {paths}
    </svg>
  );
  Icon.displayName = displayName;
  return Icon;
};

export const OriginIcon = make(<><path d="M12 12V3M12 12l8 5M12 12l-8 5" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /></>, 'Origin');
export const SetupIcon = make(<><path d="M3 17h18v3H3z" /><path d="M6 17V9h12v8" /><path d="M9 9V5h6v4" /></>, 'Setup');
export const ShadedEdgesIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" fill="currentColor" fillOpacity={0.22} /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>, 'ShadedEdges');
export const XrayIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" fill="currentColor" fillOpacity={0.1} /><path d="M4 7.5 12 12l8-4.5M12 12v9M4 16.5 12 12l8 4.5M12 3v9" opacity={0.6} /></>, 'Xray');
export const FaceMillIcon = make(<><path d="M4 18h16" /><path d="M7 14h10l-1 4H8Z" /><path d="M12 3v11" /></>, 'FaceMill');
export const RoughIcon = make(<><rect x="2.5" y="3.5" width="19" height="17" rx="1.5" strokeDasharray="2.2 1.8" opacity={0.6} /><rect x="9" y="9.5" width="6" height="5" rx="0.8" /><rect x="6" y="6.5" width="12" height="11" rx="2.5" opacity={0.7} /></>, 'Rough');
export const RestIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M7 15V9h10v6Z" opacity={0.45} /><path d="M7 11.5V9h2.5M17 11.5V9h-2.5M7 12.5V15h2.5M17 12.5V15h-2.5" /></>, 'Rest');
export const PocketIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.5" /><rect x="7" y="9" width="10" height="6" rx="1" /><path d="M9.5 12h5" opacity={0.6} /></>, 'Pocket');
export const ContourIcon = make(<><path d="M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" /><path d="M2.5 6.5v11a4 4 0 0 0 4 4h11" strokeDasharray="2 2" opacity={0.7} /></>, 'Contour');
export const DrillOpIcon = make(<><path d="M12 3v10" /><path d="m9 13 3 8 3-8Z" /><path d="M6 7h2M16 7h2" opacity={0.5} /></>, 'DrillOp');
export const BoreIcon = make(<><circle cx="12" cy="12" r="7.5" /><path d="M12 8.5a3.5 3.5 0 1 1-3.5 3.5" opacity={0.6} /><path d="m8.5 12-1.2-1.6M8.5 12l1.7-1" opacity={0.6} /></>, 'Bore');
export const SlotIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.5" /><rect x="6" y="10" width="12" height="4" rx="2" /><path d="M8 12h8" opacity={0.5} strokeDasharray="1.5 1.5" /></>, 'Slot');
export const EngraveIcon = make(<><path d="M3 19c2.5-4 5 1 7.5-3.5S15 12 17 10" /><path d="M15 3h5l-2.5 5.5Z" /><path d="M17.5 8.5v1.5" opacity={0.6} /></>, 'Engrave');
export const ChamferOpIcon = make(<><path d="M3 21V12l6-6h12v15Z" /><path d="M9 6 3 12" strokeWidth={2.2} opacity={0.55} /><path d="m13.5 1.5 2 2-3.5 3.5-2-2Z" opacity={0.6} /></>, 'ChamferOp');
export const ParallelFinishIcon = make(<><path d="M3 19h18" opacity={0.45} /><path d="M4 19c1.5-7.5 14.5-7.5 16 0" /><path d="M8 6v8M12 4.5v8.5M16 6v8" opacity={0.65} strokeDasharray="1.6 1.4" /></>, 'ParallelFinish');
export const WaterlineIcon = make(<><path d="M3 20h18" opacity={0.45} /><path d="M5 20c0-8.5 3-13.5 7-13.5s7 5 7 13.5" /><path d="M7 16h10M8.2 12.5h7.6M9.8 9.5h4.4" opacity={0.65} /></>, 'Waterline');
export const ToolpathIcon = make(<><path d="M4 6h14a2 2 0 0 1 0 4H6a2 2 0 0 0 0 4h12a2 2 0 0 1 0 4H4" /></>, 'Toolpath');
export const SimulateToolIcon = make(<><path d="M4 18h16" /><path d="M9 4h6v6l-3 4-3-4Z" /><path d="M5 18c1-3 3-4 7-4s6 1 7 4" opacity={0.6} /></>, 'SimulateTool');
export const PostIcon = make(<><path d="M6 3h9l4 4v14H6Z" /><path d="M9 11h2M13 11h2M9 14h6M9 17h4" /></>, 'Post');


/**
 * Operations as the studio's operation glyphs: by camlib's operation kind (camlib.operations `kind=`, what a build
 * describes) or by its class (what the code names).
 */
const OP_ICONS: Record<string, ReturnType<typeof make>> = {
  facing: FaceMillIcon, roughing: RoughIcon, adaptive: RoughIcon, adaptive_pocket: RoughIcon, pocket: PocketIcon, contour: ContourIcon,
  drilling: DrillOpIcon, reaming: DrillOpIcon, tapping: DrillOpIcon, bore: BoreIcon, thread_mill: BoreIcon, trochoidal_slot: SlotIcon,
  trace: EngraveIcon, v_carve: EngraveIcon, chamfer: ChamferOpIcon, deburr: ChamferOpIcon, parallel: ParallelFinishIcon, raster: ParallelFinishIcon,
  waterline: WaterlineIcon, flat: FaceMillIcon,
  Facing: FaceMillIcon, Pocket: PocketIcon, AdaptivePocket: PocketIcon, RestPocket: RestIcon, Roughing: RoughIcon, RestRoughing: RestIcon,
  Contour: ContourIcon, TrochoidalSlot: SlotIcon, Chamfer: ChamferOpIcon, Trace: EngraveIcon, VCarve: EngraveIcon, Drilling: DrillOpIcon,
  Bore: BoreIcon, Reaming: DrillOpIcon, Tapping: DrillOpIcon, ThreadMilling: DrillOpIcon, Parallel: ParallelFinishIcon, Waterline: WaterlineIcon,
  Scallop: ParallelFinishIcon, Pencil: ParallelFinishIcon, Spiral: ParallelFinishIcon, Radial: ParallelFinishIcon, Project: EngraveIcon,
  Morph: ParallelFinishIcon, Flat: FaceMillIcon,
};
export const OpIcon = ({ kind, size = 14 }: { kind: string | null; size?: number }) => {
  const Icon = (kind && OP_ICONS[kind]) || ToolpathIcon;
  return <Icon size={size} />;
};

/** An operation class's glyph as a component (the ribbon's buttons take an icon component). */
export const opIconOf = (cls: string) => OP_ICONS[cls] ?? ToolpathIcon;
