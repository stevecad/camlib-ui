/**
 * A plasma or laser table in the 3D view: the cutting head as a torch, its arc where it is cutting (the jet through the
 * sheet, its glare, the light it throws and the sparks), and the slat table the sheet lies on.
 *
 * What camlib checks is the head's declared envelope (its nozzle and body: the torch here is drawn inside it) against
 * the sheet. The arc, the sparks and the table are drawn for context only: nothing is checked against them, and the
 * player says so.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { tipAt } from '../cam/motion';
import type { StreamStock, StreamTool } from '../cam/stream';
import { usePlayer, type PlayerSource } from '../state';

/** The player's move kinds a beam is on over (motion.ts MOVE_KINDS: cuts and leads). */
const BEAM_ON = new Set([1, 3]);
export const isBeam = (tool: StreamTool | undefined) => tool?.shape?.kind === 'beam';

/** A solid of revolution about the tool's axis (Z) from (radius, z) points. */
function revolve(points: [number, number][], segments = 48) {
  const geometry = new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4), z)), segments);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/**
 * The torch, inside the head's declared nozzle (radius and length) and body (radius, from the nozzle's top to the
 * head's top): the copper nozzle, the retaining cap, the brass body with its collar, and the barrel.
 */
function torchParts(tool: StreamTool) {
  const kerf = tool.diameter_mm;
  const rn = (tool.shank_diameter_mm || tool.diameter_mm * 4) / 2;
  const ln = tool.stickout_mm || tool.cutting_length_mm || rn * 2;
  const body = tool.holders[0];
  const rb = body ? Math.max(body.radius_min_mm, body.radius_max_mm) : rn * 2.5;
  const top = body ? body.z_max_mm : ln * 6;
  const h = top - ln;
  const orifice = Math.min(rn * 0.45, Math.max(kerf * 0.9, rn * 0.2));
  return {
    kerf,
    nozzle: revolve([[0, 0], [orifice, 0], [rn * 0.8, ln * 0.45], [rn, ln * 0.7], [rn, ln], [0, ln]]),
    cap: revolve([[0, ln], [rn, ln], [rb * 0.84, ln + h * 0.07], [rb * 0.84, ln + h * 0.2], [0, ln + h * 0.2]]),
    brass: revolve([[0, ln + h * 0.2], [rb * 0.9, ln + h * 0.2], [rb, ln + h * 0.22], [rb, ln + h * 0.4], [rb * 0.9, ln + h * 0.42], [0, ln + h * 0.42]]),
    collar: revolve([[0, ln + h * 0.42], [rb * 0.92, ln + h * 0.42], [rb * 0.92, ln + h * 0.47], [0, ln + h * 0.47]]),
    barrel: revolve([[0, ln + h * 0.47], [rb * 0.76, ln + h * 0.47], [rb * 0.76, top], [0, top]]),
  };
}

/** A soft round glare (white at its centre, to nothing at its edge), drawn once. */
function glareTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.12, 'rgba(225,240,255,0.95)');
  gradient.addColorStop(0.3, 'rgba(150,195,255,0.45)');
  gradient.addColorStop(0.6, 'rgba(255,170,90,0.12)');
  gradient.addColorStop(1, 'rgba(255,140,60,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A sheet of hot-rolled plate. */
export const PLATE_COLOR = '#6f7b88';

const SPARKS = 900;
const GRAVITY = 9810;   // mm/s²

/** The sparks: short bright streaks thrown from the cut, above the sheet and below it, falling and fading. */
class Sparks {
  readonly position = new Float32Array(SPARKS * 3);
  readonly velocity = new Float32Array(SPARKS * 3);
  readonly age = new Float32Array(SPARKS).fill(1);
  readonly life = new Float32Array(SPARKS).fill(1);
  readonly geometry = new THREE.BufferGeometry();
  /** Each spark's bright head, drawn as a point over its streak. */
  readonly heads = new THREE.BufferGeometry();
  private readonly vertices = new Float32Array(SPARKS * 6);
  private readonly colors = new Float32Array(SPARKS * 6);
  private readonly headAt = new Float32Array(SPARKS * 3);
  private readonly headColor = new Float32Array(SPARKS * 3);
  private next = 0;
  private owed = 0;
  alive = 0;

  constructor() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.vertices, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.heads.setAttribute('position', new THREE.BufferAttribute(this.headAt, 3));
    this.heads.setAttribute('color', new THREE.BufferAttribute(this.headColor, 3));
    this.heads.setDrawRange(0, 0);
    this.heads.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  }

  /** Throws `rate` sparks a second from (x, y): some skim over the sheet's top, most go down through the kerf. */
  emit(dt: number, rate: number, x: number, y: number, top: number, bottom: number) {
    this.owed += rate * dt;
    while (this.owed >= 1) {
      this.owed -= 1;
      const i = this.next;
      this.next = (this.next + 1) % SPARKS;
      const around = Math.random() * Math.PI * 2;
      const above = Math.random() < 0.45;
      const speed = above ? 300 + Math.random() * 900 : 500 + Math.random() * 1400;
      const lift = above ? 0.12 + Math.random() * 0.7 : -(0.5 + Math.random() * 1.0);
      const flat = Math.cos(lift);
      this.position.set([x, y, above ? top : bottom], i * 3);
      this.velocity.set([Math.cos(around) * flat * speed, Math.sin(around) * flat * speed, Math.sin(lift) * speed], i * 3);
      this.age[i] = 0;
      this.life[i] = 0.18 + Math.random() * 0.42;
    }
  }

  /** Moves every spark by `dt`: gravity, and gone once it lands (on the sheet, or the table's floor) or burns out. */
  step(dt: number, top: number, floor: number) {
    let alive = 0;
    for (let i = 0; i < SPARKS; i++) {
      if (this.age[i] >= 1) continue;
      this.age[i] += dt / this.life[i];
      const p = i * 3;
      const wasAbove = this.position[p + 2] >= top;
      this.velocity[p + 2] -= GRAVITY * dt;
      for (let a = 0; a < 3; a++) this.position[p + a] += this.velocity[p + a] * dt;
      if ((wasAbove && this.position[p + 2] < top) || this.position[p + 2] < floor) this.age[i] = 1;
      if (this.age[i] >= 1) continue;
      // A streak along its own velocity, white-yellow when new, orange-red and dim as it burns out.
      const fade = 1 - this.age[i], heat = fade * fade;
      const v = alive * 6;
      for (let a = 0; a < 3; a++) {
        this.vertices[v + a] = this.position[p + a];
        this.vertices[v + 3 + a] = this.position[p + a] - this.velocity[p + a] * 0.022;
        this.headAt[alive * 3 + a] = this.position[p + a];
      }
      const r = fade, g = fade * (0.35 + 0.6 * heat), b = fade * 0.75 * heat * heat;
      this.colors.set([r, g, b, r * 0.25, g * 0.2, b * 0.1], v);
      this.headColor.set([r, g, b], alive * 3);
      alive++;
    }
    this.alive = alive;
    this.geometry.setDrawRange(0, alive * 2);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.heads.setDrawRange(0, alive);
    this.heads.attributes.position.needsUpdate = true;
    this.heads.attributes.color.needsUpdate = true;
  }
}

/** The cutting head at the playback position, and its arc while the move playing is a cut. */
export function CuttingHead({ source }: { source: PlayerSource }) {
  const invalidate = useThree((state) => state.invalidate);
  const group = useRef<THREE.Group>(null);
  const arc = useRef<THREE.Group>(null);
  const glare = useRef<THREE.Sprite>(null);
  const halo = useRef<THREE.Sprite>(null);
  const light = useRef<THREE.PointLight>(null);
  const tool = source.header.tools.find(isBeam) ?? source.header.tools[0];
  const parts = useMemo(() => torchParts(tool), [tool]);
  const texture = useMemo(glareTexture, []);
  const sparks = useMemo(() => new Sparks(), []);
  const stock = source.header.stock;
  const top = stock.max_mm[2], bottom = stock.min_mm[2];
  const floor = bottom - TABLE_DEPTH;
  // The jet: from the nozzle through the sheet and a little below it, as wide as the kerf.
  const jet = useMemo(() => new THREE.CylinderGeometry(parts.kerf * 0.5, parts.kerf * 0.75, 1, 12).rotateX(Math.PI / 2), [parts]);
  useEffect(() => () => { Object.values(parts).forEach((part) => { if (part instanceof THREE.BufferGeometry) part.dispose(); }); }, [parts]);
  useEffect(() => () => { texture.dispose(); sparks.geometry.dispose(); sparks.heads.dispose(); jet.dispose(); }, [texture, sparks, jet]);
  const state = useRef({ tip: [0, 0, 0] as [number, number, number], on: false });
  useEffect(() => {
    const motion = source.motion;
    const place = (position: number) => {
      if (!motion.count) return;
      tipAt(motion, position, state.current.tip);
      const [x, y, z] = state.current.tip;
      group.current?.position.set(x, y, z);
      const index = Math.min(motion.count - 1, Math.max(0, Math.floor(position)));
      state.current.on = position > 0 && position < motion.count && BEAM_ON.has(motion.kind[index]);
      if (arc.current) {
        arc.current.visible = state.current.on;
        arc.current.position.set(x, y, 0);
        // The jet's own piece: from the nozzle's tip down through the sheet.
        const column = arc.current.children[0];
        const low = bottom - Math.max(4, (top - bottom) * 1.5);
        column.position.set(0, 0, (z + low) / 2);
        column.scale.set(1, 1, Math.max(z - low, 0.1));
        glare.current?.position.set(0, 0, top + 0.5);
        halo.current?.position.set(0, 0, top + 0.5);
        light.current?.position.set(0, 0, top + 6);
      }
      invalidate();
    };
    place(usePlayer.getState().position);
    return usePlayer.subscribe((next) => place(next.position));
  }, [source, invalidate, top, bottom]);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const { tip, on } = state.current;
    const playing = usePlayer.getState().playing;
    if (on && playing) sparks.emit(dt, 1300, tip[0], tip[1], top, bottom);
    const before = sparks.alive;
    if (playing || before) sparks.step(dt, top, floor);
    // The arc flickers while it runs.
    const flicker = on && playing ? 0.82 + Math.random() * 0.36 : 1;
    const size = Math.max(24, parts.kerf * 16);
    glare.current?.scale.setScalar(size * flicker);
    halo.current?.scale.setScalar(size * 4.2 * (0.9 + (flicker - 1) * 0.5));
    if (light.current) light.current.intensity = on ? 9000 * flicker : 0;
    if ((on && playing) || sparks.alive || before) invalidate();
  });
  return (
    <>
      <group ref={group}>
        <mesh geometry={parts.nozzle} raycast={() => {}} renderOrder={14}><meshStandardMaterial color="#c9783c" metalness={0.85} roughness={0.32} /></mesh>
        <mesh geometry={parts.cap} raycast={() => {}}><meshStandardMaterial color="#1d2024" metalness={0.35} roughness={0.7} /></mesh>
        <mesh geometry={parts.brass} raycast={() => {}}><meshStandardMaterial color="#b89546" metalness={0.9} roughness={0.34} /></mesh>
        <mesh geometry={parts.collar} raycast={() => {}}><meshStandardMaterial color="#c3cad0" metalness={0.9} roughness={0.25} /></mesh>
        <mesh geometry={parts.barrel} raycast={() => {}}><meshStandardMaterial color="#3a4047" metalness={0.75} roughness={0.42} /></mesh>
      </group>
      <group ref={arc} visible={false} userData={{ uncut: true }}>
        <mesh geometry={jet} raycast={() => {}} renderOrder={31}>
          <meshBasicMaterial color="#dcecff" transparent opacity={0.95} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <sprite ref={glare} renderOrder={33} raycast={() => {}}>
          <spriteMaterial map={texture} transparent blending={THREE.AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
        </sprite>
        <sprite ref={halo} renderOrder={32} raycast={() => {}}>
          <spriteMaterial map={texture} transparent opacity={0.5} color="#ffd9a8" blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
        <pointLight ref={light} color="#bcdcff" intensity={0} distance={420} decay={2} />
      </group>
      <lineSegments geometry={sparks.geometry} renderOrder={34} raycast={() => {}} frustumCulled={false} userData={{ uncut: true }}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <points geometry={sparks.heads} renderOrder={35} raycast={() => {}} frustumCulled={false} userData={{ uncut: true }}>
        <pointsMaterial vertexColors size={3} sizeAttenuation={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </points>
    </>
  );
}

/** How far the table's floor is below the sheet (the slats' height), and what the table stands out around the sheet. */
export const TABLE_DEPTH = 70;
const TABLE_MARGIN = 45, SLAT_PITCH = 38, SLAT_THICKNESS = 3;

/**
 * The cutting table under the sheet: slats on edge the sheet lies on, a frame around them and the floor below. Drawn
 * for context (a table isn't declared to camlib, and nothing is checked against it).
 */
export function CuttingTable({ stock }: { stock: Pick<StreamStock, 'min_mm' | 'max_mm'> }) {
  const [x0, y0, z0] = stock.min_mm, [x1, y1] = stock.max_mm;
  const table = useMemo(() => {
    const width = x1 - x0 + TABLE_MARGIN * 2, depth = y1 - y0 + TABLE_MARGIN * 2;
    const count = Math.max(2, Math.floor(width / SLAT_PITCH));
    const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(SLAT_THICKNESS, depth, TABLE_DEPTH), new THREE.MeshStandardMaterial({ color: '#4a423b', metalness: 0.55, roughness: 0.82 }), count);
    const at = new THREE.Matrix4();
    for (let i = 0; i < count; i++) slats.setMatrixAt(i, at.makeTranslation(x0 - TABLE_MARGIN + ((i + 0.5) * width) / count, (y0 + y1) / 2, z0 - TABLE_DEPTH / 2 - 0.05));
    slats.instanceMatrix.needsUpdate = true;
    slats.raycast = () => {};
    const rail = 26;
    const frame: [number, number, number, number, number][] = [
      [(x0 + x1) / 2, y0 - TABLE_MARGIN - rail / 2, width + rail * 2, rail, 0], [(x0 + x1) / 2, y1 + TABLE_MARGIN + rail / 2, width + rail * 2, rail, 0],
      [x0 - TABLE_MARGIN - rail / 2, (y0 + y1) / 2, rail, depth, 0], [x1 + TABLE_MARGIN + rail / 2, (y0 + y1) / 2, rail, depth, 0],
    ];
    return { slats, frame, width, depth, rail };
  }, [x0, y0, z0, x1, y1]);
  useEffect(() => () => { table.slats.geometry.dispose(); (table.slats.material as THREE.Material).dispose(); }, [table]);
  return (
    <group>
      <primitive object={table.slats} />
      {table.frame.map(([x, y, w, d], i) => (
        <mesh key={i} position={[x, y, z0 - TABLE_DEPTH / 2 - 4]} raycast={() => {}}>
          <boxGeometry args={[w, d, TABLE_DEPTH + 8]} />
          <meshStandardMaterial color="#27507e" metalness={0.35} roughness={0.6} />
        </mesh>
      ))}
      <mesh position={[(x0 + x1) / 2, (y0 + y1) / 2, z0 - TABLE_DEPTH - 1]} raycast={() => {}}>
        <boxGeometry args={[table.width, table.depth, 2]} />
        <meshStandardMaterial color="#15181b" metalness={0.2} roughness={0.95} />
      </mesh>
    </group>
  );
}
