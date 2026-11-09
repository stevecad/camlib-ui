/**
 * The camera and its navigation (from STEVE Studio's SceneCore and Interaction): camera-controls with the mouse style's
 * buttons, Open Inventor's trackball for drag-to-orbit, orbits about the point pressed on the part, pans that keep the
 * grabbed point under the pointer, the same zoom step per wheel notch on every platform, a middle-click rotation centre,
 * and the framing kept across projection switches. A head light follows the camera.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CameraControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import CameraControlsImpl from 'camera-controls';
import * as THREE from 'three';
import { setting, useSettings } from '../settings';
import { applyMouseStyle, mouseDragAction, orbitAbout } from './mouseStyle';
import { useView, viewer } from './viewer';

interface Pose { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; visibleHeight: number }
let lastPose: Pose | null = null;

function visibleHeight(camera: THREE.Camera, target: THREE.Vector3, height: number) {
  if (camera instanceof THREE.OrthographicCamera) return height / camera.zoom;
  const perspective = camera as THREE.PerspectiveCamera;
  return 2 * camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2);
}

// Natural-log change in camera distance (or 1/zoom) per wheel event: about 15% per mouse-wheel notch, whatever pixels
// the browser reports for it (Chrome on macOS sends ~4 px a notch, Windows 100 px).
const WHEEL_NOTCH = Math.log(1.15);
const WHEEL_PIXEL = 0.003; // smooth trackpad / Magic Mouse scrolling, per pixel
const WHEEL_PINCH = 0.025; // trackpad pinch (ctrl+wheel), per unit
const WHEEL_MAX_STEP = Math.log(2);

function wheelZoomStep(event: WheelEvent, pageHeight: number) {
  const { deltaY } = event;
  // Chrome and Safari report a notched wheel as multiples of 120 here, and a trackpad as -3 × deltaY.
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  let step: number;
  if (event.ctrlKey) step = deltaY * WHEEL_PINCH;
  else if (event.deltaMode === 1) step = deltaY / 3 * WHEEL_NOTCH;
  else if (event.deltaMode === 2) step = deltaY * pageHeight / 100 * WHEEL_NOTCH;
  else if (legacy && legacy % 120 === 0 && Math.abs(legacy + 3 * deltaY) > 1) step = -legacy / 120 * WHEEL_NOTCH;
  else step = deltaY * WHEEL_PIXEL;
  return THREE.MathUtils.clamp(step, -WHEEL_MAX_STEP, WHEEL_MAX_STEP);
}

/** Settings → Navigation that camera-controls holds: zoom toward the pointer, and orbit speed. */
function tune(controls: CameraControlsImpl) {
  controls.dollyToCursor = setting('viewport.zoomToCursor');
  controls.azimuthRotateSpeed = 0.85 * setting('viewport.orbitSpeed');
  controls.polarRotateSpeed = 0.85 * setting('viewport.orbitSpeed');
}

export function CameraRig() {
  const projection = useView((state) => state.projection);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // The wheel event camera-controls is handling right now, so its dolly/zoom step can be replaced.
  const wheelRef = useRef<WheelEvent | null>(null);
  useEffect(() => {
    const begin = (event: WheelEvent) => { wheelRef.current = event; };
    const end = () => { wheelRef.current = null; };
    window.addEventListener('wheel', begin, { capture: true, passive: true });
    window.addEventListener('wheel', end, { passive: true });
    return () => {
      window.removeEventListener('wheel', begin, { capture: true });
      window.removeEventListener('wheel', end);
    };
  }, []);

  useEffect(() => { viewer.invalidate = invalidate; }, [invalidate]);

  // A change in Settings → Navigation applies to the view at once.
  useEffect(() => useSettings.subscribe((state, previous) => {
    const keys = ['viewport.zoomToCursor', 'viewport.orbitSpeed'] as const;
    if (viewer.controls && keys.some((key) => state.values[key] !== previous.values[key])) tune(viewer.controls);
    if (viewer.controls && state.values['viewport.mouseStyle'] !== previous.values['viewport.mouseStyle']) applyMouseStyle(viewer.controls);
    if (state.values['viewport.lockZUp'] && !previous.values['viewport.lockZUp']) viewer.standUpright();
  }), []);

  // camera-controls maps a drag per button only: for the styles that use Ctrl or Shift with a button (SOLIDWORKS'
  // Ctrl+middle pan, Fusion's Shift+middle orbit, Onshape's Ctrl+right pan), set its buttons from the keys held as the
  // press starts, before it reads them (capture, on the window), and put back the plain mapping when the press ends.
  const element = useThree((state) => state.gl.domElement);
  useEffect(() => {
    let held = false;
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !viewer.controls || !(event.target instanceof Node) || !element.contains(event.target)) return;
      held = true;
      applyMouseStyle(viewer.controls, event);
    };
    const up = () => {
      if (!held) return;
      held = false;
      if (viewer.controls) applyMouseStyle(viewer.controls);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
  }, [element]);

  const register = useCallback((controls: CameraControlsImpl | null) => {
    if (!controls) return;
    const camera = controls.camera as THREE.OrthographicCamera | THREE.PerspectiveCamera;
    // Z up, unless the view had been orbited over the top before a projection switch.
    if (lastPose) camera.up.copy(lastPose.up);
    else camera.up.set(0, 0, 1);
    controls.updateCameraUp();
    const A = CameraControlsImpl.ACTION;
    const ortho = camera instanceof THREE.OrthographicCamera;
    applyMouseStyle(controls);
    controls.touches.one = A.TOUCH_ROTATE;
    controls.touches.two = ortho ? A.TOUCH_ZOOM_TRUCK : A.TOUCH_DOLLY_TRUCK;
    controls.touches.three = A.TOUCH_TRUCK;
    controls.smoothTime = 0.26;
    controls.draggingSmoothTime = 0.07;
    controls.dollySpeed = 0.6;
    tune(controls);
    controls.minZoom = 1e-4;
    controls.maxZoom = 1e6;
    controls.minDistance = 1e-3;
    controls.maxDistance = 1e7;
    controls.restThreshold = 0.002;
    // camera-controls' own rotate stops dead at the top and bottom views: its drag-to-rotate goes through
    // viewer.trackball (Open Inventor's virtual trackball), or viewer.orbit with Z kept up.
    const drag = controls as unknown as {
      _rotateInternal?: (deltaX: number, deltaY: number) => void;
      _truckInternal?: (deltaX: number, deltaY: number, dragToOffset: boolean, ...rest: unknown[]) => void;
    };
    if (typeof drag._rotateInternal === 'function') {
      const pointers = controls as unknown as { _activePointers?: { clientX: number; clientY: number }[] };
      drag._rotateInternal = (deltaX, deltaY) => {
        const active = pointers._activePointers ?? [];
        const rect = (controls as unknown as { _domElement?: HTMLElement })._domElement?.getBoundingClientRect();
        if (!active.length || !rect || !rect.width || !rect.height) return;
        if (setting('viewport.lockZUp')) {
          const turn = 2 * Math.PI * setting('viewport.orbitSpeed') / rect.height;
          viewer.orbit(deltaX * turn, deltaY * turn, true);
          return;
        }
        const x = active.reduce((sum, p) => sum + p.clientX, 0) / active.length;
        const y = active.reduce((sum, p) => sum + p.clientY, 0) / active.length;
        const ndc = (cx: number, cy: number) => ({ x: (cx - rect.left) / rect.width * 2 - 1, y: 1 - (cy - rect.top) / rect.height * 2 });
        viewer.trackball(ndc(x + deltaX, y + deltaY), ndc(x, y), setting('viewport.orbitSpeed'));
      };
    }
    // Pan by exactly one screen pixel per pointer pixel at the grabbed point's depth (panDepth), so the model stays
    // under the cursor (camera-controls moves orthographic views twice as fast, perspective ones at the target's depth).
    const truck = drag._truckInternal;
    if (typeof truck === 'function') {
      drag._truckInternal = (deltaX, deltaY, dragToOffset, ...rest) => {
        if (dragToOffset) { truck.call(controls, deltaX, deltaY, dragToOffset, ...rest); return; }
        const height = Math.max(sizeRef.current.height, 1);
        let unit: number;
        if (camera instanceof THREE.OrthographicCamera) unit = (camera.top - camera.bottom) / camera.zoom / height;
        else {
          const depth = viewer.panDepth ?? camera.position.distanceTo(controls.getTarget(new THREE.Vector3(), false));
          unit = 2 * Math.max(depth, 0) * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / height;
        }
        void controls.truck(deltaX * unit, deltaY * unit, false);
      };
    }
    // The same proportional zoom step per wheel event everywhere (wheelZoomStep); both internals scale by
    // 0.95^(delta × dollySpeed), so convert the log step into their delta.
    const zoom = controls as unknown as {
      _dollyInternal?: (delta: number, x: number, y: number) => void;
      _zoomInternal?: (delta: number, x: number, y: number) => void;
    };
    for (const key of ['_dollyInternal', '_zoomInternal'] as const) {
      const internal = zoom[key];
      if (typeof internal !== 'function') continue;
      zoom[key] = (delta, x, y) => {
        const event = wheelRef.current;
        if (event) {
          wheelRef.current = null;
          const sign = setting('viewport.invertWheel') && !event.ctrlKey ? -1 : 1;
          delta = sign * setting('viewport.zoomSpeed') * wheelZoomStep(event, sizeRef.current.height) / (controls.dollySpeed * -Math.log(0.95));
        }
        internal.call(controls, delta, x, y);
      };
    }
    viewer.controls = controls;
    viewer.camera = camera;

    if (lastPose) {
      // Keep the framing across projection switches.
      const { position, target } = lastPose;
      const direction = position.clone().sub(target).normalize();
      if (ortho) {
        camera.zoom = sizeRef.current.height / lastPose.visibleHeight;
        const distance = Math.max(viewer.modelRadius() * 8, 50);
        const eye = target.clone().addScaledVector(direction, distance);
        camera.near = -viewer.modelRadius() * 40;
        camera.far = distance + viewer.modelRadius() * 60 + 1e4;
        camera.updateProjectionMatrix();
        void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
        void controls.zoomTo(camera.zoom, false);
      } else {
        const distance = lastPose.visibleHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
        const eye = target.clone().addScaledVector(direction, distance);
        camera.near = Math.max(distance / 2000, 0.01);
        camera.far = distance * 50 + viewer.modelRadius() * 20;
        camera.updateProjectionMatrix();
        void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
      }
    } else viewer.fit(false);

    controls.addEventListener('controlstart', () => { viewer.interacting = true; viewer.autoFramed = false; });
    controls.addEventListener('control', () => {
      // Only an actual orbit leaves the named view; pans and zooms keep it.
      if ((controls.currentAction === A.ROTATE || controls.currentAction === A.TOUCH_ROTATE) && useView.getState().view) useView.setState({ view: null });
    });
    controls.addEventListener('controlend', () => { viewer.interacting = false; });
    viewer.moving = false;
    controls.addEventListener('wake', () => { viewer.moving = true; });
    controls.addEventListener('rest', () => { viewer.moving = false; });
    controls.addEventListener('sleep', () => { viewer.moving = false; });
    invalidate();
  }, [invalidate]);

  useFrame(({ camera }) => {
    const controls = viewer.controls;
    if (!controls) return;
    const target = controls.getTarget(new THREE.Vector3());
    lastPose = { position: camera.position.clone(), target, up: camera.up.clone(), visibleHeight: visibleHeight(camera, target, sizeRef.current.height) };
    viewer.emitCamera();
  });

  // The view's size, and room for the overlays (view cube, nav bar, the player at the bottom).
  useEffect(() => {
    viewer.size = { width: size.width, height: size.height };
    viewer.insets = size.width < 720 ? { top: 70, right: 16, bottom: 180, left: 16 } : { top: 24, right: 150, bottom: 190, left: 24 };
    if (viewer.autoFramed) viewer.frame(null, null, false);
    invalidate();
  }, [size, invalidate]);

  return (
    <>
      {projection === 'orthographic'
        ? <OrthographicCamera key="ortho" makeDefault up={[0, 0, 1]} position={[240, -240, 200]} zoom={2.2} near={-10000} far={100000} />
        : <PerspectiveCamera key="persp" makeDefault up={[0, 0, 1]} position={[240, -240, 200]} fov={30} near={0.1} far={100000} />}
      <CameraControls key={projection} ref={register} makeDefault />
      <HeadLight />
    </>
  );
}

/** A key light that follows the camera so faces toward the viewer always read clearly. */
function HeadLight() {
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const light = new THREE.DirectionalLight('#ffffff', 1.7);
    // Upper left of the viewer, so top, front and side faces read at distinct brightness.
    light.position.set(-0.45, 0.85, 0.55);
    const target = new THREE.Object3D();
    target.position.set(0, 0, -1);
    camera.add(light, target);
    light.target = target;
    if (!camera.parent) scene.add(camera);
    return () => { camera.remove(light, target); light.dispose(); };
  }, [camera, scene]);
  return null;
}

/**
 * Pointer handling on the canvas (from STEVE Studio's Interaction): an orbit turns about the point pressed on the part
 * (or the visible model's centre, or the origin: Settings → Navigation › Orbit about), a pan holds the grabbed point
 * under the cursor, and a middle-click on the part makes it the rotation centre until the view is reset. Picking a face
 * is the part's own click.
 */
export function Interaction() {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const element = gl.domElement;
    let down: { x: number; y: number; button: number } | null = null;
    const ndcOf = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      return new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    };
    /** The part's surface under the pointer, else the point under it at the depth of `target`, facing the camera. */
    const pivotAt = (event: PointerEvent, target: THREE.Vector3) => {
      const ndc = ndcOf(event);
      const surface = viewer.surfacePoint(ndc);
      if (surface) return surface;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, viewer.camera!);
      const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(viewer.camera!.getWorldDirection(new THREE.Vector3()), target);
      return raycaster.ray.intersectPlane(facing, new THREE.Vector3()) ?? target.clone();
    };
    const orbitCentre = (event: PointerEvent, target: THREE.Vector3) => {
      if (viewer.orbitCentre) return viewer.orbitCentre.clone();
      const about = orbitAbout();
      if (about === 'origin') return new THREE.Vector3();
      if (about === 'model') {
        const bounds = viewer.bounds();
        if (!bounds.isEmpty()) return bounds.getCenter(new THREE.Vector3());
      }
      return pivotAt(event, target);
    };
    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY, button: event.button };
      const drag = event.pointerType !== 'touch' ? mouseDragAction(event) : event.button === 0 ? 'orbit' : null;
      if (drag === 'orbit' && viewer.controls && viewer.camera) {
        const controls = viewer.controls;
        // A zoom or view change still settling stops where it is first: re-pivoting mid-transition would jump.
        if (viewer.moving) controls.stop();
        const point = orbitCentre(event, controls.getTarget(new THREE.Vector3(), false));
        controls.setOrbitPoint(point.x, point.y, point.z);
      }
      viewer.panDepth = null;
      if (drag === 'pan' && viewer.camera) {
        const hit = viewer.surfacePoint(ndcOf(event));
        if (hit) viewer.panDepth = hit.clone().sub(viewer.camera.position).dot(viewer.camera.getWorldDirection(new THREE.Vector3()));
      }
    };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      viewer.panDepth = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      // A middle-click on the part makes it the rotation centre until the view is reset (as in SOLIDWORKS), when
      // orbits don't already turn about the point under the pointer.
      if (start.button === 1 && orbitAbout() !== 'pointer') {
        const hit = viewer.surfacePoint(ndcOf(event));
        if (hit) viewer.orbitCentre = hit;
      }
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('contextmenu', onContextMenu);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('contextmenu', onContextMenu);
    };
  }, [gl]);
  return null;
}
