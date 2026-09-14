struct Params {
  settings: vec4f,
}
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let size = vec2i(textureDimensions(destination));
  let position = vec2i(invocation.xy);
  if (any(position >= size)) { return; }
  let radius = i32(ceil(params.settings.x));
  var alpha = 0.0;
  for (var y = -radius; y <= radius; y++) {
    for (var x = -radius; x <= radius; x++) {
      let coverage = clamp(params.settings.x + 1.0 - length(vec2f(f32(x), f32(y))), 0.0, 1.0);
      if (coverage == 0.0) { continue; }
      let neighbor = position + vec2i(x, y);
      alpha = max(alpha, loadSource(vec2i(neighbor)).a * coverage);
    }
  }
  storeDestination(vec2i(position), vec4f(0, 0, 0, alpha));
}
