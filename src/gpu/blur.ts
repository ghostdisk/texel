import shader from '../shaders/blur.wgsl?raw';
import type { GpuFrame } from './device';
import { dispatchLocal } from './local';
import type { Surface } from './surface';

export class GaussianBlur {
  private readonly kernels = new Map<number, number[]>();

  encode(frame: GpuFrame, input: Surface, scratch: Surface, output: Surface, sigma: number): void {
    const radius = Math.ceil(3 * sigma);
    const weights = this.kernel(sigma, radius);
    const reach = radius / input.scale;
    dispatchLocal(frame, input, scratch, {
      code: shader, label: 'Blur horizontal', parameters: [0, radius, 0, 0, ...weights], radius,
      regions: input.regions.map((bounds) => ({ ...bounds, x: bounds.x - reach, width: bounds.width + 2 * reach })),
      workgroups: [2, 256],
    });
    dispatchLocal(frame, scratch, output, {
      code: shader, label: 'Blur vertical', parameters: [1, radius, 0, 0, ...weights], radius,
      regions: scratch.regions.map((bounds) => ({ ...bounds, y: bounds.y - reach, height: bounds.height + 2 * reach })),
      workgroups: [2, 256],
    });
  }

  private kernel(sigma: number, radius: number): number[] {
    if (radius > 256) throw new Error('Gaussian support exceeds one tile.');
    const cached = this.kernels.get(sigma);
    if (cached) return cached;
    const weights = Array<number>(260).fill(0);
    let total = 0;
    for (let index = 0; index <= radius; index++) {
      weights[index] = sigma === 0 ? Number(index === 0) : Math.exp(-(index * index) / (2 * sigma * sigma));
      total += weights[index] * (index === 0 ? 1 : 2);
    }
    for (let index = 0; index <= radius; index++) weights[index] /= total;
    if (this.kernels.size >= 128) this.kernels.clear();
    this.kernels.set(sigma, weights);
    return weights;
  }
}


export const gaussianBlur = new GaussianBlur();
