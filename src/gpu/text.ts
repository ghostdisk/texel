import { validateText } from '../model/text-layer';
import type { TextProperties } from '../model/text-layer';
import type { Gpu } from './device';
import type { QuadRenderer } from './quad';
import { uploadImage } from './images';
import type { Surface } from './surface';

/** Canvas lays out glyphs; the upload converts sRGB into the editor's linear premultiplied pixels. */
export function rasterizeText(gpu: Gpu, quads: QuadRenderer, properties: TextProperties): Surface {
  const text = validateText(properties);
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas text rendering is unavailable.');
  const family = ['serif', 'sans-serif', 'monospace', 'system-ui'].includes(text.fontFamily) ? text.fontFamily : JSON.stringify(text.fontFamily);
  const font = `${text.italic ? 'italic ' : ''}${text.bold ? '700 ' : ''}${text.fontSize}px ${family}`;
  context.font = font;
  const lines = text.text.replace(/\t/g, '    ').split('\n');
  const metrics = lines.map((line) => context.measureText(line));
  const advance = Math.max(1, ...metrics.map((metric) => metric.width));
  const left = Math.ceil(Math.max(0, ...metrics.map((metric) => metric.actualBoundingBoxLeft))) + 2;
  const right = Math.ceil(Math.max(0, ...metrics.map((metric) => metric.actualBoundingBoxRight - metric.width))) + 2;
  const ascent = Math.max(text.fontSize * 0.8, ...metrics.map((metric) => metric.actualBoundingBoxAscent));
  const descent = Math.max(text.fontSize * 0.2, ...metrics.map((metric) => metric.actualBoundingBoxDescent));
  const lineAdvance = text.fontSize * text.lineHeight;
  const width = Math.ceil(left + advance + right);
  const height = Math.ceil(ascent + descent + (lines.length - 1) * lineAdvance + 4);
  const limit = gpu.device.limits.maxTextureDimension2D;
  if (width > limit || height > limit || width * height > 16 * 1024 * 1024) throw new Error('This text exceeds the supported raster size. Reduce its size or content.');
  canvas.width = width;
  canvas.height = height;
  context.font = font;
  context.fillStyle = text.color;
  context.textBaseline = 'alphabetic';
  lines.forEach((line, index) => {
    const offset = text.align === 'right' ? advance - metrics[index].width : text.align === 'center' ? (advance - metrics[index].width) / 2 : 0;
    context.fillText(line, left + offset, 2 + ascent + index * lineAdvance);
  });
  return uploadImage(gpu, quads, canvas, width, height, 'Text source');
}
