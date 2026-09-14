struct Params {
  row0: vec4f,
  row1: vec4f,
  sourceBounds: vec4f,
  targetBounds: vec4f,
  info: vec4f,
  backdropClip: vec4f,
  sourceClip: vec4f,
}

@group(0) @binding(0) var backdropImage: texture_2d<f32>;
@group(0) @binding(1) var sourceImage: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;
@group(0) @binding(3) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  let position = positions[index];
  return VertexOutput(vec4f(position, 0, 1), vec2f((position.x + 1) * 0.5, (1 - position.y) * 0.5));
}

fn luminosity(color: vec3f) -> f32 { return dot(color, vec3f(0.3, 0.59, 0.11)); }
fn saturation(color: vec3f) -> f32 { return max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b)); }

fn clipColor(color: vec3f) -> vec3f {
  let light = luminosity(color);
  var result = color;
  let low = min(result.r, min(result.g, result.b));
  if (low < 0.0) { result = vec3f(light) + (result - vec3f(light)) * light / (light - low); }
  let high = max(result.r, max(result.g, result.b));
  if (high > 1.0) { result = vec3f(light) + (result - vec3f(light)) * (1.0 - light) / (high - light); }
  return result;
}

fn setLuminosity(color: vec3f, light: f32) -> vec3f { return clipColor(color + vec3f(light - luminosity(color))); }

fn setSaturation(color: vec3f, value: f32) -> vec3f {
  let low = min(color.r, min(color.g, color.b));
  let high = max(color.r, max(color.g, color.b));
  if (high <= low) { return vec3f(0); }
  return (color - vec3f(low)) * value / (high - low);
}

fn colorBurn(backdrop: f32, source: f32) -> f32 {
  if (source <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - backdrop) / source);
}

fn colorDodge(backdrop: f32, source: f32) -> f32 {
  if (source >= 1.0) { return 1.0; }
  return min(1.0, backdrop / (1.0 - source));
}

fn softLight(backdrop: f32, source: f32) -> f32 {
  if (source <= 0.5) { return backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop); }
  let curve = select(sqrt(backdrop), ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop, backdrop <= 0.25);
  return backdrop + (2.0 * source - 1.0) * (curve - backdrop);
}

fn vividLight(backdrop: f32, source: f32) -> f32 {
  if (source < 0.5) { return colorBurn(backdrop, 2.0 * source); }
  return colorDodge(backdrop, 2.0 * source - 1.0);
}

fn blendColor(backdrop: vec3f, source: vec3f, mode: u32) -> vec3f {
  switch mode {
    case 2u: { return min(backdrop, source); }
    case 3u: { return backdrop * source; }
    case 4u: { return vec3f(colorBurn(backdrop.r, source.r), colorBurn(backdrop.g, source.g), colorBurn(backdrop.b, source.b)); }
    case 5u: { return max(vec3f(0), backdrop + source - vec3f(1)); }
    case 6u: { return select(backdrop, source, luminosity(source) < luminosity(backdrop)); }
    case 7u: { return max(backdrop, source); }
    case 9u: { return vec3f(colorDodge(backdrop.r, source.r), colorDodge(backdrop.g, source.g), colorDodge(backdrop.b, source.b)); }
    case 11u: { return select(backdrop, source, luminosity(source) > luminosity(backdrop)); }
    case 12u: { return select(2.0 * backdrop * source, 1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source), backdrop > vec3f(0.5)); }
    case 13u: { return vec3f(softLight(backdrop.r, source.r), softLight(backdrop.g, source.g), softLight(backdrop.b, source.b)); }
    case 14u: { return select(2.0 * backdrop * source, 1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source), source > vec3f(0.5)); }
    case 15u: { return vec3f(vividLight(backdrop.r, source.r), vividLight(backdrop.g, source.g), vividLight(backdrop.b, source.b)); }
    case 16u: { return clamp(backdrop + 2.0 * source - vec3f(1), vec3f(0), vec3f(1)); }
    case 17u: { return select(min(backdrop, 2.0 * source), max(backdrop, 2.0 * source - vec3f(1)), source > vec3f(0.5)); }
    case 18u: { return step(vec3f(0.5), vec3f(vividLight(backdrop.r, source.r), vividLight(backdrop.g, source.g), vividLight(backdrop.b, source.b))); }
    case 19u: { return abs(backdrop - source); }
    case 21u: { return max(vec3f(0), backdrop - source); }
    case 22u: { return min(vec3f(1), backdrop / max(source, vec3f(0.000001))); }
    case 23u: { return setLuminosity(setSaturation(source, saturation(backdrop)), luminosity(backdrop)); }
    case 24u: { return setLuminosity(setSaturation(backdrop, saturation(source)), luminosity(backdrop)); }
    case 25u: { return setLuminosity(source, luminosity(backdrop)); }
    case 26u: { return setLuminosity(backdrop, luminosity(source)); }
    default: { return source; }
  }
}

fn noise(pixel: vec2f) -> f32 { return fract(sin(dot(pixel, vec2f(12.9898, 78.233))) * 43758.5453); }

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let pixel = vec2i(input.position.xy);
  let backdropInside = all(vec2f(pixel) >= params.backdropClip.xy) && all(vec2f(pixel) < params.backdropClip.zw);
  let backdrop = select(vec4f(0), loadTile(backdropImage, pixel), backdropInside);
  let world = params.targetBounds.xy + input.uv * params.targetBounds.zw;
  let local = vec2f(dot(params.row0.xyz, vec3f(world, 1)), dot(params.row1.xyz, vec3f(world, 1)));
  let sourceUv = (local - params.sourceBounds.xy) / params.sourceBounds.zw;
  let inside = all(vec2f(pixel) >= params.sourceClip.xy) && all(vec2f(pixel) < params.sourceClip.zw);
  var source = select(vec4f(0), textureSample(sourceImage, sourceSampler, sourceUv), inside);
  if (params.info.z > 0.5) { source = vec4f(vec3f(clamp(source.r, 0.0, 1.0)), 1); }
  source *= params.info.x;
  let mode = u32(params.info.y);
  if (mode == 1u) {
    if (source.a <= noise(floor(world * params.info.w))) { return backdrop; }
    source = vec4f(source.rgb / max(source.a, 0.000001), 1);
  }
  if (source.a <= 0.0) { return backdrop; }
  let backdropColor = clamp(backdrop.rgb / max(backdrop.a, 0.000001), vec3f(0), vec3f(1));
  let sourceColor = clamp(source.rgb / max(source.a, 0.000001), vec3f(0), vec3f(1));
  let blended = blendColor(backdropColor, sourceColor, mode);
  let rgb = (1.0 - source.a) * backdrop.rgb + (1.0 - backdrop.a) * source.rgb + source.a * backdrop.a * blended;
  return vec4f(rgb, source.a + backdrop.a * (1.0 - source.a));
}
