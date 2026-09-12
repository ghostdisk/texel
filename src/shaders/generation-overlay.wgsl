struct Params {
  viewport: vec4f,
  canvas: vec4f,
  row0: vec4f,
  row1: vec4f,
  layer: vec4f,
  info: vec4f,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var selection: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  let p = positions[index];
  return VertexOutput(vec4f(p, 0, 1), vec2f((p.x + 1) * 0.5, (1 - p.y) * 0.5));
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let world = params.viewport.xy + input.uv * params.viewport.zw;
  let local = vec2f(dot(params.row0.xyz, vec3f(world, 1)), dot(params.row1.xyz, vec3f(world, 1)));
  let uv = (local - params.layer.xy) / params.layer.zw;
  let pixelSize = max(fwidth(uv), vec2f(0.0001));
  if (any(world < params.canvas.xy) || any(world >= params.canvas.xy + params.canvas.zw)) { discard; }
  if (any(uv < vec2f(0)) || any(uv >= vec2f(1))) { discard; }
  var coverage = 1.0;
  if (params.info.y > 0.5) { coverage = textureSampleLevel(selection, imageSampler, uv, 0).r; }
  let wave = pow(0.5 + 0.5 * sin((input.uv.x + input.uv.y) * 80.0 - params.info.x * 3.0), 12.0);
  let edgeDistance = min(min(uv.x, 1.0 - uv.x) / pixelSize.x, min(uv.y, 1.0 - uv.y) / pixelSize.y);
  let border = (1.0 - smoothstep(0.5, 2.0, edgeDistance)) * (0.55 + 0.3 * sin(params.info.x * 3.0));
  // Selection opacity controls the final blend, not the visibility of generation progress.
  let alpha = max((0.035 + wave * 0.12) * smoothstep(0.0, 0.01, coverage), border);
  return vec4f(vec3f(0.66, 0.48, 1.0) * alpha, alpha);
}