import './style.css';
import { Gpu } from './gpu/device';
import { Compositor } from './gpu/compositor';
import { Brush } from './gpu/brush';
import type { BrushStamp } from './gpu/brush';
import { createImageLayer, importImage } from './gpu/images';
import { GroupLayer, ImageLayer, Layer } from './model/layers';
import type { BlendMode } from './model/layers';
import { inverse, maxScale, multiply, transformPoint } from './model/geometry';
import type { Point, Rect } from './model/geometry';

interface Stroke {
  layer: ImageLayer;
  last: Point;
  pointerId: number;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing interface element: ${id}`);
  return found as T;
}
const input = (id: string) => element<HTMLInputElement>(id);

function reportError(error: unknown): void {
  const banner = element('error');
  banner.textContent = error instanceof Error ? error.message : String(error);
  banner.hidden = false;
}

function run(action: () => unknown): void {
  element('error').hidden = true;
  try { void Promise.resolve(action()).catch(reportError); }
  catch (error) { reportError(error); }
}

async function boot(): Promise<void> {
  const canvas = element<HTMLCanvasElement>('canvas');
  canvas.tabIndex = 0;
  const stage = element('stage');
  const gpu = await Gpu.create();
  let halted = false;
  let scheduledFrame = 0;
  gpu.device.addEventListener('uncapturederror', (event) => {
    if (halted) return;
    element('app').inert = true;
    halted = true;
    cancelAnimationFrame(scheduledFrame);
    reportError(new Error(`GPU error: ${event.error.message}`));
  });
  void gpu.device.lost.then((info) => {
    halted = true;
    cancelAnimationFrame(scheduledFrame);
    element('app').inert = true;
    reportError(new Error(`GPU connection lost: ${info.message || info.reason}. Reload to start a new document.`));
  });
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not create a WebGPU canvas.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device: gpu.device, format, alphaMode: 'opaque', colorSpace: 'srgb' });
  const compositor = new Compositor(gpu, format);
  const brush = new Brush(gpu);
  let root = new GroupLayer('Document');
  let frameBounds: Rect = { x: 0, y: 0, width: 1000, height: 750 };
  let selected: Layer = root;
  let cssScale = 1;
  let dialogMode: 'document' | 'layer' = 'document';
  const pendingStamps = new Map<ImageLayer, BrushStamp[]>();
  let stroke: Stroke | null = null;

  function requestFrame(): void {
    if (scheduledFrame || halted) return;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = 0;
      pendingStamps.clear();
      try {
        const stats = compositor.render(root, context!.getCurrentTexture().createView(), frameBounds, canvas.width / frameBounds.width);
        element('render-stats').textContent = `${stats.updatedLayers} updated · ${stats.cachedLayers} cached · ${stats.encodingMs.toFixed(1)} ms encode`;
      } catch (error) { reportError(error); }
    });
  }

  function resize(): void {
    const area = stage.getBoundingClientRect();
    cssScale = Math.max(0.01, Math.min((area.width - 72) / frameBounds.width, (area.height - 72) / frameBounds.height));
    const width = frameBounds.width * cssScale;
    const height = frameBounds.height * cssScale;
    const density = Math.min(devicePixelRatio, gpu.device.limits.maxTextureDimension2D / Math.max(width, height));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const physicalWidth = Math.max(1, Math.round(width * density));
    const physicalHeight = Math.max(1, Math.round(height * density));
    if (canvas.width !== physicalWidth) canvas.width = physicalWidth;
    if (canvas.height !== physicalHeight) canvas.height = physicalHeight;
    requestFrame();
  }

  function allLayers(): Layer[] {
    const layers: Layer[] = [];
    const visit = (layer: Layer) => {
      layers.push(layer);
      if (layer instanceof GroupLayer) layer.children.forEach(visit);
    };
    visit(root);
    return layers;
  }

  function destinationGroup(): GroupLayer { return selected instanceof GroupLayer ? selected : selected.parent ?? root; }

  function selectLayer(layer: Layer): void {
    selected = layer;
    renderTree();
    renderInspector();
  }

  function renderTree(): void {
    const tree = element('layer-tree');
    tree.replaceChildren();
    const visit = (layer: Layer, depth: number) => {
      const row = document.createElement('div');
      row.className = `layer-row${layer === selected ? ' selected' : ''}`;
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const visibility = document.createElement('button');
      visibility.className = 'visibility';
      visibility.textContent = layer.visible ? '●' : '○';
      visibility.setAttribute('aria-label', `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`);
      visibility.onclick = () => { layer.setVisible(!layer.visible); renderTree(); };
      const choose = document.createElement('button');
      choose.className = 'select-layer';
      choose.setAttribute('aria-pressed', String(layer === selected));
      const icon = document.createElement('span');
      icon.className = 'layer-icon';
      icon.textContent = layer instanceof GroupLayer ? '▱' : '▧';
      const name = document.createElement('span');
      name.className = 'layer-title';
      name.textContent = layer.name;
      choose.append(icon, name);
      choose.onclick = () => selectLayer(layer);
      row.append(visibility, choose);
      if (layer.filters.length) {
        const badge = document.createElement('span');
        badge.className = 'layer-badge';
        badge.textContent = 'fx';
        row.append(badge);
      }
      tree.append(row);
      if (layer instanceof GroupLayer) [...layer.children].reverse().forEach((child) => visit(child, depth + 1));
    };
    visit(root, 0);
    element('layer-count').textContent = String(allLayers().length - 1);
    const index = selected.parent?.children.indexOf(selected) ?? -1;
    element<HTMLButtonElement>('layer-up').disabled = !selected.parent || index === selected.parent.children.length - 1;
    element<HTMLButtonElement>('layer-down').disabled = !selected.parent || index === 0;
    element<HTMLButtonElement>('remove-layer').disabled = selected === root;
  }

  function renderInspector(): void {
    input('layer-name').value = selected.name;
    element('layer-kind').textContent = selected === root ? 'ROOT' : selected.kind.toUpperCase();
    element('layer-size').textContent = selected instanceof ImageLayer
      ? `${selected.width} × ${selected.height} native pixels`
      : `${(selected as GroupLayer).children.length} children · isolated group`;
    element('selection-hint').textContent = selected instanceof ImageLayer
      ? `${selected.name} · Brush size is measured in layer pixels`
      : 'Select a pixel layer to paint. Group filters apply to all its children.';
    input('layer-opacity').value = String(Math.round(selected.opacity * 100));
    const blend = element<HTMLSelectElement>('layer-blend');
    blend.value = selected.blendMode;
    blend.disabled = selected === root;
    element('transform-fields').hidden = selected === root;
    element('parent-field').hidden = selected === root;
    const matrix = selected.transform;
    input('layer-x').value = String(Number(matrix[4].toFixed(2)));
    input('layer-y').value = String(Number(matrix[5].toFixed(2)));
    input('layer-scale').value = String(Number((Math.hypot(matrix[0], matrix[1]) * 100).toFixed(2)));
    input('layer-angle').value = String(Number((Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI).toFixed(2)));
    const parentSelect = element<HTMLSelectElement>('layer-parent');
    parentSelect.replaceChildren();
    for (const layer of allLayers()) {
      if (!(layer instanceof GroupLayer)) continue;
      let ancestor: Layer | null = layer;
      while (ancestor && ancestor !== selected) ancestor = ancestor.parent;
      if (ancestor === selected) continue;
      parentSelect.add(new Option(layer.name, layer.id));
    }
    parentSelect.value = selected.parent?.id ?? '';
    renderFilters();
  }

  function renderFilters(): void {
    const layer = selected;
    const stack = element('filter-stack');
    stack.replaceChildren();
    element('filter-hint').textContent = layer === root
      ? 'Root filters apply to the complete composition.'
      : 'Filters keep the original pixels intact.';
    for (const filter of layer.filters) {
      const card = document.createElement('div');
      card.className = 'filter';
      const header = document.createElement('div');
      header.className = 'filter-header';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = filter.enabled;
      enabled.setAttribute('aria-label', 'Enable Gaussian blur');
      enabled.onchange = () => layer.setFilters(layer.filters.map((item) => item.id === filter.id ? { ...item, enabled: enabled.checked } : item));
      const title = document.createElement('span');
      title.textContent = 'Gaussian blur';
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove blur');
      remove.onclick = () => { layer.setFilters(layer.filters.filter((item) => item.id !== filter.id)); renderFilters(); renderTree(); };
      header.append(enabled, title, remove);
      const controls = document.createElement('div');
      controls.className = 'filter-controls';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '32';
      range.step = '0.25';
      range.value = String(filter.sigma);
      range.setAttribute('aria-label', 'Blur sigma in local pixels');
      const amount = document.createElement('output');
      amount.textContent = `${filter.sigma} px`;
      range.oninput = () => {
        const sigma = Number(range.value);
        amount.textContent = `${sigma} px`;
        layer.setFilters(layer.filters.map((item) => item.id === filter.id ? { ...item, sigma } : item));
      };
      controls.append(range, amount);
      card.append(header, controls);
      stack.append(card);
    }
  }

  function createDocument(width: number, height: number): void {
    const layer = createImageLayer(gpu, 'Pixel layer', width, height);
    stroke = null;
    pendingStamps.clear();
    compositor.release(root);
    root.onInvalidated = undefined;
    root = new GroupLayer('Document');
    root.onInvalidated = requestFrame;
    frameBounds = { x: 0, y: 0, width, height };
    root.add(layer);
    element('frame-label').textContent = `${width} : ${height}`;
    selectLayer(layer);
    resize();
  }

  function showSizeDialog(mode: 'document' | 'layer'): void {
    dialogMode = mode;
    element('dialog-title').textContent = mode === 'document' ? 'New document' : 'New pixel layer';
    element('dialog-description').textContent = mode === 'document'
      ? 'Replace the current document. These dimensions set the framing aspect and the first layer’s pixels.'
      : 'Choose this layer’s native resolution. Its transform controls how it fits in the composition.';
    element('confirm-size').textContent = mode === 'document' ? 'Create document' : 'Add layer';
    element('new-layer-name-field').hidden = mode === 'document';
    input('new-width').value = String(frameBounds.width);
    input('new-height').value = String(frameBounds.height);
    input('new-width').max = String(gpu.device.limits.maxTextureDimension2D);
    input('new-height').max = String(gpu.device.limits.maxTextureDimension2D);
    element<HTMLDialogElement>('size-dialog').showModal();
  }

  async function addImage(name: string, blob: Blob): Promise<void> {
    const originalRoot = root;
    const parent = destinationGroup();
    const layer = await importImage(gpu, compositor.quads, name, blob);
    if (originalRoot !== root || !allLayers().includes(parent)) { layer.sourceTexture.destroy(); return; }
    try {
      const scale = Math.min(1, frameBounds.width / layer.width, frameBounds.height / layer.height);
      const x = (frameBounds.width - layer.width * scale) / 2;
      const y = (frameBounds.height - layer.height * scale) / 2;
      layer.setTransform(multiply(inverse(parent.worldTransform()), [scale, 0, 0, scale, x, y]));
      parent.add(layer);
      selectLayer(layer);
    } catch (error) { layer.sourceTexture.destroy(); throw error; }
  }

  element('new-document').onclick = () => showSizeDialog('document');
  element('add-layer').onclick = () => showSizeDialog('layer');
  element('cancel-size').onclick = () => element<HTMLDialogElement>('size-dialog').close();
  element('size-form').onsubmit = (event) => {
    event.preventDefault();
    run(() => {
      const width = input('new-width').valueAsNumber;
      const height = input('new-height').valueAsNumber;
      if (dialogMode === 'document') createDocument(width, height);
      else {
        const layer = createImageLayer(gpu, input('new-layer-name').value.trim() || 'Pixel layer', width, height);
        destinationGroup().add(layer);
        selectLayer(layer);
      }
      element<HTMLDialogElement>('size-dialog').close();
    });
  };
  element('open-image').onclick = () => run(async () => {
    const image = await window.desktop.openImage();
    if (image) await addImage(image.name, new Blob([image.bytes]));
  });
  element('add-group').onclick = () => {
    const group = new GroupLayer('Group');
    destinationGroup().add(group);
    selectLayer(group);
  };
  element('remove-layer').onclick = () => {
    if (!selected.parent) return;
    stroke = null;
    const parent = selected.parent;
    parent.remove(selected);
    compositor.release(selected);
    selectLayer(parent);
  };
  element('layer-up').onclick = () => { selected.parent?.move(selected, 1); renderTree(); };
  element('layer-down').onclick = () => { selected.parent?.move(selected, -1); renderTree(); };
  input('layer-name').onchange = () => { selected.name = input('layer-name').value.trim() || 'Untitled layer'; renderTree(); renderInspector(); };
  input('layer-opacity').oninput = () => selected.setOpacity(input('layer-opacity').valueAsNumber / 100);
  element<HTMLSelectElement>('layer-blend').onchange = () => selected.setBlendMode(element<HTMLSelectElement>('layer-blend').value as BlendMode);
  element<HTMLSelectElement>('layer-parent').onchange = () => run(() => {
    const parent = allLayers().find((layer) => layer.id === element<HTMLSelectElement>('layer-parent').value);
    if (!(parent instanceof GroupLayer) || selected === root) return;
    const matrix = multiply(inverse(parent.worldTransform()), selected.worldTransform());
    parent.add(selected);
    selected.setTransform(matrix);
    renderTree();
    renderInspector();
  });
  for (const id of ['layer-x', 'layer-y', 'layer-scale', 'layer-angle']) {
    input(id).onchange = () => run(() => {
      const scale = Math.max(0.01, Math.min(100, input('layer-scale').valueAsNumber / 100));
      const angle = input('layer-angle').valueAsNumber * Math.PI / 180;
      const cosine = Math.cos(angle) * scale;
      const sine = Math.sin(angle) * scale;
      selected.setTransform([cosine, sine, -sine, cosine, input('layer-x').valueAsNumber, input('layer-y').valueAsNumber]);
      renderInspector();
    });
  }
  element('add-blur').onclick = () => {
    selected.setFilters([...selected.filters, { id: crypto.randomUUID(), kind: 'blur', enabled: true, sigma: 6 }]);
    renderFilters();
    renderTree();
  };

  document.addEventListener('paste', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const images = [...(event.clipboardData?.items ?? [])].filter((item) => item.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    run(async () => {
      for (const item of images) {
        const file = item.getAsFile();
        if (file) await addImage('Pasted image', file);
      }
    });
  });
  stage.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  stage.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    run(async () => { for (const file of files) if (file.type.startsWith('image/')) await addImage(file.name, file); });
  });

  function localPoint(event: PointerEvent, layer: ImageLayer): Point {
    const area = canvas.getBoundingClientRect();
    return transformPoint(inverse(layer.worldTransform()), {
      x: frameBounds.x + (event.clientX - area.left) / area.width * frameBounds.width,
      y: frameBounds.y + (event.clientY - area.top) / area.height * frameBounds.height,
    });
  }

  function stamp(layer: ImageLayer, position: Point, pressure: number): void {
    const hex = input('brush-color').value.slice(1);
    const rgb = [0, 2, 4].map((offset) => {
      const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    let stamps = pendingStamps.get(layer);
    if (!stamps) {
      stamps = [];
      pendingStamps.set(layer, stamps);
      compositor.enqueue(layer, brush.operation(stamps));
    }
    stamps.push({
      x: position.x, y: position.y,
      radius: input('brush-size').valueAsNumber * Math.max(0.05, pressure) / 2,
      hardness: input('brush-hardness').valueAsNumber,
      color: [rgb[0], rgb[1], rgb[2], input('brush-flow').valueAsNumber],
    });
  }

  function moveStroke(event: PointerEvent): void {
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const point = localPoint(event, stroke.layer);
    const pressure = event.pointerType === 'pen' ? event.pressure : 1;
    const spacing = Math.max(0.25, input('brush-size').valueAsNumber * Math.max(0.05, pressure) * 0.1);
    let distance = Math.hypot(point.x - stroke.last.x, point.y - stroke.last.y);
    while (distance >= spacing) {
      const amount = spacing / distance;
      stroke.last = { x: stroke.last.x + (point.x - stroke.last.x) * amount, y: stroke.last.y + (point.y - stroke.last.y) * amount };
      stamp(stroke.layer, stroke.last, pressure);
      distance = Math.hypot(point.x - stroke.last.x, point.y - stroke.last.y);
    }
  }

  function updateCursor(event: PointerEvent): void {
    const cursor = element('brush-cursor');
    cursor.hidden = !(selected instanceof ImageLayer);
    if (cursor.hidden) return;
    const area = stage.getBoundingClientRect();
    const diameter = input('brush-size').valueAsNumber * maxScale(selected.worldTransform()) * cssScale;
    cursor.style.left = `${event.clientX - area.left}px`;
    cursor.style.top = `${event.clientY - area.top}px`;
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
  }

  canvas.addEventListener('pointerdown', (event) => run(() => {
    if (!(selected instanceof ImageLayer) || event.button !== 0 || halted || stroke) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    const point = localPoint(event, selected);
    canvas.setPointerCapture(event.pointerId);
    stroke = { layer: selected, last: point, pointerId: event.pointerId };
    stamp(selected, point, event.pointerType === 'pen' ? event.pressure : 1);
  }));
  canvas.addEventListener('pointermove', (event) => {
    updateCursor(event);
    if (!stroke) return;
    run(() => {
      const samples = event.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event]) moveStroke(sample);
    });
  });
  canvas.addEventListener('pointerup', (event) => {
    if (stroke?.pointerId !== event.pointerId) return;
    run(() => moveStroke(event));
    stroke = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointercancel', () => { stroke = null; });
  canvas.addEventListener('lostpointercapture', () => { stroke = null; });
  canvas.addEventListener('pointerleave', () => { element('brush-cursor').hidden = true; });
  input('brush-size').oninput = () => { element('brush-size-label').textContent = `${input('brush-size').value} px`; };

  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  createDocument(1000, 750);
  element('app').inert = false;
}

void boot().catch(reportError);


