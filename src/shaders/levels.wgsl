fn adjustColor(color: vec3f) -> vec3f {
  let inputBlack = params.values[0].x;
  let inputWhite = params.values[0].y;
  let gamma = params.values[0].z;
  let outputBlack = params.values[0].w;
  let outputWhite = params.values[1].x;
  let normalized = clamp((color - inputBlack) / (inputWhite - inputBlack), vec3f(0), vec3f(1));
  let corrected = pow(normalized, vec3f(1 / gamma));
  return vec3f(outputBlack) + corrected * (outputWhite - outputBlack);
}
