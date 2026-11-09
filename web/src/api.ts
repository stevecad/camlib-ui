/**
 * camlib-ui's HTTP API (camlib_ui/server.py) and the shapes of what it returns: projects and their files, the part
 * tessellated for the viewer, and builds with camlib's result (camlib_ui/build/run.py).
 */

export interface Info {
  camlib: string | null; posts: string | null; posts_found: boolean; projects: string; examples: string[]; timeout_s: number;
}

export interface ProjectFile { name: string; size: number; modified: number }
export interface Project {
  name: string; files: ProjectFile[]; part: string | null; shop: string | null; program: string | null; builds?: BuildSummary[];
}

export type BuildStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface BuildSummary {
  id: string; mode: 'preview' | 'full'; status: BuildStatus; created: number; started: number | null; finished: number | null;
  error: string | null; ok?: boolean; released?: number; refused?: number;
}

export interface ToolSummary {
  id: string; name: string; shape: { kind: string; corner_radius_mm?: number; point_angle_rad?: number; included_angle_rad?: number; tip_diameter_mm?: number };
  diameter_mm: number; cutting_length_mm: number; overall_length_mm: number; shank_diameter_mm: number; flutes: number;
  stickout_mm: number; gauge_length_mm: number; holders: { z_min_mm: number; z_max_mm: number; radius_min_mm: number; radius_max_mm: number }[];
}
export interface OperationSummary {
  id: string; kind: string | null; tool: string | null; tool_number: number | null; length_register: number | null;
  spindle_rpm: number | null; feed_mm_min: number | null;
}
export interface SceneBody { id: string; role: 'fixture' | 'protected_target'; z_min_mm: number; z_max_mm: number; outlines: number[][][] }
export interface Scene {
  travel_mm: number[][]; tip_travel_mm: number[][]; work_to_machine: { origin_mm: number[]; x: number[]; y: number[]; z: number[] };
  fixtures: string[]; protected: string[]; bodies: SceneBody[];
}
export interface MachineDescription { machine: string; controller: string; post: string; units: string; decimals: number; from_shop: string[]; scene: Scene }
export interface SetupDescription {
  id: string; stock: { min_mm: number[]; max_mm: number[]; cell_size_mm: number } | null;
  tools: ToolSummary[]; operations: OperationSummary[]; machines: MachineDescription[];
}
export interface ProgramDescription { id: string; revision: string; setups: SetupDescription[]; accept: string[] }

export interface FindingDetail { kind?: string; object_id?: string; message?: string; detail?: string; depth_mm?: number; gouge?: string; residual?: string; [key: string]: unknown }
/**
 * One of camlib's findings: the move it is attributed to (moves done, 1-based; 0 before the first; null for the whole
 * program) and its severity: camlib's result status (violation, uncertain, or a kind such as unchecked_machine).
 */
export interface Finding { move: number | null; severity: string; details: FindingDetail[] }
export interface Assessment { assessment: string; definite_cells?: number; possible_only_cells?: number; volume_mm3?: [number, number] }
export interface MaterialReport { status?: string; target_id?: string; gouge?: Assessment; residual?: Assessment; [key: string]: unknown }
/** One setup posted for one machine: its G-code when camlib released it, else why it refused. */
export interface MachineResult {
  setup: string; machine: string; controller: string; post: string; moves: number; seconds: number; lines: number;
  arc_output?: Record<string, number> | null; plan_s: number; stock_remaining_mm3?: { upper: number; lower: number };
  gcode: string | null; refused: string | null; refused_kinds?: string[]; accepted?: string[];
  findings: Finding[]; finding_counts: Record<string, number>; findings_listed: number; unchecked: string[];
  checks?: { progress?: Record<string, number>; coverage?: Record<string, unknown> } | null; material?: MaterialReport | null; scene: Scene;
}
export interface OperationStats { id: string; moves: number; cut_mm: number; rapid_mm: number; seconds: number }
export interface Metadata {
  kind: 'camlib'; camlib: { version: string; commit: string | null; posts: string | null }; program: ProgramDescription;
  warnings: { severity: string; kind: string; message: string }[]; timings_ms?: Record<string, number>;
  setups?: { id: string; operations: OperationStats[]; seconds: number; machines: MachineResult[] }[];
  programs?: { setup: string; machine: string; controller: string; post: string; artifact: string | null; refused: string | null }[];
  stream?: string;
}
export interface Build extends BuildSummary { metadata?: Metadata | null; program_error?: string | null; log: string; files: Record<string, string> }

export interface PartMesh {
  positions: number[]; indices: number[]; triangle_faces: number[];
  /** A plane's outward `normal`; a cylinder's `axis`, a `center` on it and its `radius`. */
  faces: { name: string; names: string[]; type: string; area_mm2: number; normal?: number[]; axis?: number[]; center?: number[]; radius?: number }[];
  edges: number[][];
  /** Each edge's name and kind; `flat`: a line or circular arc lying in XY (what paths() follows). */
  edge_info?: { name: string; names: string[]; type: string; flat: boolean }[];
  bounds: { min: number[]; max: number[] };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch { /* not JSON */ }
    throw new ApiError(message, response.status);
  }
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('json') ? response.json() : response.text()) as Promise<T>;
}

const p = (project: string) => `/api/projects/${encodeURIComponent(project)}`;
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  info: () => call<Info>('/api/info'),
  projects: () => call<Project[]>('/api/projects'),
  createProject: (name: string, example: string | null) => call<Project>('/api/projects', json({ name, example })),
  project: (project: string) => call<Project>(p(project)),
  file: (project: string, name: string) => call<string>(`${p(project)}/files/${encodeURIComponent(name)}`, { cache: 'no-store' }),
  writeFile: (project: string, name: string, body: BodyInit) => call<Project>(`${p(project)}/files/${encodeURIComponent(name)}`, { method: 'PUT', body }),
  deleteFile: (project: string, name: string) => call<Project>(`${p(project)}/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  part: (project: string) => call<PartMesh>(`${p(project)}/part`),
  startBuild: (project: string, mode: 'preview' | 'full') => call<BuildSummary>(`${p(project)}/builds`, json({ mode })),
  builds: (project: string) => call<BuildSummary[]>(`${p(project)}/builds`),
  build: (project: string, build: string) => call<Build>(`${p(project)}/builds/${build}`),
  cancelBuild: (project: string, build: string) => call<BuildSummary>(`${p(project)}/builds/${build}/cancel`, { method: 'POST' }),
  text: (url: string) => call<string>(url),
  /** program.py as data for the forms (nothing runs). */
  outline: (code: string) => call<import('./cam/pyCode').Outline>('/api/outline', json({ code })),
  operationFields: () => call<Record<string, unknown>>('/api/operation-fields'),
  shop: (project: string) => call<{ records: unknown[] }>(`${p(project)}/shop`),
};

/** Byte ranges of a build file (the playback stream), by HTTP range requests; a server that sends it whole is served from that. */
export function rangeFetch(url: string) {
  let whole: Promise<Uint8Array> | null = null;
  return async (offset: number, length: number): Promise<Uint8Array> => {
    if (whole) return (await whole).subarray(offset, offset + length);
    const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!response.ok) throw new ApiError(`The playback stream couldn't be read (${response.status}).`, response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) return bytes;
    whole = Promise.resolve(bytes);
    return bytes.subarray(offset, offset + length);
  };
}
