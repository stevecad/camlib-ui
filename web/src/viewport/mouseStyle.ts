/**
 * Settings → Navigation › Mouse style (from STEVE Studio): which mouse buttons and keys orbit, pan and zoom, the way
 * other CAD programs do (each preset follows its maker's help: SOLIDWORKS "Middle Mouse Button Functions", Autodesk
 * Fusion's default "Pan, Zoom, Orbit Shortcuts", Onshape "View navigation"). The wheel always zooms. The viewport's
 * camera-controls (CameraRig) and its pointer handling (Interaction) read it from here.
 */
import CameraControls from 'camera-controls';
import * as THREE from 'three';
import { setting, type Settings } from '../settings';

export type MouseStyle = Settings['viewport.mouseStyle'];
export type DragAction = 'orbit' | 'pan' | 'zoom' | null;
interface Keys { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

const NO_KEYS: Keys = { ctrlKey: false, metaKey: false, shiftKey: false };

export const MOUSE_STYLES: { value: MouseStyle; label: string; summary: string; mouse: [string, string][] }[] = [
  {
    value: 'steve', label: 'STEVE', summary: 'Left-drag orbits, middle or right-drag pans, the wheel zooms.',
    mouse: [['Orbit', 'Left drag'], ['Pan', 'Right or middle drag'], ['Zoom to cursor', 'Scroll']],
  },
  {
    value: 'solidworks', label: 'SOLIDWORKS', summary: 'Middle-drag orbits, Ctrl+middle-drag pans, Shift+middle-drag or the wheel zooms.',
    mouse: [['Orbit', 'Middle drag'], ['Pan', 'Ctrl + middle drag'], ['Zoom to cursor', 'Scroll or Shift + middle drag']],
  },
  {
    value: 'fusion', label: 'Fusion', summary: 'Shift+middle-drag orbits, middle-drag pans, the wheel zooms.',
    mouse: [['Orbit', 'Shift + middle drag'], ['Pan', 'Middle drag'], ['Zoom to cursor', 'Scroll']],
  },
  {
    value: 'onshape', label: 'Onshape', summary: 'Right-drag orbits, middle or Ctrl+right-drag pans, the wheel zooms.',
    mouse: [['Orbit', 'Right drag'], ['Pan', 'Middle or Ctrl + right drag'], ['Zoom to cursor', 'Scroll']],
  },
];

export const mouseStyleInfo = (style: MouseStyle) => MOUSE_STYLES.find((item) => item.value === style) ?? MOUSE_STYLES[0];

/** What dragging with `button` (0 left, 1 middle, 2 right) and these keys does in `style`; null: nothing (it picks). */
export function dragAction(style: MouseStyle, button: number, keys: Keys): DragAction {
  const ctrl = keys.ctrlKey || keys.metaKey;  // ⌘ on macOS, as for selection.
  switch (style) {
    case 'solidworks': return button === 1 ? (ctrl ? 'pan' : keys.shiftKey ? 'zoom' : 'orbit') : null;
    case 'fusion': return button === 1 ? (keys.shiftKey ? 'orbit' : 'pan') : null;
    case 'onshape': return button === 1 ? 'pan' : button === 2 ? (ctrl ? 'pan' : 'orbit') : null;
    default:
      if (button === 0) return 'orbit';
      if (button === 1 || button === 2) return 'pan';
      return null;
  }
}

export const ORBIT_ABOUT: { value: Settings['viewport.orbitAbout']; label: string }[] = [
  { value: 'auto', label: 'Automatic (follows the mouse style)' },
  { value: 'pointer', label: 'The point under the pointer' },
  { value: 'model', label: 'The centre of the visible model' },
  { value: 'origin', label: 'The origin' },
];

/** What orbits turn about now: 'auto' is the visible model's centre for SOLIDWORKS (its default rotation centre), else
 *  the point under the pointer as a drag starts. */
export function orbitAbout(): 'pointer' | 'model' | 'origin' {
  const chosen = setting('viewport.orbitAbout');
  if (chosen !== 'auto') return chosen;
  return setting('viewport.mouseStyle') === 'solidworks' ? 'model' : 'pointer';
}

/** What a drag starting with this pointer event does in the viewport, now. */
export const mouseDragAction = (event: Keys & { button: number }) => dragAction(setting('viewport.mouseStyle'), event.button, event);

/** Sets camera-controls' buttons for the chosen style, with the keys held as a drag starts (none: the plain mapping). */
export function applyMouseStyle(controls: CameraControls, keys: Keys = NO_KEYS) {
  const A = CameraControls.ACTION;
  const ortho = controls.camera instanceof THREE.OrthographicCamera;
  const style = setting('viewport.mouseStyle');
  const action = (button: number) => {
    const drag = dragAction(style, button, keys);
    return drag === 'orbit' ? A.ROTATE : drag === 'pan' ? A.TRUCK : drag === 'zoom' ? (ortho ? A.ZOOM : A.DOLLY) : A.NONE;
  };
  controls.mouseButtons.left = action(0);
  controls.mouseButtons.middle = action(1);
  controls.mouseButtons.right = action(2);
  controls.mouseButtons.wheel = ortho ? A.ZOOM : A.DOLLY;
}
