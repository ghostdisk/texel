import type { FilterUIContext } from '../filters/filter';

export interface LevelsState {
  inputBlack: number;
  inputWhite: number;
  gamma: number;
  outputBlack: number;
  outputWhite: number;
}

type LevelKey = keyof LevelsState;

export function drawLevelsControls(container: HTMLElement, context: FilterUIContext, values: LevelsState): void {
  const panel = document.createElement('div');
  panel.className = 'levels-editor';
  const heading = (text: string) => {
    const label = document.createElement('div');
    label.className = 'levels-heading';
    label.textContent = text;
    panel.append(label);
  };
  const fields = new Map<LevelKey, HTMLInputElement>();
  const handles = new Map<LevelKey, HTMLButtonElement>();
  const limits = (key: LevelKey): [number, number] => {
    if (key === 'gamma') return [0.1, 10];
    if (key === 'inputBlack') return [0, values.inputWhite - 1];
    if (key === 'inputWhite') return [values.inputBlack + 1, 255];
    return [0, 255];
  };
  const position = (key: LevelKey) => key === 'gamma'
    ? (values.inputBlack + (values.inputWhite - values.inputBlack) * 0.5 ** values.gamma) / 255
    : values[key] / 255;
  const sync = () => {
    for (const [key, field] of fields) {
      if (document.activeElement !== field) field.value = key === 'gamma' ? values[key].toFixed(2) : String(values[key]);
    }
    for (const [key, handle] of handles) {
      const [min, max] = limits(key);
      handle.style.left = `${position(key) * 100}%`;
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuemax', String(max));
      handle.setAttribute('aria-valuenow', String(values[key]));
    }
  };
  const change = (key: LevelKey, value: number) => {
    if (!Number.isFinite(value)) return;
    const [min, max] = limits(key);
    const next = Math.max(min, Math.min(max, key === 'gamma' ? Math.round(value * 100) / 100 : Math.round(value)));
    context.begin('Change levels');
    context.preview(() => { values[key] = next; });
    sync();
  };
  const track = (keys: readonly LevelKey[], labels: readonly string[]) => {
    const strip = document.createElement('div');
    strip.className = 'levels-track';
    keys.forEach((key, index) => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = `levels-handle ${key === 'gamma' ? 'midpoint' : key.endsWith('Black') ? 'black' : 'white'}`;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', labels[index]);
      handle.title = labels[index];
      let dragging = false;
      const move = (event: PointerEvent) => {
        const rect = strip.getBoundingClientRect();
        if (rect.width === 0) return;
        const value = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 255;
        if (key === 'gamma') {
          const fraction = Math.max(0.001, Math.min(0.999, (value - values.inputBlack) / (values.inputWhite - values.inputBlack)));
          change(key, Math.log(fraction) / Math.log(0.5));
        } else change(key, value);
      };
      handle.onpointerdown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        context.begin('Change levels');
        dragging = true;
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        move(event);
      };
      handle.onpointermove = (event) => { if (dragging) move(event); };
      const finish = () => { if (dragging) { dragging = false; context.commit(); } };
      handle.onpointerup = finish;
      handle.onpointercancel = finish;
      handle.onlostpointercapture = finish;
      handle.onkeydown = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const [min, max] = limits(key);
        const step = key === 'gamma' ? -0.05 : event.shiftKey ? 10 : 1;
        change(key, event.key === 'Home' ? min : event.key === 'End' ? max : values[key] + (event.key === 'ArrowRight' ? step : -step));
      };
      handle.onkeyup = (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) context.commit(); };
      handle.onblur = () => context.commit();
      handles.set(key, handle);
      strip.append(handle);
    });
    panel.append(strip);
    const row = document.createElement('div');
    row.className = 'levels-values';
    keys.forEach((key, index) => {
      const label = document.createElement('label');
      label.className = 'levels-value';
      const field = document.createElement('input');
      field.type = 'number';
      const [min, max] = key === 'gamma' ? [0.1, 10] : [0, 255];
      field.min = String(min);
      field.max = String(max);
      field.step = key === 'gamma' ? '0.01' : '1';
      field.setAttribute('aria-label', labels[index]);
      field.title = labels[index];
      field.oninput = () => change(key, field.valueAsNumber);
      field.onchange = () => context.commit();
      field.onblur = () => { context.commit(); sync(); };
      fields.set(key, field);
      label.append(field);
      row.append(label);
    });
    panel.append(row);
  };

  heading('Input levels · RGB');
  const histogram = document.createElement('canvas');
  histogram.className = 'levels-histogram';
  histogram.width = 256;
  histogram.height = 100;
  histogram.setAttribute('aria-label', 'Input RGB histogram');
  panel.append(histogram);
  track(['inputBlack', 'gamma', 'inputWhite'], ['Input black', 'Midtone gamma', 'Input white']);
  heading('Output levels');
  track(['outputBlack', 'outputWhite'], ['Output black', 'Output white']);
  container.append(panel);
  sync();
  if (context.histogram) void context.histogram().then((bins) => {
    if (!histogram.isConnected) return;
    const canvas = histogram.getContext('2d')!;
    const maximum = Math.max(1, ...bins);
    canvas.clearRect(0, 0, 256, 100);
    canvas.fillStyle = '#aeb2bd';
    for (let bin = 0; bin < 256; bin++) {
      const height = bins[bin] * 96 / maximum;
      canvas.fillRect(bin, 100 - height, 1, height);
    }
  }).catch((error: unknown) => { histogram.title = error instanceof Error ? error.message : 'Histogram unavailable'; });
}

