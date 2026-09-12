const SINGLE_CHANNEL = false;
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var destination: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let size = vec2f(textureDimensions(source));
  let fit = size / max(size.x, size.y);
  let uv = ((vec2f(invocation.xy) + 0.5) / 64.0 - 0.5) / fit + 0.5;
  var result = vec4f(0);
  if (all(uv >= vec2f(0)) && all(uv < vec2f(1))) {
    var pixel = textureSampleLevel(source, imageSampler, uv, 0);
    if (SINGLE_CHANNEL) { pixel = vec4f(vec3f(clamp(pixel.r, 0.0, 1.0)), 1); }
    if (pixel.a > 0.0) {
      let value = max(pixel.rgb / pixel.a, vec3f(0));
      let rgb = select(1.055 * pow(value, vec3f(1.0 / 2.4)) - 0.055, value * 12.92, value <= vec3f(0.0031308));
      result = vec4f(rgb, pixel.a);
    }
  }
  textureStore(destination, vec2i(invocation.xy), result);
}