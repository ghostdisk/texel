struct Params {
  values: array<vec4f, 2>,
}

@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: Params;

fn toSrgb(color: vec3f) -> vec3f {
  let value = max(color, vec3f(0));
  return select(1.055 * pow(value, vec3f(1.0 / 2.4)) - 0.055, value * 12.92, value <= vec3f(0.0031308));
}

fn toLinear(color: vec3f) -> vec3f {
  return select(pow((color + 0.055) / 1.055, vec3f(2.4)), color / 12.92, color <= vec3f(0.04045));
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let position = invocation.xy;
  if (any(position >= textureDimensions(destination))) { return; }
  let pixel = loadSource(vec2i(position));
  if (params.values[0].x > 0.5) {
    // Masks contain scalar coverage, so their midpoint remains 0.5.
    let value = 1.0 - clamp(pixel.r, 0.0, 1.0);
    storeDestination(vec2i(position), vec4f(vec3f(value), 1));
    return;
  }
  if (pixel.a <= 0) {
    storeDestination(vec2i(position), vec4f(0));
    return;
  }
  let color = clamp(toSrgb(pixel.rgb / pixel.a), vec3f(0), vec3f(1));
  let inverted = toLinear(vec3f(1) - color);
  storeDestination(vec2i(position), vec4f(inverted * pixel.a, pixel.a));
}
