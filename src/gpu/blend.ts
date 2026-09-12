import blendShader from '../shaders/blend.wgsl?raw';
import { BLEND_MODES } from '../model/layers';
import type { BlendMode } from '../model/layers';
import { inverse } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import { isMaskSurface, WORKING_FORMAT } from './surface';
import type { Surface } from './surface';
import type { Gpu, GpuFrame } from './device';

export class BlendCompositor {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly pointSampler: GPUSampler;

  constructor(private readonly gpu: Gpu) {
    const { device } = gpu;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ] });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.pointSampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
    const module = device.createShaderModule({ label: 'Shader blend modes', code: blendShader });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: WORKING_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  encode(
    frame: GpuFrame, backdrop: Surface, source: Surface, target: Surface, matrix: Matrix,
    opacity: number, mode: BlendMode, pointSampling = false,
  ): void {
    const [a, b, c, d, e, f] = inverse(matrix);
    const src = source.bounds;
    const dst = target.bounds;
    const params = frame.uniform([
      a, c, e, 0, b, d, f, 0,
      src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height,
      opacity, BLEND_MODES.indexOf(mode), Number(isMaskSurface(source)), 0,
    ]);
    const bindGroup = this.gpu.device.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: backdrop.view },
      { binding: 1, resource: source.view },
      { binding: 2, resource: pointSampling ? this.pointSampler : this.sampler },
      { binding: 3, resource: params },
    ] });
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
}
