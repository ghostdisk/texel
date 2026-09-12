struct Params {
  originalBounds: vec4f,
  filteredBounds: vec4f,
  outputBounds: vec4f,
  settings: vec4f,
}
@group(0) @binding(0) var originalImage: texture_2d<f32>;
@group(0) @binding(1) var filteredImage: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= textureDimensions(destination))) { return; }
  let point = params.outputBounds.xy + (vec2f(invocation.xy) + 0.5) / params.settings.y;
  let originalUV = (point - params.originalBounds.xy) / params.originalBounds.zw;
  let filteredUV = (point - params.filteredBounds.xy) / params.filteredBounds.zw;
  var original = vec4f(0);
  var filtered = vec4f(0);
  if (all(originalUV >= vec2f(0)) && all(originalUV < vec2f(1))) {
    original = textureSampleLevel(originalImage, imageSampler, originalUV, 0);
  }
  if (all(filteredUV >= vec2f(0)) && all(filteredUV < vec2f(1))) {
    filtered = textureSampleLevel(filteredImage, imageSampler, filteredUV, 0);
  }
  // Reapply the premultiplied input with strength 1 - filter Mix.
  textureStore(destination, vec2i(invocation.xy), mix(filtered, original, params.settings.x));
}

