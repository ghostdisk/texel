struct Params {
  row0: vec4f,
  row1: vec4f,
  source: vec4f,
  destinationBounds: vec4f,
  info: vec4f,
  tile: vec4f,
}

@group(0) @binding(0) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let uv = corners[index];
  let local = vec3f(params.source.xy + uv * params.source.zw, 1);
  let destinationPosition = vec2f(dot(params.row0.xyz, local), dot(params.row1.xyz, local));
  let clip = (destinationPosition - params.destinationBounds.xy) / params.destinationBounds.zw * 2 - 1;
  return VertexOutput(vec4f(clip.x, -clip.y, 0, 1), uv);
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let position = (params.source.xy + input.uv * params.source.zw) * params.tile.z - params.tile.xy;
  var color = sampleNeighborhood(position, params.tile.w > 0.5);
  if (params.info.z > 0.5) { color = vec4f(vec3f(clamp(color.r, 0.0, 1.0)), 1); }
  if (params.info.w > 0.5) { return vec4f(clamp(color.r, 0.0, 1.0) * params.info.x, 0, 0, 1); }
  let premultiplied = vec4f(color.rgb * select(1.0, color.a, params.info.y > 0.5), color.a);
  return premultiplied * params.info.x;
}
