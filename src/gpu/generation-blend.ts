import shader from '../shaders/generation-blend.wgsl?raw';
import { createSurface } from './surface';
import type { Surface } from './surface';
import type { Gpu } from './device';

export class GenerationBlend {
  private readonly pipeline: GPUComputePipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly gpu: Gpu) {
    this.pipeline = gpu.device.createComputePipeline({
      label: 'Apply generated pixels', layout: 'auto', compute: { module: gpu.device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  apply(original: Surface, generated: Surface, mask: Surface | null): Surface {
    const output = createSurface(this.gpu.device, 'Generated layer pixels', original.bounds);
    const frame = this.gpu.beginFrame();
    try {
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: original.view }, { binding: 1, resource: generated.view },
        { binding: 2, resource: (mask ?? original).view }, { binding: 3, resource: this.sampler },
        { binding: 4, resource: output.view }, { binding: 5, resource: frame.uniform([Number(!!mask), 0, 0, 0]) },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(output.texture.width / 8), Math.ceil(output.texture.height / 8));
      pass.end();
      frame.submit();
      return output;
    } catch (error) { output.texture.destroy(); frame.release(); throw error; }
  }
}