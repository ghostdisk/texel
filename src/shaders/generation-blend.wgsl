struct Params {
  hasMask: f32,
}
@group(0) @binding(0) var generated: texture_2d<f32>;
@group(0) @binding(1) var selection: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let pixel = textureSampleLevel(generated, imageSampler, uv, 0);
  var coverage = 1.0;
  if (params.hasMask > 0.5) { coverage = clamp(textureLoad(selection, id.xy, 0).r, 0.0, 1.0); }
  textureStore(destination, id.xy, pixel * coverage);
}