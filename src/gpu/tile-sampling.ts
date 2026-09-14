/** All coordinates are logical 256px chunk coordinates, regardless of backing texture size. */
export const tileLoadShader = `
fn loadTile(image: texture_2d<f32>, position: vec2i) -> vec4f {
  if (any(position < vec2i(0)) || any(position >= vec2i(256))) { return vec4f(0); }
  return textureLoad(image, min(position, vec2i(textureDimensions(image)) - 1), 0);
}
`;
