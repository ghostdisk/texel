import shader from '../shaders/generation-blend.wgsl?raw';
import type { GenerationFrame } from '../generation/lens';
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

  apply(generated: Surface, target: GenerationFrame, mask: Surface | null): Surface {
    const output = createSurface(this.gpu.device, 'Generated layer pixels', { x: 0, y: 0, width: target.width, height: target.height });
    const frame = this.gpu.beginFrame();
    try {
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: generated.view }, { binding: 1, resource: (mask ?? generated).view },
        { binding: 2, resource: this.sampler }, { binding: 3, resource: output.view },
        { binding: 4, resource: frame.uniform([Number(!!mask), 0, 0, 0]) },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
      pass.end();
      frame.submit();
      return output;
    } catch (error) { output.texture.destroy(); frame.release(); throw error; }
  }
}