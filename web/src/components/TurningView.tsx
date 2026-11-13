/**
 * A lathe setup in the 3D view (work coordinates: Z the spindle axis, X the radius): the bar before a build, camlib's
 * own turned stock from a full build's playback stream at the playback position, cut away over a quarter so its section
 * shows, and the turning tool (its insert's and holder's outlines) at the point the program moves. Drawing only: camlib
 * checked every move with its own models.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { TurnedStock as TurnedStockSpec } from '../api';
import { usePlayer, type PlayerSource } from '../state';
import { tipAt } from '../cam/motion';
import { turnedMesh } from '../cam/turnedStock';
import type { TurningToolShape } from '../cam/stream';

/** A half-section, (radius, z, bulge) points, as (x, 0, z) points in the XZ plane (an arc's bulge as chords). */
function sectionPoints(points: number[][]): [number, number, number][] {
  const out: [number, number, number][] = [];
  points.forEach(([r, z, bulge], i) => {
    out.push([r, 0, z]);
    const next = points[i + 1];
    if (!next || !bulge) return;
    // The arc to the next point: tan(sweep / 4) = bulge, positive counter-clockwise from +Z toward +X.
    const sweep = 4 * Math.atan(bulge), [r1, z1] = next;
    const chord = Math.hypot(r1 - r, z1 - z), radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
    const mid = [(r + r1) / 2, (z + z1) / 2], h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2)) * Math.sign(bulge) * (Math.abs(sweep) > Math.PI ? -1 : 1);
    // In (z, r) axes (z to the right, r up) the centre lies left of the chord for a counter-clockwise arc.
    const cz = mid[1] - ((r1 - r) / chord) * h, cr = mid[0] + ((z1 - z) / chord) * h;
    const a0 = Math.atan2(r - cr, z - cz), steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
    for (let k = 1; k < steps; k++) { const a = a0 + (sweep * k) / steps; out.push([cr + radius * Math.sin(a), 0, cz + radius * Math.cos(a)]); }
  });
  return out;
}

/** The bar as the program gives it (before a build, or with the playback's stock off), the part's half-section and the chuck face. */
export function TurnedBar({ stock }: { stock: TurnedStockSpec }) {
  const geometry = useMemo(() => {
    const length = stock.z_max_mm - stock.z_min_mm;
    const bar = new THREE.CylinderGeometry(stock.outer_radius_mm, stock.outer_radius_mm, length, 64, 1, false);
    bar.rotateX(Math.PI / 2);   // A cylinder's axis is Y; the bar's is Z.
    bar.translate(0, 0, (stock.z_min_mm + stock.z_max_mm) / 2);
    return { bar, edges: new THREE.EdgesGeometry(bar, 30) };
  }, [stock]);
  useEffect(() => () => { geometry.bar.dispose(); geometry.edges.dispose(); }, [geometry]);
  const profile = useMemo(() => sectionPoints(stock.profile ?? []), [stock]);
  const bore = useMemo(() => sectionPoints(stock.bore ?? []), [stock]);
  const chuck = stock.chuck_z_mm;
  return (
    <group>
      <mesh geometry={geometry.bar} renderOrder={9} raycast={() => {}}>
        <meshStandardMaterial color="#b9c4cf" transparent opacity={0.12} depthWrite={false} />
      </mesh>
      <lineSegments geometry={geometry.edges} renderOrder={10}>
        <lineBasicMaterial color="#e8bd84" transparent opacity={0.8} />
      </lineSegments>
      {profile.length > 1 && <Line points={profile} color="#53b6ff" lineWidth={1.5} depthTest={false} renderOrder={24} />}
      {bore.length > 1 && <Line points={bore} color="#53b6ff" lineWidth={1.5} depthTest={false} renderOrder={24} />}
      {chuck != null && <Line points={[[0, 0, chuck], [stock.outer_radius_mm * 1.6, 0, chuck]]} color="#ef4444" lineWidth={1.5} dashed dashSize={1.5} gapSize={1} depthTest={false} renderOrder={24} />}
    </group>
  );
}

/**
 * camlib's turned stock from the playback stream, at the playback position: as it is once the moves before the playing
 * one are done (the stream's changes apply at a move's end). Seeks read only what they need, the latest wins.
 */
export function TurnedStock({ source, mode }: { source: PlayerSource; mode: 'solid' | 'translucent' }) {
  const invalidate = useThree((state) => state.invalidate);
  const canvas = useThree((state) => state.gl.domElement);
  const geometry = useMemo(() => new THREE.BufferGeometry(), [source]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => {
    const stock = source.header.stock;
    const grid = { nx: stock.nx, z_min_mm: stock.z_min_mm!, z_max_mm: stock.z_max_mm! };
    let live = true, busy = false, wanted = -1, shown = -1;
    const show = () => {
      if (busy || wanted === shown || !live) return;
      const n = wanted;
      busy = true;
      source.stream.stockAt(source.setup, n).then((cells) => {
        if (!live) return;
        const mesh = turnedMesh(grid, cells);
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        geometry.computeBoundingSphere();
        shown = n;
        // What is drawn, readable from the page: the move the stock is at and its triangles.
        canvas.dataset.turnedStock = `${n}:${mesh.indices.length / 3}`;
        invalidate();
      }).catch((error) => {
        if (live) usePlayer.setState({ stockError: error instanceof Error ? error.message : String(error) });
      }).finally(() => { busy = false; show(); });
    };
    const seek = (position: number) => { wanted = Math.max(0, Math.min(source.header.moves, Math.floor(position))); show(); };
    seek(usePlayer.getState().position);
    const unsubscribe = usePlayer.subscribe((state, previous) => { if (state.position !== previous.position) seek(state.position); });
    return () => { live = false; unsubscribe(); delete canvas.dataset.turnedStock; };
  }, [geometry, source, invalidate, canvas]);
  const clear = mode === 'translucent';
  return (
    <mesh geometry={geometry} renderOrder={clear ? 9 : 2} raycast={() => {}}>
      <meshStandardMaterial color="#b4bec8" metalness={0.55} roughness={0.42} transparent={clear} opacity={clear ? 0.35 : 1} depthWrite={!clear} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** An outline in the XZ plane as a plate between y0 and y1 (the cutting face is y = 0; the body is below it). */
function plate(outline: [number, number][], y0: number, y1: number): THREE.BufferGeometry | null {
  const points = outline.filter((point, i) => i === 0 || Math.hypot(point[0] - outline[i - 1][0], point[1] - outline[i - 1][1]) > 1e-6);
  if (points.length < 3 || !(y1 > y0)) return null;
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z))), { depth: y1 - y0, bevelEnabled: false });
  geometry.translate(0, 0, -y1);
  geometry.rotateX(Math.PI / 2);   // The shape's (x, z) to work (x, ·, z); its depth runs along −Y from y1 down to y0.
  return geometry;
}

/** A drill, drawn round its axis (the spindle's): its half outline, (radius, z) from its tip. */
function drill(outline: [number, number][]): THREE.BufferGeometry {
  const half = outline.filter(([x]) => x >= 0).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const top = Math.max(...half.map(([, z]) => z));
  const geometry = new THREE.LatheGeometry([...half, [0, top] as [number, number]].map(([x, z]) => new THREE.Vector2(Math.max(x, 1e-4), z)), 32);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function toolGeometry(shape: TurningToolShape) {
  const [low, high] = shape.holder_y_mm ?? [-10, 0];
  // The insert as a 3 mm plate under its cutting face (its real thickness and clearances are camlib's, not drawn).
  const insert = shape.insert === 'drill' ? drill(shape.insert_outline) : plate(shape.insert_outline, -3, 0);
  return { insert, holder: plate(shape.holder_outline, low, high) };
}

/** The turning tool at the playback position: the point the program moves is where its outlines are drawn from. */
export function TurningTool({ source }: { source: PlayerSource }) {
  const invalidate = useThree((state) => state.invalidate);
  const group = useRef<THREE.Group>(null);
  const [index, setIndex] = useState(0);
  const tools = useMemo(() => source.header.tools.map((tool) => (tool.turning ? toolGeometry(tool.turning) : null)), [source]);
  useEffect(() => () => { for (const tool of tools) { tool?.insert?.dispose(); tool?.holder?.dispose(); } }, [tools]);
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
  const tool = tools[index] ?? tools[0];
  if (!tool) return null;
  return (
    <group ref={group}>
      {tool.insert && <mesh geometry={tool.insert} raycast={() => {}} renderOrder={14}><meshStandardMaterial color="#e8bd84" metalness={0.7} roughness={0.3} side={THREE.DoubleSide} /></mesh>}
      {tool.holder && <mesh geometry={tool.holder} raycast={() => {}}><meshStandardMaterial color="#59636b" metalness={0.6} roughness={0.4} transparent opacity={0.85} side={THREE.DoubleSide} /></mesh>}
    </group>
  );
}
