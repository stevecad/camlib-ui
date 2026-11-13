/**
 * The 3D view, in the program's work coordinates (millimetres, Z up): the part (click a face for its name), the stock
 * (its box from the program, or as cut from a full build's playback stream), the fixtures the program placed, the
 * toolpath, the tool at the playback position and camlib's findings where they are. Drawing only: camlib decided.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { Copy, EyeOff } from 'lucide-react';
import { CameraRig, Interaction } from '../viewport/CameraRig';
import ViewCube from '../viewport/ViewCube';
import NavBar from '../viewport/NavBar';
import { useView, viewer } from '../viewport/viewer';
import { pickedGeometry, pickIntoForm, useEditor, usePickingKind } from '../cam/programEditor';
import { showAllPaths, useApp, usePaths, usePlayer, type PlayerSource } from '../state';
import type { MachineResult, PartMesh, SetupDescription } from '../api';
import { MOVE_KINDS, tipAt, type Motion } from '../cam/motion';
import { drawRanges, hiddenCount, hiddenOwners, ownerRuns } from '../cam/pathVisibility';
import { toolpathLines } from '../cam/toolpathLines';
import { fieldGrid, HeightStockView } from '../cam/heightStock';
import { findingMove, severityOf, simPlan, simPosition, toolProfile, type SimPlan } from '../cam/playback';
import type { SimReply, SimRequest } from '../cam/stockSim.worker';
import { isTurned } from '../cam/stream';
import { TurnedBar, TurnedStock, TurningTool } from './TurningView';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/** Toolpath colours by move kind (the player's legend uses the same). */
export const KIND_COLORS: Record<(typeof MOVE_KINDS)[number], string> = {
  rapid: '#ffd23f', feed: '#3b9eff', plunge: '#ff7a45', lead: '#36cfc9', link: '#b37feb', retract: '#e6b422',
};
export const SEVERITY_COLORS = { violation: '#ef4444', uncertain: '#f59e0b', unchecked: '#94a3b8' } as const;

// ── Part ────────────────────────────────────────────────────────────────────

function PartView({ mesh, translucent }: { mesh: PartMesh; translucent: boolean }) {
  const picked = useApp((state) => state.picked);
  const geometry = useMemo(() => {
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
    out.setIndex(mesh.indices);
    out.computeVertexNormals();
    return out;
  }, [mesh]);
  const edges = useMemo(() => {
    const positions: number[] = [];
    for (const edge of mesh.edges) for (let i = 3; i < edge.length; i += 3) positions.push(edge[i - 3], edge[i - 2], edge[i - 1], edge[i], edge[i + 1], edge[i + 2]);
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return out;
  }, [mesh]);
  const highlight = useMemo(() => {
    if (!picked) return null;
    const index: number[] = [];
    mesh.triangle_faces.forEach((face, t) => { if (face === picked.face) index.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]); });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', geometry.getAttribute('position'));
    out.setIndex(index);
    return out;
  }, [picked, mesh, geometry]);
  // What the form's field being picked holds: its faces filled, its edges drawn bold.
  const field = useEditor((state) => (state.form?.mode === 'op' && state.picking ? state.form.draft.geometry[state.picking] : null));
  const kind = usePickingKind();
  const chosen = useMemo(() => {
    if (!kind) return null;
    const { faces, edges: lines } = pickedGeometry(mesh, field?.names ?? []);
    const index: number[] = [];
    mesh.triangle_faces.forEach((face, t) => { if (faces.has(face - 1)) index.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]); });
    const fill = new THREE.BufferGeometry();
    fill.setAttribute('position', geometry.getAttribute('position'));
    fill.setIndex(index);
    const positions: number[] = [];
    for (const e of lines) { const edge = mesh.edges[e]; for (let i = 3; i < edge.length; i += 3) positions.push(edge[i - 3], edge[i - 2], edge[i - 1], edge[i], edge[i + 1], edge[i + 2]); }
    const line = new THREE.BufferGeometry();
    line.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return { fill, line, segments: positions.length / 3 };
  }, [kind, field, mesh, geometry]);
  useEffect(() => () => { geometry.dispose(); edges.dispose(); }, [geometry, edges]);
  useEffect(() => () => highlight?.dispose(), [highlight]);
  useEffect(() => () => { chosen?.fill.dispose(); chosen?.line.dispose(); }, [chosen]);
  const down = useRef<[number, number] | null>(null);
  const click = (event: ThreeEvent<MouseEvent>) => {
    // A click, not the end of an orbit drag.
    if (down.current && Math.hypot(event.nativeEvent.clientX - down.current[0], event.nativeEvent.clientY - down.current[1]) > 4) return;
    event.stopPropagation();
    const face = event.faceIndex != null ? mesh.triangle_faces[event.faceIndex] : null;
    if (!face) return;
    const point: [number, number, number] = [event.point.x, event.point.y, event.point.z];
    // A form waiting for geometry takes the click; otherwise it picks the face (its names show).
    if (pickIntoForm(face, point)) return;
    useApp.setState({ picked: { face, point } });
  };
  // The display style (V): faces solid, translucent (x-ray, or under the playback's stock), depth only (hidden line:
  // only the edges you can see), or none (wireframe).
  const style = useView((state) => state.style);
  const seeThrough = translucent || style === 'xray';
  const faces = style !== 'wireframe';
  const edgesShown = style !== 'shaded';
  const lineColor = style === 'hidden-line' || style === 'wireframe' ? '#c9d4e0' : '#1b2530';
  return (
    <group>
      <mesh geometry={geometry} onPointerDown={(event) => { down.current = [event.nativeEvent.clientX, event.nativeEvent.clientY]; }} onClick={click} renderOrder={seeThrough ? 6 : 0}
        visible={faces} userData={{ surface: true }}>
        <meshStandardMaterial color="#8aa4c8" metalness={0.15} roughness={0.6} transparent={seeThrough} opacity={seeThrough ? 0.28 : 1} depthWrite={!seeThrough}
          colorWrite={style !== 'hidden-line'} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} side={THREE.DoubleSide} />
      </mesh>
      {edgesShown && (
        <lineSegments geometry={edges} renderOrder={seeThrough ? 7 : 1}>
          <lineBasicMaterial color={lineColor} transparent opacity={translucent ? 0.35 : 0.85} />
        </lineSegments>
      )}
      {highlight && (
        <mesh geometry={highlight} renderOrder={20}>
          <meshBasicMaterial color="#53b6ff" transparent opacity={0.55} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} side={THREE.DoubleSide} />
        </mesh>
      )}
      {chosen && (
        <group>
          <mesh geometry={chosen.fill} renderOrder={21} raycast={() => {}}>
            <meshBasicMaterial color="#e8bd84" transparent opacity={0.6} depthWrite={false} polygonOffset polygonOffsetFactor={-3} polygonOffsetUnits={-3} side={THREE.DoubleSide} />
          </mesh>
          {chosen.segments > 0 && <Line points={chunk(chosen.line)} segments color="#e8bd84" lineWidth={3} depthTest={false} renderOrder={22} />}
        </group>
      )}
    </group>
  );
}

/** A line geometry's points as [x, y, z] tuples (drei's Line). */
function chunk(geometry: THREE.BufferGeometry): [number, number, number][] {
  const array = geometry.getAttribute('position').array as Float32Array;
  const out: [number, number, number][] = [];
  for (let i = 0; i < array.length; i += 3) out.push([array[i], array[i + 1], array[i + 2]]);
  return out;
}

// ── Stock ───────────────────────────────────────────────────────────────────

function StockBox({ setup }: { setup: SetupDescription }) {
  const stock = setup.stock?.kind === 'turned' ? null : setup.stock;
  const geometry = useMemo(() => {
    if (!stock) return null;
    const [a, b] = [stock.min_mm, stock.max_mm];
    const box = new THREE.BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    box.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    return { box, edges: new THREE.EdgesGeometry(box) };
  }, [stock]);
  useEffect(() => () => { geometry?.box.dispose(); geometry?.edges.dispose(); }, [geometry]);
  if (!geometry) return null;
  return (
    <group>
      <mesh geometry={geometry.box} renderOrder={9} raycast={() => {}}>
        <meshStandardMaterial color="#b9c4cf" transparent opacity={0.12} depthWrite={false} />
      </mesh>
      <lineSegments geometry={geometry.edges} renderOrder={10}>
        <lineBasicMaterial color="#e8bd84" transparent opacity={0.8} />
      </lineSegments>
    </group>
  );
}

/**
 * camlib's own stock grid from the playback stream, at the playback position: each cell's upper bound of the top height
 * (the most material that may still be there), as it is once the moves before the playing one are done (the stream's
 * changes apply at a move's end). Seeks read only the keyframe and chunks they need, one at a time (the latest wins).
 */
function GridStock({ source, mode }: { source: PlayerSource; mode: 'solid' | 'translucent' }) {
  const invalidate = useThree((state) => state.invalidate);
  const renderer = useThree((state) => state.gl);
  const view = useMemo(() => {
    const stock = source.header.stock;
    return new HeightStockView(fieldGrid(stock.min_mm, stock.max_mm, { nx: stock.nx, ny: stock.ny }), renderer);
  }, [source, renderer]);
  useEffect(() => {
    const field = view.field, top = source.header.stock.max_mm[2];
    const heights = new Float32Array(field.h.length), tags = new Uint8Array(field.h.length), rims = new Uint32Array(field.h.length);
    let live = true, busy = false, wanted = -1, shown = -1;
    const show = () => {
      if (busy || wanted === shown || !live) return;
      const n = wanted;
      busy = true;
      source.stream.stockAt(source.setup, n).then((grid) => {
        if (!live) return;
        for (let i = 0; i < heights.length; i++) {
          heights[i] = grid[2 * i + 1];
          tags[i] = heights[i] < top - 1e-6 ? 1 : 0;   // Cut cells take the first operation colour's tint.
        }
        view.apply(0, field.ny - 1, heights, tags, rims);
        shown = n;
        invalidate();
      }).catch((error) => {
        if (live) usePlayer.setState({ stockError: error instanceof Error ? error.message : String(error) });
      }).finally(() => { busy = false; show(); });
    };
    const seek = (position: number) => { wanted = Math.max(0, Math.min(source.header.moves, Math.floor(position))); show(); };
    seek(usePlayer.getState().position);
    const unsubscribe = usePlayer.subscribe((state, previous) => { if (state.position !== previous.position) seek(state.position); });
    return () => { live = false; unsubscribe(); };
  }, [view, source, invalidate]);
  useEffect(() => { view.setMode(mode); invalidate(); }, [view, mode, invalidate]);
  useEffect(() => () => view.dispose(), [view]);
  return <primitive object={view.group} />;
}

/**
 * The display stock: a fine height field cut by each tool's own profile swept along every move, in a worker, as it is
 * at the playback position (part way through the playing move too). Display only: camlib's grid and checks decide.
 */
function DisplayStock({ source, plan, mode }: { source: PlayerSource; plan: SimPlan; mode: 'solid' | 'translucent' }) {
  const invalidate = useThree((state) => state.invalidate);
  const renderer = useThree((state) => state.gl);
  const view = useMemo(() => {
    const stock = source.header.stock;
    return new HeightStockView(fieldGrid(stock.min_mm, stock.max_mm, plan.cell), renderer);
  }, [source, plan, renderer]);
  useEffect(() => {
    const stock = source.header.stock, field = view.field;
    let live = true;
    const worker = new Worker(new URL('../cam/stockSim.worker.ts', import.meta.url), { type: 'module' });
    const send = (message: SimRequest) => worker.postMessage(message);
    const status = (cutting: number | null) => usePlayer.setState({ stockStatus: { cell: field.cell, nx: field.nx, ny: field.ny, cutting } });
    status(null);
    worker.onmessage = (event: MessageEvent<SimReply>) => {
      if (!live) return;
      const reply = event.data;
      if (reply.type === 'rows') {
        view.apply(reply.j0, reply.j1, reply.h, reply.op, reply.rim);
        status(reply.done ? null : reply.at);
        invalidate();
      } else usePlayer.setState({ stockError: reply.message, show: { ...usePlayer.getState().show, grid: true } });
    };
    worker.onerror = (event) => { if (live) usePlayer.setState({ stockError: event.message || 'the stock simulation stopped', show: { ...usePlayer.getState().show, grid: true } }); };
    // Restore points: more on machines that say they have the memory (Chromium's deviceMemory, in GB).
    const memory = ((navigator as { deviceMemory?: number }).deviceMemory ?? 4) >= 8 ? 256e6 : 128e6;
    // The worker gets copies: the plan stays whole for the next time this stock shows.
    const moves = { ...plan.moves, start: plan.moves.start.slice(), end: plan.moves.end.slice() };
    send({ type: 'init', min: stock.min_mm, max: stock.max_mm, cell: plan.cell, moves, cutters: plan.cutters, memory });
    const seek = (position: number) => send({ type: 'seek', t: simPosition(plan.starts, position) });
    seek(usePlayer.getState().position);
    const unsubscribe = usePlayer.subscribe((state, previous) => { if (state.position !== previous.position) seek(state.position); });
    return () => { live = false; unsubscribe(); worker.terminate(); usePlayer.setState({ stockStatus: null }); };
  }, [view, source, plan, invalidate]);
  useEffect(() => { view.setMode(mode); invalidate(); }, [view, mode, invalidate]);
  useEffect(() => () => view.dispose(), [view]);
  return <primitive object={view.group} />;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function Fixtures({ machine }: { machine: SetupDescription['machines'][number] }) {
  const bodies = useMemo(() => machine.scene.bodies.flatMap((body) => body.outlines.filter((outline) => outline.length >= 3).map((outline, i) => {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: body.z_max_mm - body.z_min_mm, bevelEnabled: false });
    geometry.translate(0, 0, body.z_min_mm);
    return { key: `${body.id}:${i}`, role: body.role, geometry, edges: new THREE.EdgesGeometry(geometry, 20) };
  })), [machine]);
  useEffect(() => () => { for (const body of bodies) { body.geometry.dispose(); body.edges.dispose(); } }, [bodies]);
  return (
    <group>
      {bodies.map((body) => (
        <group key={body.key}>
          <mesh geometry={body.geometry} raycast={() => {}} renderOrder={5}>
            <meshStandardMaterial color={body.role === 'fixture' ? '#6b7785' : '#7e5a9b'} metalness={0.5} roughness={0.5} transparent opacity={0.55} depthWrite={false} />
          </mesh>
          <lineSegments geometry={body.edges}><lineBasicMaterial color="#9aa6ad" transparent opacity={0.5} /></lineSegments>
        </group>
      ))}
    </group>
  );
}

// ── Toolpath ────────────────────────────────────────────────────────────────

const VERTEX = /* glsl */ `
attribute float aMove;
attribute float aKind;
attribute float aDist;
uniform vec3 uColors[6];
varying vec3 vColor;
varying float vMove;
varying float vKind;
varying float vDist;
void main() {
  vColor = uColors[int(aKind + 0.5)];
  vMove = aMove; vKind = aKind; vDist = aDist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = /* glsl */ `
uniform float uPosition;
uniform float uDash;
varying vec3 vColor;
varying float vMove;
varying float vKind;
varying float vDist;
void main() {
  // Rapids and retracts are dashed.
  if ((vKind < 0.5 || vKind > 4.5) && mod(vDist, uDash * 2.0) > uDash) discard;
  float played = step(vMove, uPosition - 1e-4);
  gl_FragColor = vec4(vColor, mix(0.25, 0.95, played));
}`;

/**
 * The toolpath's lines, built once for a stream. The operations hidden in the browser are left out of the draw by
 * giving the geometry only the vertex ranges of the others (its groups): hiding or showing one changes those few
 * ranges and nothing else, whatever the program's size.
 */
function Toolpath({ motion, owners, hidden }: { motion: Motion; owners: Uint32Array; hidden: ReadonlySet<number> }) {
  const invalidate = useThree((state) => state.invalidate);
  const canvas = useThree((state) => state.gl.domElement);
  const { geometry, materials, runs, first } = useMemo(() => {
    const { positions, moves, kinds, dists, first } = toolpathLines(motion);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aMove', new THREE.BufferAttribute(moves, 1));
    geometry.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
    geometry.setAttribute('aDist', new THREE.BufferAttribute(dists, 1));
    geometry.computeBoundingSphere();
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false,
      uniforms: { uPosition: { value: usePlayer.getState().position }, uDash: { value: 1.2 }, uColors: { value: MOVE_KINDS.map((kind) => new THREE.Color(KIND_COLORS[kind])) } },
    });
    // A material list makes three.js draw the geometry's groups, and only them.
    return { geometry, materials: [material], runs: ownerRuns(owners), first };
  }, [motion, owners]);
  useEffect(() => () => { geometry.dispose(); materials[0].dispose(); }, [geometry, materials]);
  useEffect(() => usePlayer.subscribe((state) => { materials[0].uniforms.uPosition.value = state.position; invalidate(); }), [materials, invalidate]);
  useEffect(() => {
    const ranges = drawRanges(runs, first, hidden);
    geometry.clearGroups();
    for (const range of ranges) geometry.addGroup(range.start, range.count, 0);
    // What is drawn, readable from the page (as the player's data-moves): vertex ranges "start+count", of how many.
    canvas.dataset.toolpathDrawn = ranges.map((range) => `${range.start}+${range.count}`).join(' ');
    canvas.dataset.toolpathVertices = String(first[first.length - 1]);
    invalidate();
    return () => { delete canvas.dataset.toolpathDrawn; delete canvas.dataset.toolpathVertices; };
  }, [geometry, runs, first, hidden, invalidate, canvas]);
  return <lineSegments geometry={geometry} material={materials} renderOrder={12} raycast={() => {}} userData={{ toolpath: true }} />;
}

// ── Tool ────────────────────────────────────────────────────────────────────

function lathe(points: [number, number][]) {
  const geometry = new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4), z)), 40);
  geometry.rotateX(Math.PI / 2);   // The lathe's axis is Y; the tool's is Z.
  return geometry;
}

function Tool({ source }: { source: PlayerSource }) {
  const invalidate = useThree((state) => state.invalidate);
  const group = useRef<THREE.Group>(null);
  const spinner = useRef<THREE.Group>(null);
  const [index, setIndex] = useState(0);
  const tools = useMemo(() => source.header.tools.map((tool) => {
    const profile = toolProfile(tool);
    return { cutter: lathe(profile.cutter), shank: profile.shank.length ? lathe(profile.shank) : null, holders: profile.holders.map(lathe) };
  }), [source]);
  useEffect(() => () => { for (const tool of tools) { tool.cutter.dispose(); tool.shank?.dispose(); tool.holders.forEach((holder) => holder.dispose()); } }, [tools]);
  useEffect(() => {
    const motion = source.motion;
    const tip: [number, number, number] = [0, 0, 0];
    const place = (position: number) => {
      if (!motion.count) return;
      tipAt(motion, position, tip);
      group.current?.position.set(tip[0], tip[1], tip[2]);
      setIndex(motion.tool[Math.min(motion.count - 1, Math.max(0, Math.floor(position)))]);
      invalidate();
    };
    place(usePlayer.getState().position);
    return usePlayer.subscribe((state) => place(state.position));
  }, [source, invalidate]);
  useFrame((_, delta) => {
    if (spinner.current && usePlayer.getState().playing) { spinner.current.rotation.z -= Math.min(delta, 0.1) * Math.PI * 4; invalidate(); }
  });
  const tool = tools[index] ?? tools[0];
  if (!tool) return null;
  return (
    <group ref={group}>
      <group ref={spinner}>
        <mesh geometry={tool.cutter} raycast={() => {}} renderOrder={14}><meshStandardMaterial color="#e8bd84" metalness={0.7} roughness={0.3} /></mesh>
        {tool.shank && <mesh geometry={tool.shank} raycast={() => {}}><meshStandardMaterial color="#c9d1d6" metalness={0.8} roughness={0.25} /></mesh>}
        {tool.holders.map((holder, i) => <mesh key={i} geometry={holder} raycast={() => {}}><meshStandardMaterial color="#59636b" metalness={0.6} roughness={0.4} transparent opacity={0.85} /></mesh>)}
      </group>
    </group>
  );
}

// ── Findings ────────────────────────────────────────────────────────────────

/**
 * camlib's findings where they are. A finding at a move of an operation whose toolpath is hidden goes with it, unless
 * it is the one in focus (picked in the Result panel, which lists every finding whatever is hidden here).
 */
function FindingMarks({ source, machine, size, hidden }: { source: PlayerSource; machine: MachineResult; size: number; hidden: ReadonlySet<number> }) {
  const focus = usePlayer((state) => state.focus);
  const marks = useMemo(() => machine.findings.flatMap((finding, index) => {
    const move = findingMove(finding);
    if (move === null) return [];
    const at: [number, number, number] = [0, 0, 0];
    tipAt(source.motion, move + 1, at);
    return [{ index, at, color: SEVERITY_COLORS[severityOf(finding)], owner: source.owners[Math.min(source.motion.count - 1, move)] }];
  }), [source, machine]);
  const r = Math.max(0.4, size * 0.006);
  return (
    <group>
      {marks.filter((mark) => focus === mark.index || !hidden.has(mark.owner)).map((mark) => (
        <mesh key={mark.index} position={mark.at} renderOrder={30} raycast={() => {}}>
          <sphereGeometry args={[focus === mark.index ? r * 2.2 : r, 16, 12]} />
          <meshBasicMaterial color={mark.color} depthTest={false} transparent opacity={focus === null || focus === mark.index ? 0.95 : 0.45} />
        </mesh>
      ))}
    </group>
  );
}

// ── Scene ───────────────────────────────────────────────────────────────────

function WorkTriad({ size }: { size: number }) {
  return (
    <group>
      <Line points={[[0, 0, 0], [size, 0, 0]]} color="#ff6b6b" lineWidth={2} depthTest={false} renderOrder={26} />
      <Line points={[[0, 0, 0], [0, size, 0]]} color="#7ed47c" lineWidth={2} depthTest={false} renderOrder={26} />
      <Line points={[[0, 0, 0], [0, 0, size]]} color="#5aa9ff" lineWidth={2} depthTest={false} renderOrder={26} />
    </group>
  );
}

/** What orbits pivot on and pans hold: the part's surface under a canvas point (the stock is drawn on the GPU, so it isn't hit). */
function SurfaceProbe() {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    viewer.surfacePoint = (ndc) => {
      if (!viewer.camera) return null;
      raycaster.setFromCamera(ndc, viewer.camera);
      const surfaces: THREE.Object3D[] = [];
      scene.traverseVisible((object) => { if (object.userData.surface) surfaces.push(object); });
      return raycaster.intersectObjects(surfaces, false)[0]?.point.clone() ?? null;
    };
    return () => { viewer.surfacePoint = () => null; };
  }, [scene]);
  return null;
}

export default function Viewport() {
  const part = useApp((state) => state.part);
  const build = useApp((state) => state.build);
  const player = useApp((state) => state.player);
  const project = useApp((state) => state.project?.name);
  const show = usePlayer((state) => state.show);
  const source = player.status === 'ready' ? player.source : null;
  const described = useApp((state) => state.described);
  // The program as the shown build ran it, else as the last build that ran it (a failed one leaves the view as it was).
  const description = build?.metadata?.program ?? described?.program;
  const setup = description?.setups.find((item) => item.id === (player.setup ?? description.setups[0]?.id)) ?? description?.setups[0] ?? null;
  const machineResult = source ? build?.metadata?.setups?.find((item) => item.id === source.header.id)?.machines[0] ?? null : null;
  const box = useMemo(() => {
    const out = new THREE.Box3();
    if (part.mesh) out.union(new THREE.Box3(new THREE.Vector3(...part.mesh.bounds.min), new THREE.Vector3(...part.mesh.bounds.max)));
    if (setup?.stock) out.union(new THREE.Box3(new THREE.Vector3(...setup.stock.min_mm), new THREE.Vector3(...setup.stock.max_mm)));
    return out.isEmpty() ? null : out;
  }, [part.mesh, setup?.stock]);
  const size = box ? box.getSize(new THREE.Vector3()).length() : 100;
  const view = useView();
  useEffect(() => { viewer.bounds = () => (box ? box.clone() : new THREE.Box3()); }, [box]);
  // Frame the scene (isometric) when a project opens and once its geometry is in.
  const framed = useRef<string | null>(null);
  useEffect(() => {
    // Again once the stock is known (a first check or build), while the view is still the automatic one: a bar is
    // much longer than the part turned from it.
    const key = `${project}:${box ? 'box' : 'none'}:${setup?.stock ? 'stock' : 'part'}`;
    if (!box || framed.current === key) return;
    if (framed.current?.startsWith(`${project}:box:`) && !viewer.autoFramed) { framed.current = key; return; }
    let frame = 0;
    // The camera's controls register inside the canvas, possibly after this runs: frame once they're there.
    const tryFrame = () => {
      if (!viewer.controls) { frame = requestAnimationFrame(tryFrame); return; }
      framed.current = key;
      viewer.setView('iso', false);
    };
    tryFrame();
    return () => cancelAnimationFrame(frame);
  }, [project, box, setup?.stock]);
  // While a form is open the part is what matters: shown solid and pickable, the stock as its box, no playback.
  const formOpen = useEditor((state) => !!state.form);
  const streaming = !!source && show.stock !== 'off' && !formOpen;
  const plan = useMemo(() => (source ? simPlan(source) : null), [source]);
  // A lathe setup's stock is camlib's own turned stock, revolved (TurningView).
  const turned = !!source && isTurned(source.header.stock);
  // The operations whose toolpath the browser hides (the setup playing's). The stock, the tool and the playback don't use it.
  const hiddenIds = usePaths((state) => (source ? state.setups[source.header.id]?.hidden : undefined));
  const hidden = useMemo(() => hiddenOwners(source?.header.operations.map((op) => op.id) ?? [], hiddenIds), [source, hiddenIds]);
  return (
    <div className="viewport" id="viewport">
      <Canvas frameloop="demand" dpr={[1, 2]} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }} camera={{ position: [240, -240, 200], up: [0, 0, 1], near: 0.1, far: 100000 }}
        onPointerMissed={(event) => { if (event.button === 0) useApp.setState({ picked: null }); }}>
        <CameraRig />
        <Interaction />
        <SurfaceProbe />
        <hemisphereLight args={['#dfe8ff', '#30363b', 0.9]} />
        <directionalLight position={[200, -300, 500]} intensity={0.6} />
        {view.showGrid && <gridHelper args={[1000, 100, '#3a4349', '#262c31']} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, (box?.min.z ?? 0) - 0.01]} raycast={() => null} />}
        {view.showOrigin && <WorkTriad size={Math.max(5, size * 0.12)} />}
        {part.mesh && (formOpen || (!view.partHidden && (show.part || !source))) && <PartView mesh={part.mesh} translucent={!!source && !formOpen} />}
        {setup && !streaming && (setup.stock?.kind === 'turned' ? <TurnedBar stock={setup.stock} /> : <StockBox setup={setup} />)}
        {source && streaming && (turned
          ? <TurnedStock source={source} mode={show.stock as 'solid' | 'translucent'} />
          : show.grid || !plan
            ? <GridStock source={source} mode={show.stock as 'solid' | 'translucent'} />
            : <DisplayStock source={source} plan={plan} mode={show.stock as 'solid' | 'translucent'} />)}
        {setup?.machines[0] && show.fixtures && <Fixtures machine={setup.machines[0]} />}
        {source && show.toolpath && !formOpen && <Toolpath motion={source.motion} owners={source.owners} hidden={hidden} />}
        {source && show.tool && !formOpen && (source.header.tools.some((tool) => tool.turning) ? <TurningTool source={source} /> : <Tool source={source} />)}
        {source && !formOpen && machineResult && machineResult.findings.some((finding) => finding.move != null) && <FindingMarks source={source} machine={machineResult} size={size} hidden={hidden} />}
      </Canvas>
      <ViewCube disabled={!box} />
      <NavBar disabled={!box} />
      <PickedFace />
      {source && !formOpen && <HiddenPaths source={source} />}
      {part.status === 'loading' && <div className="viewport-note">Reading the part…</div>}
      {part.status === 'error' && <div className="viewport-note" data-tone="danger">The part couldn’t be read: {part.error}</div>}
    </div>
  );
}

/** Toolpaths are hidden (the browser's eyes): how many, and all of them back in a click. */
function HiddenPaths({ source }: { source: PlayerSource }) {
  const paths = usePaths((state) => state.setups[source.header.id]);
  const ids = source.header.operations.map((op) => op.id);
  const count = hiddenCount(paths, ids);
  if (!count) return null;
  return (
    <button type="button" className="paths-note" id="paths-show-all" onClick={() => showAllPaths(source.header.id)}
      title={`${count} of this setup’s ${new Set(ids).size} toolpaths ${count === 1 ? 'is' : 'are'} hidden (the eye on an operation’s row in the browser). Only their lines: the playback, the tool, the stock and the timeline still run every operation. Click to show them all.`}>
      <EyeOff size={12} />{count} {count === 1 ? 'toolpath' : 'toolpaths'} hidden<b>Show all</b>
    </button>
  );
}

/** The face picked on the part: its name (what the program's helpers take), the names the part file gives it, its kind. */
function PickedFace() {
  const picked = useApp((state) => state.picked);
  const mesh = useApp((state) => state.part.mesh);
  if (!picked || !mesh) return null;
  const face = mesh.faces[picked.face - 1];
  if (!face) return null;
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };
  const names = [face.name, ...face.names];
  return (
    <div className="picked" id="picked-face">
      <div className="picked-names">
        {names.map((name) => (
          <button key={name} type="button" className="chip" title={`Copy "${name}"`} onClick={() => copy(`"${name}"`)}><Copy size={11} />{name}</button>
        ))}
      </div>
      <small>{face.type.toLowerCase()} · {Number(face.area_mm2.toFixed(2))} mm² · at ({picked.point.map((v) => Number(v.toFixed(2))).join(', ')})</small>
    </div>
  );
}
