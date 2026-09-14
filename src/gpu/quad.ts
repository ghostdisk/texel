import compositeShader from '../shaders/composite.wgsl?raw';
import presentShader from '../shaders/present.wgsl?raw';
import { IDENTITY, inverse, transformBounds } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import type { FixedBlendMode } from '../model/layers';
import { WORKING_FORMAT, MASK_FORMAT, TILE_SIZE, createSurface, isMaskSurface, intersectBounds, planTiles } from './surface';
import type { Surface, Tile, TileColor, TileRegion } from './surface';
import { neighborhoodEntries, neighborhoodRevision, neighborhoodShader } from './local';
import type { Gpu, GpuFrame } from './device';

export const SOURCE_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const SCREEN: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const EXCLUSION: GPUBlendState = {
  color: { srcFactor: 'one-minus-dst', dstFactor: 'one-minus-src', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};


interface QuadDraw {
  source: Surface;
  matrix: Matrix;
  opacity: number;
  blend: FixedBlendMode;
  straightAlpha: boolean;
  pointSampling: boolean;
}

interface TileDraw {
  draw: QuadDraw;
  x: number;
  y: number;
  bounds: Rect;
}

interface CompositeTile {
  x: number;
  y: number;
  bounds: Rect;
  draws: TileDraw[];
}

export interface QuadPass {
  draws: QuadDraw[];
  end(): void;
}

export let quads: QuadRenderer;

export class QuadRenderer {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly presentation: GPURenderPipeline;
  private readonly module: GPUShaderModule;

  constructor(private readonly gpu: Gpu, canvasFormat: GPUTextureFormat) {
    quads = this;
    this.module = gpu.device.createShaderModule({ label: 'Tiled layer composite', code: neighborhoodShader() + compositeShader });
    const module = gpu.device.createShaderModule({ label: 'Tiled canvas presentation', code: neighborhoodShader() + presentShader });
    this.presentation = gpu.device.createRenderPipeline({
      layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: canvasFormat }] },
    });
  }

  private pipeline(format: GPUTextureFormat, mode: FixedBlendMode): GPURenderPipeline {
    const key = format + ':' + mode;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const blends = { normal: SOURCE_OVER, add: ADDITIVE, screen: SCREEN, exclusion: EXCLUSION };
      pipeline = this.gpu.device.createRenderPipeline({
        layout: 'auto', vertex: { module: this.module, entryPoint: 'vertexMain' },
        fragment: { module: this.module, entryPoint: 'fragmentMain', targets: [{ format, blend: blends[mode] }] },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  begin(frame: GpuFrame, target: Surface, loadOp: GPULoadOp = 'clear'): QuadPass {
    const draws: QuadDraw[] = [];
    return { draws, end: () => this.composite(frame, target, draws, loadOp) };
  }

  draw(pass: QuadPass, _frame: GpuFrame, source: Surface, _target: Surface, matrix: Matrix = IDENTITY,
    opacity = 1, blend: FixedBlendMode = 'normal', straightAlpha = false, pointSampling = false): void {
    if (opacity !== 0) pass.draws.push({ source, matrix, opacity, blend, straightAlpha, pointSampling });
  }

  copy(frame: GpuFrame, source: Surface, target: Surface, straightAlpha = false): void {
    const pass = this.begin(frame, target);
    this.draw(pass, frame, source, target, IDENTITY, 1, 'normal', straightAlpha);
    pass.end();
  }

  region(frame: GpuFrame, source: Surface, bounds: Rect, scale = 1, matrix: Matrix = IDENTITY, format = source.format): Surface {
    const output = createSurface('Sampled tile region', bounds, scale, format);
    frame.retire(output);
    const pass = this.begin(frame, output);
    this.draw(pass, frame, source, output, matrix);
    pass.end();
    return output;
  }

  private composite(frame: GpuFrame, target: Surface, draws: readonly QuadDraw[], loadOp: GPULoadOp): void {
    const candidates = new Map<string, CompositeTile>();
    for (const draw of draws) {
      const opaqueMask = isMaskSurface(draw.source) && !isMaskSurface(target);
      const visible = intersectBounds(draw.source.bounds, transformBounds(inverse(draw.matrix), target.bounds));
      if (!visible) continue;
      const columns = Math.ceil((visible.x + visible.width) * draw.source.scale / TILE_SIZE) - Math.floor(visible.x * draw.source.scale / TILE_SIZE);
      const rows = Math.ceil((visible.y + visible.height) * draw.source.scale / TILE_SIZE) - Math.floor(visible.y * draw.source.scale / TILE_SIZE);
      const sources = new Map<string, TileRegion>();
      if (opaqueMask || columns * rows < draw.source.tiles.size) {
        for (const [key, region] of planTiles(draw.source, [visible])) {
          const tile = draw.source.tiles.get(key);
          if (opaqueMask) sources.set(key, region);
          else if (tile) sources.set(key, { x: tile.x, y: tile.y, bounds: tile.contentBounds });
        }
      } else {
        for (const [key, tile] of draw.source.tiles) if (intersectBounds(tile.contentBounds, visible)) sources.set(key, { x: tile.x, y: tile.y, bounds: tile.contentBounds });
      }
      for (const source of sources.values()) {
        const transformed = transformBounds(draw.matrix, source.bounds);
        for (const [key, region] of planTiles(target, [transformed])) {
          let candidate = candidates.get(key);
          if (!candidate) { candidate = { ...region, draws: [] }; candidates.set(key, candidate); }
          else {
            const left = Math.min(candidate.bounds.x, region.bounds.x), top = Math.min(candidate.bounds.y, region.bounds.y);
            candidate.bounds = { x: left, y: top, width: Math.max(candidate.bounds.x + candidate.bounds.width, region.bounds.x + region.bounds.width) - left,
              height: Math.max(candidate.bounds.y + candidate.bounds.height, region.bounds.y + region.bounds.height) - top };
          }
          candidate.draws.push({ draw, x: source.x, y: source.y, bounds: intersectBounds(draw.source.tileBounds(source.x, source.y), draw.source.bounds)! });
        }
      }
    }
    if (loadOp === 'clear') target.retain(new Set(candidates.keys()), frame);
    for (const [key, region] of candidates) {
      const signature = JSON.stringify(region.draws.map(({ draw, x, y, bounds }) => [
        draw.matrix, draw.opacity, draw.blend, draw.straightAlpha, draw.pointSampling, bounds, draw.source.scale, draw.source.format,
        neighborhoodRevision(draw.source, x, y),
      ]));
      if (loadOp === 'clear' && target.tiles.get(key)?.signature === signature) continue;
      if (loadOp === 'clear' && region.draws.length === 1) {
        const { draw, x, y, bounds } = region.draws[0];
        const color = draw.source.solidColor(x, y), clip = intersectBounds(target.tileBounds(region.x, region.y), target.bounds)!;
        if (color && draw.blend === 'normal' && draw.source.scale === target.scale && draw.matrix.every((value, index) => value === IDENTITY[index]) &&
          bounds.x <= clip.x && bounds.y <= clip.y && bounds.x + bounds.width >= clip.x + clip.width && bounds.y + bounds.height >= clip.y + clip.height) {
          const scalar = Math.max(0, Math.min(1, color[0]));
          const sampled: TileColor = isMaskSurface(draw.source) ? [scalar, scalar, scalar, 1] : color;
          const alpha = draw.straightAlpha ? sampled[3] : 1;
          const result: TileColor = isMaskSurface(target) ? [Math.max(0, Math.min(1, sampled[0])) * draw.opacity, 0, 0, 1] :
            [sampled[0] * alpha * draw.opacity, sampled[1] * alpha * draw.opacity, sampled[2] * alpha * draw.opacity, sampled[3] * draw.opacity];
          target.setColor(frame, region.x, region.y, result);
          const stored = target.tile(region.x, region.y);
          if (stored) stored.signature = signature;
          continue;
        }
      }
      const tile = target.writable(frame, region.x, region.y, region.bounds, loadOp === 'load');
      const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: tile.view, loadOp, storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      this.scissor(pass, tile, target.bounds);
      for (const { draw, x, y, bounds } of region.draws) this.drawTile(pass, frame, draw, x, y, bounds, tile, target.format);
      pass.end();
      tile.signature = signature;
    }
  }

  private drawTile(pass: GPURenderPassEncoder, frame: GpuFrame, draw: QuadDraw, x: number, y: number, src: Rect, target: Tile, format: GPUTextureFormat): void {
    const { source, matrix, opacity, blend, straightAlpha, pointSampling } = draw;
    const [a, b, c, d, e, f] = matrix;
    const dst = target.bounds;
    const params = frame.uniform([
      a, c, e, 0, b, d, f, 0, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height,
      opacity, Number(straightAlpha), Number(isMaskSurface(source)), Number(format === MASK_FORMAT),
      x * TILE_SIZE, y * TILE_SIZE, source.scale, Number(pointSampling),
    ]);
    const pipeline = this.pipeline(format, blend);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: params }] }));
    pass.setBindGroup(1, this.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: neighborhoodEntries(frame, source, x, y) }));
    pass.draw(6);
  }

  private scissor(pass: GPURenderPassEncoder, tile: Tile, bounds: Rect): void {
    const clip = intersectBounds(tile.bounds, bounds)!;
    const x = Math.max(0, Math.round((clip.x - tile.bounds.x) * tile.scale)), y = Math.max(0, Math.round((clip.y - tile.bounds.y) * tile.scale));
    pass.setScissorRect(x, y, Math.min(TILE_SIZE - x, Math.round(clip.width * tile.scale)), Math.min(TILE_SIZE - y, Math.round(clip.height * tile.scale)));
  }

  present(frame: GpuFrame, source: Surface, view: GPUTextureView, bounds: Rect, opacity: number,
    framing: Rect, background: GPUColorDict, pointSampling = false, world: Matrix = IDENTITY): void {
    const [a, b, c, d, e, f] = world;
    const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: background }] });
    pass.setPipeline(this.presentation);
    const draw = (x: number, y: number, src: Rect, artwork: boolean) => {
      const params = frame.uniform([
        bounds.x, bounds.y, bounds.width, bounds.height, src.x, src.y, src.width, src.height,
        framing.x, framing.y, framing.width, framing.height, opacity, Number(isMaskSurface(source)), Number(artwork), Number(pointSampling),
        a, c, e, 0, b, d, f, 0, background.r, background.g, background.b, background.a, x * TILE_SIZE, y * TILE_SIZE, source.scale, 0,
      ]);
      pass.setBindGroup(0, this.gpu.device.createBindGroup({ layout: this.presentation.getBindGroupLayout(0), entries: [{ binding: 0, resource: params }] }));
      pass.setBindGroup(1, this.gpu.device.createBindGroup({ layout: this.presentation.getBindGroupLayout(1), entries: neighborhoodEntries(frame, source, x, y) }));
      pass.draw(6);
    };
    draw(0, 0, bounds, false);
    const visible = transformBounds(inverse(world), bounds);
    const tiles = isMaskSurface(source) ? planTiles(source, [visible]) : source.tiles;
    for (const tile of tiles.values()) {
      const clipped = intersectBounds(source.tileBounds(tile.x, tile.y), source.bounds);
      if (clipped && intersectBounds(clipped, visible)) draw(tile.x, tile.y, clipped, true);
    }
    pass.end();
  }
}
