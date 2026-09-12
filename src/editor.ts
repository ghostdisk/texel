import { ActionRegistry } from './actions';
import { FilterRegistry } from './filters/filter';
import type { Filter } from './filters/filter';
import { BlurFilter } from './filters/blur-filter';
import { SmartBlurFilter } from './filters/smart-blur-filter';
import { BrightnessContrastFilter } from './filters/brightness-contrast-filter';
import { LevelsFilter } from './filters/levels-filter';
import { PosterizeFilter } from './filters/posterize-filter';
import { BorderFilter } from './filters/border-filter';
import { DropShadowFilter } from './filters/drop-shadow-filter';
import { Brush } from './gpu/brush';
import type { BrushStamp } from './gpu/brush';
import { Compositor } from './gpu/compositor';
import type { RenderStats } from './gpu/compositor';
import type { Gpu } from './gpu/device';
import { importImage } from './gpu/images';
import { GpuReadback } from './gpu/readback';
import type { SampledColor } from './gpu/readback';
import { PixelPicker } from './gpu/picking';
import { LayerPreviews } from './ui/layer-previews';
import { UndoOperation, UndoStack } from './history/undo';
import type { UndoDirection } from './history/undo';
import { ImageDocument } from './model/image-document';
import type { ReframeMode } from './model/image-document';
import { GroupLayer, ImageLayer, Layer } from './model/layers';
import type { LayerProperties } from './model/layers';
import { inverse, multiply } from './model/geometry';
import type { Point } from './model/geometry';
import { BrushTool } from './tools/brush-tool';
import { TransformTool } from './tools/transform-tool';
import { EyedropperTool } from './tools/eyedropper-tool';
import type { Tool, ToolPointer } from './tools/tool';
import { Viewport } from './viewport';

interface PointerGesture {
  id: number;
  mode: 'tool' | 'pan';
  last: Point;
}

export class Editor {
  readonly compositor: Compositor;
  readonly brush: Brush;
  readonly filters = new FilterRegistry();
  readonly actions: ActionRegistry;
  readonly history: UndoStack;
  readonly image: ImageDocument;
  readonly viewport = new Viewport();
  readonly tools = new Map<string, Tool>();
  private baseTool: Tool;
  private altHeld = false;
  readonly readback: GpuReadback;
  readonly previews: LayerPreviews;
  private readonly picker: PixelPicker;
  private pickGeneration = 0;
  private previewsRequested = false;
  private previewsRunning = false;
  private previewsReady = false;
  onPreviews?: () => void;
  onColorChange?: (color: string) => void;
  panHeld = false;
  halted = false;
  onChange?: () => void;
  onFrame?: (stats: RenderStats) => void;
  onNewDocument?: () => void;
  onNewLayer?: () => void;
  onRename?: () => void;
  commitEdits?: () => void;
  private scheduledFrame = 0;
  private pendingStamps = new Map<ImageLayer, BrushStamp[]>();
  private pointer: PointerGesture | null = null;
  private context: GPUCanvasContext;
  private lastMenus = '';
  private reframing = false;

  constructor(
    readonly gpu: Gpu,
    readonly canvas: HTMLCanvasElement,
    readonly stage: HTMLElement,
    readonly overlay: SVGSVGElement,
    readonly brushCursor: HTMLElement,
    readonly report: (error: unknown) => void,
  ) {
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not create a WebGPU canvas.');
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device: gpu.device, format, alphaMode: 'opaque', colorSpace: 'srgb' });
    this.compositor = new Compositor(gpu, format);
    this.brush = new Brush(gpu);
    this.readback = new GpuReadback(gpu);
    this.previews = new LayerPreviews(this.readback);
    this.picker = new PixelPicker(this.compositor, this.readback);
    this.filters.register({ kind: 'blur', label: 'Gaussian blur', create: (id) => new BlurFilter(id) });
    this.filters.register({ kind: 'smart-blur', label: 'Smart blur', create: (id) => new SmartBlurFilter(id) });
    this.filters.register({ kind: 'brightness-contrast', label: 'Brightness / contrast', create: (id) => new BrightnessContrastFilter(id) });
    this.filters.register({ kind: 'levels', label: 'Levels', create: (id) => new LevelsFilter(id) });
    this.filters.register({ kind: 'posterize', label: 'Posterize', create: (id) => new PosterizeFilter(id) });
    this.filters.register({ kind: 'border', label: 'Border', create: (id) => new BorderFilter(id) });
    this.filters.register({ kind: 'drop-shadow', label: 'Drop shadow', create: (id) => new DropShadowFilter(id) });
    this.history = new UndoStack((operation, direction) => this.applyUndo(operation, direction));
    this.image = new ImageDocument(gpu, this.compositor, this.filters, this.history, () => this.flushPaint());
    this.actions = new ActionRegistry(report);
    this.baseTool = new BrushTool(this);
    this.tools.set(this.activeTool.id, this.activeTool);
    this.tools.set('transform', new TransformTool(this));
    this.tools.set('eyedropper', new EyedropperTool(this));
    this.image.onInvalidated = () => this.requestRender();
    this.image.onChange = () => this.changed();
    this.history.onChange = () => { this.pickGeneration++; this.queuePreviews(); this.changed(); };
    this.viewport.onChange = () => this.requestRender();
    this.actions.beforeExecute = () => this.finishGesture();
    this.actions.blocked = () => this.halted || this.reframing;
    this.registerActions();
    this.attachInput();
    new ResizeObserver(() => this.resize()).observe(stage);
    window.addEventListener('resize', () => this.resize());
  }

  get activeTool(): Tool { return this.altHeld && this.baseTool.id === 'brush' ? this.tools.get('eyedropper')! : this.baseTool; }
  private get rasterDensity(): number { return this.viewport.scale * this.canvas.width / this.viewport.width; }
  private get interacting(): boolean { return !!this.pointer || !!this.commitEdits; }

  private queuePreviews(): void { this.previewsRequested = true; this.requestRender(); }

  private async refreshPreviews(): Promise<void> {
    this.previewsRequested = false;
    this.previewsRunning = true;
    try {
      this.flushPaint();
      await this.previews.update(this.image.allLayers(), (layer) => this.compositor.resolve(layer, this.rasterDensity));
      this.previewsReady = true;
    } finally {
      this.previewsRunning = false;
      this.requestRender();
    }
  }

  async histogram(layer: Layer, filterId: string): Promise<Uint32Array> {
    this.flushPaint();
    this.compositor.resolve(layer, this.rasterDensity);
    const input = this.compositor.filterInput(layer, filterId);
    return input ? this.readback.histogram(input) : new Uint32Array(256);
  }

  async sampleColor(point: Point): Promise<SampledColor | null> {
    this.flushPaint();
    return this.picker.color(this.image.root, point, this.image.frame, this.rasterDensity);
  }

  setBrushColor(color: string, sampled = false): void {
    if (!sampled) this.tools.get('eyedropper')?.cancel();
    (this.tools.get('brush') as BrushTool).color = color;
    this.onColorChange?.(color);
  }

  async pickLayer(point: Point): Promise<void> {
    const generation = ++this.pickGeneration;
    const documentId = this.image.id;
    const selected = this.image.selected;
    this.flushPaint();
    const layer = await this.picker.layer(this.image.root, point, this.image.frame, this.rasterDensity);
    if (!this.halted && generation === this.pickGeneration && this.image.id === documentId && this.activeTool.id === 'transform' &&
      this.image.selected === selected && layer && this.image.allLayers().includes(layer)) this.select(layer);
  }

  setAltHeld(held: boolean): void {
    if (this.altHeld === held) return;
    if (this.baseTool.id === 'brush') {
      if (this.pointer?.mode !== 'pan') this.finishGesture();
      this.activeTool.hover(null);
    }
    this.altHeld = held;
    this.canvas.style.cursor = this.panHeld ? 'grab' : this.activeTool.cursor;
    this.changed();
  }

  run(action: () => unknown): void {
    if (this.halted || this.reframing) return;
    try { void Promise.resolve(action()).catch(this.report); }
    catch (error) { this.report(error); }
  }

  changed(): void {
    this.onChange?.();
    const menus = this.actions.menus();
    const json = JSON.stringify(menus);
    if (json !== this.lastMenus) { this.lastMenus = json; void window.desktop.setMenus(menus).catch(this.report); }
    this.requestRender();
  }

  requestRender(): void {
    if (this.scheduledFrame || this.halted) return;
    this.scheduledFrame = requestAnimationFrame(() => {
      this.scheduledFrame = 0;
      this.pendingStamps.clear();
      this.run(() => {
        const density = this.canvas.width / this.viewport.width;
        const stats = this.compositor.render(
          this.image.root, this.context.getCurrentTexture().createView(), this.viewport.bounds(), this.image.frame, this.viewport.scale * density,
        );
        this.overlay.replaceChildren();
        (this.tools.get('transform') as TransformTool).drawOverlay(this.activeTool.id === 'transform');
        if (!this.interacting) {
          if (this.previewsReady) { this.previewsReady = false; this.onPreviews?.(); }
          if (this.previewsRequested && !this.previewsRunning) void this.refreshPreviews().catch(this.report);
        }
        this.onFrame?.(stats);
      });
    });
  }

  resize(): void {
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const density = Math.min(devicePixelRatio, this.gpu.device.limits.maxTextureDimension2D / Math.max(width, height));
    this.canvas.width = Math.max(1, Math.round(width * density));
    this.canvas.height = Math.max(1, Math.round(height * density));
    this.viewport.resize(width, height);
  }

  reset(width: number, height: number): void {
    this.finishGesture();
    this.pickGeneration++;
    this.tools.get('eyedropper')?.cancel();
    this.previews.clear();
    this.image.reset(width, height);
    this.queuePreviews();
    this.viewport.fit(this.image.frame);
  }

  select(layer: Layer): void { this.pickGeneration++; this.finishGesture(); this.image.select(layer); }

  switchTool(id: string): void {
    const tool = this.tools.get(id);
    if (!tool || tool === this.baseTool) return;
    this.finishGesture();
    this.activeTool.hover(null);
    this.pickGeneration++;
    this.baseTool = tool;
    this.canvas.style.cursor = this.panHeld ? 'grab' : this.activeTool.cursor;
    this.changed();
  }

  paint(layer: ImageLayer, stamp: BrushStamp): void {
    let stamps = this.pendingStamps.get(layer);
    if (!stamps) {
      stamps = [];
      this.pendingStamps.set(layer, stamps);
      this.compositor.enqueue(layer, this.brush.operation(stamps));
    }
    stamps.push(stamp);
  }

  flushPaint(): void { this.compositor.flush(); this.pendingStamps.clear(); }

  finishGesture(): void {
    const pointer = this.pointer;
    this.pointer = null;
    this.commitEdits?.();
    this.activeTool.finish();
    this.flushPaint();
    if (pointer && this.canvas.hasPointerCapture(pointer.id)) this.canvas.releasePointerCapture(pointer.id);
    this.canvas.style.cursor = this.panHeld ? 'grab' : this.activeTool.cursor;
    this.requestRender();
  }

  cancelGesture(): void {
    const pointer = this.pointer;
    this.pointer = null;
    this.activeTool.cancel();
    if (pointer && this.canvas.hasPointerCapture(pointer.id)) this.canvas.releasePointerCapture(pointer.id);
    this.changed();
  }

  setPanHeld(held: boolean): void {
    this.panHeld = held;
    if (held && this.pointer?.mode === 'tool') {
      this.activeTool.finish();
      this.pointer.mode = 'pan';
    }
    this.brushCursor.hidden = true;
    this.canvas.style.cursor = this.pointer?.mode === 'pan' ? 'grabbing' : held ? 'grab' : this.activeTool.cursor;
  }

  changeLayer(layer: Layer, label: string, mutate: () => void): void {
    this.finishGesture();
    const before = layer.properties();
    mutate();
    this.recordLayerChange(layer, before, label);
  }

  recordLayerChange(layer: Layer, before: LayerProperties, label: string): void {
    const after = layer.properties();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.history.push(new UndoOperation(
      label,
      { type: 'layer', targetId: layer.id, action: 'properties', data: { properties: before } },
      { type: 'layer', targetId: layer.id, action: 'properties', data: { properties: after } },
    ));
  }

  addFilter(kind: string): void {
    const layer = this.image.selected;
    const filter = this.filters.create(kind);
    const index = layer.filters.length;
    layer.addFilter(filter);
    this.history.push(new UndoOperation(
      `Add ${filter.label}`,
      { type: 'layer', targetId: layer.id, action: 'remove-filter', data: { filterId: filter.id } },
      { type: 'layer', targetId: layer.id, action: 'add-filter', data: { index, filter: filter.serialize() } },
    ));
  }

  removeFilter(layer: Layer, filter: Filter): void {
    this.finishGesture();
    const index = layer.filters.indexOf(filter);
    const serialized = filter.serialize();
    layer.removeFilter(filter.id);
    this.history.push(new UndoOperation(
      `Remove ${filter.label}`,
      { type: 'layer', targetId: layer.id, action: 'add-filter', data: { index, filter: serialized } },
      { type: 'layer', targetId: layer.id, action: 'remove-filter', data: { filterId: filter.id } },
    ));
  }

  moveFilter(layer: Layer, filterId: string, insertionIndex: number): void {
    this.finishGesture();
    const previous = layer.filters.findIndex((filter) => filter.id === filterId);
    if (previous < 0) return;
    const index = Math.max(0, Math.min(insertionIndex, layer.filters.length)) - Number(previous < insertionIndex);
    if (index === previous) return;
    layer.moveFilter(filterId, index);
    this.history.push(new UndoOperation(
      'Reorder filters',
      { type: 'layer', targetId: layer.id, action: 'move-filter', data: { filterId, index: previous } },
      { type: 'layer', targetId: layer.id, action: 'move-filter', data: { filterId, index } },
    ));
  }

  private applyUndo(operation: UndoOperation, direction: UndoDirection): void {
    this.flushPaint();
    const payload = operation.payload(direction);
    if (payload.type === 'image') this.image.applyUndo(operation, direction);
    else if (payload.type === 'layer') {
      const layer = this.image.find(payload.targetId);
      layer.applyUndo(operation, direction, { gpu: this.gpu, filters: this.filters });
      this.image.selected = layer;
    } else if (payload.type === 'filter') {
      const layer = this.image.find(String(payload.data.layerId));
      const filter = layer.filters.find((item) => item.id === payload.targetId);
      if (!filter) throw new Error('Undo filter no longer exists.');
      filter.applyUndo(operation, direction);
      layer.invalidate();
      this.image.selected = layer;
    } else {
      const tool = this.tools.get(payload.targetId);
      if (!tool) throw new Error(`Unknown undo tool: ${payload.targetId}`);
      tool.applyUndo(operation, direction);
    }
  }

  async addImage(name: string, blob: Blob): Promise<void> {
    this.finishGesture();
    const documentId = this.image.id;
    const parent = this.image.destination();
    const layer = await importImage(this.gpu, this.compositor.quads, name, blob);
    if (documentId !== this.image.id || !this.image.allLayers().includes(parent)) { this.compositor.release(layer); return; }
    try {
      this.finishGesture();
      const frame = this.image.frame;
      const scale = Math.min(1, frame.width / layer.width, frame.height / layer.height);
      const x = frame.x + (frame.width - layer.width * scale) / 2;
      const y = frame.y + (frame.height - layer.height * scale) / 2;
      layer.setTransform(multiply(inverse(parent.worldTransform()), [scale, 0, 0, scale, x, y]));
      this.image.add(layer, parent);
    } catch (error) { if (!layer.parent) this.compositor.release(layer); throw error; }
  }

  private async reframeSelected(mode: ReframeMode): Promise<void> {
    const layer = this.image.selected;
    if (!(layer instanceof ImageLayer) || this.reframing) return;
    this.finishGesture();
    const app = document.getElementById('app');
    const previousInert = app?.inert ?? false;
    this.reframing = true;
    if (app) { app.inert = true; app.setAttribute('aria-busy', 'true'); }
    try {
      this.changed();
      await this.image.reframe(layer, mode);
    } finally {
      this.reframing = false;
      if (app) { app.inert = previousInert || this.halted; app.removeAttribute('aria-busy'); }
      this.changed();
    }
  }

  private registerActions(): void {
    const register = this.actions.register.bind(this.actions);
    register({ id: 'file.new', label: 'New document…', menu: 'File', execute: () => this.onNewDocument?.() });
    register({ id: 'file.open', label: 'Add image…', menu: 'File', execute: async () => {
      const image = await window.desktop.openImage();
      if (image) await this.addImage(image.name, new Blob([image.bytes]));
    } });
    register({ id: 'layer.new', label: 'New pixel layer…', menu: 'File', execute: () => this.onNewLayer?.() });
    register({ id: 'group.new', label: 'New group', menu: 'File', execute: () => this.image.add(new GroupLayer('Group')) });
    register({ id: 'history.undo', label: () => `Undo${this.history.canUndo ? ` ${this.history.undoLabel}` : ''}`, menu: 'Edit', enabled: () => this.history.canUndo, execute: () => this.history.undo() });
    register({ id: 'history.redo', label: () => `Redo${this.history.canRedo ? ` ${this.history.redoLabel}` : ''}`, menu: 'Edit', enabled: () => this.history.canRedo, execute: () => this.history.redo() });
    register({ id: 'layer.duplicate', label: 'Duplicate layer', menu: 'Edit', enabled: () => !!this.image.selected.parent, execute: () => this.image.duplicateSelected() });
    register({ id: 'layer.delete', label: 'Delete layer', menu: 'Edit', enabled: () => !!this.image.selected.parent, execute: () => this.image.deleteSelected() });
    register({ id: 'layer.rename', label: 'Rename layer', menu: 'Edit', execute: () => this.onRename?.() });
    const reframe = (mode: ReframeMode, label: string) => register({
      id: `layer.reframe.${mode}`, label, menu: 'Layer', submenu: 'Reframe',
      enabled: () => this.image.selected instanceof ImageLayer,
      execute: () => this.reframeSelected(mode),
    });
    reframe('normalize', 'Normalize to Canvas');
    reframe('trim', 'Trim Transparent Borders');
    reframe('extend', 'Extend to Canvas');
    for (const filter of this.filters.list()) register({ id: `filter.${filter.kind}`, label: filter.label, menu: 'Filter', execute: () => this.addFilter(filter.kind) });
    register({ id: 'tool.brush', label: 'Brush', execute: () => this.switchTool('brush') });
    register({ id: 'tool.transform', label: 'Move / transform', execute: () => this.switchTool('transform') });
    register({ id: 'tool.eyedropper', label: 'Eyedropper', execute: () => this.switchTool('eyedropper') });
    register({ id: 'tool.sample-held', label: 'Temporary eyedropper', execute: () => this.setAltHeld(true), release: () => this.setAltHeld(false) });
    register({ id: 'view.pan', label: 'Pan', execute: () => this.setPanHeld(true), release: () => this.setPanHeld(false) });
    register({ id: 'view.fit', label: 'Fit image', execute: () => this.viewport.fit(this.image.frame) });
    this.actions.bind('B', 'tool.brush');
    this.actions.bind('V', 'tool.transform');
    this.actions.bind('I', 'tool.eyedropper');
    this.actions.bind('Alt', 'tool.sample-held');
    this.actions.bind('Delete', 'layer.delete');
    this.actions.bind('Ctrl+J', 'layer.duplicate');
    this.actions.bind('Ctrl+Shift+N', 'layer.reframe.normalize');
    this.actions.bind('F2', 'layer.rename');
    this.actions.bind('Space', 'view.pan');
    this.actions.bind('Ctrl+Z', 'history.undo');
    this.actions.bind('Ctrl+Shift+Z', 'history.redo');
    this.actions.bind('Ctrl+Y', 'history.redo');
    this.actions.bind('Ctrl+N', 'file.new');
    this.actions.bind('Ctrl+O', 'file.open');
  }

  private attachInput(): void {
    const screenPoint = (event: MouseEvent): Point => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pointerData = (event: PointerEvent): ToolPointer => {
      const screen = screenPoint(event);
      return { screen, world: this.viewport.screenToWorld(screen), pressure: event.pointerType === 'pen' ? event.pressure : 1, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey };
    };
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointerdown', (event) => this.run(() => {
      if (this.pointer || !event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
      event.preventDefault();
      this.pickGeneration++;
      this.finishGesture();
      this.canvas.focus({ preventScroll: true });
      this.setAltHeld(event.altKey);
      const mode = this.panHeld || event.button === 1 ? 'pan' : 'tool';
      this.pointer = { id: event.pointerId, mode, last: screenPoint(event) };
      this.canvas.setPointerCapture(event.pointerId);
      if (mode === 'tool') this.activeTool.pointerDown(pointerData(event));
      else this.canvas.style.cursor = 'grabbing';
    }));
    this.canvas.addEventListener('pointermove', (event) => this.run(() => {
      if (this.pointer && this.pointer.id !== event.pointerId) return;
      const data = pointerData(event);
      if (this.pointer?.mode === 'pan') {
        this.viewport.pan(data.screen.x - this.pointer.last.x, data.screen.y - this.pointer.last.y);
        this.pointer.last = data.screen;
        return;
      }
      this.activeTool.hover(data);
      if (this.pointer?.mode !== 'tool') return;
      const coalesced = event.getCoalescedEvents?.() ?? [];
      for (const sample of coalesced.length ? coalesced : [event]) this.activeTool.pointerMove(pointerData(sample));
      this.pointer.last = data.screen;
    }));
    this.canvas.addEventListener('pointerup', (event) => this.run(() => {
      if (this.pointer?.id !== event.pointerId) return;
      if (this.pointer.mode === 'tool' && this.activeTool.id === 'transform') this.activeTool.pointerMove(pointerData(event));
      this.finishGesture();
    }));
    this.canvas.addEventListener('pointercancel', () => this.run(() => this.cancelGesture()));
    this.canvas.addEventListener('lostpointercapture', () => { if (this.pointer) this.run(() => this.cancelGesture()); });
    this.canvas.addEventListener('pointerleave', () => this.activeTool.hover(null));
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.run(() => {
        if (this.pointer?.mode === 'tool') this.finishGesture();
        const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.height : 1;
        this.viewport.zoomAt(screenPoint(event), Math.exp(-Math.max(-500, Math.min(500, event.deltaY * units)) * 0.002));
        this.activeTool.hover(null);
      });
    }, { passive: false });
    window.addEventListener('blur', () => this.run(() => { this.finishGesture(); this.setPanHeld(false); this.setAltHeld(false); }));
  }
}
