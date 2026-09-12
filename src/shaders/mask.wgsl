struct Params {
  row0: vec4f,
  row1: vec4f,
  maskBounds: vec4f,
  outputInfo: vec4f,
  mode: vec4f,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var maskImage: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= textureDimensions(destination))) { return; }
  let point = vec3f(params.outputInfo.xy + (vec2f(invocation.xy) + 0.5) / params.outputInfo.z, 1);
  let local = vec2f(dot(params.row0.xyz, point), dot(params.row1.xyz, point));
  let uv = (local - params.maskBounds.xy) / params.maskBounds.zw;
  var coverage = 0.0;
  if (all(uv >= vec2f(0)) && all(uv < vec2f(1))) {
    let pixel = textureSampleLevel(maskImage, imageSampler, uv, 0);
    coverage = clamp(select(pixel.a, pixel.r, params.outputInfo.w > 0.5), 0.0, 1.0);
  }
  coverage = select(coverage, 1.0 - coverage, params.mode.x > 0.5);
  textureStore(destination, vec2i(invocation.xy), textureLoad(source, vec2i(invocation.xy), 0) * coverage);
}
