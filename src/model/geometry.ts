export type Matrix = readonly [number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function transformPoint(matrix: Matrix, point: Point): Point {
  return { x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] };
}

export function inverse(matrix: Matrix): Matrix {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-10) throw new Error('This layer has a non-invertible transform.');
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}

export function transformBounds(matrix: Matrix, bounds: Rect): Rect {
  const points = [
    transformPoint(matrix, { x: bounds.x, y: bounds.y }),
    transformPoint(matrix, { x: bounds.x + bounds.width, y: bounds.y }),
    transformPoint(matrix, { x: bounds.x, y: bounds.y + bounds.height }),
    transformPoint(matrix, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }),
  ];
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  return { x, y, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y };
}

export function unionBounds(bounds: readonly Rect[]): Rect {
  if (bounds.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...bounds.map((rect) => rect.x));
  const y = Math.min(...bounds.map((rect) => rect.y));
  return {
    x, y,
    width: Math.max(...bounds.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...bounds.map((rect) => rect.y + rect.height)) - y,
  };
}

export function expandBounds(bounds: Rect, padding: number): Rect {
  return { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
}

export function maxScale([a, b, c, d]: Matrix): number {
  const trace = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  return Math.sqrt((trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))) / 2);
}
