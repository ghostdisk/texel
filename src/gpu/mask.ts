import { inverse, transformBounds } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import type { Gpu, GpuFrame } from './device';
import { isMaskSurface, intersectBounds, planTiles } from './surface';
import type { Surface } from './surface';
import { quads } from './quad';
import { dispatchLocal } from './local';

export interface MaskInput {
  surface: Surface;
  /** Maps the receiving layer's local coordinates into the mask layer. */
  transform: Matrix;
}

const shader = `
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: vec4f;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let position = invocation.xy;
  let mask = loadSecondary(vec2i(position));
  var coverage = clamp(select(mask.a, mask.r, params.x > 0.5), 0.0, 1.0);
  coverage = select(coverage, 1.0 - coverage, params.y > 0.5);
  storeDestination(vec2i(position), loadSource(vec2i(position)) * coverage);
}`;

export class MaskRenderer {
  constructor(_gpu: Gpu) {}

  encode(frame: GpuFrame, input: Surface, output: Surface, mask: MaskInput, invert = false): void {
    const aligned = output.scratch(frame, 'aligned-mask', output.bounds, output.scale, mask.surface.format);
    const pass = quads.begin(frame, aligned);
    quads.draw(pass, frame, mask.surface, aligned, inverse(mask.transform));
    pass.end();
    dispatchLocal(frame, input, output, { code: shader, label: 'Layer mask',
      parameters: [Number(isMaskSurface(mask.surface)), Number(invert), 0, 0], secondary: aligned, regions: input.regions });
  }
}


/** Prove a whole region has constant selection coverage without sampling resident pixels. */
export function uniformMaskCoverage(mask: MaskInput | null, bounds: Rect): number | null {
  if (!mask) return 1;
  const { surface, transform } = mask;
  if (transform[1] !== 0 || transform[2] !== 0) return null;
  const local = transformBounds(transform, bounds), clipped = intersectBounds(local, surface.bounds);
  if (!clipped) return 0;
  if (clipped.x !== local.x || clipped.y !== local.y || clipped.width !== local.width || clipped.height !== local.height) return null;
  let coverage: number | undefined;
  for (const { x, y } of planTiles(surface, [local]).values()) {
    const color = surface.solidColor(x, y);
    if (!color) return null;
    const value = Math.max(0, Math.min(1, color[isMaskSurface(surface) ? 0 : 3]));
    if (coverage !== undefined && value !== coverage) return null;
    coverage = value;
  }
  return coverage ?? 0;
}
