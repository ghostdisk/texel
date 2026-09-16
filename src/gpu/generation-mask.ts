import type { GenerationFrame } from '../generation/lens';
import type { Gpu } from './device';
import { createSurface, TILE_SIZE } from './surface';
import type { Surface } from './surface';
import { dispatchLocal } from './local';

const shader = `
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: array<vec4f, 3>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let position = invocation.xy;
  let pixel = vec2f(position) + params[2].xy;
  var coverage = 1.0;
  if (params[1].y > 0.5) { coverage = clamp(loadSource(vec2i(position)).r, 0.0, 1.0); }
  let edge = min(pixel, params[0].xy - vec2f(1) - pixel) * params[0].zw / params[0].xy;
  coverage *= smoothstep(0.0, params[1].x, min(edge.x, edge.y));
  storeDestination(vec2i(position), vec4f(coverage));
}`;

export class GenerationMask {
  constructor(private readonly gpu: Gpu) {}

  create(selection: Surface | null, target: GenerationFrame, feather: number, fallback: Surface): Surface | null {
    if (feather <= 0) return selection;
    const output = createSurface('Feathered generation mask', { x: 0, y: 0, width: target.width, height: target.height });
    const frame = this.gpu.beginFrame();
    try {
      dispatchLocal(frame, selection ?? fallback, output, {
        code: shader, label: 'Feather generation mask', regions: selection ? selection.regions : [output.bounds],
        parameters: ({ x, y }) => [target.width, target.height, target.canonicalWidth, target.canonicalHeight,
          feather, Number(!!selection), 0, 0, x * TILE_SIZE, y * TILE_SIZE, 0, 0],
      });
      frame.submit();
      return output;
    } catch (error) { output.destroy(); frame.release(); throw error; }
  }
}
