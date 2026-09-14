import shader from '../shaders/brush.wgsl?raw';
import { IDENTITY, inverse } from '../model/geometry';
import { SOURCE_OVER } from './quad';
import { MASK_FORMAT, WORKING_FORMAT, createSurface, isMaskSurface } from './surface';
import type { Surface, Tile, TileColor, TileRegion } from './surface';
import { TILE_SIZE, intersectBounds } from './surface';
import type { Rect } from '../model/geometry';
import type { QuadRenderer } from './quad';
import type { MaskInput } from './mask';
import type { Gpu, GpuFrame } from './device';

export interface OperationContext {
  readonly frame: GpuFrame;
  readonly target: Tile;
  readonly image: Surface;
  readonly quads: QuadRenderer;
}

export interface RenderOperation {
  readonly erase?: boolean;
  regions(): readonly Rect[];
  solidColor?(image: Surface, region: TileRegion): TileColor | null;
  encode(context: OperationContext): void;
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
    this.empty = createSurface('Unused selection binding', { x: 0, y: 0, width: 1, height: 1 }, 1, MASK_FORMAT);
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
    return { erase, regions: () => stamps.map(stampBounds), encode: (context) => {
      const { frame, target, quads } = context;
      const visible = stamps.filter((stamp) => intersectBounds(stampBounds(stamp), target.bounds));
      if (visible.length === 0) return;
      const pipeline = this.pipeline(isMaskSurface(target) ? MASK_FORMAT : WORKING_FORMAT, erase);
      const data = new Float32Array(visible.length * 12);
      visible.forEach((stamp, index) => {
        data.set([
          stamp.x, stamp.y, stamp.width === undefined ? stamp.radius : stamp.width / 2,
          stamp.height === undefined ? stamp.radius : stamp.height / 2,
          stamp.hardness, Number(stamp.rectangle ?? false), 0, 0, ...stamp.color,
        ], index * 12);
      });
      const mask = selection ? quads.region(frame, selection.surface, target.bounds, target.scale, inverse(selection.transform)) : this.empty;
      const [a, b, c, d, e, f] = IDENTITY;
      const bounds = mask.bounds;
      const params = frame.uniform([
        TILE_SIZE, TILE_SIZE, Number(!!selection), Number(isMaskSurface(mask)),
        a, c, e, 0, b, d, f, 0, bounds.x, bounds.y, bounds.width, bounds.height,
        target.bounds.x, target.bounds.y, 0, 0,
      ]);
      const instances = frame.upload(data, GPUBufferUsage.VERTEX);
      const pass = beginTilePaint(context);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: params }, { binding: 1, resource: mask.view(target.x, target.y) }, { binding: 2, resource: this.sampler },
      ] }));
      pass.setVertexBuffer(0, instances);
      pass.draw(6, visible.length);
      pass.end();
    } };
  }
}

export function stampBounds(stamp: BrushStamp): Rect {
  const width = stamp.width ?? stamp.radius * 2, height = stamp.height ?? stamp.radius * 2;
  return { x: stamp.x - width / 2, y: stamp.y - height / 2, width, height };
}

export function beginTilePaint({ frame, target, image }: OperationContext): GPURenderPassEncoder {
  const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }] });
  const clip = intersectBounds(target.bounds, image.bounds)!;
  const x = Math.round((clip.x - target.bounds.x) * target.scale), y = Math.round((clip.y - target.bounds.y) * target.scale);
  pass.setScissorRect(x, y, Math.round(clip.width * target.scale), Math.round(clip.height * target.scale));
  return pass;
}
