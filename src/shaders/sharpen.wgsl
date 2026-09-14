struct Params {
  settings: vec4f,
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
  let centerPixel = loadSource(vec2i(position));
  if (centerPixel.a <= 0) { storeDestination(vec2i(position), vec4f(0)); return; }
  let blurPixel = loadSecondary(vec2i(position));
  let center = toSrgb(centerPixel.rgb / centerPixel.a);
  let soft = toSrgb(blurPixel.rgb / max(blurPixel.a, 0.00001));
  let detail = center - soft;
  let magnitude = max(abs(detail.r), max(abs(detail.g), abs(detail.b)));
  let adjusted = select(center, center + detail * params.settings.x, magnitude >= params.settings.y);
  storeDestination(vec2i(position), vec4f(toLinear(clamp(adjusted, vec3f(0), vec3f(1))) * centerPixel.a, centerPixel.a));
}
