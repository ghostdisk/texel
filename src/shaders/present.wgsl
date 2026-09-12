struct Params {
  frame: vec4f,
  source: vec4f,
  info: vec4f,
}

@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  let position = positions[index];
  return VertexOutput(vec4f(position, 0, 1), vec2f((position.x + 1) * 0.5, (1 - position.y) * 0.5));
}

fn toSrgb(color: vec3f) -> vec3f {
  let value = max(color, vec3f(0));
  return select(1.055 * pow(value, vec3f(1.0 / 2.4)) - 0.055, value * 12.92, value <= vec3f(0.0031308));
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let local = params.frame.xy + input.uv * params.frame.zw;
  let uv = (local - params.source.xy) / params.source.zw;
  // Sample before branching so implicit derivatives remain uniform.
  let sampled = textureSample(image, imageSampler, uv);
  let inside = all(uv >= vec2f(0)) && all(uv <= vec2f(1));
  let color = select(vec4f(0), sampled * params.info.x, inside);
  let tile = vec2u(input.position.xy / 12);
  let background = vec3f(select(0.72, 0.86, (tile.x + tile.y) % 2u == 0u));
  return vec4f(toSrgb(color.rgb + background * (1 - color.a)), 1);
}
