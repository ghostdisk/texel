import shader from '../shaders/mask.wgsl?raw';
import type { Matrix } from '../model/geometry';
import type { Gpu, GpuFrame } from './device';
import { isMaskSurface } from './surface';
import type { Surface } from './surface';

export interface MaskInput {
  surface: Surface;
  /** Maps the receiving layer's local coordinates into the mask layer. */
  transform: Matrix;
}

export class MaskRenderer {
  private readonly pipeline: GPUComputePipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly gpu: Gpu) {
    this.pipeline = gpu.device.createComputePipeline({
      label: 'Layer mask', layout: 'auto', compute: { module: gpu.device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  encode(frame: GpuFrame, input: Surface, output: Surface, mask: MaskInput): void {
    const [a, b, c, d, e, f] = mask.transform;
    const bounds = mask.surface.bounds;
    const params = frame.uniform([
      a, c, e, 0, b, d, f, 0, bounds.x, bounds.y, bounds.width, bounds.height,
      output.bounds.x, output.bounds.y, output.scale, Number(isMaskSurface(mask.surface)),
    ]);
    const pass = frame.encoder.beginComputePass({ label: 'Apply layer mask' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: input.view }, { binding: 1, resource: mask.surface.view },
      { binding: 2, resource: this.sampler }, { binding: 3, resource: output.view }, { binding: 4, resource: params },
    ] }));
    pass.dispatchWorkgroups(Math.ceil(output.texture.width / 8), Math.ceil(output.texture.height / 8));
    pass.end();
  }
}