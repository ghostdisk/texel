import compositeShader from '../shaders/composite.wgsl?raw';
import presentShader from '../shaders/present.wgsl?raw';
import { IDENTITY, inverse } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import type { BlendMode } from '../model/layers';
import { WORKING_FORMAT, MASK_FORMAT, isMaskSurface } from './surface';
import type { Surface } from './surface';
import type { Gpu, GpuFrame } from './device';

export const SOURCE_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export class QuadRenderer {
  private readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly pointSampler: GPUSampler;
  private readonly pipelines: Record<BlendMode, GPURenderPipeline>;
  private readonly maskPipeline: GPURenderPipeline;
  private readonly presentation: GPURenderPipeline;

  constructor(private readonly gpu: Gpu, canvasFormat: GPUTextureFormat) {
    const { device } = gpu;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ] });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.pointSampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const module = device.createShaderModule({ label: 'Layer composite', code: compositeShader });
    const pipeline = (blend: GPUBlendState, format = WORKING_FORMAT) => device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines = { normal: pipeline(SOURCE_OVER), add: pipeline(ADDITIVE) };
    this.maskPipeline = pipeline(SOURCE_OVER, MASK_FORMAT);
    const present = device.createShaderModule({ label: 'Canvas presentation', code: presentShader });
    this.presentation = device.createRenderPipeline({
      layout,
      vertex: { module: present, entryPoint: 'vertexMain' },
      fragment: { module: present, entryPoint: 'fragmentMain', targets: [{ format: canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  begin(frame: GpuFrame, target: Surface, loadOp: GPULoadOp = 'clear'): GPURenderPassEncoder {
    return frame.encoder.beginRenderPass({
      colorAttachments: [{ view: target.view, loadOp, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
  }

  draw(
    pass: GPURenderPassEncoder, frame: GpuFrame, source: Surface, target: Surface,
    matrix: Matrix = IDENTITY, opacity = 1, blend: BlendMode = 'normal', straightAlpha = false, pointSampling = false,
  ): void {
    const [a, b, c, d, e, f] = matrix;
    const src = source.bounds;
    const dst = target.bounds;
    const params = frame.uniform([
      a, c, e, 0, b, d, f, 0,
      src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height,
      opacity, Number(straightAlpha), Number(isMaskSurface(source)), Number(isMaskSurface(target)),
    ]);
    pass.setPipeline(isMaskSurface(target) ? this.maskPipeline : this.pipelines[blend]);
    pass.setBindGroup(0, this.bind(source, params, pointSampling));
    pass.draw(6);
  }

  copy(frame: GpuFrame, source: Surface, target: Surface, straightAlpha = false): void {
    const pass = this.begin(frame, target);
    this.draw(pass, frame, source, target, IDENTITY, 1, 'normal', straightAlpha);
    pass.end();
  }

  present(
    frame: GpuFrame, source: Surface, view: GPUTextureView, bounds: Rect, opacity: number,
    framing: Rect, pointSampling = false, world: Matrix = IDENTITY,
  ): void {
    const src = source.bounds;
    const [a, b, c, d, e, f] = inverse(world);
    const params = frame.uniform([
      bounds.x, bounds.y, bounds.width, bounds.height,
      src.x, src.y, src.width, src.height, framing.x, framing.y, framing.width, framing.height,
      opacity, Number(isMaskSurface(source)), 0, 0, a, c, e, 0, b, d, f, 0,
    ]);
    const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.presentation);
    pass.setBindGroup(0, this.bind(source, params, pointSampling));
    pass.draw(3);
    pass.end();
  }

  private bind(source: Surface, params: GPUBufferBinding, pointSampling = false): GPUBindGroup {
    return this.gpu.device.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: source.view },
      { binding: 1, resource: pointSampling ? this.pointSampler : this.sampler },
      { binding: 2, resource: params },
    ] });
  }
}