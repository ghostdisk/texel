import shader from '../shaders/retouch.wgsl?raw';
import { IDENTITY, inverse } from '../model/geometry';
import type { Matrix } from '../model/geometry';
import { SOURCE_OVER } from './quad';
import { MASK_FORMAT, TILE_SIZE, createSurface, isMaskSurface, intersectBounds } from './surface';
import type { Surface } from './surface';
import type { MaskInput } from './mask';
import type { Gpu } from './device';
import { beginTilePaint } from './brush';
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
    this.empty = createSurface('Unused retouch selection', { x: 0, y: 0, width: 1, height: 1 }, 1, MASK_FORMAT);
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
    const bounds = (stamp: RetouchStamp) => ({ x: stamp.x - stamp.radius, y: stamp.y - stamp.radius, width: stamp.radius * 2, height: stamp.radius * 2 });
    return { erase: input.erase, regions: () => stamps.map(bounds), encode: (context) => {
      const { frame, target, quads } = context;
      const visible = stamps.filter((stamp) => intersectBounds(bounds(stamp), target.bounds));
      if (!visible.length) return;
      if (isMaskSurface(target)) throw new Error('Retouch tools require an RGBA pixel layer.');
      const pipeline = this.pipeline(input.erase);
      const data = new Float32Array(visible.length * 8);
      visible.forEach((stamp, index) => data.set([stamp.x, stamp.y, stamp.radius, stamp.hardness, stamp.flow, 0, 0, 0], index * 8));
      const source = quads.region(frame, input.source, target.bounds, target.scale, inverse(input.sourceTransform));
      const sourceBlur = input.sourceBlur ? quads.region(frame, input.sourceBlur, target.bounds, target.scale, inverse(input.sourceTransform)) : source;
      const destinationBlur = input.destinationBlur ? quads.region(frame, input.destinationBlur, target.bounds, target.scale) : source;
      const selection = input.selection ? quads.region(frame, input.selection.surface, target.bounds, target.scale, inverse(input.selection.transform)) : this.empty;
      const [sa, sb, sc, sd, se, sf] = IDENTITY;
      const [ma, mb, mc, md, me, mf] = IDENTITY;
      const sourceBounds = target.bounds;
      const destinationBounds = target.bounds;
      const selectionBounds = target.bounds;
      const params = frame.uniform([
        TILE_SIZE, TILE_SIZE, target.bounds.x, target.bounds.y,
        sa, sc, se, 0, sb, sd, sf, 0,
        sourceBounds.x, sourceBounds.y, sourceBounds.width, sourceBounds.height,
        destinationBounds.x, destinationBounds.y, destinationBounds.width, destinationBounds.height,
        ma, mc, me, 0, mb, md, mf, 0,
        selectionBounds.x, selectionBounds.y, selectionBounds.width, selectionBounds.height,
        Number(!!input.selection), Number(isMaskSurface(selection)), Number(input.heal), Number(input.erase),
      ]);
      const instances = frame.upload(data, GPUBufferUsage.VERTEX);
      const pass = beginTilePaint(context);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: params },
        { binding: 1, resource: source.view(target.x, target.y) },
        { binding: 2, resource: sourceBlur.view(target.x, target.y) },
        { binding: 3, resource: destinationBlur.view(target.x, target.y) },
        { binding: 4, resource: selection.view(target.x, target.y) },
        { binding: 5, resource: this.sampler },
      ] }));
      pass.setVertexBuffer(0, instances);
      pass.draw(6, visible.length);
      pass.end();
    } };
  }
}
