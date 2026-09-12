import exportShader from '../shaders/generation-export.wgsl?raw';
import pixelShader from '../shaders/read-pixel.wgsl?raw';
import thumbnailShader from '../shaders/thumbnail.wgsl?raw';
import histogramShader from '../shaders/histogram.wgsl?raw';
import type { Point } from '../model/geometry';
import type { Gpu } from './device';
import type { Surface } from './surface';
import { isMaskSurface } from './surface';

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
        label, layout: 'auto', compute: { module: this.gpu.device.createShaderModule({ label, code }), entryPoint: 'main' },
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
        const params = frame.uniform([(point.x - surface.bounds.x) * surface.scale, (point.y - surface.bounds.y) * surface.scale, index, Number(isMaskSurface(surface))]);
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: surface.view }, { binding: 1, resource: { buffer: result } }, { binding: 2, resource: params },
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

  async rgba(source: Surface, mask = false): Promise<Uint8Array<ArrayBuffer>> {
    const { device } = this.gpu;
    const width = source.texture.width, height = source.texture.height;
    const stride = Math.ceil(width * 4 / 256) * 256;
    const buffer = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const frame = this.gpu.beginFrame();
    try {
      const pipeline = this.pipeline(exportShader, 'Generation image transfer');
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: source.view }, { binding: 1, resource: texture.createView() },
        { binding: 2, resource: frame.uniform([Number(mask), 0, 0, 0]) },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      frame.encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [width, height]);
      frame.submit();
    } catch (error) { buffer.destroy(); frame.release(); throw error; }
    finally { texture.destroy(); }
    const mapped = new Uint8Array(await this.read(buffer));
    const bytes = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) bytes.set(mapped.subarray(row * stride, row * stride + width * 4), row * width * 4);
    return bytes;
  }

  async thumbnails(sources: readonly Surface[]): Promise<ImageData[]> {
    if (!sources.length) return [];
    const { device } = this.gpu;
    const stride = 64 * 64 * 4;
    const readback = device.createBuffer({ size: stride * sources.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const image = device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const view = image.createView();
    const encoder = device.createCommandEncoder({ label: 'Committed layer previews' });
    try {
      sources.forEach((source, index) => {
        const code = thumbnailShader.replace('const SINGLE_CHANNEL = false;', `const SINGLE_CHANNEL = ${isMaskSurface(source)};`);
        const pipeline = this.pipeline(code, 'Layer thumbnails');
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: source.view }, { binding: 1, resource: this.sampler }, { binding: 2, resource: view },
        ] }));
        pass.dispatchWorkgroups(8, 8);
        pass.end();
        encoder.copyTextureToBuffer({ texture: image }, { buffer: readback, offset: index * stride, bytesPerRow: 256 }, [64, 64]);
      });
      device.queue.submit([encoder.finish()]);
    } catch (error) { readback.destroy(); throw error; }
    finally { image.destroy(); }
    const bytes = await this.read(readback);
    return sources.map((_, index) => new ImageData(new Uint8ClampedArray(bytes.slice(index * stride, (index + 1) * stride)), 64, 64));
  }

  async histogram(source: Surface): Promise<Uint32Array> {
    const { device } = this.gpu;
    const pipeline = this.pipeline(histogramShader, 'Levels histogram');
    const bins = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 1024, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = device.createCommandEncoder({ label: 'Read histogram' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: source.view }, { binding: 1, resource: { buffer: bins } },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(source.texture.width / 16), Math.ceil(source.texture.height / 16));
      pass.end();
      encoder.copyBufferToBuffer(bins, 0, readback, 0, 1024);
      device.queue.submit([encoder.finish()]);
    } catch (error) { readback.destroy(); throw error; }
    finally { bins.destroy(); }
    return new Uint32Array(await this.read(readback));
  }
}