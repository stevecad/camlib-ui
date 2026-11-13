/**
 * A height field drawn as a lit solid (from STEVE Studio's CAM player): the top is a grid displaced on the GPU from a
 * float height texture (normals from a B-spline through the neighbouring heights, so floors are flat and scallops
 * visible), closed by side walls down to the stock's bottom and a bottom face; columns cut through are discarded. Walls
 * come from the cutter that made them, not from the grid: the vertices along a wall move sideways onto the rim the cut
 * cells recorded (heightfield.ts `wallShift`, the same sum as `hfShift` here) and wall pixels take that rim's normal, so
 * a curved wall is one smooth surface instead of steps across the grid. Surfaces an operation cut are tinted in its
 * colour. Only the rows that changed are uploaded. Work millimetres.
 *
 * Used for both stocks the player shows: the fine display field (cut in a worker) and camlib's own check grid from the
 * playback stream (no rim records: its walls fall between cells).
 */
import * as THREE from 'three';
import { RIM_DEEP, RIM_SCALE, WALL_SHIFT, WALL_STEP } from './heightfield';

const STOCK_COLOR = '#c3ccd5';
/** One colour per operation, on the timeline's bands and on the surfaces each operation cut (never a status colour). */
export const OP_COLORS = ['#38bdf8', '#a78bfa', '#2dd4bf', '#f472b6', '#818cf8', '#c4a484'];
/** Grid quads per instanced tile side, and the most vertices the top grid draws (finer fields draw every other texel or so). */
const TILE = 128;
const MAX_VERTICES = 2_400_000;
/** A fresh cut's tint strength. */
const TINT = 0.32;
/** Tag on moves no operation band holds (between operations): cut, but not tinted. */
export const UNASSIGNED_TAG = 255;

/** The field as the view needs it: its grid and the arrays it draws (heights, tags, rim records). */
export interface FieldGrid {
  nx: number; ny: number; x0: number; y0: number; dx: number; dy: number; cell: number; bottom: number;
  h: Float32Array; op: Uint8Array; rim: Uint32Array;
}

/** A field over a stock box: `cell` mm cells, or the grid's own column and row counts. */
export function fieldGrid(min: number[], max: number[], cell: number | { nx: number; ny: number }): FieldGrid {
  const nx = typeof cell === 'number' ? Math.max(1, Math.round((max[0] - min[0]) / cell)) : cell.nx;
  const ny = typeof cell === 'number' ? Math.max(1, Math.round((max[1] - min[1]) / cell)) : cell.ny;
  const dx = (max[0] - min[0]) / nx, dy = (max[1] - min[1]) / ny;
  return {
    nx, ny, x0: min[0], y0: min[1], dx, dy, cell: Math.min(dx, dy), bottom: min[2],
    h: new Float32Array(nx * ny).fill(max[2]), op: new Uint8Array(nx * ny), rim: new Uint32Array(nx * ny),
  };
}

type Part = 'grid' | 'skirt' | 'bottom';

/** Rim records (heightfield.ts rimCode) in GLSL: vec3(direction from the cutter's axis, cells inside its rim); z < 0 none. */
const RIM_GLSL = /* glsl */ `
uniform highp usampler2D uRim;
// x: a wall's least height step, y: the cell (mm), z: the most a vertex moves (mm).
uniform vec3 uWall;
vec3 hfRim(ivec2 c) {
  uint v = texelFetch(uRim, clamp(c, ivec2(0), uSize - 1), 0).r;
  if (v == 0u || v >= ${RIM_DEEP}u) return vec3(0.0, 0.0, -1.0);
  float d = float(v & 16383u) / 4096.0;
  vec2 p = d <= 2.0 ? vec2(1.0 - d, 1.0 - abs(1.0 - d)) : vec2(d - 3.0, -(1.0 - abs(d - 3.0)));
  return vec3(normalize(p), float(v >> 14u) / ${RIM_SCALE.toFixed(1)});
}
`;

const VERTEX_HEAD = /* glsl */ `
uniform sampler2D uHeight;
uniform ivec2 uSize;
uniform vec2 uOrigin;
uniform vec2 uCell;
uniform float uBottom;
uniform float uStep;
varying vec2 vCell;
varying float vZ;
#ifdef HF_GRID
attribute vec2 aTile;
#endif
float hfAt(ivec2 c) { return texelFetch(uHeight, clamp(c, ivec2(0), uSize - 1), 0).r; }
// A texel's vertex position: cell centres inside, the stock's own edges on the border.
vec2 hfXY(ivec2 c) {
  vec2 p = uOrigin + (vec2(c) + 0.5) * uCell;
  if (c.x <= 0) p.x = uOrigin.x;
  if (c.y <= 0) p.y = uOrigin.y;
  if (c.x >= uSize.x - 1) p.x = uOrigin.x + float(uSize.x) * uCell.x;
  if (c.y >= uSize.y - 1) p.y = uOrigin.y + float(uSize.y) * uCell.y;
  return p;
}
${RIM_GLSL}
// heightfield.ts wallShift: a vertex on top of a wall moves onto the rim its lower neighbours recorded, one at the foot
// of a wall onto its own, at most uWall.z (so no triangle turns over); border vertices stay.
vec2 hfShift(ivec2 c, float h) {
  if (c.x <= 0 || c.y <= 0 || c.x >= uSize.x - 1 || c.y >= uSize.y - 1) return vec2(0.0);
  vec2 s = vec2(0.0);
  float n = 0.0;
  bool foot = false;
  for (int b = -1; b <= 1; b++) for (int a = -1; a <= 1; a++) {
    if (a == 0 && b == 0) continue;
    ivec2 k = c + ivec2(a, b);
    float hk = hfAt(k);
    if (hk > h + uWall.x) { foot = true; continue; }
    if (!(hk < h - uWall.x)) continue;
    vec3 r = hfRim(k);
    if (r.z < 0.0) continue;
    float d = r.z * uWall.y + (float(a) * uCell.x * r.x + float(b) * uCell.y * r.y);
    if (d < 0.0) { s += d * r.xy; n += 1.0; }
  }
  if (foot) {
    vec3 r = hfRim(c);
    if (r.z >= 0.0) { s += r.z * uWall.y * r.xy; n += 1.0; }
  }
  if (n == 0.0) return vec2(0.0);
  s /= n;
  float len = length(s);
  return len > uWall.z ? s * (uWall.z / len) : s;
}
`;

const NORMAL_CODE: Record<Part, string> = {
  grid: /* glsl */ `
    ivec2 hfC = clamp(ivec2((aTile + position.xy) * uStep), ivec2(0), uSize - 1);
    float hfH = hfAt(hfC);
    // The top's shading normal is worked out per pixel (FRAGMENT_NORMAL); this one only feeds the varyings.
    vec3 objectNormal = vec3(0.0, 0.0, 1.0);
    vec2 hfP = hfXY(hfC) + hfShift(hfC, hfH);
    vec3 hfPos = vec3(hfP, max(hfH, uBottom));
  `,
  skirt: /* glsl */ `
    ivec2 hfC = clamp(ivec2(position.xy), ivec2(0), uSize - 1);
    vec3 objectNormal = normal;
    vec2 hfP = hfXY(hfC);
    vec3 hfPos = vec3(hfP, position.z > 0.5 ? max(hfAt(hfC), uBottom) : uBottom);
  `,
  bottom: /* glsl */ `
    vec3 objectNormal = vec3(0.0, 0.0, -1.0);
    vec2 hfP = uOrigin + position.xy * uCell * vec2(uSize);
    vec3 hfPos = vec3(hfP, uBottom);
  `,
};

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uOps;
uniform ivec2 uSize;
uniform float uBottom;
uniform vec3 uPalette[6];
uniform float uTint;
uniform vec2 uCell;
varying vec2 vCell;
varying float vZ;
${RIM_GLSL}
float hfTop(ivec2 c) { return max(texelFetch(uHeight, clamp(c, ivec2(0), uSize - 1), 0).r, uBottom); }
// The top's normal from a cubic B-spline through the 4 × 4 columns around the point: smooth across texels, so floors
// and scallops shade as continuous surfaces. With clip, columns across a wall from this point (a step of more than
// uWall.x) count at this point's height, so a wall doesn't bend the floor or top next to it.
vec3 hfSmoothNormal(bool clip) {
  vec2 p = vCell - 0.5, f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec4 wx = vec4(pow(1.0 - f.x, 3.0), 3.0 * f.x * f.x * f.x - 6.0 * f.x * f.x + 4.0, -3.0 * f.x * f.x * f.x + 3.0 * f.x * f.x + 3.0 * f.x + 1.0, f.x * f.x * f.x) / 6.0;
  vec4 wy = vec4(pow(1.0 - f.y, 3.0), 3.0 * f.y * f.y * f.y - 6.0 * f.y * f.y + 4.0, -3.0 * f.y * f.y * f.y + 3.0 * f.y * f.y + 3.0 * f.y + 1.0, f.y * f.y * f.y) / 6.0;
  vec4 dx = vec4(-(1.0 - f.x) * (1.0 - f.x), 3.0 * f.x * f.x - 4.0 * f.x, -3.0 * f.x * f.x + 2.0 * f.x + 1.0, f.x * f.x) / 2.0;
  vec4 dy = vec4(-(1.0 - f.y) * (1.0 - f.y), 3.0 * f.y * f.y - 4.0 * f.y, -3.0 * f.y * f.y + 2.0 * f.y + 1.0, f.y * f.y) / 2.0;
  float gx = 0.0, gy = 0.0;
  for (int b = 0; b < 4; b++) for (int a = 0; a < 4; a++) {
    float h = hfTop(i + ivec2(a - 1, b - 1));
    if (clip && abs(h - vZ) > uWall.x) h = vZ;
    gx += h * dx[a] * wy[b];
    gy += h * wx[a] * dy[b];
  }
  return normalize((viewMatrix * vec4(normalize(vec3(-gx / uCell.x, -gy / uCell.y, 1.0)), 0.0)).xyz);
}
// On a wall (this point's height inside a step of more than uWall.x between two neighbouring columns near it): the
// cutter's own side, horizontal, facing back towards the axis the low columns of those steps recorded. Else the smooth
// normal (and on a step no cut recorded, such as camlib's grid, the smooth normal across it).
vec3 hfNormal() {
  ivec2 c0 = ivec2(floor(vCell));
  float eps = 0.02 * uWall.x;
  vec2 n = vec2(0.0);
  bool wall = false;
  for (int b = -1; b <= 1; b++) for (int a = -1; a <= 1; a++) {
    ivec2 c = c0 + ivec2(a, b);
    float hc = hfTop(c);
    for (int k = 0; k < 2; k++) {
      ivec2 d = c + (k == 0 ? ivec2(1, 0) : ivec2(0, 1));
      float hd = hfTop(d);
      float lo = min(hc, hd), hi = max(hc, hd);
      if (hi - lo <= uWall.x || vZ <= lo + eps || vZ >= hi - eps) continue;
      wall = true;
      ivec2 low = hc < hd ? c : d;
      vec3 r = hfRim(low);
      if (r.z < 0.0) continue;
      vec2 off = vCell - (vec2(low) + 0.5);
      n -= r.xy / (0.25 + dot(off, off));
    }
  }
  if (wall && dot(n, n) > 0.0) return normalize((viewMatrix * vec4(normalize(n), 0.0, 0.0)).xyz);
  return hfSmoothNormal(!wall);
}
`;

const FRAGMENT_NORMAL = /* glsl */ `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = hfNormal();
vec3 nonPerturbedNormal = normal;
`;

const FRAGMENT_COLOR = /* glsl */ `
  ivec2 hfF = clamp(ivec2(floor(vCell)), ivec2(0), uSize - 1);
  // A column cut through has no material to draw.
  if (texelFetch(uHeight, hfF, 0).r <= uBottom + 1e-4) discard;
  // The four columns around this point: a wall between two of them takes the lower one's operation, so walls read as
  // one surface rather than stripes.
  ivec2 hfB = ivec2(floor(vCell - 0.5));
  float hfLow = 1e30, hfTag = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 c = clamp(hfB + ivec2(k & 1, k >> 1), ivec2(0), uSize - 1);
    float top = texelFetch(uHeight, c, 0).r;
    if (top <= uBottom + 1e-4) continue;
    if (top < hfLow) { hfLow = top; hfTag = floor(texelFetch(uOps, c, 0).r * 255.0 + 0.5); }
  }
  if (hfTag > 0.5 && hfTag < 254.5) diffuseColor.rgb = mix(diffuseColor.rgb, uPalette[int(mod(hfTag - 1.0, 6.0))], uTint);
`;

function makeUniforms(field: FieldGrid, step: number, height: THREE.DataTexture, ops: THREE.DataTexture, rim: THREE.DataTexture) {
  return {
    uHeight: { value: height }, uOps: { value: ops }, uRim: { value: rim },
    uWall: { value: new THREE.Vector3(WALL_STEP * field.cell, field.cell, WALL_SHIFT * field.cell) },
    uSize: { value: new THREE.Vector2(field.nx, field.ny) }, uOrigin: { value: new THREE.Vector2(field.x0, field.y0) },
    uCell: { value: new THREE.Vector2(field.dx, field.dy) }, uBottom: { value: field.bottom }, uStep: { value: step },
    uPalette: { value: OP_COLORS.map((color) => new THREE.Color(color)) }, uTint: { value: TINT },
  };
}
type Uniforms = ReturnType<typeof makeUniforms>;

/**
 * One-sided: the top grid is a graph over XY, so every triangle faces up or out; where a wall steps across the grid,
 * the triangles facing away sit behind the ones facing the camera (drawn two-sided they'd show as dark hairlines).
 */
function makeMaterial(part: Part, uniforms: Uniforms, color: string) {
  const material = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.42, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.defines = { ...shader.defines, [`HF_${part.toUpperCase()}`]: '' };
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader
      .replace('#include <beginnormal_vertex>', NORMAL_CODE[part])
      .replace('#include <begin_vertex>', 'vec3 transformed = hfPos;\n  vCell = (hfPos.xy - uOrigin) / uCell;\n  vZ = hfPos.z;');
    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOR}`);
    if (part === 'grid') shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', FRAGMENT_NORMAL);
  };
  material.customProgramCacheKey = () => `camlib-ui-heightfield-${part}`;
  return material;
}

/** A plain material with a part's shape (made in the vertex shader), for the section view's stencil writers. */
function makeShapeMaterial(part: Part, uniforms: Uniforms) {
  const material = new THREE.MeshBasicMaterial();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.defines = { ...shader.defines, [`HF_${part.toUpperCase()}`]: '' };
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace('#include <begin_vertex>', `${NORMAL_CODE[part]}\n  vec3 transformed = hfPos;`);
  };
  material.customProgramCacheKey = () => `camlib-ui-heightfield-shape-${part}`;
  return material;
}

/** The top grid: one tile of TILE × TILE quads (vertex coordinates in texel steps), instanced over the field. */
function gridGeometry(field: FieldGrid, step: number) {
  const tile = new THREE.PlaneGeometry(TILE, TILE, TILE, TILE);
  tile.translate(TILE / 2, TILE / 2, 0);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = tile.index;
  geometry.setAttribute('position', tile.getAttribute('position'));
  const vx = Math.ceil((field.nx - 1) / step) + 1, vy = Math.ceil((field.ny - 1) / step) + 1;
  const tx = Math.ceil((vx - 1) / TILE), ty = Math.ceil((vy - 1) / TILE);
  const offsets = new Float32Array(Math.max(1, tx * ty) * 2);
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) offsets.set([i * TILE, j * TILE], (j * tx + i) * 2);
  geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(offsets, 2));
  geometry.instanceCount = Math.max(1, tx * ty);
  tile.dispose();
  return geometry;
}

/** The four side walls: a top and bottom vertex per border texel (z flags which), outward normals. */
function skirtGeometry(field: FieldGrid) {
  const positions: number[] = [], normals: number[] = [], index: number[] = [];
  const wall = (cells: [number, number][], normal: [number, number, number], flip: boolean) => {
    const base = positions.length / 3;
    for (const [i, j] of cells) { positions.push(i, j, 0, i, j, 1); normals.push(...normal, ...normal); }
    for (let k = 0; k + 1 < cells.length; k++) {
      const a = base + k * 2, b = a + 2;
      if (flip) index.push(a, a + 1, b, b, a + 1, b + 1); else index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  };
  const { nx, ny } = field;
  const xs = Array.from({ length: nx }, (_, i) => i), ys = Array.from({ length: ny }, (_, j) => j);
  wall(xs.map((i) => [i, 0]), [0, -1, 0], false);
  wall(xs.map((i) => [i, ny - 1]), [0, 1, 0], true);
  wall(ys.map((j) => [0, j]), [-1, 0, 0], true);
  wall(ys.map((j) => [nx - 1, j]), [1, 0, 0], false);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return geometry;
}

function bottomGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0.5, 0.5, 0);
  geometry.rotateX(Math.PI);  // Facing down.
  geometry.translate(0, 1, 0);
  return geometry;
}

/** The field on the GPU: textures, the three meshes and their look. */
export class HeightStockView {
  readonly group = new THREE.Group();
  readonly field: FieldGrid;
  private readonly height: THREE.DataTexture;
  private readonly ops: THREE.DataTexture;
  private readonly rim: THREE.DataTexture;
  private readonly materials: THREE.MeshStandardMaterial[];
  private readonly geometries: THREE.BufferGeometry[];
  private readonly renderer: THREE.WebGLRenderer;

  /** `color`: the material's (the stock's own grey by default; a sheet of plate is darker). */
  constructor(field: FieldGrid, renderer: THREE.WebGLRenderer, color: string = STOCK_COLOR) {
    this.field = field;
    this.renderer = renderer;
    const { nx, ny } = field;
    this.height = new THREE.DataTexture(field.h, nx, ny, THREE.RedFormat, THREE.FloatType);
    this.ops = new THREE.DataTexture(field.op, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
    this.rim = new THREE.DataTexture(field.rim, nx, ny, THREE.RedIntegerFormat, THREE.UnsignedIntType);
    this.rim.internalFormat = 'R32UI';
    for (const texture of [this.height, this.ops, this.rim]) {
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      renderer.initTexture(texture);
    }
    const step = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / MAX_VERTICES)));
    const uniforms = makeUniforms(field, step, this.height, this.ops, this.rim);
    const parts: [Part, THREE.BufferGeometry][] = [['grid', gridGeometry(field, step)], ['skirt', skirtGeometry(field)], ['bottom', bottomGeometry()]];
    this.materials = parts.map(([part]) => makeMaterial(part, uniforms, color));
    this.geometries = parts.map(([, geometry]) => geometry);
    parts.forEach(([part, geometry], i) => {
      const mesh = new THREE.Mesh(geometry, this.materials[i]);
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.userData.stockField = part;
      // Top, walls and bottom close a solid: the section view caps its cut.
      mesh.userData.solid = true;
      mesh.userData.stencilMaterial = () => makeShapeMaterial(part, uniforms);
      this.group.add(mesh);
    });
  }

  /** Rows j0..j1 of new heights, tags and rim records; only those rows go to the GPU. */
  apply(j0: number, j1: number, h: Float32Array, op: Uint8Array, rim: Uint32Array) {
    if (j1 < j0) return;
    const at = j0 * this.field.nx;
    this.field.h.set(h, at);
    this.field.op.set(op, at);
    this.field.rim.set(rim, at);
    if (!this.upload(this.height, j0, j1, this.field.h) || !this.upload(this.ops, j0, j1, this.field.op) || !this.upload(this.rim, j0, j1, this.field.rim)) {
      this.height.needsUpdate = true;
      this.ops.needsUpdate = true;
      this.rim.needsUpdate = true;
    }
  }

  /**
   * Uploads rows of a texture already on the GPU (three's update ranges are RGBA rows only). False when the texture
   * isn't uploaded yet (the caller then uploads it whole).
   */
  private upload(texture: THREE.DataTexture, j0: number, j1: number, data: Float32Array | Uint8Array | Uint32Array) {
    const handle = (this.renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!handle || texture.version === 0) return false;
    const gl = this.renderer.getContext() as WebGL2RenderingContext, state = this.renderer.state;
    state.bindTexture(gl.TEXTURE_2D, handle);
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const [format, type] = data instanceof Float32Array ? [gl.RED, gl.FLOAT] : data instanceof Uint32Array ? [gl.RED_INTEGER, gl.UNSIGNED_INT] : [gl.RED, gl.UNSIGNED_BYTE];
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, j0, this.field.nx, j1 - j0 + 1, format, type, data, j0 * this.field.nx);
    return true;
  }

  setMode(mode: 'solid' | 'translucent') {
    const translucent = mode === 'translucent';
    for (const material of this.materials) {
      if (material.transparent !== translucent) { material.transparent = translucent; material.needsUpdate = true; }
      material.opacity = translucent ? 0.32 : 1;
      material.depthWrite = !translucent;
      // Solid, the stock sits a hair behind coincident faces (the part's); see-through, a hair in front, so neither flickers.
      material.polygonOffsetFactor = material.polygonOffsetUnits = translucent ? -1 : 1;
    }
    for (const child of this.group.children) child.renderOrder = translucent ? 8 : 1;
  }

  dispose() {
    for (const texture of [this.height, this.ops, this.rim]) texture.dispose();
    for (const material of this.materials) material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
  }
}
