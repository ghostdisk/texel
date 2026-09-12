fn adjustColor(color: vec3f) -> vec3f {
  let linear = toLinear(color);
  let exposed = max(linear * exp2(params.values[0].x) + params.values[0].y, vec3f(0));
  return toSrgb(pow(exposed, vec3f(1.0 / params.values[0].z)));
}
