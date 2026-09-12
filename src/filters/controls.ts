import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { SliderInput } from '../ui/slider-input';

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
  format?: (value: number) => string;
  unit?: string;
}

export function drawFilterSlider(container: HTMLElement, context: FilterUIContext, options: SliderOptions): void {
  const label = document.createElement('label');
  label.className = 'filter-parameter';
  const heading = document.createElement('span');
  heading.textContent = options.label;
  const controls = document.createElement('span');
  controls.className = 'filter-controls';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(options.min);
  slider.max = String(options.max);
  slider.step = String(options.step);
  slider.setAttribute('aria-label', options.label);
  const output = document.createElement('output');
  const sync = () => {
    const value = options.get();
    slider.value = String(value);
    output.textContent = options.format?.(value) ?? String(value);
  };
  slider.oninput = () => {
    const value = slider.valueAsNumber;
    context.begin(`Change ${options.label.toLowerCase()}`);
    context.preview(() => options.set(value));
    sync();
  };
  slider.onchange = () => context.commit();
  slider.onblur = () => context.commit();
  sync();
  controls.append(slider, output);
  label.append(heading, controls);
  container.append(label);
}

export function drawFilterSliderInput(container: HTMLElement, context: FilterUIContext, options: SliderOptions): void {
  const control = new SliderInput({
    label: options.label, min: options.min, max: options.max, step: options.step, unit: options.unit, get: options.get,
    begin: () => context.begin(`Change ${options.label.toLowerCase()}`),
    input: (value) => context.preview(() => options.set(value)),
    commit: () => context.commit(),
  });
  container.append(control.element);
}

export function filterNumber(properties: JsonObject, key: string, min: number, max: number, integer = false): number {
  const value = properties[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`Filter property ${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

export function drawFilterNumber(container: HTMLElement, context: FilterUIContext, options: SliderOptions): void {
  const label = document.createElement('label');
  label.className = 'filter-number';
  const text = document.createElement('span');
  text.textContent = options.label;
  const field = document.createElement('input');
  field.type = 'number';
  field.min = String(options.min);
  field.max = String(options.max);
  field.step = String(options.step);
  field.value = String(Number(options.get().toFixed(3)));
  field.oninput = () => {
    const value = field.valueAsNumber;
    if (!Number.isFinite(value)) return;
    context.begin(`Change ${options.label.toLowerCase()}`);
    context.preview(() => options.set(Math.max(options.min, Math.min(options.max, value))));
  };
  field.onchange = () => context.commit();
  field.onblur = () => { context.commit(); field.value = String(Number(options.get().toFixed(3))); };
  label.append(text, field);
  container.append(label);
}

export function drawFilterColor(container: HTMLElement, context: FilterUIContext, name: string, get: () => string, set: (value: string) => void): void {
  const label = document.createElement('label');
  label.className = 'filter-color';
  const text = document.createElement('span');
  text.textContent = name;
  const field = document.createElement('input');
  field.type = 'color';
  field.value = get();
  field.oninput = () => {
    const value = field.value;
    context.begin('Change effect color');
    context.preview(() => set(value));
  };
  field.onchange = () => context.commit();
  field.onblur = () => context.commit();
  label.append(text, field);
  container.append(label);
}

export function filterColor(properties: JsonObject, key: string): string {
  const value = properties[key];
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Filter property ${key} must be an RGB hex color.`);
  return value;
}
