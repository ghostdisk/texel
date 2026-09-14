import shader from '../shaders/path.wgsl?raw';
import { IDENTITY, inverse } from '../model/geometry';
import type { Point } from '../model/geometry';
import { SOURCE_OVER } from './quad';
import { MASK_FORMAT, WORKING_FORMAT, TILE_SIZE, tilePool, createSurface, isMaskSurface, intersectBounds } from './surface';
import type { Surface } from './surface';
import { uniformMaskCoverage } from './mask';
import type { MaskInput } from './mask';
import type { Gpu } from './device';
import { beginTilePaint } from './brush';
import type { OperationContext, RenderOperation } from './brush';

const ERASE: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/** Rasterize even-odd path coverage once, then blend it into a layer on the GPU. */
export class PathRenderer {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly module: GPUShaderModule;
  private readonly sampler: GPUSampler;
  private readonly empty: Surface;

  constructor(private readonly gpu: Gpu) {
    this.module = gpu.device.createShaderModule({ label: 'Filled paths', code: shader });
    this.sampler = gpu.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.empty = createSurface('Unused path selection binding', { x: 0, y: 0, width: 1, height: 1 }, 1, MASK_FORMAT);
  }

  private pipeline(format: GPUTextureFormat, erase: boolean): GPURenderPipeline {
    const key = `${format}:${erase}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module;
      pipeline = this.gpu.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: erase ? ERASE : SOURCE_OVER }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  operation(points: readonly Point[], color: readonly [number, number, number, number], erase = false,
    selection: MaskInput | null = null): RenderOperation {
    const path = points.slice(0, 2048).map((point) => ({ ...point }));
    const left = Math.floor(Math.min(...path.map((point) => point.x)) - 1), top = Math.floor(Math.min(...path.map((point) => point.y)) - 1);
    const right = Math.ceil(Math.max(...path.map((point) => point.x)) + 1), bottom = Math.ceil(Math.max(...path.map((point) => point.y)) + 1);
    return { erase, regions: () => path.length < 3 ? [] : [{ x: left, y: top, width: right - left, height: bottom - top }],
      encode: (context) => {
        const { frame, target } = context;
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
        const drawing = canvas.getContext('2d');
        if (!drawing) throw new Error('Canvas path rendering is unavailable.');
        const outline = new Path2D();
        outline.moveTo(path[0].x - target.bounds.x, path[0].y - target.bounds.y);
        for (let index = 1; index < path.length; index++) outline.lineTo(path[index].x - target.bounds.x, path[index].y - target.bounds.y);
        outline.closePath();
        drawing.fillStyle = '#fff';
        drawing.fill(outline, 'evenodd');
        const coverage = tilePool.acquire('rgba8unorm');
        frame.retire({ destroy: () => tilePool.release(coverage) });
        this.gpu.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: coverage.texture }, [TILE_SIZE, TILE_SIZE]);
        this.drawCoverage(context, coverage.view, false, color, erase, selection);
      },
    };
  }

  coverageOperation(coverage: Surface, color: readonly [number, number, number, number], erase = false,
    selection: MaskInput | null = null): RenderOperation {
    return { erase, regions: () => coverage.regions,
      solidColor: (image, region) => {
        if (image.scale !== coverage.scale) return null;
        const bounds = intersectBounds(image.tileBounds(region.x, region.y), image.bounds)!;
        const clipped = intersectBounds(bounds, coverage.bounds);
        if (!clipped || clipped.x !== bounds.x || clipped.y !== bounds.y || clipped.width !== bounds.width || clipped.height !== bounds.height) return null;
        const fill = coverage.solidColor(region.x, region.y);
        const selected = uniformMaskCoverage(selection, bounds);
        if (!fill || selected === null) return null;
        const alpha = fill[isMaskSurface(coverage) ? 0 : 3] * selected * color[3];
        const base = image.solidColor(region.x, region.y);
        if (alpha === 1) return erase ? [0, 0, 0, 0] : [color[0], color[1], color[2], 1];
        if (!base) return null;
        const amount = erase ? 0 : alpha;
        return [base[0] * (1 - alpha) + color[0] * amount, base[1] * (1 - alpha) + color[1] * amount,
          base[2] * (1 - alpha) + color[2] * amount, base[3] * (1 - alpha) + amount];
      },
      encode: (context) => {
      const { frame, target, quads } = context;
      const local = coverage.scale === target.scale ? coverage : quads.region(frame, coverage, target.bounds, target.scale);
      this.drawCoverage(context, local.view(target.x, target.y), isMaskSurface(local), color, erase, selection);
    } };
  }

  private drawCoverage(context: OperationContext, coverage: GPUTextureView, scalar: boolean,
    color: readonly [number, number, number, number], erase: boolean, selection: MaskInput | null): void {
    const { frame, target, quads } = context;
    const mask = selection ? quads.region(frame, selection.surface, target.bounds, target.scale, inverse(selection.transform)) : this.empty;
    const bounds = target.bounds;
    const pipeline = this.pipeline(isMaskSurface(target) ? MASK_FORMAT : WORKING_FORMAT, erase);
    const params = frame.uniform([
      TILE_SIZE, TILE_SIZE, 0, Number(!!selection), bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height,
      1, 0, 0, 0, 0, 1, 0, 0, bounds.x, bounds.y, bounds.width, bounds.height,
      ...color, Number(isMaskSurface(mask)), Number(scalar), 0, 0, bounds.x, bounds.y, 0, 0,
    ]);
    const pass = beginTilePaint(context);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: params }, { binding: 1, resource: coverage },
      { binding: 2, resource: mask.view(target.x, target.y) }, { binding: 3, resource: this.sampler },
    ] }));
    pass.draw(6);
    pass.end();
  }
}
