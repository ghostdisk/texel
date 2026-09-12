fn adjustColor(color: vec3f) -> vec3f {
  let brightness = params.values[0].x;
  let contrast = params.values[0].y;
  let factor = (1 + contrast) / max(1 - contrast, 0.0001);
  return (color - 0.5) * factor + 0.5 + brightness;
}
