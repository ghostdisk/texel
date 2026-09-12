import shader from '../shaders/sharpen.wgsl?raw';
import { GaussianBlur } from '../gpu/blur';
import type { Gpu } from '../gpu/device';
import type { Surface } from '../gpu/surface';
import type { JsonObject } from '../history/undo';
import type { Rect } from '../model/geometry';
import { drawFilterSlider, filterNumber } from './controls';
import { Filter } from './filter';
import type { FilterRenderContext, FilterUIContext } from './filter';

export class SharpenFilter extends Filter {
  readonly kind = 'sharpen';
  readonly label = 'Sharpen';
  amount = 100;
  radius = 1;
  threshold = 0;
  private static blurs = new WeakMap<Gpu, GaussianBlur>();
  private static pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();

  outputBounds(input: Rect): Rect { return input; }
  protected properties(): JsonObject { return { amount: this.amount, radius: this.radius, threshold: this.threshold }; }

  protected loadProperties(properties: JsonObject): void {
    this.amount = filterNumber(properties, 'amount', 0, 500);
    this.radius = filterNumber(properties, 'radius', 0.1, 32);
    this.threshold = filterNumber(properties, 'threshold', 0, 100);
  }

  render(context: FilterRenderContext, input: Surface): Surface {
    if (this.amount === 0) return input;
    let blur = SharpenFilter.blurs.get(context.gpu);
    if (!blur) { blur = new GaussianBlur(context.gpu); SharpenFilter.blurs.set(context.gpu, blur); }
    const reduction = Math.max(1, 2 ** Math.ceil(Math.log2(this.radius * input.scale / 32)));
    const scale = input.scale / reduction;
    const blurInput = context.surface('blur-input', input.bounds, scale);
    const scratch = context.surface('blur-scratch', input.bounds, scale);
    const smallBlur = context.surface('small-blur', input.bounds, scale);
    context.quads.copy(context.frame, input, blurInput);
    blur.encode(context.frame, blurInput, scratch, smallBlur, this.radius * scale);
    let blurred = smallBlur;
    if (reduction > 1) {
      blurred = context.surface('blurred', input.bounds, input.scale);
      context.quads.copy(context.frame, smallBlur, blurred);
    }
    const output = context.surface('output', input.bounds, input.scale);
    const { device } = context.gpu;
    let pipeline = SharpenFilter.pipelines.get(device);
    if (!pipeline) {
      pipeline = device.createComputePipeline({
        label: this.label, layout: 'auto',
        compute: { module: device.createShaderModule({ label: this.label, code: shader }), entryPoint: 'main' },
      });
      SharpenFilter.pipelines.set(device, pipeline);
    }
    const pass = context.frame.encoder.beginComputePass({ label: this.label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: input.view }, { binding: 1, resource: blurred.view }, { binding: 2, resource: output.view },
      { binding: 3, resource: context.frame.uniform([this.amount / 100, this.threshold / 100, 0, 0]) },
    ] }));
    pass.dispatchWorkgroups(Math.ceil(input.texture.width / 8), Math.ceil(input.texture.height / 8));
    pass.end();
    return output;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawFilterSlider(container, context, {
      label: 'Amount', min: 0, max: 500, step: 1, format: (value) => `${value}%`,
      get: () => this.amount, set: (value) => { this.amount = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Radius', min: 0.1, max: 32, step: 0.1, format: (value) => `${value.toFixed(1)} px`,
      get: () => this.radius, set: (value) => { this.radius = value; },
    });
    drawFilterSlider(container, context, {
      label: 'Threshold', min: 0, max: 100, step: 1, format: (value) => `${value}%`,
      get: () => this.threshold, set: (value) => { this.threshold = value; },
    });
  }
}
