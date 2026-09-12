struct Params {
  values: vec4f,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;
@group(0) @binding(2) var<uniform> params: Params;

fn toSrgb(value: vec3f) -> vec3f {
  return select(1.055 * pow(max(value, vec3f(0)), vec3f(1.0 / 2.4)) - 0.055, value * 12.92, value <= vec3f(0.0031308));
}

@compute @workgroup_size(1)
fn main() {
  let position = vec2i(floor(params.values.xy));
  let size = vec2i(textureDimensions(source));
  var color = vec4f(0);
  if (all(position >= vec2i(0)) && all(position < size)) {
    var pixel = textureLoad(source, position, 0);
    if (params.values.w > 0.5) { pixel = vec4f(vec3f(clamp(pixel.r, 0.0, 1.0)), 1); }
    if (pixel.a > 0.0) { color = vec4f(clamp(toSrgb(pixel.rgb / pixel.a), vec3f(0), vec3f(1)), pixel.a); }
  }
  results[u32(params.values.z)] = color;
}