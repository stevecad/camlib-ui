/**
 * Settings that belong to this browser (kept in localStorage): Settings → Navigation, as in STEVE Studio. The keys and
 * defaults are the studio's, so the view behaves the same in both.
 */
import { create } from 'zustand';

export interface Settings {
  /** Which mouse buttons orbit, pan and zoom (viewport/mouseStyle.ts). */
  'viewport.mouseStyle': 'steve' | 'solidworks' | 'fusion' | 'onshape';
  /** What orbits turn about; 'auto' follows the mouse style. */
  'viewport.orbitAbout': 'auto' | 'pointer' | 'model' | 'origin';
  /** Orbit without rolling or going over the top, with Z always up. */
  'viewport.lockZUp': boolean;
  /** The wheel zooms towards the pointer, not the middle of the view. */
  'viewport.zoomToCursor': boolean;
  'viewport.orbitSpeed': number;
  'viewport.zoomSpeed': number;
  /** The wheel zooms the other way. */
  'viewport.invertWheel': boolean;
}

export const DEFAULTS: Settings = {
  'viewport.mouseStyle': 'steve',
  'viewport.orbitAbout': 'auto',
  'viewport.lockZUp': false,
  'viewport.zoomToCursor': true,
  'viewport.orbitSpeed': 1,
  'viewport.zoomSpeed': 1,
  'viewport.invertWheel': false,
};

const STORAGE = 'camlib-ui:settings';

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? '{}');
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof saved[key] === typeof DEFAULTS[key]) (out as Record<string, unknown>)[key] = saved[key];
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export const useSettings = create<{ values: Settings }>(() => ({ values: load() }));

export const setting = <K extends keyof Settings>(key: K): Settings[K] => useSettings.getState().values[key];
export const useSetting = <K extends keyof Settings>(key: K): Settings[K] => useSettings((state) => state.values[key]);

export function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  useSettings.setState((state) => ({ values: { ...state.values, [key]: value } }));
  try { localStorage.setItem(STORAGE, JSON.stringify(useSettings.getState().values)); } catch { /* private mode: kept for this visit */ }
}

export function resetSettings() {
  useSettings.setState({ values: { ...DEFAULTS } });
  try { localStorage.removeItem(STORAGE); } catch { /* nothing kept */ }
}
