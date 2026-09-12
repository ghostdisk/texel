import type { Rect } from '../model/geometry';

export const WORKING_FORMAT: GPUTextureFormat = 'rgba16float';

export interface Surface {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly bounds: Rect;
  readonly scale: number;
}

export function rasterBounds(bounds: Rect, scale: number): Rect {
  const x = Math.floor(bounds.x * scale) / scale;
  const y = Math.floor(bounds.y * scale) / scale;
  const right = Math.ceil((bounds.x + bounds.width) * scale) / scale;
  const bottom = Math.ceil((bounds.y + bounds.height) * scale) / scale;
  return { x, y, width: Math.max(1 / scale, right - x), height: Math.max(1 / scale, bottom - y) };
}

export function createSurface(device: GPUDevice, label: string, requestedBounds: Rect, scale = 1): Surface {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Rasterization scale must be positive.');
  const bounds = rasterBounds(requestedBounds, scale);
  const width = Math.round(bounds.width * scale);
  const height = Math.round(bounds.height * scale);
  const limit = device.limits.maxTextureDimension2D;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width > limit || height > limit) {
    throw new Error(`${label} needs a ${width} × ${height} texture; this GPU supports up to ${limit} per side.`);
  }
  const texture = device.createTexture({
    label,
    size: { width, height },
    format: WORKING_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
  return { texture, view: texture.createView(), bounds, scale };
}

export function matchesSurface(surface: Surface, bounds: Rect, scale: number): boolean {
  const target = rasterBounds(bounds, scale);
  return surface.scale === scale && surface.bounds.x === target.x && surface.bounds.y === target.y &&
    surface.bounds.width === target.width && surface.bounds.height === target.height;
}
