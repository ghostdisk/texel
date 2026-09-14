struct Params {
  targetSize: vec4f,
  sourceRow0: vec4f,
  sourceRow1: vec4f,
  sourceBounds: vec4f,
  destinationBounds: vec4f,
  selectionRow0: vec4f,
  selectionRow1: vec4f,
  selectionBounds: vec4f,
  flags: vec4f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sourceImage: texture_2d<f32>;
@group(0) @binding(2) var sourceBlurImage: texture_2d<f32>;
@group(0) @binding(3) var destinationBlurImage: texture_2d<f32>;
@group(0) @binding(4) var selectionImage: texture_2d<f32>;
@group(0) @binding(5) var imageSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) pixel: vec2f,
  @location(2) hardness: f32,
  @location(3) flow: f32,
}

@vertex fn vertexMain(
  @builtin(vertex_index) index: u32,
  @location(0) stamp: vec4f,
  @location(1) brush: vec4f,
) -> VertexOutput {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let local = corners[index];
  let pixel = stamp.xy + local * stamp.z;
  let clip = (pixel - params.targetSize.zw) / params.targetSize.xy * 2 - 1;
  return VertexOutput(vec4f(clip.x, -clip.y, 0, 1), local, pixel, stamp.w, brush.x);
}

fn sampled(image: texture_2d<f32>, point: vec2f, bounds: vec4f) -> vec4f {
  let uv = (point - bounds.xy) / bounds.zw;
  if (any(uv < vec2f(0)) || any(uv >= vec2f(1))) { return vec4f(0); }
  return textureSampleLevel(image, imageSampler, uv, 0);
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let distance = length(input.local);
  let inner = min(input.hardness, 1.0 - max(fwidth(distance), 0.0001));
  var coverage = (1.0 - smoothstep(inner, 1.0, distance)) * input.flow;
  if (params.flags.x > 0.5) {
    let point = vec3f(input.pixel, 1);
    let local = vec2f(dot(params.selectionRow0.xyz, point), dot(params.selectionRow1.xyz, point));
    let selection = sampled(selectionImage, local, params.selectionBounds);
    coverage *= clamp(select(selection.a, selection.r, params.flags.y > 0.5), 0.0, 1.0);
  }
  if (coverage <= 0) { return vec4f(0); }
  if (params.flags.w > 0.5) { return vec4f(0, 0, 0, coverage); }
  let point = vec3f(input.pixel, 1);
  let sourcePoint = vec2f(dot(params.sourceRow0.xyz, point), dot(params.sourceRow1.xyz, point));
  let source = sampled(sourceImage, sourcePoint, params.sourceBounds);
  if (source.a <= 0.00001) { return vec4f(0); }
  var result = source;
  if (params.flags.z > 0.5) {
    let sourceBlur = sampled(sourceBlurImage, sourcePoint, params.sourceBounds);
    let destinationBlur = sampled(destinationBlurImage, input.pixel, params.destinationBounds);
    let sourceColor = source.rgb / source.a;
    if (destinationBlur.a > 0.00001 && sourceBlur.a > 0.00001) {
      let detail = sourceColor - sourceBlur.rgb / sourceBlur.a;
      let healed = max(destinationBlur.rgb / destinationBlur.a + detail, vec3f(0));
      result = vec4f(healed * source.a, source.a);
    }
  }
  return result * coverage;
}
