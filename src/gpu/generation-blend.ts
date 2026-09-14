import type { Matrix } from '../model/geometry';
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

  apply(generated: Surface, mask: Surface | null, maskTransform: Matrix): Surface {
    if (!mask) return generated.snapshot('Generated layer pixels');
    const output = createSurface('Generated layer pixels', generated.bounds, generated.scale);
    const frame = this.gpu.beginFrame();
    try {
      // Align the selection to the native output grid; never resample the generated image.
      const alignedMask = quads.region(frame, mask, output.bounds, output.scale, maskTransform);
      dispatchLocal(frame, generated, output, { code: shader, label: 'Apply generated pixels', parameters: [1, 0, 0, 0], secondary: alignedMask });
      frame.submit();
      return output;
    } catch (error) { output.destroy(); frame.release(); throw error; }
  }
}
