struct Params {
  size: vec4f,
  settings: vec4f,
}
@group(0) @binding(0) var selection: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (any(id.xy >= size)) { return; }
  var coverage = 1.0;
  if (params.settings.y > 0.5) { coverage = clamp(textureLoad(selection, id.xy, 0).r, 0.0, 1.0); }
  if (params.settings.x > 0.0) {
    let edge = min(vec2f(id.xy), vec2f(size - vec2u(1) - id.xy)) * params.size.zw / vec2f(size);
    coverage *= smoothstep(0.0, params.settings.x, min(edge.x, edge.y));
  }
  textureStore(destination, id.xy, vec4f(vec3f(coverage), 1));
}