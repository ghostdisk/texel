struct Params {
  size: vec4f,
  bounds: vec4f,
  row0: vec4f,
  row1: vec4f,
  maskBounds: vec4f,
  color: vec4f,
  mode: vec4f,
  origin: vec4f,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var coverageImage: texture_2d<f32>;
@group(0) @binding(2) var selectionImage: texture_2d<f32>;
@group(0) @binding(3) var imageSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) pixel: vec2f,
}

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let pixel = mix(params.bounds.xy, params.bounds.zw, corners[index]);
  let clip = (pixel - params.origin.xy) / params.size.xy * 2 - 1;
  return VertexOutput(vec4f(clip.x, -clip.y, 0, 1), pixel);
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let coverageUv = (input.pixel - params.bounds.xy) / (params.bounds.zw - params.bounds.xy);
  let coveragePixel = textureSampleLevel(coverageImage, imageSampler, coverageUv, 0);
  var coverage = select(coveragePixel.a, coveragePixel.r, params.mode.y > 0.5);
  if (params.size.w > 0.5) {
    let point = vec3f(input.pixel, 1);
    let local = vec2f(dot(params.row0.xyz, point), dot(params.row1.xyz, point));
    let uv = (local - params.maskBounds.xy) / params.maskBounds.zw;
    var selection = 0.0;
    if (all(uv >= vec2f(0)) && all(uv < vec2f(1))) {
      let value = textureSampleLevel(selectionImage, imageSampler, uv, 0);
      selection = clamp(select(value.a, value.r, params.mode.x > 0.5), 0.0, 1.0);
    }
    coverage *= selection;
  }
  let alpha = coverage * params.color.a;
  return vec4f(params.color.rgb * alpha, alpha);
}
