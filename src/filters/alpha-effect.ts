import dilationShader from '../shaders/dilate-alpha.wgsl?raw';
import { dispatchLocal, expandedRegions } from '../gpu/local';
import type { Surface } from '../gpu/surface';
import type { Point, Rect } from '../model/geometry';
import { unionBounds } from '../model/geometry';
import type { FilterRenderContext } from './filter';

export function dilateAlpha(context: FilterRenderContext, input: Surface, output: Surface, radius: number): void {
  dispatchLocal(context.frame, input, output, {
    code: dilationShader, label: 'Round alpha border', parameters: [radius, 0, 0, 0], radius,
    regions: expandedRegions(input, Math.ceil(radius) / input.scale),
  });
}

const behindShader = `
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: array<vec4f, 2>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let position = invocation.xy;
  let original = loadSource(vec2i(position));
  let maskAlpha = loadSecondary(vec2i(position)).a;
  let coverage = select(maskAlpha * (1 - original.a), max(0.0, maskAlpha - original.a), params[1].x > 0.5);
  let alpha = coverage * params[0].a;
  storeDestination(vec2i(position), original + vec4f(params[0].rgb * alpha, alpha));
}`;

export function renderBehind(context: FilterRenderContext, source: Surface, mask: Surface, bounds: Rect,
  color: string, opacity: number, offset: Point = { x: 0, y: 0 }, outline = false): Surface {
  const output = context.surface('result', bounds, source.scale);
  const aligned = context.surface('effect-aligned', bounds, source.scale);
  const pass = context.quads.begin(context.frame, aligned);
  context.quads.draw(pass, context.frame, mask, aligned, [1, 0, 0, 1, offset.x, offset.y]);
  pass.end();
  const rgb = [1, 3, 5].map((index) => {
    const value = parseInt(color.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  dispatchLocal(context.frame, source, output, {
    code: behindShader, label: 'Composite alpha effect', parameters: [...rgb, opacity, Number(outline), 0, 0, 0],
    secondary: aligned, regions: [...source.regions, ...aligned.regions],
  });
  return output;
}

