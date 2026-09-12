import shader from '../shaders/path.wgsl?raw';
import { IDENTITY } from '../model/geometry';
import type { Point } from '../model/geometry';
import { SOURCE_OVER } from './quad';
import { MASK_FORMAT, WORKING_FORMAT, createSurface, isMaskSurface } from './surface';
import type { Surface } from './surface';
import type { MaskInput } from './mask';
import type { Gpu } from './device';
import type { RenderOperation } from './brush';

const ERASE: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** Rasterize even-odd path coverage once, then blend it into a layer on the GPU. */
export class PathRenderer {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly module: GPUShaderModule;
  private readonly sampler: GPUSampler;
  private readonly empty: Surface;

  constructor(private readonly gpu: Gpu) {
    this.module = gpu.device.createShaderModule({ label: 'Filled paths', code: shader });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.empty = createSurface(gpu.device, 'Unused path selection binding', { x: 0, y: 0, width: 1, height: 1 }, 1, MASK_FORMAT);
  }

  private pipeline(format: GPUTextureFormat, erase: boolean): GPURenderPipeline {
    const key = `${format}:${erase}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module;
      pipeline = this.gpu.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: erase ? ERASE : SOURCE_OVER }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  operation(points: readonly Point[], color: readonly [number, number, number, number], erase = false,
    selection: MaskInput | null = null): RenderOperation {
    const path = points.slice(0, 2048).map((point) => ({ x: point.x, y: point.y }));
    return { encode: (pass, { frame, target }) => {
      if (path.length < 3) return;
      const minX = Math.max(0, Math.floor(Math.min(...path.map((point) => point.x)) - 1));
      const minY = Math.max(0, Math.floor(Math.min(...path.map((point) => point.y)) - 1));
      const maxX = Math.min(target.texture.width, Math.ceil(Math.max(...path.map((point) => point.x)) + 1));
      const maxY = Math.min(target.texture.height, Math.ceil(Math.max(...path.map((point) => point.y)) + 1));
      if (maxX <= minX || maxY <= minY) return;
      const pipeline = this.pipeline(isMaskSurface(target) ? MASK_FORMAT : WORKING_FORMAT, erase);
      const width = maxX - minX;
      const height = maxY - minY;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas path rendering is unavailable.');
      const outline = new Path2D();
      outline.moveTo(path[0].x - minX, path[0].y - minY);
      for (let index = 1; index < path.length; index++) outline.lineTo(path[index].x - minX, path[index].y - minY);
      outline.closePath();
      context.fillStyle = '#fff';
      context.fill(outline, 'evenodd');
      const coverage = this.gpu.device.createTexture({
        label: 'Filled path coverage', size: { width, height }, format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      frame.retire(coverage);
      this.gpu.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: coverage }, { width, height });
      const mask = selection?.surface ?? this.empty;
      const [a, b, c, d, e, f] = selection?.transform ?? IDENTITY;
      const bounds = mask.bounds;
      const params = frame.uniform([
        target.texture.width, target.texture.height, path.length, Number(!!selection),
        minX, minY, maxX, maxY,
        a, c, e, 0, b, d, f, 0,
        bounds.x, bounds.y, bounds.width, bounds.height,
        ...color, Number(isMaskSurface(mask)), 0, 0, 0,
      ]);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: params }, { binding: 1, resource: coverage.createView() },
        { binding: 2, resource: mask.view }, { binding: 3, resource: this.sampler },
      ] }));
      pass.draw(6);
    } };
  }
}
