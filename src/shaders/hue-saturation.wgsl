fn rgbToHsl(color: vec3f) -> vec3f {
  let maximum = max(color.r, max(color.g, color.b));
  let minimum = min(color.r, min(color.g, color.b));
  let range = maximum - minimum;
  let lightness = (maximum + minimum) * 0.5;
  var hue = 0.0;
  if (range > 0.00001) {
    if (maximum == color.r) { hue = (color.g - color.b) / range; }
    else if (maximum == color.g) { hue = 2.0 + (color.b - color.r) / range; }
    else { hue = 4.0 + (color.r - color.g) / range; }
    hue = fract(hue / 6.0);
  }
  let saturation = select(0.0, range / max(1.0 - abs(2.0 * lightness - 1.0), 0.00001), range > 0.00001);
  return vec3f(hue, saturation, lightness);
}

fn hslToRgb(color: vec3f) -> vec3f {
  let chroma = (1.0 - abs(2.0 * color.z - 1.0)) * color.y;
  let hue = fract(color.x) * 6.0;
  let x = chroma * (1.0 - abs(fract(hue * 0.5) * 2.0 - 1.0));
  var rgb = vec3f(0);
  if (hue < 1.0) { rgb = vec3f(chroma, x, 0); }
  else if (hue < 2.0) { rgb = vec3f(x, chroma, 0); }
  else if (hue < 3.0) { rgb = vec3f(0, chroma, x); }
  else if (hue < 4.0) { rgb = vec3f(0, x, chroma); }
  else if (hue < 5.0) { rgb = vec3f(x, 0, chroma); }
  else { rgb = vec3f(chroma, 0, x); }
  return rgb + color.z - chroma * 0.5;
}

fn adjustColor(color: vec3f) -> vec3f {
  var hsl = rgbToHsl(color);
  hsl.x = fract(hsl.x + params.values[0].x);
  let saturation = params.values[0].y;
  if (hsl.y > 0.0) {
    hsl.y = select(hsl.y * (1.0 + saturation), hsl.y + (1.0 - hsl.y) * saturation, saturation >= 0.0);
  }
  let lightness = params.values[0].z;
  hsl.z = select(hsl.z * (1.0 + lightness), hsl.z + (1.0 - hsl.z) * lightness, lightness >= 0.0);
  return hslToRgb(hsl);
}
