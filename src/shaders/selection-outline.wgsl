struct Params {
  viewport: vec4f,
  canvas: vec4f,
  maskBounds: vec4f,
  row0: vec4f,
  row1: vec4f,
  settings: vec4f,
  tile: vec4f,
}
@group(0) @binding(2) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) world: vec2f,
}

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let world = params.tile.xy + corners[index] * params.tile.zw;
  let clip = (world - params.viewport.xy) / params.viewport.zw * 2 - 1;
  return VertexOutput(vec4f(clip.x, -clip.y, 0, 1), world);
}

fn coverage(world: vec2f) -> f32 {
  if (any(world < params.canvas.xy) || any(world >= params.canvas.xy + params.canvas.zw)) { return 0.0; }
  let point = vec3f(world, 1);
  let local = vec2f(dot(params.row0.xyz, point), dot(params.row1.xyz, point));
  let uv = (local - params.maskBounds.xy) / params.maskBounds.zw;
  if (any(uv < vec2f(0)) || any(uv >= vec2f(1))) { return 0.0; }
  return clamp(sampleNeighborhood(local - params.tile.xy, false).r, 0.0, 1.0);
}

// Contours are detected in screen space, so their width is independent of zoom.
fn contour(center: f32, low: f32, high: f32, level: f32) -> f32 {
  if (high - low < 0.0001 || low > level || high < level) { return 0.0; }
  return clamp(1.0 - abs(center - level) / max(high - low, 0.0001), 0.0, 1.0);
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let stepSize = 1.0 / params.settings.x;
  let center = coverage(input.world);
  let samples = vec4f(
    coverage(input.world + vec2f(stepSize, 0)), coverage(input.world - vec2f(stepSize, 0)),
    coverage(input.world + vec2f(0, stepSize)), coverage(input.world - vec2f(0, stepSize)),
  );
  let low = min(center, min(min(samples.x, samples.y), min(samples.z, samples.w)));
  let high = max(center, max(max(samples.x, samples.y), max(samples.z, samples.w)));
  let edge = contour(center, low, high, 0.5);
  let softEdge = max(max(contour(center, low, high, 0.1), contour(center, low, high, 0.9)) * 0.4, contour(center, low, high, 0.01) * 0.25);
  let partial = 4.0 * center * (1.0 - center);
  let tintAlpha = max(0.18 * partial + 0.07 * center * params.settings.z, softEdge);
  let tint = vec3f(0.45, 0.7, 1.0);
  let phase = floor((input.position.x + input.position.y) / 5.0 - params.settings.y * 3.0);
  let stripe = select(0.03, 0.97, fract(phase * 0.5) > 0.25);
  let alpha = edge + tintAlpha * (1.0 - edge);
  return vec4f(vec3f(stripe) * edge + tint * tintAlpha * (1.0 - edge), alpha);
}
