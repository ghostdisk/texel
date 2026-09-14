struct Params {
  viewport: vec4f,
  source: vec4f,
  framing: vec4f,
  info: vec4f,
  row0: vec4f,
  row1: vec4f,
  background: vec4f,
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
  let local = params.source.xy + uv * params.source.zw;
  let point = vec3f(local, 1);
  let world = select(params.viewport.xy + uv * params.viewport.zw, vec2f(dot(params.row0.xyz, point), dot(params.row1.xyz, point)), params.info.z > 0.5);
  let clip = (world - params.viewport.xy) / params.viewport.zw * 2 - 1;
  return VertexOutput(vec4f(clip.x, -clip.y, 0, 1), uv);
}

fn toSrgb(color: vec3f) -> vec3f {
  let value = max(color, vec3f(0));
  return select(1.055 * pow(value, vec3f(1.0 / 2.4)) - 0.055, value * 12.92, value <= vec3f(0.0031308));
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let local = params.source.xy + input.uv * params.source.zw;
  let point = vec3f(local, 1);
  let world = select(params.viewport.xy + input.uv * params.viewport.zw, vec2f(dot(params.row0.xyz, point), dot(params.row1.xyz, point)), params.info.z > 0.5);
  let insideFrame = all(world >= params.framing.xy) && all(world <= params.framing.xy + params.framing.zw);
  var color = vec4f(0);
  if (params.info.z > 0.5) {
    color = sampleNeighborhood(local * params.tile.z - params.tile.xy, params.info.w > 0.5);
    if (params.info.y > 0.5) { color = vec4f(vec3f(clamp(color.r, 0.0, 1.0)), 1); }
    color *= params.info.x;
  }
  let tile = vec2u(input.position.xy / 12);
  let background = vec3f(select(0.72, 0.86, (tile.x + tile.y) % 2u == 0u));
  let artwork = toSrgb(color.rgb + background * (1 - color.a));
  return vec4f(select(params.background.rgb, artwork, insideFrame), 1);
}
