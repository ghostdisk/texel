struct Params {
  settings: vec4f,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: Params;

// Stream neighboring 8 × 8 tiles instead of allocating a radius-sized halo.
var<workgroup> tilePixels: array<vec4f, 64>;
var<workgroup> tileColors: array<vec4f, 64>;

fn distanceColor(pixel: vec4f) -> vec4f {
  if (pixel.a <= 0) { return vec4f(0); }
  let linear = clamp(pixel.rgb / pixel.a, vec3f(0), vec3f(1));
  let srgb = select(1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055, linear * 12.92, linear <= vec3f(0.0031308));
  return vec4f(srgb, pixel.a);
}

@compute @workgroup_size(8, 8) fn main(
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_id) local: vec3u,
) {
  let size = vec2i(textureDimensions(source));
  let groupPosition = vec2i(group.xy);
  let pixelPosition = groupPosition * 8 + vec2i(local.xy);
  let inBounds = all(pixelPosition < size);
  let localIndex = local.y * 8u + local.x;
  let radius = params.settings.x;
  let extent = i32(ceil(radius));
  let radiusSquared = radius * radius;
  let tileRadius = i32(ceil(radius / 8));
  let firstTile = max(groupPosition - vec2i(tileRadius), vec2i(0));
  let lastTile = min(groupPosition + vec2i(tileRadius), (size - vec2i(1)) / vec2i(8));
  let thresholdSquared = params.settings.y * params.settings.y;
  let sigma = max(radius * 0.5, 0.5);
  let inverseVariance = 1 / (2 * sigma * sigma);
  var centerColor = vec4f(0);
  if (inBounds) { centerColor = distanceColor(textureLoad(source, pixelPosition, 0)); }
  var sum = vec4f(0);
  var weightSum = 0.0;

  // Every invocation, including those outside a partial edge tile, reaches the barriers.
  for (var tileY = firstTile.y; tileY <= lastTile.y; tileY++) {
    for (var tileX = firstTile.x; tileX <= lastTile.x; tileX++) {
      let origin = vec2i(tileX, tileY) * 8;
      let loadPosition = origin + vec2i(local.xy);
      var neighborPixel = vec4f(0);
      if (all(loadPosition < size)) { neighborPixel = textureLoad(source, loadPosition, 0); }
      tilePixels[localIndex] = neighborPixel;
      tileColors[localIndex] = distanceColor(neighborPixel);
      workgroupBarrier();

      if (inBounds) {
        let first = max(origin, pixelPosition - vec2i(extent));
        let last = min(min(origin + vec2i(7), pixelPosition + vec2i(extent)), size - vec2i(1));
        for (var y = first.y; y <= last.y; y++) {
          for (var x = first.x; x <= last.x; x++) {
            let offset = vec2f(vec2i(x, y) - pixelPosition);
            let distanceSquared = dot(offset, offset);
            if (distanceSquared > radiusSquared) { continue; }
            let index = u32(y - origin.y) * 8u + u32(x - origin.x);
            let difference = tileColors[index] - centerColor;
            // RMS sRGB distance, with alpha also acting as an edge boundary.
            let colorDistanceSquared = max(dot(difference.rgb, difference.rgb) / 3, difference.a * difference.a);
            if (colorDistanceSquared <= thresholdSquared) {
              let weight = exp(-distanceSquared * inverseVariance);
              sum += tilePixels[index] * weight;
              weightSum += weight;
            }
          }
        }
      }
      workgroupBarrier();
    }
  }
  // The center pixel is always admitted, even when the threshold is zero.
  if (inBounds) { textureStore(destination, pixelPosition, sum / max(weightSum, 0.000001)); }
}
