import shader from '../shaders/mix-filter.wgsl?raw';
import type { Rect } from '../model/geometry';
import type { Gpu, GpuFrame } from './device';
import type { Surface } from './surface';

export class FilterMixer {
  private readonly pipeline: GPUComputePipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly gpu: Gpu) {
    this.pipeline = gpu.device.createComputePipeline({
      label: 'Filter mix', layout: 'auto', compute: { module: gpu.device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  encode(frame: GpuFrame, original: Surface, filtered: Surface, output: Surface, originalStrength: number): void {
    const rect = (bounds: Rect) => [bounds.x, bounds.y, bounds.width, bounds.height];
    const params = frame.uniform([...rect(original.bounds), ...rect(filtered.bounds), ...rect(output.bounds), originalStrength, output.scale, 0, 0]);
    const pass = frame.encoder.beginComputePass({ label: 'Reapply filter input' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: original.view }, { binding: 1, resource: filtered.view }, { binding: 2, resource: this.sampler },
      { binding: 3, resource: output.view }, { binding: 4, resource: params },
    ] }));
    pass.dispatchWorkgroups(Math.ceil(output.texture.width / 8), Math.ceil(output.texture.height / 8));
    pass.end();
  }
}

