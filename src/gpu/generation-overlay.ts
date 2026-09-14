import shader from '../shaders/generation-overlay.wgsl?raw';
import { inverse, multiply, transformBounds } from '../model/geometry';
import type { Rect } from '../model/geometry';
import type { GenerationFrame } from '../generation/lens';
import type { Gpu, GpuFrame } from './device';
import type { Surface } from './surface';
import { planTiles, TILE_SIZE } from './surface';
import { neighborhoodEntries, neighborhoodShader } from './local';
import { SOURCE_OVER, quads } from './quad';

export interface GenerationVisual {
  frame: GenerationFrame;
  reference: Surface;
  mask: Surface | null;
}

export class GenerationOverlay {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly gpu: Gpu, format: GPUTextureFormat) {
    const module = gpu.device.createShaderModule({ label: 'Generation animation', code: neighborhoodShader() + shader });
    this.pipeline = gpu.device.createRenderPipeline({
      layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: SOURCE_OVER }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  encode(frame: GpuFrame, view: GPUTextureView, viewport: Rect, canvas: Rect, generation: GenerationVisual, pixelsPerUnit: number): void {
    const { frame: target, mask, reference } = generation;
    const [a, b, c, d, e, f] = inverse(target.transform);
    const bounds = { x: 0, y: 0, width: target.width, height: target.height };
    const width = Math.max(1, Math.round(viewport.width * pixelsPerUnit)), height = Math.max(1, Math.round(viewport.height * pixelsPerUnit));
    const screen = [pixelsPerUnit, 0, 0, pixelsPerUnit, -viewport.x * pixelsPerUnit, -viewport.y * pixelsPerUnit] as const;
    const transform = multiply(screen, target.transform);
    const sampled = quads.region(frame, mask ?? reference, { x: 0, y: 0, width, height }, 1, transform);
    const planned = planTiles(sampled, [transformBounds(transform, bounds)]);
    const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.pipeline);
    for (const { x, y } of planned.values()) {
      const params = frame.uniform([
        viewport.x, viewport.y, viewport.width, viewport.height, canvas.x, canvas.y, canvas.width, canvas.height,
        a, c, e, 0, b, d, f, 0, bounds.x, bounds.y, bounds.width, bounds.height, performance.now() / 1000, Number(!!mask), 0, 0,
        x * TILE_SIZE, y * TILE_SIZE, width, height,
      ]);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: params }] }));
      pass.setBindGroup(1, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(1), entries: neighborhoodEntries(frame, sampled, x, y) }));
      pass.draw(6);
    }
    pass.end();
  }
}
