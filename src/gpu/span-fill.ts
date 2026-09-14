import shader from '../shaders/span-fill.wgsl?raw';
import { inverse } from '../model/geometry';
import type { Point } from '../model/geometry';
import type { Gpu, GpuFrame } from './device';
import { uniformMaskCoverage } from './mask';
import type { MaskInput } from './mask';
import { createSurface, intersectBounds, isMaskSurface, TILE_SIZE, tileKey, tilePool, WORKING_FORMAT } from './surface';
import type { Surface, TileColor, TileResource } from './surface';
import { tileLoadShader } from './tile-sampling';
import { quads } from './quad';

const EDGE_WORDS = TILE_SIZE * 4 / 32;
const WORDS_PER_EDGE = TILE_SIZE / 32;
const SUMMARY_WORDS = EDGE_WORDS + 5;
const EMPTY_EDGES = new Uint32Array(EDGE_WORDS);
// Shared with seedComponents: whole edges followed by individual corners.
const LEFT = 1, RIGHT = 2, TOP = 4, BOTTOM = 8;
const TOP_LEFT = 16, TOP_RIGHT = 32, BOTTOM_LEFT = 64, BOTTOM_RIGHT = 128;
const WHITE: TileColor = [1, 1, 1, 1];

interface FillTile {
  x: number;
  y: number;
  incoming: Uint32Array<ArrayBuffer> | null;
  outgoing: Uint32Array | null;
  entries: number;
  seed: boolean;
  queued: boolean;
  complete: boolean;
}

interface FillSeed {
  color: TileColor;
  pixel: TileColor;
  selected: boolean;
}

/** One bounded GPU workspace is reused for every resident chunk, including revisits. */
class FillScratch {
  readonly params: GPUBuffer;
  readonly parents: GPUBuffer;
  readonly reached: GPUBuffer;
  readonly entries: GPUBuffer;
  readonly summary: GPUBuffer;
  readonly readback: GPUBuffer;
  readonly coverage: TileResource;

  constructor(gpu: Gpu) {
    const { device } = gpu;
    this.params = device.createBuffer({ label: 'Fill parameters', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.parents = device.createBuffer({ label: 'Fill component labels', size: TILE_SIZE * TILE_SIZE * 4, usage: GPUBufferUsage.STORAGE });
    this.reached = device.createBuffer({ label: 'Fill reached components', size: TILE_SIZE * TILE_SIZE / 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.entries = device.createBuffer({ label: 'Fill incoming edges', size: EDGE_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.summary = device.createBuffer({ label: 'Fill outgoing edges and bounds', size: SUMMARY_WORDS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.readback = device.createBuffer({ size: SUMMARY_WORDS * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.coverage = tilePool.acquire(WORKING_FORMAT);
  }

  async read(signal: AbortSignal): Promise<Uint32Array<ArrayBuffer>> {
    await this.readback.mapAsync(GPUMapMode.READ);
    try { signal.throwIfAborted(); return new Uint32Array(this.readback.getMappedRange().slice(0)); }
    finally { this.readback.unmap(); }
  }

  destroy(): void {
    this.params.destroy();
    this.parents.destroy();
    this.reached.destroy();
    this.entries.destroy();
    this.summary.destroy();
    this.readback.destroy();
    tilePool.release(this.coverage);
  }
}

/** Chunk graph traversal; resident connectivity stays on the GPU, only edge bitsets cross to the CPU. */
export class SpanFill {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: Record<string, GPUComputePipeline>;

  constructor(private readonly gpu: Gpu) {
    const { device } = gpu;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: {} },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: {} },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: WORKING_FORMAT } },
    ] });
    const module = device.createShaderModule({ label: 'Chunk fill connectivity', code: tileLoadShader + shader });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipelines = Object.fromEntries(['sampleSeed', 'initialize', 'connect', 'seedComponents', 'coverage'].map((entryPoint) =>
      [entryPoint, device.createComputePipeline({ label: 'Fill: ' + entryPoint, layout, compute: { module, entryPoint } })]));
  }

  async region(source: Surface, point: Point, tolerance: number, contiguous: boolean, selection: MaskInput | null, signal: AbortSignal): Promise<Surface> {
    if (source.scale !== 1 || source.bounds.x !== 0 || source.bounds.y !== 0) throw new Error('Bucket fill requires native layer pixel coordinates.');
    const output = createSurface('Fill coverage', source.bounds);
    if (point.x < 0 || point.y < 0 || point.x >= source.width || point.y >= source.height) return output;
    const seedX = Math.floor(point.x / TILE_SIZE), seedY = Math.floor(point.y / TILE_SIZE);
    const tiles = new Map<string, FillTile>(), order: FillTile[] = [];
    let scratch: FillScratch | null = null;
    let yieldChannel: MessageChannel | null = null;
    let frame = this.gpu.beginFrame();
    const workspace = () => scratch ??= new FillScratch(this.gpu);
    const getTile = (x: number, y: number): FillTile | null => {
      if (x < 0 || y < 0 || x * TILE_SIZE >= source.width || y * TILE_SIZE >= source.height) return null;
      const key = tileKey(x, y);
      let tile = tiles.get(key);
      if (!tile) {
        tile = { x, y, incoming: null, outgoing: null, entries: 0, seed: false, queued: false, complete: false };
        tiles.set(key, tile);
      }
      return tile;
    };
    const schedule = (tile: FillTile) => { if (!tile.queued && !tile.complete) { tile.queued = true; order.push(tile); } };
    const enter = (x: number, y: number, entry: number) => {
      const tile = getTile(x, y);
      if (!tile || tile.complete || (tile.entries & entry) !== 0) return;
      tile.entries |= entry;
      schedule(tile);
    };
    const forwardSolid = (tile: FillTile) => {
      enter(tile.x - 1, tile.y, RIGHT);
      enter(tile.x + 1, tile.y, LEFT);
      enter(tile.x, tile.y - 1, BOTTOM);
      enter(tile.x, tile.y + 1, TOP);
      enter(tile.x - 1, tile.y - 1, BOTTOM_RIGHT);
      enter(tile.x + 1, tile.y - 1, BOTTOM_LEFT);
      enter(tile.x - 1, tile.y + 1, TOP_RIGHT);
      enter(tile.x + 1, tile.y + 1, TOP_LEFT);
    };
    const forwardEdge = (tile: FillTile, edges: Uint32Array, from: number, to: number, x: number, y: number) => {
      const start = from * WORDS_PER_EDGE, targetStart = to * WORDS_PER_EDGE;
      let target: FillTile | null = null;
      for (let word = 0; word < WORDS_PER_EDGE; word++) {
        const index = start + word;
        const fresh = edges[index] & ~(tile.outgoing?.[index] ?? 0);
        const previous = word > 0 ? edges[index - 1] & ~(tile.outgoing?.[index - 1] ?? 0) : 0;
        const next = word + 1 < WORDS_PER_EDGE ? edges[index + 1] & ~(tile.outgoing?.[index + 1] ?? 0) : 0;
        // Include diagonal pixel neighbors, carrying across 32-bit word boundaries.
        const incoming = fresh | (fresh << 1) | (fresh >>> 1) | (previous >>> 31) | (next << 31);
        if (incoming === 0) continue;
        target ??= getTile(x, y);
        if (!target || target.complete || (target.entries & (1 << to)) !== 0) return;
        target.incoming ??= new Uint32Array(EDGE_WORDS);
        const targetIndex = targetStart + word;
        if ((incoming & ~target.incoming[targetIndex] & ~(target.outgoing?.[targetIndex] ?? 0)) === 0) continue;
        target.incoming[targetIndex] |= incoming;
        schedule(target);
      }
    };
    const forward = (tile: FillTile, edges: Uint32Array, height: number) => {
      forwardEdge(tile, edges, 0, 1, tile.x - 1, tile.y);
      forwardEdge(tile, edges, 1, 0, tile.x + 1, tile.y);
      forwardEdge(tile, edges, 2, 3, tile.x, tile.y - 1);
      forwardEdge(tile, edges, 3, 2, tile.x, tile.y + 1);
      const fresh = (edge: number) => bit(edges, edge) && !bit(tile.outgoing ?? EMPTY_EDGES, edge);
      if (fresh(0)) enter(tile.x - 1, tile.y - 1, BOTTOM_RIGHT);
      if (fresh(TILE_SIZE)) enter(tile.x + 1, tile.y - 1, BOTTOM_LEFT);
      if (fresh(height - 1)) enter(tile.x - 1, tile.y + 1, TOP_RIGHT);
      if (fresh(TILE_SIZE + height - 1)) enter(tile.x + 1, tile.y + 1, TOP_LEFT);
      tile.outgoing = edges.subarray(0, EDGE_WORDS);
    };
    try {
      signal.throwIfAborted();
      const known = source.solidColor(seedX, seedY);
      const selected = uniformMaskCoverage(selection, { x: point.x, y: point.y, width: 1, height: 1 });
      const seed: FillSeed = known && selected !== null ? { color: comparisonColor(known, isMaskSurface(source)), pixel: canonicalPixel(known, isMaskSurface(source)), selected: selected > 0 } :
        await this.sampleSeed(source, point, selection, workspace(), signal);
      if (!seed.selected) return output;
      if (contiguous) { const tile = getTile(seedX, seedY)!; tile.seed = true; schedule(tile); }
      else {
        for (let y = 0; y < Math.ceil(source.height / TILE_SIZE); y++) for (let x = 0; x < Math.ceil(source.width / TILE_SIZE); x++) schedule(getTile(x, y)!);
      }
      let yieldAt = performance.now() + 8;
      for (let cursor = 0; cursor < order.length; cursor++) {
        signal.throwIfAborted();
        const tile = order[cursor];
        tile.queued = false;
        const bounds = intersectBounds(source.tileBounds(tile.x, tile.y), source.bounds)!;
        const width = Math.round(bounds.width), height = Math.round(bounds.height);
        const color = source.solidColor(tile.x, tile.y);
        const coverage = uniformMaskCoverage(selection, bounds);
        if (color && coverage !== null) {
          tile.complete = true;
          const exact = canonicalPixel(color, isMaskSurface(source)).every((value, channel) => value === seed.pixel[channel]);
          const matches = exact || comparisonColor(color, isMaskSurface(source)).every((value, channel) => Math.abs(Math.fround(value - seed.color[channel])) <= Math.fround(tolerance));
          if (coverage > 0 && matches) {
            output.setColor(frame, tile.x, tile.y, WHITE);
            if (contiguous) forwardSolid(tile);
          }
        } else {
          // Submit previous copies before the workspace texture is reused.
          frame.submit();
          frame = this.gpu.beginFrame();
          const work = workspace();
          const summary = await this.fillTile(source, tile, point, seed, tolerance, contiguous, selection, work, signal);
          yieldAt = performance.now() + 8;
          const count = summary[EDGE_WORDS + 4];
          if (count === width * height) { output.setColor(frame, tile.x, tile.y, WHITE); tile.complete = true; }
          else if (count > 0) {
            const [left, top, right, bottom] = summary.subarray(EDGE_WORDS, EDGE_WORDS + 4);
            const content = { x: bounds.x + left, y: bounds.y + top, width: right - left, height: bottom - top };
            const target = output.writable(frame, tile.x, tile.y, content, false, false);
            frame.encoder.copyTextureToTexture({ texture: work.coverage.texture }, { texture: target.texture }, [TILE_SIZE, TILE_SIZE]);
          }
          if (contiguous) {
            if (tile.complete) forwardSolid(tile);
            else forward(tile, summary, height);
          }
        }
        // Yield only after a CPU time slice, without the nested-timer minimum delay.
        if (cursor % 32 === 31 && performance.now() >= yieldAt) {
          yieldChannel ??= new MessageChannel();
          const channel = yieldChannel;
          await new Promise<void>((resolve) => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); });
          yieldAt = performance.now() + 8;
        }
      }
      signal.throwIfAborted();
      frame.submit();
      return output;
    } catch (error) { output.destroy(); throw error; }
    finally {
      frame.release();
      (scratch as FillScratch | null)?.destroy();
      yieldChannel?.port1.close();
      yieldChannel?.port2.close();
    }
  }

  private bindings(frame: GpuFrame, source: Surface, x: number, y: number, selection: MaskInput | null, scratch: FillScratch, values: readonly number[]): GPUBindGroup {
    const mask = selection ? quads.region(frame, selection.surface, source.tileBounds(x, y), 1, inverse(selection.transform)) : source;
    this.gpu.device.queue.writeBuffer(scratch.params, 0, new Float32Array(values));
    return this.gpu.device.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: source.view(x, y) }, { binding: 1, resource: mask.view(x, y) }, { binding: 2, resource: { buffer: scratch.params } },
      { binding: 3, resource: { buffer: scratch.parents } }, { binding: 4, resource: { buffer: scratch.reached } },
      { binding: 5, resource: { buffer: scratch.entries } }, { binding: 6, resource: { buffer: scratch.summary } },
      { binding: 7, resource: scratch.coverage.view },
    ] });
  }

  private async sampleSeed(source: Surface, point: Point, selection: MaskInput | null, scratch: FillScratch, signal: AbortSignal): Promise<FillSeed> {
    const x = Math.floor(point.x / TILE_SIZE), y = Math.floor(point.y / TILE_SIZE), frame = this.gpu.beginFrame();
    try {
      const bindGroup = this.bindings(frame, source, x, y, selection, scratch, [
        TILE_SIZE, TILE_SIZE, point.x % TILE_SIZE, point.y % TILE_SIZE, 0, Number(isMaskSurface(source)), Number(!!selection), Number(!!selection && isMaskSurface(selection.surface)),
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(this.pipelines.sampleSeed);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      frame.encoder.copyBufferToBuffer(scratch.summary, 0, scratch.readback, 0, SUMMARY_WORDS * 4);
      frame.submit();
      const words = await scratch.read(signal), values = new Float32Array(words.buffer);
      return { color: [values[0], values[1], values[2], values[3]], pixel: [values[5], values[6], values[7], values[8]], selected: words[4] !== 0 };
    } finally { frame.release(); }
  }

  private async fillTile(source: Surface, tile: FillTile, point: Point, seed: FillSeed, tolerance: number, contiguous: boolean,
    selection: MaskInput | null, scratch: FillScratch, signal: AbortSignal): Promise<Uint32Array<ArrayBuffer>> {
    const width = Math.min(TILE_SIZE, source.width - tile.x * TILE_SIZE), height = Math.min(TILE_SIZE, source.height - tile.y * TILE_SIZE);
    const initial = new Uint32Array(SUMMARY_WORDS);
    initial[EDGE_WORDS] = width;
    initial[EDGE_WORDS + 1] = height;
    this.gpu.device.queue.writeBuffer(scratch.entries, 0, tile.incoming ?? EMPTY_EDGES);
    this.gpu.device.queue.writeBuffer(scratch.summary, 0, initial);
    const frame = this.gpu.beginFrame();
    try {
      const bindGroup = this.bindings(frame, source, tile.x, tile.y, selection, scratch, [
        width, height, 0, 0, tolerance, Number(isMaskSurface(source)), Number(!!selection), Number(!!selection && isMaskSurface(selection.surface)), ...seed.color,
        tile.seed ? point.y % TILE_SIZE * TILE_SIZE + point.x % TILE_SIZE : -1, Number(contiguous), tile.entries, 0, ...seed.pixel,
      ]);
      frame.encoder.clearBuffer(scratch.reached);
      const pass = frame.encoder.beginComputePass();
      pass.setBindGroup(0, bindGroup);
      for (const step of contiguous ? ['initialize', 'connect', 'seedComponents', 'coverage'] : ['initialize', 'seedComponents', 'coverage']) {
        pass.setPipeline(this.pipelines[step]);
        pass.dispatchWorkgroups(TILE_SIZE / 8, TILE_SIZE / 8);
      }
      pass.end();
      frame.encoder.copyBufferToBuffer(scratch.summary, 0, scratch.readback, 0, SUMMARY_WORDS * 4);
      frame.submit();
      return await scratch.read(signal);
    } finally { frame.release(); }
  }
}

function bit(words: Uint32Array, index: number): boolean { return ((words[index >>> 5] >>> (index & 31)) & 1) !== 0; }

function comparisonColor(pixel: TileColor, scalar: boolean): TileColor {
  if (scalar) return [pixel[0], pixel[0], pixel[0], 1];
  if (pixel[3] <= 0) return [0, 0, 0, 0];
  const srgb = (channel: number) => {
    const value = Math.max(0, pixel[channel] / pixel[3]);
    return Math.fround(Math.max(0, Math.min(1, value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055)));
  };
  return [srgb(0), srgb(1), srgb(2), pixel[3]];
}

function canonicalPixel(pixel: TileColor, scalar: boolean): TileColor { return scalar ? [pixel[0], 0, 0, 1] : pixel; }
