fn adjustColor(color: vec3f) -> vec3f {
  let temperature = params.values[0].x;
  let tint = params.values[0].y;
  let gains = exp2(vec3f(temperature * 0.25 + tint * 0.06, -tint * 0.2, -temperature * 0.25 + tint * 0.06));
  return toSrgb(toLinear(color) * gains);
}
