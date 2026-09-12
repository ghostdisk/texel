import shader from '../shaders/generation-mask.wgsl?raw';
import type { GenerationFrame } from '../generation/lens';
import type { Gpu } from './device';
import { createSurface } from './surface';
import type { Surface } from './surface';

export class GenerationMask {
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly gpu: Gpu) {
    this.pipeline = gpu.device.createComputePipeline({
      label: 'Feather generation mask', layout: 'auto',
      compute: { module: gpu.device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
  }

  create(selection: Surface | null, target: GenerationFrame, feather: number, fallback: Surface): Surface | null {
    if (feather <= 0) return selection;
    const output = createSurface(this.gpu.device, 'Feathered generation mask', { x: 0, y: 0, width: target.width, height: target.height });
    const frame = this.gpu.beginFrame();
    try {
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: (selection ?? fallback).view }, { binding: 1, resource: output.view },
        { binding: 2, resource: frame.uniform([target.width, target.height, target.canonicalWidth, target.canonicalHeight, feather, Number(!!selection), 0, 0]) },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
      pass.end();
      frame.submit();
      return output;
    } catch (error) { output.texture.destroy(); frame.release(); throw error; }
  }
}