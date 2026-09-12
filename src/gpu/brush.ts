import shader from '../shaders/brush.wgsl?raw';
import { IDENTITY } from '../model/geometry';
import { SOURCE_OVER } from './quad';
import { MASK_FORMAT, WORKING_FORMAT, createSurface, isMaskSurface } from './surface';
import type { Surface } from './surface';
import type { MaskInput } from './mask';
import type { Gpu, GpuFrame } from './device';

export interface OperationContext {
  readonly frame: GpuFrame;
  readonly target: Surface;
}

export interface RenderOperation {
  encode(pass: GPURenderPassEncoder, context: OperationContext): void;
}

export interface BrushStamp {
  x: number;
  y: number;
  radius: number;
  hardness: number;
  color: readonly [number, number, number, number];
  width?: number;
  height?: number;
  rectangle?: boolean;
}

const ERASE: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export class Brush {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly module: GPUShaderModule;
  private readonly sampler: GPUSampler;
  private readonly empty: Surface;

  constructor(private readonly gpu: Gpu) {
    this.module = gpu.device.createShaderModule({ label: 'Drawing stamps', code: shader });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.empty = createSurface(gpu.device, 'Unused selection binding', { x: 0, y: 0, width: 1, height: 1 }, 1, MASK_FORMAT);
  }

  private pipeline(format: GPUTextureFormat, erase: boolean): GPURenderPipeline {
    const key = `${format}:${erase}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module;
      pipeline = this.gpu.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain', buffers: [{ arrayStride: 48, stepMode: 'instance', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
          { shaderLocation: 2, offset: 32, format: 'float32x4' },
        ] }] },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: erase ? ERASE : SOURCE_OVER }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  operation(stamps: readonly BrushStamp[], erase = false, selection: MaskInput | null = null): RenderOperation {
    return { encode: (pass, { frame, target }) => {
      if (stamps.length === 0) return;
      const pipeline = this.pipeline(isMaskSurface(target) ? MASK_FORMAT : WORKING_FORMAT, erase);
      const data = new Float32Array(stamps.length * 12);
      stamps.forEach((stamp, index) => {
        data.set([
          stamp.x, stamp.y, stamp.width === undefined ? stamp.radius : stamp.width / 2,
          stamp.height === undefined ? stamp.radius : stamp.height / 2,
          stamp.hardness, Number(stamp.rectangle ?? false), 0, 0, ...stamp.color,
        ], index * 12);
      });
      const mask = selection?.surface ?? this.empty;
      const [a, b, c, d, e, f] = selection?.transform ?? IDENTITY;
      const bounds = mask.bounds;
      const params = frame.uniform([
        target.texture.width, target.texture.height, Number(!!selection), Number(isMaskSurface(mask)),
        a, c, e, 0, b, d, f, 0, bounds.x, bounds.y, bounds.width, bounds.height,
      ]);
      const instances = frame.upload(data, GPUBufferUsage.VERTEX);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: params }, { binding: 1, resource: mask.view }, { binding: 2, resource: this.sampler },
      ] }));
      pass.setVertexBuffer(0, instances);
      pass.draw(6, stamps.length);
    } };
  }
}