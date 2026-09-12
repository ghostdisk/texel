export interface SliderInputOptions {
  label: string;
  min: number;
  max: number;
  sliderMax?: number;
  step: number;
  unit?: string;
  get(): number;
  begin?(): void;
  input(value: number): void;
  commit?(): void;
}

/** One value with a continuous slider, precise numeric entry, and a shared edit boundary. */
export class SliderInput {
  readonly element = document.createElement('div');
  private readonly range = document.createElement('input');
  private readonly number = document.createElement('input');

  constructor(private readonly options: SliderInputOptions) {
    this.element.className = 'slider-field';
    const label = document.createElement('span');
    label.className = 'slider-label';
    label.textContent = options.label;
    label.title = options.label;
    const controls = document.createElement('div');
    controls.className = 'slider-input';
    this.range.type = 'range';
    this.number.type = 'number';
    for (const field of [this.range, this.number]) {
      field.min = String(options.min);
      field.max = String(field === this.range ? options.sliderMax ?? options.max : options.max);
      field.step = String(options.step);
      field.setAttribute('aria-label', options.label);
      field.oninput = () => {
        const value = field.valueAsNumber;
        if (!Number.isFinite(value)) return;
        options.begin?.();
        const snapped = options.min + Math.round((value - options.min) / options.step) * options.step;
        options.input(Math.max(options.min, Math.min(options.max, Number(snapped.toFixed(8)))));
        this.sync();
      };
      field.onchange = () => this.commit();
      field.onblur = () => this.commit();
    }
    this.range.onpointerdown = () => options.begin?.();
    this.range.onpointerup = () => this.commit();
    this.range.onpointercancel = () => this.commit();
    this.number.onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); this.commit(); }
    };
    const value = document.createElement('span');
    value.className = 'slider-value';
    value.append(this.number);
    if (options.unit) {
      const unit = document.createElement('span');
      unit.className = 'slider-unit';
      unit.textContent = options.unit;
      value.append(unit);
    }
    controls.append(this.range, value);
    this.element.append(label, controls);
    this.sync(true);
  }

  sync(force = false): void {
    const value = Number(this.options.get().toFixed(8));
    this.range.value = String(value);
    this.range.setAttribute('aria-valuetext', `${value}${this.options.unit ?? ''}`);
    if (force || document.activeElement !== this.number) this.number.value = String(value);
  }

  private commit(): void { this.options.commit?.(); this.sync(true); }
}