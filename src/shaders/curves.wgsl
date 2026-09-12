fn controlPoint(channel: u32, index: u32) -> vec2f {
  let offset = channel * 16u + index * 2u;
  return vec2f(params.values[offset / 4u][offset % 4u], params.values[(offset + 1u) / 4u][(offset + 1u) % 4u]);
}

fn mapCurve(channel: u32, value: f32) -> f32 {
  var left = controlPoint(channel, 0u);
  for (var index = 1u; index < 8u; index++) {
    let right = controlPoint(channel, index);
    if (right.x > 1.0 || value <= right.x) {
      return mix(left.y, right.y, clamp((value - left.x) / max(right.x - left.x, 0.00001), 0.0, 1.0));
    }
    left = right;
  }
  return left.y;
}

fn adjustColor(color: vec3f) -> vec3f {
  let master = vec3f(mapCurve(0u, color.r), mapCurve(0u, color.g), mapCurve(0u, color.b));
  return vec3f(mapCurve(1u, master.r), mapCurve(2u, master.g), mapCurve(3u, master.b));
}
