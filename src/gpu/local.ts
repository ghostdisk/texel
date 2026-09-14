import { tileLoadShader } from './tile-sampling';
import type { Rect } from '../model/geometry';
import { expandBounds } from '../model/geometry';
import type { GpuFrame } from './device';
import { TILE_SIZE, planTiles, isMaskSurface } from './surface';
import type { Surface, Tile, TileRegion } from './surface';

/** Nine explicit bindings work on the baseline WebGPU sampled-texture limit. */
export function neighborhoodShader(group = 1): string {
  const bindings = Array.from({ length: 9 }, (_, index) => `@group(${group}) @binding(${index}) var neighbor${index}: texture_2d<f32>;`).join('\n');
  const cases = Array.from({ length: 9 }, (_, index) => `case ${index}: { return loadTile(neighbor${index}, pixel); }`).join('\n');
  return `${tileLoadShader}\n${bindings}
@group(${group}) @binding(9) var<uniform> neighborClip: vec4f;
fn loadNeighborhood(position: vec2i) -> vec4f {
  if (any(vec2f(position) < neighborClip.xy) || any(vec2f(position) >= neighborClip.zw)) { return vec4f(0); }
  let cell = vec2i(floor(vec2f(position) / ${TILE_SIZE}.0));
  if (any(cell < vec2i(-1)) || any(cell > vec2i(1))) { return vec4f(0); }
  let pixel = position - cell * ${TILE_SIZE};
  switch ((cell.y + 1) * 3 + cell.x + 1) { ${cases} default: { return vec4f(0); } }
}
fn sampleNeighborhood(position: vec2f, nearest: bool) -> vec4f {
  if (nearest) { return loadNeighborhood(vec2i(floor(position))); }
  let pixel = position - 0.5;
  let base = vec2i(floor(pixel));
  let fraction = fract(pixel);
  return mix(mix(loadNeighborhood(base), loadNeighborhood(base + vec2i(1, 0)), fraction.x),
    mix(loadNeighborhood(base + vec2i(0, 1)), loadNeighborhood(base + vec2i(1, 1)), fraction.x), fraction.y);
}`;
}

export function neighborhoodEntries(frame: GpuFrame, source: Surface, x: number, y: number): GPUBindGroupEntry[] {
  return [...Array.from({ length: 9 }, (_, index) => ({ binding: index, resource: source.view(x + index % 3 - 1, y + Math.floor(index / 3) - 1) })),
    { binding: 9, resource: frame.uniform(tileClip(source, { bounds: source.tileBounds(x, y) })) }];
}

export function neighborhoodRevision(source: Surface, x: number, y: number, radius = 1): number[] {
  const versions: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) versions.push(source.tile(x + dx, y + dy)?.revision ?? 0);
  return versions;
}

export interface LocalKernel {
  code: string;
  label: string;
  parameters: readonly number[] | ((tile: TileRegion) => readonly number[]);
  /** Sampling reach in physical pixels, bounded by one tile. */
  radius?: number;
  regions?: readonly Rect[];
  secondary?: Surface;
  workgroups?: readonly [number, number];
}

interface KernelPipeline {
  pipeline: GPUComputePipeline;
  id: number;
}

const pipelines = new Map<string, KernelPipeline>();

/** Shared sparse planning, dependency tracking, allocation and per-tile kernel dispatch. */
export function dispatchLocal(frame: GpuFrame, input: Surface, output: Surface, kernel: LocalKernel): void {
  const radius = kernel.radius ?? 0;
  if (!Number.isFinite(radius) || radius < 0 || Math.ceil(radius) > TILE_SIZE) throw new Error(`${kernel.label} exceeds the ${TILE_SIZE}px local-filter support radius.`);
  if (input.scale !== output.scale || kernel.secondary && kernel.secondary.scale !== output.scale) throw new Error('Local filter inputs must use the same pixel grid.');
  const neighbors = radius > 0;
  const scalar = isMaskSurface(input);
  const code = kernel.code;
  const convert = `if (any(vec2f(position) < inputClip.xy) || any(vec2f(position) >= inputClip.zw)) { return vec4f(0); } return ${scalar ? 'vec4f(pixel.rrr, 1)' : 'pixel'};`;
  const loads = '@group(0) @binding(10) var<uniform> inputClip: vec4f;\n' + (neighbors ?
    `${neighborhoodShader()}\nfn loadSource(position: vec2i) -> vec4f { let pixel = loadNeighborhood(position); ${convert} }` :
    `${tileLoadShader}\n@group(1) @binding(0) var center: texture_2d<f32>;\nfn loadSource(position: vec2i) -> vec4f { let pixel = loadTile(center, position); ${convert} }`);
  const secondary = kernel.secondary ? `
@group(0) @binding(12) var secondaryImage: texture_2d<f32>;
@group(0) @binding(13) var<uniform> secondaryClip: vec4f;
fn loadSecondary(position: vec2i) -> vec4f {
  if (any(vec2f(position) < secondaryClip.xy) || any(vec2f(position) >= secondaryClip.zw)) { return vec4f(0); }
  return loadTile(secondaryImage, position);
}
` : '';
  const compiled = `${loads}\n${secondary}
@group(0) @binding(11) var<uniform> tileClip: vec4f;
fn storeDestination(position: vec2i, color: vec4f) {
  let pixel = vec2f(position) + 0.5;
  let inside = all(pixel >= tileClip.xy) && all(pixel < tileClip.zw);
  textureStore(destination, position, select(vec4f(0), color, inside));
}
${code}`;
  const cache = pipelines;
  let cached = cache.get(compiled);
  if (!cached) {
    cached = { id: cache.size + 1, pipeline: frame.gpu.device.createComputePipeline({
      label: kernel.label, layout: 'auto', compute: { module: frame.gpu.device.createShaderModule({ code: compiled }), entryPoint: 'main' },
    }) };
    cache.set(compiled, cached);
  }
  const { pipeline, id } = cached;
  const regions = kernel.regions ?? input.regions;
  const planned = planTiles(output, regions);
  output.retain(new Set(planned.keys()), frame);
  const sharedParameters = typeof kernel.parameters === 'function' ? null : frame.uniform(kernel.parameters);
  for (const [key, region] of planned) {
    const { x, y, bounds } = region;
    const values = typeof kernel.parameters === 'function' ? kernel.parameters(region) : kernel.parameters;
    const signature = JSON.stringify([id, values, bounds, input.bounds, kernel.secondary?.bounds, neighborhoodRevision(input, x, y, Number(neighbors)), kernel.secondary?.tile(x, y)?.revision ?? 0]);
    if (output.tiles.get(key)?.signature === signature) continue;
    const tile = output.writable(frame, x, y, bounds);
    const clip = tileClip(output, tile);
    const entries: GPUBindGroupEntry[] = [
      { binding: 1, resource: tile.view }, { binding: 2, resource: sharedParameters ?? frame.uniform(values) }, { binding: 11, resource: frame.uniform(clip) },
    ];
    entries.push({ binding: 10, resource: frame.uniform(tileClip(input, tile)) });
    if (kernel.secondary) entries.push({ binding: 12, resource: kernel.secondary.view(x, y) }, { binding: 13, resource: frame.uniform(tileClip(kernel.secondary, tile)) });
    const pass = frame.encoder.beginComputePass({ label: kernel.label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, frame.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.setBindGroup(1, frame.gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries:
      neighbors ? neighborhoodEntries(frame, input, x, y) : [{ binding: 0, resource: input.view(x, y) }],
    }));
    pass.dispatchWorkgroups(...(kernel.workgroups ?? [TILE_SIZE / 8, TILE_SIZE / 8]));
    pass.end();
    tile.signature = signature;
  }
}

export function tileClip(surface: Surface, tile: Pick<Tile, 'bounds'>): number[] {
  return [(surface.bounds.x - tile.bounds.x) * surface.scale, (surface.bounds.y - tile.bounds.y) * surface.scale,
    (surface.bounds.x + surface.bounds.width - tile.bounds.x) * surface.scale, (surface.bounds.y + surface.bounds.height - tile.bounds.y) * surface.scale];
}

export function expandedRegions(input: Surface, radius: number): Rect[] { return input.regions.map((bounds) => expandBounds(bounds, radius)); }
