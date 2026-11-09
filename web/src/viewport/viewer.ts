/**
 * The bridge between the interface and the 3D view (from STEVE Studio's viewer): the camera and its controls, framing,
 * standard views, orbiting (turntable, free, or with Z kept up) and Open Inventor's trackball for mouse drags. The view
 * state the interface shows (named view, projection, display style, grid, origin) is `useView`.
 */
import * as THREE from 'three';
import type CameraControls from 'camera-controls';
import { create } from 'zustand';
import { setting } from '../settings';

export type StandardView = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left';
export type Projection = 'perspective' | 'orthographic';
export type DisplayStyle = 'shaded-edges' | 'shaded' | 'hidden-line' | 'wireframe' | 'xray';

/** `partHidden`: the browser's eye on the part (fixtures have the player's, shared with its Fixtures toggle). */
export const useView = create<{ view: StandardView | null; projection: Projection; style: DisplayStyle; showGrid: boolean; showOrigin: boolean; partHidden: boolean }>(() => ({
  view: 'iso', projection: 'perspective', style: 'shaded-edges', showGrid: true, showOrigin: true, partHidden: false,
}));
const setView = (patch: Partial<ReturnType<typeof useView.getState>>) => useView.setState(patch);

export const VIEW_DIRECTIONS: Record<StandardView, [number, number, number]> = {
  iso: [1, -1, 0.82],
  top: [0, -1e-4, 1],
  bottom: [0, -1e-4, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

export const VIEW_LABELS: Record<StandardView, string> = {
  iso: 'Isometric', top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', right: 'Right', left: 'Left',
};

type CameraListener = (camera: THREE.Camera) => void;

const Z_UP = new THREE.Vector3(0, 0, 1);
/** How near straight up or down (radians) the camera goes with Z kept up: where the top and bottom views stand. */
const POLE = 1e-4;

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

class Viewer {
  controls: CameraControls | null = null;
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera | null = null;
  size = { width: 1, height: 1 };
  /** Room the overlays take at the view's edges (view cube, nav bar, the player), kept clear when framing. */
  insets = { top: 24, right: 150, bottom: 84, left: 24 };
  interacting = false;
  /** True while the camera is still moving (camera-controls' wake/rest/sleep). */
  moving = false;
  /** View depth of the model point grabbed by a mouse pan, so it stays under the cursor; null pans at the target's depth. */
  panDepth: number | null = null;
  /** A rotation centre a middle-click put on the part (as in SOLIDWORKS): orbits turn about it until the view is reset. */
  orbitCentre: THREE.Vector3 | null = null;
  /** True while the camera still shows an automatic framing the user hasn't changed. */
  autoFramed = false;
  /** What there is to look at (the part, the stock): the viewport sets it. */
  bounds: () => THREE.Box3 = () => new THREE.Box3();
  /** The point of what's shown under a canvas point (-1..1), or null: the viewport sets it (orbit pivot, pan depth, zoom to). */
  surfacePoint: (ndc: THREE.Vector2) => THREE.Vector3 | null = () => null;
  invalidate: () => void = () => {};
  private listeners = new Set<CameraListener>();

  onCamera(listener: CameraListener) {
    this.listeners.add(listener);
    if (this.camera) listener(this.camera);
    return () => { this.listeners.delete(listener); };
  }

  emitCamera() {
    if (this.camera) for (const listener of this.listeners) listener(this.camera);
  }

  modelRadius(): number {
    const box = this.bounds();
    if (box.isEmpty()) return 100;
    return Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
  }

  /** Frames a box from a view direction, animating rotation, target and zoom together. */
  frame(box: THREE.Box3 | null = null, direction: THREE.Vector3 | null = null, animate = true) {
    const { controls, camera } = this;
    if (!controls || !camera) return;
    this.orbitCentre = null;
    const bounds = box && !box.isEmpty() ? box : this.bounds();
    if (bounds.isEmpty()) return;
    const smooth = animate && !reducedMotion();
    const target = controls.getTarget(new THREE.Vector3());
    const eye = controls.getPosition(new THREE.Vector3());
    const dir = (direction ?? eye.clone().sub(target)).clone().normalize();
    if (dir.lengthSq() < 0.5) dir.set(1, -1, 0.8).normalize();
    // Named views stand upright on Z; a plain refit keeps whatever roll free orbiting left the camera in.
    const up = direction ? Z_UP.clone() : camera.up.clone();
    const basis = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), up);
    const xAxis = new THREE.Vector3().setFromMatrixColumn(basis, 0);
    const yAxis = new THREE.Vector3().setFromMatrixColumn(basis, 1);
    const center = bounds.getCenter(new THREE.Vector3());
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z).sub(center);
      const x = corner.dot(xAxis), y = corner.dot(yAxis);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const halfWidth = Math.max((maxX - minX) / 2, 1e-3);
    const halfHeight = Math.max((maxY - minY) / 2, 1e-3);
    const { width, height } = this.size;
    const inset = this.insets;
    const usableW = Math.max(width - inset.left - inset.right, width * 0.35);
    const usableH = Math.max(height - inset.top - inset.bottom, height * 0.35);
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    // Centre the model in the usable area rather than behind the overlays.
    const frameCenter = center.clone().addScaledVector(xAxis, (maxX + minX) / 2).addScaledVector(yAxis, (maxY + minY) / 2);
    this.setUp(up);
    void controls.setFocalOffset(0, 0, 0, smooth);
    if (camera instanceof THREE.OrthographicCamera) {
      const zoom = Math.min(usableW / (2 * halfWidth), usableH / (2 * halfHeight)) * 0.9;
      const worldPerPixel = 1 / zoom;
      frameCenter.addScaledVector(xAxis, -((inset.left - inset.right) / 2) * worldPerPixel);
      frameCenter.addScaledVector(yAxis, ((inset.top - inset.bottom) / 2) * worldPerPixel);
      const distance = Math.max(radius * 8, 50);
      camera.near = -radius * 40;
      camera.far = distance + radius * 60 + 1e4;
      camera.updateProjectionMatrix();
      const position = frameCenter.clone().addScaledVector(dir, distance);
      void controls.setLookAt(position.x, position.y, position.z, frameCenter.x, frameCenter.y, frameCenter.z, smooth);
      void controls.zoomTo(zoom, smooth);
    } else {
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const aspect = usableW / usableH;
      const distance = Math.max(halfHeight / Math.tan(fov / 2), halfWidth / (Math.tan(fov / 2) * aspect)) * 1.12 + radius;
      camera.near = Math.max(distance / 2000, 0.01);
      camera.far = distance * 50 + radius * 20;
      camera.updateProjectionMatrix();
      const position = frameCenter.clone().addScaledVector(dir, distance);
      void controls.setLookAt(position.x, position.y, position.z, frameCenter.x, frameCenter.y, frameCenter.z, smooth);
    }
    this.invalidate();
  }

  fit(animate = true) {
    this.frame(null, null, animate);
    this.autoFramed = true;
  }

  setView(view: StandardView, animate = true) {
    this.frame(null, new THREE.Vector3(...VIEW_DIRECTIONS[view]), animate);
    this.autoFramed = true;
    setView({ view });
  }

  lookFrom(direction: THREE.Vector3, animate = true) {
    const dir = direction.clone().normalize();
    // Keep top/bottom views oriented with +Y up on screen.
    if (Math.abs(dir.z) > 0.9999) dir.set(0, -1e-4, Math.sign(dir.z));
    this.frame(null, dir, animate);
    const match = (Object.entries(VIEW_DIRECTIONS) as [StandardView, number[]][])
      .find(([, value]) => new THREE.Vector3(...value).normalize().distanceTo(dir) < 1e-3);
    setView({ view: match ? match[0] : null });
  }

  zoomTo(box: THREE.Box3) {
    if (!box.isEmpty()) this.frame(box, null, true);
  }

  /** Orbit steps around the screen axes, as used by the view cube arrows. */
  rotateBy(azimuthDeg: number, polarDeg: number) {
    if (!this.controls) return;
    if (setting('viewport.lockZUp')) this.standUpright();
    void this.controls.rotate(THREE.MathUtils.degToRad(azimuthDeg), THREE.MathUtils.degToRad(polarDeg), !reducedMotion());
    setView({ view: null });
  }

  /**
   * Orbits about the target like `controls.rotate` (same signs, radians), but without its stop at the top and bottom,
   * so the view cube and mouse drags can tumble the model all the way round. The view cube turns like a turntable
   * (about world Z); mouse drags (`free`) turn about the screen's own axes and keep turning about the point a press on
   * the model chose. With "Keep Z up when orbiting" on, every one of them turns about world Z and tips about the
   * screen's horizontal axis, with no roll and no passing over the top.
   */
  orbit(azimuth: number, elevation: number, free = false) {
    const { controls, camera } = this;
    if (!controls || !camera) return;
    const target = controls.getTarget(new THREE.Vector3(), false);
    const offset = controls.getPosition(new THREE.Vector3(), false).sub(target);
    const back = offset.clone().normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, back);
    if (right.lengthSq() < 1e-12) right.setFromMatrixColumn(camera.matrixWorld, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    // A press on the model pivots about the point under the cursor, which camera-controls keeps as a target plus a
    // camera-space focal offset. Fold that offset into the target (the view doesn't move) so the tumble turns about the
    // middle of the screen. A mouse drag keeps it: the turn is about the pressed point.
    const focal = controls.getFocalOffset(new THREE.Vector3(), false);
    if (!free && focal.lengthSq() > 0) {
      target.addScaledVector(right, focal.x).addScaledVector(up, -focal.y).addScaledVector(back, focal.z);
      void controls.setFocalOffset(0, 0, 0, false);
    }
    if (setting('viewport.lockZUp')) {
      const polar = Math.atan2(Math.hypot(offset.x, offset.y), offset.z);
      const side = Math.sin(polar) < 2 * POLE
        ? new THREE.Vector3(up.x, up.y, 0).multiplyScalar(offset.z > 0 ? -1 : 1)
        : new THREE.Vector3(offset.x, offset.y, 0);
      side.normalize().applyAxisAngle(Z_UP, azimuth);
      const tipped = THREE.MathUtils.clamp(polar + elevation, POLE, Math.PI - POLE);
      const distance = offset.length();
      offset.copy(side).multiplyScalar(Math.sin(tipped)).setZ(Math.cos(tipped)).multiplyScalar(distance);
      camera.up.copy(Z_UP);
      controls.updateCameraUp();
      const eye = target.clone().add(offset);
      void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
      return;
    }
    // Turntable: turn about world Z (reversed once over the top, so a drag keeps its on-screen direction). Free: turn
    // about the screen's vertical axis. Both tip about the screen's horizontal axis with no limit.
    const spin = free ? up.clone() : up.z < 0 ? Z_UP.clone().negate() : Z_UP;
    const turn = new THREE.Quaternion().setFromAxisAngle(spin, azimuth).multiply(new THREE.Quaternion().setFromAxisAngle(right, elevation));
    offset.applyQuaternion(turn);
    up.applyQuaternion(turn).normalize();
    camera.up.copy(free || Math.abs(up.z) <= 1e-3 ? up : up.z > 0 ? Z_UP : Z_UP.clone().negate());
    controls.updateCameraUp();
    const eye = target.clone().add(offset);
    void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
  }

  /**
   * Mouse-drag rotation exactly as Open Inventor's examiner viewer does it (Coin's SbSphereSheetProjector, FreeCAD's
   * "Trackball" orbit style): each pointer position, in the canvas's own -1..1 coordinates (x right, y up), is
   * projected onto a virtual trackball of radius 0.8 centred on the screen, which beyond 45 degrees from its centre
   * continues as a hyperbolic sheet; the model turns by the shortest arc that carries the previous projected point to
   * the new one, about the view's centre. `speed` scales the angle (Settings → Navigation, 1 = Inventor's).
   */
  trackball(from: { x: number; y: number }, to: { x: number; y: number }, speed = 1) {
    const { controls, camera } = this;
    if (!controls || !camera) return;
    const a = sheetPoint(from.x, from.y), b = sheetPoint(to.x, to.y);
    if (a.distanceToSquared(b) < 1e-14) return;
    const turn = new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize());
    if (speed !== 1) {
      const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
      const axis = new THREE.Vector3(turn.x, turn.y, turn.z);
      if (axis.lengthSq() > 1e-20) turn.setFromAxisAngle(axis.normalize().multiplyScalar(Math.sign(turn.w) || 1), angle * speed);
    }
    const target = controls.getTarget(new THREE.Vector3(), false);
    const position = controls.getPosition(new THREE.Vector3(), false);
    const view = position.clone().sub(target).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, view);
    if (right.lengthSq() < 1e-12) right.setFromMatrixColumn(camera.matrixWorld, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(view, right);
    // A press on the model leaves camera-controls a focal offset (the camera and its target both shifted in camera
    // space): fold it into both, so the view doesn't move.
    const focal = controls.getFocalOffset(new THREE.Vector3(), false);
    if (focal.lengthSq() > 0) {
      const shift = new THREE.Vector3().addScaledVector(right, focal.x).addScaledVector(up, -focal.y).addScaledVector(view, focal.z);
      target.add(shift);
      position.add(shift);
      void controls.setFocalOffset(0, 0, 0, false);
    }
    const basis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, view));
    const world = basis.clone().multiply(turn.invert()).multiply(basis.clone().invert());
    const offset = position.sub(target).applyQuaternion(world);
    camera.up.copy(up.applyQuaternion(world).normalize());
    controls.updateCameraUp();
    const eye = target.clone().add(offset);
    void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
  }

  /** Stands a view left rolled or upside down back on Z, from where it looks: for "Keep Z up when orbiting". */
  standUpright() {
    if (!this.camera || this.camera.up.distanceToSquared(Z_UP) < 1e-12) return;
    this.orbit(0, 0, true);
    this.invalidate();
  }

  /** Changes camera.up without moving the camera, re-expressing camera-controls' state in the new frame. */
  private setUp(up: THREE.Vector3) {
    const { controls, camera } = this;
    if (!controls || !camera || camera.up.distanceToSquared(up) < 1e-12) return;
    const target = controls.getTarget(new THREE.Vector3(), false);
    const eye = controls.getPosition(new THREE.Vector3(), false);
    camera.up.copy(up).normalize();
    controls.updateCameraUp();
    void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
  }
}

export const viewer = new Viewer();

/** Coin's SbSphereSheetProjector::project with Open Inventor's examiner settings (orthographic -1..1 view volume,
 * sphere radius 0.8 at the origin, oriented to the eye): the sphere within 45 degrees of its centre, else the
 * hyperbolic sheet z = (r^2 / 2) / d over the plane through the centre. */
const TRACKBALL_RADIUS = 0.8;
function sheetPoint(x: number, y: number): THREE.Vector3 {
  const d = Math.hypot(x, y), r = TRACKBALL_RADIUS;
  if (d < r * Math.cos(Math.PI / 4)) return new THREE.Vector3(x, y, Math.sqrt(r * r - d * d));
  return new THREE.Vector3(x, y, (r * r * 0.5) / d);
}
