import shader from '../shaders/blur.wgsl?raw';
import type { Gpu, GpuFrame } from './device';
import type { Surface } from './surface';

/** Stateless with respect to layers: the compositor owns all input/output textures. */
export class GaussianBlur {
  private readonly pipeline: GPUComputePipeline;
  private readonly kernels = new Map<number, number[]>();

  constructor(private readonly gpu: Gpu) {
    this.pipeline = gpu.device.createComputePipeline({
      label: 'Separable Gaussian blur',
      layout: 'auto',
      compute: { module: gpu.device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
  }

  encode(frame: GpuFrame, input: Surface, scratch: Surface, output: Surface, sigma: number): void {
    const radius = Math.min(96, Math.ceil(3 * sigma));
    const weights = this.kernel(sigma, radius);
    this.axis(frame, input, scratch, radius, weights, false);
    this.axis(frame, scratch, output, radius, weights, true);
  }

  private axis(frame: GpuFrame, input: Surface, output: Surface, radius: number, weights: number[], vertical: boolean): void {
    const params = frame.uniform([Number(vertical), radius, 0, 0, ...weights]);
    const group = this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: input.view },
      { binding: 1, resource: output.view },
      { binding: 2, resource: params },
    ] });
    const pass = frame.encoder.beginComputePass({ label: vertical ? 'Blur vertical' : 'Blur horizontal' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    const { width, height } = output.texture;
    pass.dispatchWorkgroups(Math.ceil((vertical ? height : width) / 128), vertical ? width : height);
    pass.end();
  }

  private kernel(sigma: number, radius: number): number[] {
    const key = Math.round(sigma * 10000) / 10000;
    const cached = this.kernels.get(key);
    if (cached) return cached;
    const weights = Array<number>(100).fill(0);
    let total = 0;
    for (let index = 0; index <= radius; index++) {
      weights[index] = Math.exp(-(index * index) / (2 * sigma * sigma));
      total += weights[index] * (index === 0 ? 1 : 2);
    }
    for (let index = 0; index <= radius; index++) weights[index] /= total;
    if (this.kernels.size >= 128) this.kernels.clear();
    this.kernels.set(key, weights);
    return weights;
  }
}
