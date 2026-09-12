import shader from '../shaders/retouch.wgsl?raw';
import { IDENTITY } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import { SOURCE_OVER } from './quad';
import { MASK_FORMAT, createSurface, isMaskSurface } from './surface';
import type { Surface } from './surface';
import type { MaskInput } from './mask';
import type { Gpu } from './device';
import type { RenderOperation } from './brush';

export interface RetouchStamp {
  x: number;
  y: number;
  radius: number;
  hardness: number;
  flow: number;
}

export interface RetouchInput {
  source: Surface;
  sourceBlur: Surface | null;
  destinationBlur: Surface | null;
  sourceTransform: Matrix;
  selection: MaskInput | null;
  heal: boolean;
  erase: boolean;
}

const ERASE: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export class RetouchBrush {
  private readonly pipelines = new Map<boolean, GPURenderPipeline>();
  private readonly sampler: GPUSampler;
  private readonly empty: Surface;

  constructor(private readonly gpu: Gpu) {
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.empty = createSurface(gpu.device, 'Unused retouch selection', { x: 0, y: 0, width: 1, height: 1 }, 1, MASK_FORMAT);
  }

  private pipeline(erase: boolean): GPURenderPipeline {
    let pipeline = this.pipelines.get(erase);
    if (!pipeline) {
      const module = this.gpu.device.createShaderModule({ label: 'Retouch stamps', code: shader });
      pipeline = this.gpu.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain', buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
        ] }] },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float', blend: erase ? ERASE : SOURCE_OVER }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(erase, pipeline);
    }
    return pipeline;
  }

  operation(stamps: readonly RetouchStamp[], input: RetouchInput): RenderOperation {
    return { encode: (pass, { frame, target }) => {
      if (!stamps.length) return;
      if (isMaskSurface(target)) throw new Error('Retouch tools require an RGBA pixel layer.');
      const pipeline = this.pipeline(input.erase);
      const data = new Float32Array(stamps.length * 8);
      stamps.forEach((stamp, index) => data.set([stamp.x, stamp.y, stamp.radius, stamp.hardness, stamp.flow, 0, 0, 0], index * 8));
      const selection = input.selection?.surface ?? this.empty;
      const [sa, sb, sc, sd, se, sf] = input.sourceTransform;
      const [ma, mb, mc, md, me, mf] = input.selection?.transform ?? IDENTITY;
      const sourceBounds = input.source.bounds;
      const destinationBounds = input.destinationBlur?.bounds ?? target.bounds;
      const selectionBounds = selection.bounds;
      const params = frame.uniform([
        target.texture.width, target.texture.height, 0, 0,
        sa, sc, se, 0, sb, sd, sf, 0,
        sourceBounds.x, sourceBounds.y, sourceBounds.width, sourceBounds.height,
        destinationBounds.x, destinationBounds.y, destinationBounds.width, destinationBounds.height,
        ma, mc, me, 0, mb, md, mf, 0,
        selectionBounds.x, selectionBounds.y, selectionBounds.width, selectionBounds.height,
        Number(!!input.selection), Number(isMaskSurface(selection)), Number(input.heal), Number(input.erase),
      ]);
      const instances = frame.upload(data, GPUBufferUsage.VERTEX);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: params },
        { binding: 1, resource: input.source.view },
        { binding: 2, resource: (input.sourceBlur ?? input.source).view },
        { binding: 3, resource: (input.destinationBlur ?? input.source).view },
        { binding: 4, resource: selection.view },
        { binding: 5, resource: this.sampler },
      ] }));
      pass.setVertexBuffer(0, instances);
      pass.draw(6, stamps.length);
    } };
  }
}
