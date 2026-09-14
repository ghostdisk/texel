import { ImageLayer } from '../model/layers';
import { createSurface, MASK_FORMAT, WORKING_FORMAT, TILE_SIZE, planTiles } from './surface';
import type { Surface } from './surface';
import type { Gpu } from './device';
import type { QuadRenderer } from './quad';

export function createImageLayer(gpu: Gpu, name: string, width: number, height: number, channels: 1 | 4 = 4, fill = 0): ImageLayer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Layer dimensions must be positive whole numbers.');
  const surface = createSurface(`${name}: source`, { x: 0, y: 0, width, height }, 1, channels === 1 ? MASK_FORMAT : WORKING_FORMAT);
  const layer = new ImageLayer(name, surface);
  if (channels === 1) layer.setVisible(false);
  if (fill !== 0) {
    const frame = gpu.beginFrame();
    try {
      const value = Math.max(0, Math.min(1, fill));
      surface.fill(frame, [value, value, value, 1]);
      frame.submit();
    } catch (error) { surface.destroy(); frame.release(); throw error; }
  }
  return layer;
}

/** Upload and convert one small canvas at a time, retaining only nontransparent tile records. */
export function uploadImage(gpu: Gpu, quads: QuadRenderer, image: CanvasImageSource, width: number, height: number, label: string): Surface {
  const source = createSurface(label, { x: 0, y: 0, width, height });
  const upload = createSurface(label + ': upload', source.bounds, 1, 'rgba8unorm-srgb');
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image upload canvas is unavailable.');
  const frame = gpu.beginFrame();
  frame.retire(upload);
  try {
    for (const { x, y, bounds } of planTiles(source, [source.bounds]).values()) {
      context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      context.drawImage(image, -x * TILE_SIZE, -y * TILE_SIZE);
      const pixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
      let left = TILE_SIZE, top = TILE_SIZE, right = 0, bottom = 0;
      for (let row = 0; row < bounds.height; row++) for (let column = 0; column < bounds.width; column++) {
        if (!pixels[(row * TILE_SIZE + column) * 4 + 3]) continue;
        left = Math.min(left, column); top = Math.min(top, row);
        right = Math.max(right, column + 1); bottom = Math.max(bottom, row + 1);
      }
      if (right <= left) continue;
      const content = { x: x * TILE_SIZE + left, y: y * TILE_SIZE + top, width: right - left, height: bottom - top };
      const tile = upload.writable(frame, x, y, content, false, false);
      gpu.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: tile.texture, premultipliedAlpha: false, colorSpace: 'srgb' }, [TILE_SIZE, TILE_SIZE]);
    }
    quads.copy(frame, upload, source, true);
    frame.submit();
    return source;
  } catch (error) { source.destroy(); frame.release(); throw error; }
}

export async function importImage(gpu: Gpu, quads: QuadRenderer, name: string, blob: Blob): Promise<ImageLayer> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  try { return new ImageLayer(name, uploadImage(gpu, quads, bitmap, bitmap.width, bitmap.height, `${name}: source`)); }
  finally { bitmap.close(); }
}
