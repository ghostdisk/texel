fn adjustColor(color: vec3f) -> vec3f {
  let gray = dot(color, params.values[0].xyz);
  return vec3f(gray);
}
