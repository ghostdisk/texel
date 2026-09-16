import { IDENTITY, inverse, multiply, transformPoint } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import type { TransformTarget } from '../tools/transform-controls';
import type { GenerationSizeBucket, GenerationSizeConstraints } from './provider';

export interface GenerationFrame {
  width: number;
  height: number;
  transform: Matrix;
  canonicalWidth: number;
  canonicalHeight: number;
}

function ratio(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const result = Number(match[1]) / Number(match[2]);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function expandedSize(width: number, height: number, aspectRatio: number): { width: number; height: number } {
  return width / height < aspectRatio ? { width: height * aspectRatio, height } : { width, height: width / aspectRatio };
}

function expansionScore(width: number, height: number, candidate: { width: number; height: number }): number {
  return candidate.width * candidate.height / (width * height);
}

function chooseAspect(width: number, height: number, constraints: GenerationSizeConstraints): number {
  const buckets = (constraints.sizeBuckets ?? constraints.outputSizeBuckets)?.map((bucket) => bucket.width / bucket.height) ??
    constraints.aspectRatios?.map(ratio).filter((value): value is number => value !== null) ?? [];
  if (buckets.length) return buckets.reduce((best, current) => {
    const bestSize = expandedSize(width, height, best), currentSize = expandedSize(width, height, current);
    return expansionScore(width, height, currentSize) < expansionScore(width, height, bestSize) ? current : best;
  });
  const current = width / height;
  return Math.max(constraints.minAspectRatio ?? 0, Math.min(constraints.maxAspectRatio ?? Infinity, current));
}

function roundUp(value: number, multiple: number): number { return Math.ceil(value / multiple - 0.000001) * multiple; }
function roundDown(value: number, multiple: number): number { return Math.floor(value / multiple + 0.000001) * multiple; }

function chooseBucket(buckets: readonly GenerationSizeBucket[], aspectRatio: number, desiredWidth: number, desiredHeight: number): GenerationSizeBucket {
  const matching = buckets.filter((bucket) => Math.abs(bucket.width / bucket.height - aspectRatio) < 0.0001);
  const candidates = matching.length ? matching : [...buckets];
  const sufficient = candidates.filter((bucket) => bucket.width >= desiredWidth && bucket.height >= desiredHeight);
  const pool = sufficient.length ? sufficient : candidates;
  return pool.reduce((best, current) => {
    const bestDistance = Math.abs(Math.log(best.width / desiredWidth)) + Math.abs(Math.log(best.height / desiredHeight));
    const distance = Math.abs(Math.log(current.width / desiredWidth)) + Math.abs(Math.log(current.height / desiredHeight));
    return distance < bestDistance ? current : best;
  });
}

function constrainedPixels(width: number, height: number, scale: number, aspectRatio: number,
  constraints: GenerationSizeConstraints): { width: number; height: number; scale: number } {
  const desiredWidth = width * scale, desiredHeight = height * scale;
  if (constraints.sizeBuckets?.length) {
    const bucket = chooseBucket(constraints.sizeBuckets, aspectRatio, desiredWidth, desiredHeight);
    return { width: bucket.width, height: bucket.height, scale: Math.min(bucket.width / width, bucket.height / height) };
  }
  let pixelWidth = desiredWidth, pixelHeight = desiredHeight;
  const grow = Math.max(1, (constraints.minWidth ?? 0) / pixelWidth, (constraints.minHeight ?? 0) / pixelHeight,
    (constraints.minShortSide ?? 0) / Math.min(pixelWidth, pixelHeight),
    (constraints.minLongSide ?? 0) / Math.max(pixelWidth, pixelHeight),
    Math.sqrt((constraints.minPixels ?? 0) / (pixelWidth * pixelHeight)));
  pixelWidth *= grow;
  pixelHeight *= grow;
  if (constraints.shortSideBuckets?.length) {
    const desiredShortSide = Math.min(pixelWidth, pixelHeight);
    const sufficient = constraints.shortSideBuckets.filter((size) => size >= desiredShortSide);
    const shortSide = (sufficient.length ? sufficient : constraints.shortSideBuckets).reduce((best, current) =>
      Math.abs(Math.log(current / desiredShortSide)) < Math.abs(Math.log(best / desiredShortSide)) ? current : best);
    const factor = shortSide / desiredShortSide;
    pixelWidth *= factor;
    pixelHeight *= factor;
  }
  if (constraints.pixelAreaBuckets?.length) {
    const desiredPixels = pixelWidth * pixelHeight;
    const sufficient = constraints.pixelAreaBuckets.filter((pixels) => pixels >= desiredPixels);
    const pixels = (sufficient.length ? sufficient : constraints.pixelAreaBuckets).reduce((best, current) =>
      Math.abs(Math.log(current / desiredPixels)) < Math.abs(Math.log(best / desiredPixels)) ? current : best);
    const factor = Math.sqrt(pixels / (pixelWidth * pixelHeight));
    pixelWidth *= factor;
    pixelHeight *= factor;
  }
  const shrink = Math.min(1, (constraints.maxWidth ?? Infinity) / pixelWidth, (constraints.maxHeight ?? Infinity) / pixelHeight,
    (constraints.maxShortSide ?? Infinity) / Math.min(pixelWidth, pixelHeight),
    (constraints.maxLongSide ?? Infinity) / Math.max(pixelWidth, pixelHeight),
    Math.sqrt((constraints.maxPixels ?? Infinity) / (pixelWidth * pixelHeight)));
  pixelWidth *= shrink;
  pixelHeight *= shrink;
  const effectiveScale = Math.min(pixelWidth / width, pixelHeight / height);
  const granularity = constraints.granularity;
  const widthMultiple = typeof granularity === 'number' ? granularity : granularity?.width ?? 1;
  const heightMultiple = typeof granularity === 'number' ? granularity : granularity?.height ?? 1;
  pixelWidth = roundUp(pixelWidth, widthMultiple);
  pixelHeight = roundUp(pixelHeight, heightMultiple);
  if (constraints.maxWidth && pixelWidth > constraints.maxWidth) pixelWidth = roundDown(constraints.maxWidth, widthMultiple);
  if (constraints.maxHeight && pixelHeight > constraints.maxHeight) pixelHeight = roundDown(constraints.maxHeight, heightMultiple);
  return { width: Math.max(widthMultiple, pixelWidth), height: Math.max(heightMultiple, pixelHeight), scale: effectiveScale };
}

/** Keep native result pixels and map their full bounds to the expanded lens. */
export function generationResultFrame(target: GenerationFrame, width: number, height: number): GenerationFrame {
  return {
    width, height, canonicalWidth: target.canonicalWidth, canonicalHeight: target.canonicalHeight,
    transform: multiply(target.transform, [target.width / width, 0, 0, target.height / height, 0, 0]),
  };
}

export class GenerationLens implements TransformTarget {
  readonly parent = null;
  private matrix: Matrix = IDENTITY;

  constructor(private readonly baseWidth: number, private readonly baseHeight: number, private readonly changed: () => void = () => {}) {}

  get transform(): Matrix { return this.matrix; }
  get width(): number { return Math.hypot(this.matrix[0], this.matrix[1]) * this.baseWidth; }
  get height(): number { return Math.hypot(this.matrix[2], this.matrix[3]) * this.baseHeight; }
  get angle(): number { return Math.atan2(this.matrix[1], this.matrix[0]) * 180 / Math.PI; }
  localBounds(): Rect { return { x: 0, y: 0, width: this.baseWidth, height: this.baseHeight }; }
  worldTransform(): Matrix { return this.matrix; }

  setTransform(matrix: Matrix): void {
    if (!matrix.every(Number.isFinite)) throw new Error('Lens coordinates must be finite.');
    inverse(matrix);
    this.matrix = [...matrix];
    this.changed();
  }

  setSize(width: number, height: number): void {
    this.setTransform(multiply(this.matrix, [Math.max(1, width) / this.width, 0, 0, Math.max(1, height) / this.height, 0, 0]));
  }

  setAngle(degrees: number): void {
    const angle = (degrees - this.angle) * Math.PI / 180;
    const c = Math.cos(angle), s = Math.sin(angle);
    const { x, y } = transformPoint(this.matrix, { x: this.baseWidth / 2, y: this.baseHeight / 2 });
    this.setTransform(multiply([c, s, -s, c, x - c * x + s * y, y - s * x - c * y], this.matrix));
  }

  fit(width: number, height: number): void { this.setTransform([width / this.baseWidth, 0, 0, height / this.baseHeight, 0, 0]); }

  snapshot(): GenerationLens {
    const lens = new GenerationLens(this.baseWidth, this.baseHeight);
    lens.setTransform(this.matrix);
    return lens;
  }

  frame(scale: number, constraints: GenerationSizeConstraints = {}): GenerationFrame {
    const resolution = Math.max(0.000001, scale);
    const aspectRatio = chooseAspect(this.width, this.height, constraints);
    let expanded = expandedSize(this.width, this.height, aspectRatio);
    const pixels = constrainedPixels(expanded.width, expanded.height, resolution, aspectRatio, constraints);
    expanded = expandedSize(expanded.width, expanded.height, pixels.width / pixels.height);
    const growth = Math.max(1, pixels.width / pixels.scale / expanded.width, pixels.height / pixels.scale / expanded.height);
    expanded = { width: expanded.width * growth, height: expanded.height * growth };
    const localWidth = this.baseWidth * expanded.width / this.width;
    const localHeight = this.baseHeight * expanded.height / this.height;
    return {
      width: pixels.width, height: pixels.height, canonicalWidth: expanded.width, canonicalHeight: expanded.height,
      transform: multiply(this.matrix, [localWidth / pixels.width, 0, 0, localHeight / pixels.height,
        (this.baseWidth - localWidth) / 2, (this.baseHeight - localHeight) / 2]),
    };
  }
}
