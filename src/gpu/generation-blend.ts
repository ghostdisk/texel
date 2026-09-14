import type { GenerationFrame } from '../generation/lens';
import { createSurface } from './surface';
import type { Surface } from './surface';
import type { Gpu } from './device';
import { quads } from './quad';
import { dispatchLocal } from './local';

const shader = `
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: vec4f;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let position = invocation.xy;
  let coverage = select(1.0, clamp(loadSecondary(vec2i(position)).r, 0.0, 1.0), params.x > 0.5);
  storeDestination(vec2i(position), loadSource(vec2i(position)) * coverage);
}`;

export class GenerationBlend {
  constructor(private readonly gpu: Gpu) {}

  apply(generated: Surface, target: GenerationFrame, mask: Surface | null): Surface {
    const output = createSurface('Generated layer pixels', { x: 0, y: 0, width: target.width, height: target.height });
    const frame = this.gpu.beginFrame();
    try {
      const sx = target.width / generated.bounds.width, sy = target.height / generated.bounds.height;
      const resized = quads.region(frame, generated, output.bounds, 1, [sx, 0, 0, sy, -generated.bounds.x * sx, -generated.bounds.y * sy]);
      dispatchLocal(frame, resized, output, { code: shader, label: 'Apply generated pixels', parameters: [Number(!!mask), 0, 0, 0], secondary: mask ?? resized });
      frame.submit();
      return output;
    } catch (error) { output.destroy(); frame.release(); throw error; }
  }
}
