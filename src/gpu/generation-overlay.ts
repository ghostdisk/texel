import shader from '../shaders/generation-overlay.wgsl?raw';
import { inverse } from '../model/geometry';
import type { Rect } from '../model/geometry';
import type { ImageLayer } from '../model/layers';
import type { Gpu, GpuFrame } from './device';
import type { Surface } from './surface';
import { SOURCE_OVER } from './quad';

export interface GenerationVisual {
  layer: ImageLayer;
  mask: Surface | null;
}

export class GenerationOverlay {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly gpu: Gpu, format: GPUTextureFormat) {
    const module = gpu.device.createShaderModule({ label: 'Generation animation', code: shader });
    this.pipeline = gpu.device.createRenderPipeline({
      layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: SOURCE_OVER }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  encode(frame: GpuFrame, view: GPUTextureView, viewport: Rect, canvas: Rect, generation: GenerationVisual): void {
    const { layer, mask } = generation;
    const [a, b, c, d, e, f] = inverse(layer.worldTransform());
    const bounds = layer.source.bounds;
    const params = frame.uniform([
      viewport.x, viewport.y, viewport.width, viewport.height, canvas.x, canvas.y, canvas.width, canvas.height,
      a, c, e, 0, b, d, f, 0, bounds.x, bounds.y, bounds.width, bounds.height, performance.now() / 1000, Number(!!mask), 0, 0,
    ]);
    const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: params }, { binding: 1, resource: (mask ?? layer.source).view }, { binding: 2, resource: this.sampler },
    ] }));
    pass.draw(3);
    pass.end();
  }
}