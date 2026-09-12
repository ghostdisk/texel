import { ImageLayer } from '../model/layers';
import { createSurface } from './surface';
import type { Gpu } from './device';
import type { QuadRenderer } from './quad';

export function createImageLayer(gpu: Gpu, name: string, width: number, height: number): ImageLayer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Layer dimensions must be positive whole numbers.');
  }
  return new ImageLayer(name, createSurface(gpu.device, `${name}: source`, { x: 0, y: 0, width, height }));
}

export async function importImage(gpu: Gpu, quads: QuadRenderer, name: string, blob: Blob): Promise<ImageLayer> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  const frame = gpu.beginFrame();
  let layer: ImageLayer | undefined;
  try {
    layer = createImageLayer(gpu, name, bitmap.width, bitmap.height);
    const upload = gpu.device.createTexture({
      label: `${name}: import`,
      size: { width: bitmap.width, height: bitmap.height },
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    frame.retire(upload);
    gpu.device.queue.copyExternalImageToTexture(
      { source: bitmap }, { texture: upload, premultipliedAlpha: false, colorSpace: 'srgb' },
      { width: bitmap.width, height: bitmap.height },
    );
    const imported = { texture: upload, view: upload.createView(), bounds: layer.source.bounds, scale: 1 };
    quads.copy(frame, imported, layer.source, true);
    frame.submit();
    return layer;
  } catch (error) {
    layer?.sourceTexture.destroy();
    frame.release();
    throw error;
  } finally {
    bitmap.close();
  }
}
