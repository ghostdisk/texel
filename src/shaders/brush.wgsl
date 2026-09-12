struct Params {
  size: vec4f,
  row0: vec4f,
  row1: vec4f,
  maskBounds: vec4f,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var selectionImage: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
  @location(2) shape: vec2f,
  @location(3) pixel: vec2f,
}

@vertex fn vertexMain(
  @builtin(vertex_index) index: u32,
  @location(0) stamp: vec4f,
  @location(1) shape: vec4f,
  @location(2) color: vec4f,
) -> VertexOutput {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let local = corners[index];
  let pixel = stamp.xy + local * stamp.zw;
  let clip = pixel / params.size.xy * 2 - 1;
  return VertexOutput(vec4f(clip.x, -clip.y, 0, 1), local, color, shape.xy, pixel);
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let distance = select(length(input.local), max(abs(input.local.x), abs(input.local.y)), input.shape.y > 0.5);
  let inner = min(input.shape.x, 1.0 - max(fwidth(distance), 0.0001));
  var alpha = (1.0 - smoothstep(inner, 1.0, distance)) * input.color.a;
  if (params.size.z > 0.5) {
    let point = vec3f(input.pixel, 1);
    let local = vec2f(dot(params.row0.xyz, point), dot(params.row1.xyz, point));
    let uv = (local - params.maskBounds.xy) / params.maskBounds.zw;
    var coverage = 0.0;
    if (all(uv >= vec2f(0)) && all(uv < vec2f(1))) {
      let value = textureSampleLevel(selectionImage, imageSampler, uv, 0);
      coverage = clamp(select(value.a, value.r, params.size.w > 0.5), 0.0, 1.0);
    }
    alpha *= coverage;
  }
  return vec4f(input.color.rgb * alpha, alpha);
}