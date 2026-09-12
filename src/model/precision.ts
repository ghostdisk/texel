import type { Layer } from './layers';
import { IDENTITY, inverse, multiply, transformBounds } from './geometry';
import type { Matrix, Point, Rect } from './geometry';

export type GuideAxis = 'horizontal' | 'vertical';

export interface Guide {
  axis: GuideAxis;
  position: number;
}

export interface PrecisionState {
  gridSize: number;
  guides: Guide[];
}

export interface TransformGeometry {
  readonly transform: Matrix;
  readonly parent: {
    worldTransform(): Matrix;
  } | null;
  worldTransform(): Matrix;
  localBounds(): Rect;
}

export interface SnapOptions {
  frame: Rect;
  gridSize: number;
  guides: readonly Guide[];
  otherBounds: readonly Rect[];
  grid: boolean;
  guideLines: boolean;
  threshold: number;
  axis: 'x' | 'y' | null;
}

export const DEFAULT_GRID_SIZE = 32;
export const MAX_GUIDES = 1000;

export function validatePrecision(state: PrecisionState): PrecisionState {
  if (!Number.isFinite(state.gridSize) || state.gridSize < 1 || state.gridSize > 1_000_000) {
    throw new Error('Grid size must be between 1 and 1,000,000 pixels.');
  }
  if (!Array.isArray(state.guides) || state.guides.length > MAX_GUIDES) throw new Error(`A document can contain at most ${MAX_GUIDES} guides.`);
  const guides = state.guides.map((guide) => {
    if ((guide.axis !== 'horizontal' && guide.axis !== 'vertical') || !Number.isFinite(guide.position) || Math.abs(guide.position) > 1_000_000_000) {
      throw new Error('Guide positions must be finite document coordinates.');
    }
    return { axis: guide.axis, position: guide.position };
  });
  return { gridSize: state.gridSize, guides };
}

export function worldBounds(target: TransformGeometry): Rect { return transformBounds(target.worldTransform(), target.localBounds()); }

export function applyWorldTransform(layer: Layer, operation: Matrix): void {
  const parentWorld = layer.parent?.worldTransform() ?? IDENTITY;
  layer.setTransform(multiply(inverse(parentWorld), multiply(operation, layer.worldTransform())));
}

export function translation(x: number, y: number): Matrix { return [1, 0, 0, 1, x, y]; }

export function around(center: Point, matrix: Matrix): Matrix {
  return multiply(translation(center.x, center.y), multiply(matrix, translation(-center.x, -center.y)));
}

export function snapTransform(target: TransformGeometry, proposed: Matrix, options: SnapOptions): Matrix {
  const parentWorld = target.parent?.worldTransform() ?? IDENTITY;
  const bounds = transformBounds(multiply(parentWorld, proposed), target.localBounds());
  const xs = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
  const ys = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
  const xTargets = [options.frame.x, options.frame.x + options.frame.width / 2, options.frame.x + options.frame.width];
  const yTargets = [options.frame.y, options.frame.y + options.frame.height / 2, options.frame.y + options.frame.height];
  for (const bounds of options.otherBounds) {
    xTargets.push(bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width);
    yTargets.push(bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height);
  }
  if (options.guideLines) {
    for (const guide of options.guides) (guide.axis === 'vertical' ? xTargets : yTargets).push(guide.position);
  }
  if (options.grid) {
    for (const x of xs) xTargets.push(Math.round(x / options.gridSize) * options.gridSize);
    for (const y of ys) yTargets.push(Math.round(y / options.gridSize) * options.gridSize);
  }
  const dx = options.axis === 'y' ? 0 : closestOffset(xs, xTargets, options.threshold);
  const dy = options.axis === 'x' ? 0 : closestOffset(ys, yTargets, options.threshold);
  if (!dx && !dy) return proposed;
  return multiply(inverse(parentWorld), multiply(translation(dx, dy), multiply(parentWorld, proposed)));
}

function closestOffset(features: readonly number[], targets: readonly number[], threshold: number): number {
  let best = 0;
  let distance = threshold + Number.EPSILON;
  for (const feature of features) for (const target of targets) {
    const current = Math.abs(target - feature);
    if (current < distance) { best = target - feature; distance = current; }
  }
  return distance <= threshold ? best : 0;
}
