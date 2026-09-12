fn adjustColor(color: vec3f) -> vec3f {
  let steps = params.values[0].x - 1;
  return floor(clamp(color, vec3f(0), vec3f(1)) * steps + 0.5) / steps;
}
