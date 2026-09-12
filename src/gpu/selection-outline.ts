import shader from '../shaders/selection-outline.wgsl?raw';
import type { Matrix, Rect } from '../model/geometry';
import type { Gpu, GpuFrame } from './device';
import { SOURCE_OVER } from './quad';
import type { Surface } from './surface';

export class SelectionOutline {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly gpu: Gpu, format: GPUTextureFormat) {
    const module = gpu.device.createShaderModule({ label: 'Selection coverage outline', code: shader });
    this.pipeline = gpu.device.createRenderPipeline({
      layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: SOURCE_OVER }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  encode(frame: GpuFrame, mask: Surface, worldToMask: Matrix, view: GPUTextureView, viewport: Rect, canvas: Rect, pixelsPerUnit: number, editing: boolean): void {
    const rect = (r: Rect) => [r.x, r.y, r.width, r.height];
    const [a, b, c, d, e, f] = worldToMask;
    const params = frame.uniform([
      ...rect(viewport), ...rect(canvas), ...rect(mask.bounds), a, c, e, 0, b, d, f, 0,
      pixelsPerUnit, performance.now() / 1000, Number(editing), 0,
    ]);
    const pass = frame.encoder.beginRenderPass({ label: 'Selection overlay', colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: mask.view }, { binding: 1, resource: this.sampler }, { binding: 2, resource: params },
    ] }));
    pass.draw(3);
    pass.end();
  }
}