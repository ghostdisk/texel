struct Params {
  mask: f32,
  transparent: f32,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(source))) { return; }
  let pixel = textureLoad(source, id.xy, 0);
  var color = vec3f(clamp(pixel.r, 0.0, 1.0));
  var alpha = 1.0;
  if (params.mask < 0.5) {
    var linear = max(pixel.rgb + vec3f(1.0 - pixel.a), vec3f(0));
    if (params.transparent > 0.5) {
      alpha = clamp(pixel.a, 0.0, 1.0);
      linear = vec3f(0);
      if (pixel.a > 0.0) { linear = max(pixel.rgb / pixel.a, vec3f(0)); }
    }
    color = select(1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055, linear * 12.92, linear <= vec3f(0.0031308));
  }
  textureStore(destination, id.xy, vec4f(clamp(color, vec3f(0), vec3f(1)), alpha));
}
