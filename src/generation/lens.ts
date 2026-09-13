import { IDENTITY, inverse, multiply, transformPoint } from '../model/geometry';
import type { Matrix, Rect } from '../model/geometry';
import type { TransformTarget } from '../tools/transform-controls';

export interface GenerationFrame {
  width: number;
  height: number;
  transform: Matrix;
  canonicalWidth: number;
  canonicalHeight: number;
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

  frame(scale: number, dimensionMultiple = 1): GenerationFrame {
    const multiple = Math.max(1, Math.round(dimensionMultiple));
    const width = Math.max(multiple, Math.round(this.width * scale / multiple) * multiple);
    const height = Math.max(multiple, Math.round(this.height * scale / multiple) * multiple);
    return {
      width, height, canonicalWidth: this.width, canonicalHeight: this.height,
      transform: multiply(this.matrix, [this.baseWidth / width, 0, 0, this.baseHeight / height, 0, 0]),
    };
  }
}
