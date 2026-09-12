import type { CurveChannel, CurvePoint, CurvesFilter } from '../filters/curves-filter';
import type { FilterUIContext } from '../filters/filter';

interface CurveChannelChoice {
  value: CurveChannel;
  label: string;
}

interface NumericField {
  label: HTMLLabelElement;
  input: HTMLInputElement;
}

const CHANNELS: readonly CurveChannelChoice[] = [
  { value: 'rgb', label: 'RGB' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
];

export function drawCurvesControls(container: HTMLElement, context: FilterUIContext, filter: CurvesFilter): void {
  const panel = document.createElement('div');
  panel.className = 'curves-editor';
  const channel = document.createElement('select');
  channel.setAttribute('aria-label', 'Curve channel');
  for (const item of CHANNELS) channel.add(new Option(item.label, item.value));
  channel.value = filter.selectedChannel;
  const graph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  graph.classList.add('curves-graph');
  graph.setAttribute('viewBox', '0 0 256 160');
  graph.setAttribute('preserveAspectRatio', 'none');
  graph.setAttribute('aria-label', 'Tone curve');
  graph.tabIndex = 0;
  const controls = document.createElement('div');
  controls.className = 'curves-controls';
  const xField = numberField('Input', 0, 255);
  const yField = numberField('Output', 0, 255);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Delete point';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset';
  controls.append(xField.label, yField.label, remove, reset);
  panel.append(channel, graph, controls);
  container.append(panel);
  let selected = 0;
  let dragging = false;

  const points = () => filter.curves[filter.selectedChannel];
  const syncFields = () => {
    const point = points()[selected];
    if (!point) return;
    if (document.activeElement !== xField.input) xField.input.value = String(Math.round(point.x * 255));
    if (document.activeElement !== yField.input) yField.input.value = String(Math.round(point.y * 255));
    xField.input.disabled = selected === 0 || selected === points().length - 1;
    remove.disabled = points().length <= 2 || selected === 0 || selected === points().length - 1;
  };
  const render = () => {
    graph.replaceChildren();
    for (let index = 1; index < 4; index++) {
      const x = index * 64;
      graph.append(line(x, 0, x, 160, 'curves-grid'));
    }
    for (let index = 1; index < 4; index++) {
      const y = index * 40;
      graph.append(line(0, y, 256, y, 'curves-grid'));
    }
    graph.append(line(0, 160, 256, 0, 'curves-diagonal'));
    const curve = points();
    const path = document.createElementNS(graph.namespaceURI, 'path');
    path.setAttribute('d', `M ${curve.map((point) => `${point.x * 256} ${(1 - point.y) * 160}`).join(' L ')}`);
    path.setAttribute('class', `curves-line ${filter.selectedChannel}`);
    graph.append(path);
    curve.forEach((point, index) => {
      const handle = document.createElementNS(graph.namespaceURI, 'circle');
      handle.setAttribute('cx', String(point.x * 256));
      handle.setAttribute('cy', String((1 - point.y) * 160));
      handle.setAttribute('r', index === selected ? '5' : '4');
      handle.setAttribute('class', `curves-point${index === selected ? ' selected' : ''}`);
      graph.append(handle);
    });
    syncFields();
  };
  const position = (event: PointerEvent): CurvePoint => {
    const bounds = graph.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height)),
    };
  };
  const moveSelected = (point: CurvePoint) => {
    const curve = points();
    const previous = curve[selected - 1];
    const next = curve[selected + 1];
    const margin = previous && next ? Math.min(0.002, (next.x - previous.x) / 3) : 0;
    const x = selected === 0 || selected === curve.length - 1 ? curve[selected].x : Math.max(previous.x + margin, Math.min(next.x - margin, point.x));
    context.preview(() => { curve[selected] = { x, y: point.y }; });
    render();
  };
  graph.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = position(event);
    const curve = points();
    let nearest = 0;
    let distance = Infinity;
    curve.forEach((candidate, index) => {
      const current = Math.hypot((candidate.x - point.x) * 256, (candidate.y - point.y) * 160);
      if (current < distance) { distance = current; nearest = index; }
    });
    if (distance > 10 && curve.length < 8 && point.x > 0.002 && point.x < 0.998) {
      nearest = curve.findIndex((candidate) => candidate.x > point.x);
      const previous = curve[nearest - 1];
      const next = curve[nearest];
      const margin = Math.min(0.002, (next.x - previous.x) / 3);
      point.x = Math.max(previous.x + margin, Math.min(next.x - margin, point.x));
      context.begin('Change curves');
      context.preview(() => curve.splice(nearest, 0, point));
    } else if (distance > 10) {
      selected = nearest;
      render();
      return;
    } else context.begin('Change curves');
    selected = nearest;
    dragging = true;
    graph.setPointerCapture(event.pointerId);
    moveSelected(point);
  };
  graph.onpointermove = (event) => { if (dragging) moveSelected(position(event)); };
  const finish = () => { if (dragging) { dragging = false; context.commit(); } };
  graph.onpointerup = finish;
  graph.onpointercancel = finish;
  graph.onlostpointercapture = finish;
  channel.onchange = () => {
    filter.selectedChannel = channel.value as CurveChannel;
    selected = 0;
    render();
  };
  const editField = (field: HTMLInputElement, axis: 'x' | 'y') => {
    field.oninput = () => {
      if (!Number.isFinite(field.valueAsNumber)) return;
      const point = { ...points()[selected], [axis]: Math.max(0, Math.min(1, field.valueAsNumber / 255)) };
      context.begin('Change curves');
      moveSelected(point);
    };
    field.onchange = () => context.commit();
    field.onblur = () => { context.commit(); syncFields(); };
  };
  editField(xField.input, 'x');
  editField(yField.input, 'y');
  remove.onclick = () => {
    if (remove.disabled) return;
    context.begin('Delete curve point');
    context.preview(() => points().splice(selected, 1));
    selected = Math.max(0, selected - 1);
    context.commit();
    render();
  };
  reset.onclick = () => {
    context.begin('Reset curve');
    context.preview(() => { filter.curves[filter.selectedChannel] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]; });
    selected = 0;
    context.commit();
    render();
  };
  render();
}

function numberField(label: string, min: number, max: number): NumericField {
  const element = document.createElement('label');
  element.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  element.append(input);
  return { label: element, input };
}

function line(x1: number, y1: number, x2: number, y2: number, className: string): SVGLineElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  element.setAttribute('x1', String(x1));
  element.setAttribute('y1', String(y1));
  element.setAttribute('x2', String(x2));
  element.setAttribute('y2', String(y2));
  element.setAttribute('class', className);
  return element;
}
