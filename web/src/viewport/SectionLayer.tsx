/**
 * Section view: a plane along X, Y or Z that cuts everything in the 3D view (the stock as cut, the part, the tool, the
 * toolpath) and fills the cut through closed solids with hatched caps. The plane is dragged along its axis; the cut
 * follows live without rebuilding anything.
 *
 * Adapted from Steve's Section analysis (cad-web/src/viewport/SectionLayer.tsx, Apache-2.0, see NOTICE): its caps
 * (stencil counting and the hatch shader), its plane and handle, and its drag are Steve's. What differs is where the
 * cut is applied: Steve clips its model's own materials; here every material in the scene outside this layer takes
 * the plane, each frame the section is on, since the scene's meshes come and go with the playback.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { useView, viewer, type SectionState } from './viewer';

const get = () => useView.getState();
const set = (patch: { section: SectionState }) => useView.setState(patch);
const theme: 'dark' | 'light' = 'dark';

/** Runs `apply` at most once per animation frame with the latest value; `flush` runs a pending one now (Steve's dragStep.ts). */
function perFrame<T>(apply: (value: T) => void) {
  let frame = 0;
  let pending: { value: T } | null = null;
  const run = () => { frame = 0; const next = pending; pending = null; if (next) apply(next.value); };
  return {
    push(value: T) { pending = { value }; if (!frame) frame = requestAnimationFrame(run); },
    flush() { if (frame) { cancelAnimationFrame(frame); run(); } },
  };
}

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

export function sectionPlane(section: SectionState, box: THREE.Box3): { plane: THREE.Plane; position: number } {
  const axis = AXES[section.axis];
  const min = box.min.dot(axis), max = box.max.dot(axis);
  // Stay a hair inside the extremes so the cap never z-fights with an end face.
  const position = THREE.MathUtils.lerp(min, max, THREE.MathUtils.clamp(section.offset, 0.0005, 0.9995));
  // Clipping keeps the side where the signed distance is positive.
  const normal = axis.clone().multiplyScalar(section.flip ? 1 : -1);
  return { plane: new THREE.Plane(normal, section.flip ? -position : position), position };
}

const capVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const capFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHatch;
  uniform float uSpacing;
  uniform vec3 uU;
  uniform vec3 uV;
  varying vec3 vWorld;
  void main() {
    float s = dot(vWorld, uU) + dot(vWorld, uV);
    float coord = s / uSpacing;
    float line = abs(fract(coord) - 0.5) / fwidth(coord);
    float hatch = 1.0 - min(line / 0.75, 1.0);
    gl_FragColor = vec4(mix(uColor, uHatch, hatch * 0.7), 1.0);
    #include <colorspace_fragment>
  }
`;

/** Whether an object is left whole: this layer's own plane, caps and handle, and anything marked `userData.uncut` (the ground grid, the origin). */
const uncut = (object: THREE.Object3D) => { for (let o: THREE.Object3D | null = object; o; o = o.parent) if (o.userData.sectionLayer || o.userData.uncut) return true; return false; };
/** The stencil writers: drawn to the stencil only, back faces counting up and front faces down. */
const STENCIL_BASE = { depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc };
const COUNT_UP = { stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp };
const COUNT_DOWN = { stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp };
const materialsOf = (object: THREE.Object3D): THREE.Material[] => {
  const material = (object as THREE.Mesh).material;
  return !material ? [] : Array.isArray(material) ? material : [material];
};

export default function SectionLayer({ box }: { box: THREE.Box3 }) {
  const section = useView((state) => state.section);
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);
  const [hot, setHot] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cut = useMemo(() => (box.isEmpty() ? null : sectionPlane(section, box)), [section, box]);
  const plane = viewer.sectionPlane;
  // Keep the shared plane in sync; materials hold a reference, so this is all a drag needs.
  if (cut) plane.copy(cut.plane);
  useEffect(() => { invalidate(); }, [cut, invalidate]);

  const capMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: capVertex,
    fragmentShader: capFragment,
    uniforms: { uColor: { value: new THREE.Color() }, uHatch: { value: new THREE.Color() }, uSpacing: { value: 2 }, uU: { value: new THREE.Vector3() }, uV: { value: new THREE.Vector3() } },
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
    side: THREE.DoubleSide,
  }), []);
  const stencil = useMemo(() => ({
    back: new THREE.MeshBasicMaterial({ ...STENCIL_BASE, side: THREE.BackSide, ...COUNT_UP }),
    front: new THREE.MeshBasicMaterial({ ...STENCIL_BASE, side: THREE.FrontSide, ...COUNT_DOWN }),
  }), []);

  // The cut itself. While the section is on, every material outside this layer takes the plane, and every mesh of a
  // closed solid (marked `userData.solid`) gets its two stencil writers, which count its faces in front of and behind
  // the cut so the cap is drawn only where the plane is inside it. A mesh whose shape is made in its vertex shader
  // gives its own writer material (`userData.stencilMaterial`). The scene's meshes come and go with the playback, so
  // this is looked at each frame; it does work only when something is new.
  const clipped = useRef(new Set<THREE.Material>());
  const writers = useRef(new Map<THREE.Mesh, { meshes: THREE.Mesh[]; own: THREE.Material[] }>());
  const planes = useMemo(() => [plane], [plane]);
  const drop = (mesh: THREE.Mesh) => {
    const entry = writers.current.get(mesh);
    if (!entry) return;
    entry.meshes.forEach((writer) => writer.removeFromParent());
    entry.own.forEach((material) => material.dispose());
    writers.current.delete(mesh);
  };
  useFrame(() => {
    if (!section.enabled) return;
    stencil.back.clippingPlanes = stencil.front.clippingPlanes = planes;
    const seen = new Set<THREE.Mesh>();
    const solids: THREE.Mesh[] = [];
    scene.traverse((object) => {
      if (uncut(object) || object.userData.sectionWriter) return;
      for (const material of materialsOf(object)) {
        if (clipped.current.has(material)) continue;
        material.clippingPlanes = planes;
        material.needsUpdate = true;
        clipped.current.add(material);
      }
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.userData.solid) solids.push(mesh);
    });
    for (const mesh of solids) {
      seen.add(mesh);
      const entry = writers.current.get(mesh);
      if (entry) { for (const writer of entry.meshes) if (writer.geometry !== mesh.geometry) writer.geometry = mesh.geometry; continue; }
      const own: THREE.Material[] = [];
      const meshes = ([THREE.BackSide, THREE.FrontSide] as const).map((side) => {
        let material: THREE.Material = side === THREE.BackSide ? stencil.back : stencil.front;
        const make = mesh.userData.stencilMaterial as (() => THREE.Material) | undefined;
        if (make) {
          material = make();
          Object.assign(material, STENCIL_BASE, { side, clippingPlanes: planes }, side === THREE.BackSide ? COUNT_UP : COUNT_DOWN);
          own.push(material);
        }
        const writer = new THREE.Mesh(mesh.geometry, material);
        writer.renderOrder = 20;
        writer.frustumCulled = mesh.frustumCulled;
        writer.raycast = () => {};
        writer.userData.sectionWriter = true;
        mesh.add(writer);
        return writer;
      });
      writers.current.set(mesh, { meshes, own });
    }
    for (const mesh of [...writers.current.keys()]) if (!seen.has(mesh)) drop(mesh);
  });
  useEffect(() => {
    gl.localClippingEnabled = true;
    if (!section.enabled) return;
    const materials = clipped.current;
    invalidate();
    return () => {
      for (const material of materials) { material.clippingPlanes = null; material.needsUpdate = true; }
      materials.clear();
      for (const mesh of [...writers.current.keys()]) drop(mesh);
      invalidate();
    };
  }, [section.enabled, gl, invalidate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const dark = theme === 'dark';
    // Cut faces: orange hatching, so the section reads apart from the model's own faces.
    capMaterial.uniforms.uColor.value.set(dark ? '#e0782a' : '#f0a45c');
    capMaterial.uniforms.uHatch.value.set(dark ? '#7a3510' : '#b4500f');
    capMaterial.uniforms.uSpacing.value = Math.max(box.getSize(new THREE.Vector3()).length() / 26, 0.05);
  }, [box, capMaterial]);

  const frame = useMemo(() => {
    if (!cut || box.isEmpty()) return null;
    const axis = AXES[section.axis];
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    center.addScaledVector(axis, cut.position - center.dot(axis));
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const u = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
    const v = axis.clone().cross(u);
    const margin = size.length() * 0.08;
    const w = Math.abs(size.dot(u)) + margin * 2, h = Math.abs(size.dot(v)) + margin * 2;
    return { axis, center, quaternion, u, v, w, h, span: Math.max(w, h) * 2, min: box.min.dot(axis), max: box.max.dot(axis), handle: size.length() * 0.09 };
  }, [cut, box, section.axis]);

  // Drag the plane along its axis. Capture-phase listeners run before camera-controls,
  // so a press on the plane never orbits; a press without movement still selects.
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    const canvas = gl.domElement;
    const container = canvas.parentElement;
    if (!container || !section.enabled) return;
    const raycaster = new THREE.Raycaster();
    const rayAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), viewer.camera!);
      return raycaster.ray;
    };
    const onPlane = (event: PointerEvent) => {
      const f = frameRef.current;
      if (!f || !viewer.camera) return false;
      const hit = rayAt(event).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(f.axis, f.center), new THREE.Vector3());
      if (!hit) return false;
      const local = hit.sub(f.center);
      return Math.abs(local.dot(f.u)) <= f.w / 2 && Math.abs(local.dot(f.v)) <= f.h / 2;
    };
    // Parameter along the section axis closest to the pointer ray, measured from a fixed origin.
    // The origin must not move with the plane during a drag, or each step undoes the last one.
    const axisParameter = (event: PointerEvent, origin: THREE.Vector3, axis: THREE.Vector3) => {
      const ray = rayAt(event);
      const w0 = ray.origin.clone().sub(origin);
      const b = ray.direction.dot(axis);
      const denominator = 1 - b * b;
      if (denominator < 1e-4) return null;
      return (w0.dot(axis) - b * w0.dot(ray.direction)) / denominator;
    };
    let drag: { id: number; x: number; y: number; origin: THREE.Vector3; axis: THREE.Vector3; t0: number | null; start: number; moved: boolean; button: number } | null = null;
    const frames = perFrame((offset: number) => { const current = get().section; if (current.offset !== offset) set({ section: { ...current, offset } }); });

    const onDown = (event: PointerEvent) => {
      const f = frameRef.current;
      if (event.button !== 0 || !f || !onPlane(event)) return;
      event.stopPropagation();
      event.preventDefault();
      const state = get();
      const origin = f.center.clone(), axis = f.axis.clone();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin, axis, t0: axisParameter(event, origin, axis), start: THREE.MathUtils.lerp(f.min, f.max, state.section.offset), moved: false, button: event.button };
      window.addEventListener('pointermove', onDrag);
      window.addEventListener('pointerup', onUp);
    };
    const onDrag = (event: PointerEvent) => {
      const f = frameRef.current;
      if (!drag || event.pointerId !== drag.id || !f) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
      if (!drag.moved) { drag.moved = true; setDragging(true); }
      let position: number;
      const t = axisParameter(event, drag.origin, drag.axis);
      if (t !== null && drag.t0 !== null) position = drag.start + (t - drag.t0);
      else {
        // Looking straight down the axis: fall back to vertical mouse travel.
        const camera = viewer.camera!;
        const perPixel = camera instanceof THREE.OrthographicCamera ? 1 / camera.zoom : (f.max - f.min) / 300;
        position = drag.start + (drag.y - event.clientY) * perPixel;
      }
      const offset = THREE.MathUtils.clamp((position - f.min) / Math.max(f.max - f.min, 1e-9), 0, 1);
      frames.push(offset);
    };
    const onUp = () => {
      frames.flush();
      window.removeEventListener('pointermove', onDrag);
      window.removeEventListener('pointerup', onUp);
      drag = null;
      setDragging(false);
    };
    const onHover = (event: PointerEvent) => {
      if (drag || event.buttons) return;
      const over = onPlane(event);
      viewer.sectionHot = over;
      setHot((current) => (current === over ? current : over));
      canvas.style.cursor = over ? 'grab' : canvas.style.cursor === 'grab' ? '' : canvas.style.cursor;
    };
    container.addEventListener('pointerdown', onDown, { capture: true });
    container.addEventListener('pointermove', onHover);
    return () => {
      container.removeEventListener('pointerdown', onDown, { capture: true });
      container.removeEventListener('pointermove', onHover);
      window.removeEventListener('pointermove', onDrag);
      window.removeEventListener('pointerup', onUp);
      if (canvas.style.cursor === 'grab') canvas.style.cursor = '';
      viewer.sectionHot = false;
    };
  }, [gl, section.enabled]);

  useEffect(() => {
    const canvas = gl.domElement;
    if (dragging) canvas.style.cursor = 'grabbing';
    else if (canvas.style.cursor === 'grabbing') canvas.style.cursor = hot ? 'grab' : '';
  }, [dragging, hot, gl]);

  if (!section.enabled || !frame) return null;
  capMaterial.uniforms.uU.value.copy(frame.u);
  capMaterial.uniforms.uV.value.copy(frame.v);
  const { w, h } = frame;
  const outline: [number, number, number][] = [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0], [-w / 2, -h / 2, 0]];
  const accent = theme === 'dark' ? '#8fdcc0' : '#1f9a73';
  const active = hot || dragging;
  // The handle points into the removed half, the side the viewer is looking from.
  const toward = section.flip ? -1 : 1;
  const cap = (
    <mesh material={capMaterial} renderOrder={21} onUpdate={(mesh) => { mesh.raycast = () => {}; }}>
      <planeGeometry args={[frame.span, frame.span]} />
    </mesh>
  );
  return (
    <group position={frame.center} quaternion={frame.quaternion} userData={{ sectionLayer: true }}>
      {cap}
      <mesh renderOrder={22}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color={accent} transparent opacity={active ? 0.13 : 0.05} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={outline} color={accent} lineWidth={active ? 2.4 : 1.4} transparent opacity={active ? 1 : 0.8} />
      <group rotation={[toward > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0]}>
        <mesh position={[0, frame.handle * 0.45, 0]} renderOrder={23}>
          <cylinderGeometry args={[frame.handle * 0.035, frame.handle * 0.035, frame.handle * 0.9, 12]} />
          <meshBasicMaterial color={accent} depthTest={false} transparent opacity={active ? 1 : 0.85} />
        </mesh>
        <mesh position={[0, frame.handle * 1.05, 0]} renderOrder={23}>
          <coneGeometry args={[frame.handle * 0.11, frame.handle * 0.3, 20]} />
          <meshBasicMaterial color={accent} depthTest={false} transparent opacity={active ? 1 : 0.85} />
        </mesh>
      </group>
    </group>
  );
}
