struct Params {
  sourceBounds: vec4f,
  maskBounds: vec4f,
  outputBounds: vec4f,
  color: vec4f,
  settings: vec4f,
}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var maskImage: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= textureDimensions(destination))) { return; }
  let position = params.outputBounds.xy + (vec2f(invocation.xy) + 0.5) / params.settings.z;
  let sourceUV = (position - params.sourceBounds.xy) / params.sourceBounds.zw;
  let maskUV = (position - params.settings.xy - params.maskBounds.xy) / params.maskBounds.zw;
  var original = vec4f(0);
  var maskAlpha = 0.0;
  if (all(sourceUV >= vec2f(0)) && all(sourceUV < vec2f(1))) {
    original = textureSampleLevel(source, imageSampler, sourceUV, 0);
  }
  if (all(maskUV >= vec2f(0)) && all(maskUV < vec2f(1))) {
    maskAlpha = textureSampleLevel(maskImage, imageSampler, maskUV, 0).a;
  }
  var coverage = maskAlpha * (1.0 - original.a);
  if (params.settings.w > 0.5) {
    // The outer border fills the dilation's missing coverage. Subtracting the
    // source already excludes its coverage; source-over would attenuate it twice.
    coverage = max(0.0, maskAlpha - original.a);
  }
  let alpha = coverage * params.color.a;
  textureStore(destination, vec2i(invocation.xy), original + vec4f(params.color.rgb * alpha, alpha));
}

