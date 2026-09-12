struct Params {
  size: vec4f,
}

@group(0) @binding(0) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
  @location(2) hardness: f32,
}

@vertex fn vertexMain(
  @builtin(vertex_index) index: u32,
  @location(0) stamp: vec4f,
  @location(1) color: vec4f,
) -> VertexOutput {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let local = corners[index];
  let clip = (stamp.xy + local * stamp.z) / params.size.xy * 2 - 1;
  return VertexOutput(vec4f(clip.x, -clip.y, 0, 1), local, color, stamp.w);
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let distance = length(input.local);
  let inner = min(input.hardness, 1 - fwidth(distance));
  let alpha = (1 - smoothstep(inner, 1, distance)) * input.color.a;
  return vec4f(input.color.rgb * alpha, alpha);
}
