import { tileLoadShader } from './tile-sampling';
import { tileClip } from './local';
import emptyShader from '../shaders/image-empty.wgsl?raw';
import exportShader from '../shaders/generation-export.wgsl?raw';
import pixelShader from '../shaders/read-pixel.wgsl?raw';
import histogramShader from '../shaders/histogram.wgsl?raw';
import type { Point } from '../model/geometry';
import type { Gpu } from './device';
import type { Surface } from './surface';
import { isMaskSurface, TILE_SIZE, createSurface, intersectBounds } from './surface';
import { quads } from './quad';

export type SampledColor = readonly [number, number, number, number];

export interface PixelSample {
  surface: Surface;
  point: Point;
}

/** Small, explicit GPU-to-CPU transfers for interaction and committed previews. */
export class GpuReadback {
  private pipelines = new Map<string, GPUComputePipeline>();
  private readonly sampler: GPUSampler;

  constructor(private readonly gpu: Gpu) {
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  private pipeline(code: string, label: string): GPUComputePipeline {
    let pipeline = this.pipelines.get(code);
    if (!pipeline) {
      pipeline = this.gpu.device.createComputePipeline({
        label, layout: 'auto', compute: { module: this.gpu.device.createShaderModule({ label, code: tileLoadShader + code }), entryPoint: 'main' },
      });
      this.pipelines.set(code, pipeline);
    }
    return pipeline;
  }

  private async read(buffer: GPUBuffer): Promise<ArrayBuffer> {
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const data = buffer.getMappedRange().slice(0);
      buffer.unmap();
      return data;
    } finally { buffer.destroy(); }
  }

  async sample(requests: readonly PixelSample[]): Promise<SampledColor[]> {
    if (!requests.length) return [];
    const { device } = this.gpu;
    const pipeline = this.pipeline(pixelShader, 'Read layer pixels');
    const size = requests.length * 16;
    const result = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const frame = this.gpu.beginFrame();
    try {
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      requests.forEach(({ surface, point }, index) => {
        const px = point.x * surface.scale, py = point.y * surface.scale;
        const x = Math.floor(px / TILE_SIZE), y = Math.floor(py / TILE_SIZE);
        const inside = point.x >= surface.bounds.x && point.y >= surface.bounds.y && point.x < surface.bounds.x + surface.bounds.width && point.y < surface.bounds.y + surface.bounds.height;
        const params = frame.uniform([inside ? px - x * TILE_SIZE : -1, inside ? py - y * TILE_SIZE : -1, index, Number(isMaskSurface(surface))]);
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: surface.view(x, y) }, { binding: 1, resource: { buffer: result } }, { binding: 2, resource: params },
        ] }));
        pass.dispatchWorkgroups(1);
      });
      pass.end();
      frame.encoder.copyBufferToBuffer(result, 0, readback, 0, size);
      frame.retire(result);
      frame.submit();
    } catch (error) { result.destroy(); readback.destroy(); frame.release(); throw error; }
    const data = new Float32Array(await this.read(readback));
    return requests.map((_, index): SampledColor => [data[index * 4], data[index * 4 + 1], data[index * 4 + 2], data[index * 4 + 3]]);
  }

  /** Reduce alpha (or a mask's single channel) to one four-byte occupancy flag. */
  async isEmpty(source: Surface): Promise<boolean> {
    if (!source.tiles.size) return true;
    const resident = [...source.tiles.values()].filter((tile) => tile.resource.color === null);
    if ([...source.tiles.values()].some((tile) => (tile.resource.color?.[isMaskSurface(source) ? 0 : 3] ?? 0) > 0)) return false;
    if (!resident.length) return true;
    const { device } = this.gpu;
    const result = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const frame = this.gpu.beginFrame();
    try {
      const pipeline = this.pipeline(emptyShader, 'Check image occupancy');
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      for (const tile of resident) {
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: tile.view }, { binding: 1, resource: { buffer: result } },
          { binding: 2, resource: frame.uniform([Number(isMaskSurface(source)), 0, 0, 0]) },
        ] }));
        pass.dispatchWorkgroups(TILE_SIZE / 16, TILE_SIZE / 16);
      }
      pass.end();
      frame.encoder.copyBufferToBuffer(result, 0, readback, 0, 4);
      frame.submit();
    } catch (error) { readback.destroy(); frame.release(); throw error; }
    finally { result.destroy(); }
    return new Uint32Array(await this.read(readback))[0] === 0;
  }

  async rgba(source: Surface, mask = false, transparent = false): Promise<Uint8Array<ArrayBuffer>> {
    const { device } = this.gpu;
    const width = source.width, height = source.height;
    const bytes = new Uint8Array(width * height * 4);
    if (!transparent && !mask) bytes.fill(255);
    else if (mask) for (let index = 3; index < bytes.length; index += 4) bytes[index] = 255;
    const tiles = [...source.tiles.values()];
    if (!tiles.length) return bytes;
    const tileBytes = TILE_SIZE * TILE_SIZE * 4, capacity = Math.min(64, tiles.length);
    const buffer = device.createBuffer({ size: tileBytes * capacity, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const texture = device.createTexture({ size: [TILE_SIZE, TILE_SIZE], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const view = texture.createView();
    const pipeline = this.pipeline(exportShader, 'Image tile transfer');
    try {
      for (let start = 0; start < tiles.length; start += capacity) {
        const batch = tiles.slice(start, start + capacity), frame = this.gpu.beginFrame();
        try {
          batch.forEach((tile, index) => {
            const pass = frame.encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
              { binding: 0, resource: tile.view }, { binding: 1, resource: view },
              { binding: 2, resource: frame.uniform([Number(mask), Number(transparent), 0, 0]) },
            ] }));
            pass.dispatchWorkgroups(TILE_SIZE / 8, TILE_SIZE / 8);
            pass.end();
            frame.encoder.copyTextureToBuffer({ texture }, { buffer, offset: index * tileBytes, bytesPerRow: TILE_SIZE * 4 }, [TILE_SIZE, TILE_SIZE]);
          });
          frame.submit();
        } catch (error) { frame.release(); throw error; }
        await buffer.mapAsync(GPUMapMode.READ);
        try {
          const mapped = new Uint8Array(buffer.getMappedRange());
          batch.forEach((tile, index) => {
            const clip = intersectBounds(tile.bounds, source.bounds)!;
            const x = Math.round((clip.x - source.bounds.x) * source.scale), y = Math.round((clip.y - source.bounds.y) * source.scale);
            const tx = Math.round((clip.x - tile.bounds.x) * source.scale), ty = Math.round((clip.y - tile.bounds.y) * source.scale);
            const columns = Math.round(clip.width * source.scale), rows = Math.round(clip.height * source.scale);
            for (let row = 0; row < rows; row++) {
              const offset = index * tileBytes + ((ty + row) * TILE_SIZE + tx) * 4;
              bytes.set(mapped.subarray(offset, offset + columns * 4), ((y + row) * width + x) * 4);
            }
          });
        } finally { buffer.unmap(); }
      }
      return bytes;
    } finally { buffer.destroy(); texture.destroy(); }
  }

  async thumbnails(sources: readonly Surface[]): Promise<ImageData[]> {
    const images: ImageData[] = [];
    for (const source of sources) {
      const output = createSurface('Layer thumbnail', { x: 0, y: 0, width: 64, height: 64 });
      const frame = this.gpu.beginFrame();
      try {
        const scale = 64 / Math.max(source.bounds.width, source.bounds.height);
        const x = (64 - source.bounds.width * scale) / 2 - source.bounds.x * scale;
        const y = (64 - source.bounds.height * scale) / 2 - source.bounds.y * scale;
        const pass = quads.begin(frame, output);
        quads.draw(pass, frame, source, output, [scale, 0, 0, scale, x, y]);
        pass.end();
        frame.submit();
        images.push(new ImageData(new Uint8ClampedArray(await this.rgba(output, false, true)), 64, 64));
      } finally { frame.release(); output.destroy(); }
    }
    return images;
  }

  async histogram(source: Surface): Promise<Uint32Array> {
    const { device } = this.gpu;
    const pipeline = this.pipeline(histogramShader, 'Levels histogram');
    const bins = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 1024, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const frame = this.gpu.beginFrame();
      const encoder = frame.encoder;
      try {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        for (const tile of source.tiles.values()) {
          pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: tile.view }, { binding: 1, resource: { buffer: bins } },
            { binding: 2, resource: frame.uniform([...tileClip(source, tile), Number(isMaskSurface(source)), 0, 0, 0]) },
          ] }));
          pass.dispatchWorkgroups(TILE_SIZE / 16, TILE_SIZE / 16);
        }
        pass.end();
        encoder.copyBufferToBuffer(bins, 0, readback, 0, 1024);
        frame.submit();
      } finally { frame.release(); }
    } catch (error) { readback.destroy(); throw error; }
    finally { bins.destroy(); }
    const counts = new Uint32Array(await this.read(readback));
    if (isMaskSurface(source)) {
      const residentPixels = [...source.tiles.values()].reduce((sum, tile) => {
        const bounds = intersectBounds(tile.bounds, source.bounds)!;
        return sum + Math.round(bounds.width * source.scale) * Math.round(bounds.height * source.scale);
      }, 0);
      counts[0] += (source.width * source.height - residentPixels) * 3;
    }
    return counts;
  }
}
