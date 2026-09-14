import type { Gpu, GpuFrame } from './device';
import type { Surface } from './surface';
import { dispatchLocal } from './local';

const shader = `
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: vec4f;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let position = invocation.xy;
  storeDestination(vec2i(position), mix(loadSecondary(vec2i(position)), loadSource(vec2i(position)), params.x));
}`;

export class FilterMixer {
  constructor(_gpu: Gpu) {}

  encode(frame: GpuFrame, original: Surface, filtered: Surface, output: Surface, originalStrength: number): void {
    dispatchLocal(frame, original, output, {
      code: shader, label: 'Filter mix', parameters: [originalStrength, 0, 0, 0], secondary: filtered,
      regions: originalStrength === 1 ? original.regions : originalStrength === 0 ? filtered.regions : [...original.regions, ...filtered.regions],
    });
  }
}

