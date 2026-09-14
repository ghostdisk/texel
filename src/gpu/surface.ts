import { unionBounds } from '../model/geometry';
import type { Rect } from '../model/geometry';
import type { GpuFrame } from './device';
import { device } from './device';

export const TILE_SIZE = 256;
export const MAX_IMAGE_SIZE = 1 << 20;
export const WORKING_FORMAT: GPUTextureFormat = 'rgba16float';
export const MASK_FORMAT: GPUTextureFormat = 'r16float';
const SOLID_CACHE_LIMIT = 256;
const POOL_BUDGET = 128 * 1024 * 1024;
let nextRevision = 1;

/** Linear, premultiplied RGBA; scalar surfaces use only red. */
export type TileColor = readonly [number, number, number, number];
const ZERO: TileColor = [0, 0, 0, 0];

export interface TileResource {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  references: number;
  /** Null for writable pixel storage; solid resources are always immutable. */
  readonly color: TileColor | null;
  readonly cacheKey: string | null;
}

export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly bounds: Rect;
  readonly scale: number;
  readonly resource: TileResource;
  readonly revision: number;
  /** Conservative pixel support, never rounded out to the tile boundary. */
  readonly contentBounds: Rect;
  signature: string;
}

export class TilePool {
  private readonly free = new Map<GPUTextureFormat, TileResource[]>();
  private readonly colors = new Map<string, TileResource>();
  private readonly idleColors = new Set<TileResource>();
  private readonly empty = new Map<GPUTextureFormat, TileResource>();
  private bytes = 0;

  acquire(format: GPUTextureFormat): TileResource {
    const cached = this.free.get(format)?.pop();
    if (cached) { this.bytes -= resourceBytes(cached); cached.references = 1; return cached; }
    const texture = device.createTexture({
      label: 'Image tile', size: [TILE_SIZE, TILE_SIZE], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST |
        (format === WORKING_FORMAT || format === 'rgba8unorm' ? GPUTextureUsage.STORAGE_BINDING : 0),
    });
    return { texture, view: texture.createView(), references: 1, color: null, cacheKey: null };
  }

  release(resource: TileResource): void {
    if (--resource.references !== 0) return;
    const bytes = resourceBytes(resource);
    if (resource.cacheKey !== null) {
      if (this.bytes + bytes > POOL_BUDGET || this.idleColors.size >= SOLID_CACHE_LIMIT) { this.colors.delete(resource.cacheKey); resource.texture.destroy(); }
      else { this.idleColors.add(resource); this.bytes += bytes; }
      return;
    }
    if (this.bytes + bytes > POOL_BUDGET) { resource.texture.destroy(); return; }
    const list = this.free.get(resource.texture.format) ?? [];
    list.push(resource);
    this.free.set(resource.texture.format, list);
    this.bytes += bytes;
  }

  /** Immutable one-texel backing, shared by exact stored color and format. */
  solid(format: GPUTextureFormat, color: TileColor): TileResource {
    const { pixel, canonical } = encodeColor(format, color);
    const key = `${format}:${[...pixel]}`;
    const cached = this.colors.get(key);
    if (cached) {
      if (this.idleColors.delete(cached)) this.bytes -= resourceBytes(cached);
      cached.references++;
      return cached;
    }
    const texture = device.createTexture({ label: 'Solid image tile', size: [1, 1], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture }, pixel, { bytesPerRow: pixel.byteLength }, [1, 1]);
    const result: TileResource = { texture, view: texture.createView(), references: 1, color: Object.freeze(canonical), cacheKey: key };
    this.colors.set(key, result);
    return result;
  }

  transparent(format: GPUTextureFormat): TileResource {
    let tile = this.empty.get(format);
    if (!tile) {
      tile = this.solid(format, ZERO);
      this.empty.set(format, tile);
    }
    return tile;
  }
}

export const tilePool = new TilePool();

export function tileBytes(format: GPUTextureFormat): number { return TILE_SIZE * TILE_SIZE * (format === MASK_FORMAT ? 2 : format === WORKING_FORMAT ? 8 : 4); }
export function resourceBytes(resource: TileResource): number { return resource.texture.width * resource.texture.height * tileBytes(resource.texture.format) / (TILE_SIZE * TILE_SIZE); }
export function tileKey(x: number, y: number): string { return `${x},${y}`; }
export function isMaskSurface(surface: {
  format?: GPUTextureFormat;
  texture?: GPUTexture;
}): boolean {
  return (surface.format ?? surface.texture?.format) === MASK_FORMAT;
}

export function intersectBounds(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Sparse records have three states: missing/zero, immutable solid color, or resident pixels. */
export class Surface {
  readonly tiles = new Map<string, Tile>();
  private readonly scratchSurfaces = new Map<string, Surface>();
  private disposed = false;
  readonly pool = tilePool;
  readonly bounds: Rect;
  readonly width: number;
  readonly height: number;

  constructor(readonly label: string, bounds: Rect, readonly scale = 1, readonly format: GPUTextureFormat = WORKING_FORMAT) {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Rasterization scale must be positive.');
    this.bounds = rasterBounds(bounds, scale);
    this.width = Math.round(this.bounds.width * scale);
    this.height = Math.round(this.bounds.height * scale);
    if (![this.width, this.height].every((size) => Number.isSafeInteger(size) && size > 0 && size <= MAX_IMAGE_SIZE)) {
      throw new Error(`${label} exceeds the ${MAX_IMAGE_SIZE} pixel image limit.`);
    }
  }

  get regions(): Rect[] { return [...this.tiles.values()].map((tile) => tile.contentBounds); }
  get bytes(): number { return [...new Set([...this.tiles.values()].map((tile) => tile.resource))].reduce((bytes, resource) => bytes + resourceBytes(resource), 0); }
  solidColor(x: number, y: number): TileColor | null { return this.tile(x, y)?.resource.color ?? (this.tile(x, y) ? null : ZERO); }
  tile(x: number, y: number): Tile | undefined { return this.tiles.get(tileKey(x, y)); }
  view(x: number, y: number): GPUTextureView { return this.tile(x, y)?.view ?? this.pool.transparent(this.format).view; }
  tileBounds(x: number, y: number): Rect { return { x: x * TILE_SIZE / this.scale, y: y * TILE_SIZE / this.scale, width: TILE_SIZE / this.scale, height: TILE_SIZE / this.scale }; }

  /** Share immutable resources; the next write detaches only the touched tiles. */
  snapshot(label = this.label): Surface {
    if (this.disposed) throw new Error('Cannot snapshot a released image.');
    const result = createSurface(label, this.bounds, this.scale, this.format);
    for (const [key, tile] of this.tiles) {
      tile.resource.references++;
      result.tiles.set(key, tile);
    }
    return result;
  }

  writable(frame: GpuFrame, x: number, y: number, contentBounds: Rect, preserve = false, clear = true): Tile {
    if (this.disposed) throw new Error('Cannot write a released image.');
    const key = tileKey(x, y);
    const old = this.tiles.get(key);
    const shared = old && (old.resource.color !== null || old.resource.references > 1);
    const resource = old && !shared ? old.resource : this.pool.acquire(this.format);
    if (!old || shared) {
      if (old && preserve && old.resource.color) {
        const bounds = intersectBounds(old.bounds, this.bounds)!;
        paintSolid(frame, resource, old.resource.color, { x: Math.round((bounds.x - old.bounds.x) * this.scale), y: Math.round((bounds.y - old.bounds.y) * this.scale),
          width: Math.round(bounds.width * this.scale), height: Math.round(bounds.height * this.scale) }, true);
      } else if (old && preserve) frame.encoder.copyTextureToTexture({ texture: old.texture }, { texture: resource.texture }, [TILE_SIZE, TILE_SIZE]);
      else if (clear) {
        const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: resource.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        pass.end();
      }
    }
    const clipped = intersectBounds(intersectBounds(rasterBounds(contentBounds, this.scale), this.bounds)!, this.tileBounds(x, y))!;
    const tile: Tile = {
      x, y, texture: resource.texture, view: resource.view, resource, bounds: this.tileBounds(x, y), scale: this.scale, revision: nextRevision++,
      contentBounds: preserve && old ? unionBounds([old.contentBounds, clipped]) : clipped, signature: '',
    };
    this.tiles.set(key, tile);
    frame.change(() => { if (old && resource !== old.resource) this.pool.release(old.resource); }, () => {
      if (this.disposed) {
        if (old && resource !== old.resource) this.pool.release(old.resource);
        return;
      }
      if (old) this.tiles.set(key, old);
      else this.tiles.delete(key);
      if (resource !== old?.resource) this.pool.release(resource);
    });
    return tile;
  }

  /** Replace the logical chunk; sampling clips its shared one-texel backing to image bounds. */
  setColor(frame: GpuFrame, x: number, y: number, color: TileColor): void {
    if (this.disposed) throw new Error('Cannot write a released image.');
    const bounds = this.tileBounds(x, y), contentBounds = intersectBounds(bounds, this.bounds);
    if (!contentBounds) return;
    const key = tileKey(x, y);
    if (this.format === MASK_FORMAT ? color[0] === 0 : color.every((value) => value === 0)) { this.remove(key, frame); return; }
    const resource = this.pool.solid(this.format, color);
    const old = this.tiles.get(key);
    if (old?.resource === resource) { this.pool.release(resource); return; }
    const tile: Tile = { x, y, texture: resource.texture, view: resource.view, resource, bounds, scale: this.scale,
      revision: nextRevision++, contentBounds, signature: '' };
    this.tiles.set(key, tile);
    frame.change(() => { if (old) this.pool.release(old.resource); }, () => {
      if (this.disposed) { if (old) this.pool.release(old.resource); return; }
      if (old) this.tiles.set(key, old);
      else this.tiles.delete(key);
      this.pool.release(resource);
    });
  }

  fill(frame: GpuFrame, color: TileColor): void {
    if (this.format === MASK_FORMAT ? color[0] === 0 : color.every((value) => value === 0)) { this.retain(new Set(), frame); return; }
    for (const { x, y } of planTiles(this, [this.bounds]).values()) this.setColor(frame, x, y, color);
  }

  remove(key: string, frame?: GpuFrame): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.tiles.delete(key);
    if (frame) frame.change(() => this.pool.release(tile.resource), () => {
      if (this.disposed) this.pool.release(tile.resource);
      else this.tiles.set(key, tile);
    });
    else this.pool.release(tile.resource);
  }

  retain(keys: ReadonlySet<string>, frame: GpuFrame): void {
    for (const key of this.tiles.keys()) if (!keys.has(key)) this.remove(key, frame);
  }

  scratch(frame: GpuFrame, key: string, bounds = this.bounds, scale = this.scale, format: GPUTextureFormat = WORKING_FORMAT): Surface {
    const existing = this.scratchSurfaces.get(key);
    if (existing && existing.format === format && matchesSurface(existing, bounds, scale)) return existing;
    if (existing) frame.retire(existing);
    const result = createSurface(`${this.label}: ${key}`, bounds, scale, format);
    this.scratchSurfaces.set(key, result);
    return result;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of this.tiles.keys()) this.remove(key);
    for (const surface of this.scratchSurfaces.values()) surface.destroy();
    this.scratchSurfaces.clear();
  }

  retainScratch(frame: GpuFrame, prefix: string, used: ReadonlySet<string>): void {
    for (const [key, surface] of this.scratchSurfaces) if (key.startsWith(prefix) && !used.has(key)) {
      frame.retire(surface);
      this.scratchSurfaces.delete(key);
    }
  }
}

export interface TileRegion {
  x: number;
  y: number;
  bounds: Rect;
}

/** Keep exact support through the filter chain; round only when addressing physical storage. */
export function planTiles(surface: Surface, regions: readonly Rect[]): Map<string, TileRegion> {
  const result = new Map<string, TileRegion>();
  for (const region of regions) {
    const clipped = intersectBounds(region, surface.bounds);
    if (!clipped) continue;
    const left = Math.floor(clipped.x * surface.scale / TILE_SIZE), top = Math.floor(clipped.y * surface.scale / TILE_SIZE);
    const right = Math.ceil((clipped.x + clipped.width) * surface.scale / TILE_SIZE), bottom = Math.ceil((clipped.y + clipped.height) * surface.scale / TILE_SIZE);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const key = tileKey(x, y), bounds = intersectBounds(clipped, surface.tileBounds(x, y))!;
      const existing = result.get(key);
      result.set(key, { x, y, bounds: existing ? unionBounds([existing.bounds, bounds]) : bounds });
    }
  }
  return result;
}

export function rasterBounds(bounds: Rect, scale: number): Rect {
  const x = Math.floor(bounds.x * scale) / scale, y = Math.floor(bounds.y * scale) / scale;
  const right = Math.ceil((bounds.x + bounds.width) * scale) / scale, bottom = Math.ceil((bounds.y + bounds.height) * scale) / scale;
  return { x, y, width: Math.max(1 / scale, right - x), height: Math.max(1 / scale, bottom - y) };
}

export function createSurface(label: string, bounds: Rect, scale = 1, format: GPUTextureFormat = WORKING_FORMAT): Surface {
  return new Surface(label, bounds, scale, format);
}

export function matchesSurface(surface: Surface, bounds: Rect, scale: number): boolean {
  const target = rasterBounds(bounds, scale);
  return surface.scale === scale && surface.bounds.x === target.x && surface.bounds.y === target.y && surface.bounds.width === target.width && surface.bounds.height === target.height;
}


interface EncodedColor {
  pixel: Uint16Array<ArrayBuffer> | Uint8Array<ArrayBuffer>;
  canonical: [number, number, number, number];
}

function encodeColor(format: GPUTextureFormat, color: TileColor): EncodedColor {
  if (color.some((value) => !Number.isFinite(value))) throw new Error('Solid tile colors must be finite.');
  if (format === MASK_FORMAT || format === WORKING_FORMAT) {
    const pixel = Uint16Array.from(format === MASK_FORMAT ? [color[0]] : color, floatToHalf);
    const values = [...pixel].map(halfToFloat);
    if (values.some((value) => !Number.isFinite(value))) throw new Error('Solid tile color exceeds the half-float range.');
    return { pixel, canonical: format === MASK_FORMAT ? [values[0], 0, 0, 1] : [values[0], values[1], values[2], values[3]] };
  }
  if (format !== 'rgba8unorm' && format !== 'rgba8unorm-srgb') throw new Error('Unsupported solid tile format.');
  const srgb = format === 'rgba8unorm-srgb';
  const pixel = Uint8Array.from(color, (value, channel) => {
    const linear = Math.max(0, Math.min(1, value));
    return Math.round(255 * (srgb && channel < 3 ? linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055 : linear));
  });
  const values = [...pixel].map((value, channel) => {
    const encoded = value / 255;
    return srgb && channel < 3 ? encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4 : encoded;
  });
  return { pixel, canonical: [values[0], values[1], values[2], values[3]] };
}

export function floatToHalf(value: number): number {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
  const sign = (bits >>> 16) & 0x8000, exponent = ((bits >>> 23) & 255) - 127;
  const fraction = bits & 0x7fffff;
  if (exponent > 15) return sign | 0x7c00 | (exponent === 128 && fraction ? 0x200 : 0);
  if (exponent < -25) return sign;
  const mantissa = exponent < -14 ? fraction | 0x800000 : fraction;
  const shift = exponent < -14 ? -exponent - 1 : 13;
  const truncated = mantissa >>> shift, remainder = mantissa & ((1 << shift) - 1), halfway = 1 << (shift - 1);
  return sign | ((exponent < -14 ? 0 : (exponent + 15) << 10) + truncated + Number(remainder > halfway || remainder === halfway && (truncated & 1) !== 0));
}

export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 31, fraction = bits & 1023;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? fraction ? NaN : Infinity : (1 + fraction / 1024) * 2 ** (exponent - 15));
}

const solidPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

/** Materialize or overwrite part of a writable chunk; solid source textures are never attachments. */
export function paintSolid(frame: GpuFrame, target: TileResource, color: TileColor, clip: Rect, clear = false): void {
  let pipeline = solidPipelines.get(target.texture.format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: `
@group(0) @binding(0) var<uniform> color: vec4f;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fragmentMain() -> @location(0) vec4f { return color; }
` });
    pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: target.texture.format }] } });
    solidPipelines.set(target.texture.format, pipeline);
  }
  const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
  pass.setPipeline(pipeline);
  pass.setScissorRect(clip.x, clip.y, clip.width, clip.height);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: frame.uniform(color) }] }));
  pass.draw(3);
  pass.end();
}
