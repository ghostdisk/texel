import { ActionRegistry } from './actions';
import { DocumentFiles } from './files/document-files';
import type { LoadedDocument } from './files/txl';
import { ImageGeneration } from './generation/image-generation';
import { GenerationTool } from './tools/generation-tool';
import { FilterRegistry } from './filters/filter';
import type { Filter } from './filters/filter';
import { BlurFilter } from './filters/blur-filter';
import { SmartBlurFilter } from './filters/smart-blur-filter';
import { BrightnessContrastFilter } from './filters/brightness-contrast-filter';
import { LevelsFilter } from './filters/levels-filter';
import { PosterizeFilter } from './filters/posterize-filter';
import { InvertFilter } from './filters/invert-filter';
import { BorderFilter } from './filters/border-filter';
import { DropShadowFilter } from './filters/drop-shadow-filter';
import { MaskFilter } from './filters/mask-filter';
import { createSurface } from './gpu/surface';
import type { Surface } from './gpu/surface';
import type { MaskInput } from './gpu/mask';
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
import { GroupLayer, ImageLayer, Layer, canReferenceLayer } from './model/layers';
import type { LayerProperties } from './model/layers';
import { inverse, multiply } from './model/geometry';
import type { Point } from './model/geometry';
import { BrushTool } from './tools/brush-tool';
import { RectangleTool } from './tools/rectangle-tool';
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
  readonly generation: ImageGeneration;
  readonly image: ImageDocument;
  readonly files: DocumentFiles;
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
  onColorChange?: (primary: string, secondary: string) => void;
  primaryColor = '#000000';
  secondaryColor = '#ffffff';
  private panKeyHeld = false;
  private panMode = false;
  eraseMode = false;
  selectionMode = false;
  private selectionReturnId: string | null = null;
  private editedMask: ImageLayer | null = null;
  halted = false;
  onChange?: () => void;
  onFrame?: (stats: RenderStats) => void;
  onNewDocument?: () => void;
  onNewSizedLayer?: () => void;
  onRename?: () => void;
  commitEdits?: () => void;
  private scheduledFrame = 0;
  private pendingStamps = new Map<ImageLayer, BrushStamp[]>();
  private pointer: PointerGesture | null = null;
  private hoverPointer: ToolPointer | null = null;
  private context: GPUCanvasContext;
  private lastMenus = '';
  private reframing = false;
  private selectionCheck = 0;

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
    this.filters.register({ kind: 'blur', label: 'Gaussian blur', group: 'Blur', create: (id) => new BlurFilter(id) });
    this.filters.register({ kind: 'smart-blur', label: 'Smart blur', group: 'Blur', create: (id) => new SmartBlurFilter(id) });
    this.filters.register({ kind: 'brightness-contrast', label: 'Brightness / contrast', group: 'Adjustments', create: (id) => new BrightnessContrastFilter(id) });
    this.filters.register({ kind: 'levels', label: 'Levels', group: 'Adjustments', create: (id) => new LevelsFilter(id) });
    this.filters.register({ kind: 'posterize', label: 'Posterize', group: 'Adjustments', create: (id) => new PosterizeFilter(id) });
    this.filters.register({ kind: 'border', label: 'Border', group: 'Effects', create: (id) => new BorderFilter(id) });
    this.filters.register({ kind: 'drop-shadow', label: 'Drop shadow', group: 'Effects', create: (id) => new DropShadowFilter(id) });
    this.filters.register({ kind: 'invert', label: 'Invert', group: 'Adjustments', create: (id) => new InvertFilter(id) });
    this.filters.register({ kind: 'mask', label: 'Mask', create: (id) => new MaskFilter(id) });
    this.history = new UndoStack((operation, direction) => this.applyUndo(operation, direction));
    this.image = new ImageDocument(gpu, this.compositor, this.filters, this.history, () => this.flushPaint());
    this.actions = new ActionRegistry(report);
    this.baseTool = new BrushTool(this);
    this.tools.set(this.activeTool.id, this.activeTool);
    this.tools.set('rectangle', new RectangleTool(this));
    this.tools.set('transform', new TransformTool(this));
    this.tools.set('eyedropper', new EyedropperTool(this));
    this.generation = new ImageGeneration(this);
    this.tools.set('generation', new GenerationTool(this));
    this.files = new DocumentFiles(this);
    this.image.onInvalidated = () => this.requestRender();
    this.image.onChange = () => this.changed();
    this.history.onChange = (operation, direction) => {
      this.pickGeneration++;
      this.queuePreviews();
      this.changed();
      const selection = this.image.selectionLayer;
      const payload = operation?.payload(direction ?? 'redo');
      if (selection && payload && (payload.targetId === selection.id || payload.data.layerId === selection.id)) {
        void this.checkSelectionEmpty(selection).catch(this.report);
      }
    };
    this.viewport.onChange = () => { this.refreshHover(); this.requestRender(); };
    this.actions.beforeExecute = () => this.finishGesture();
    this.actions.blocked = () => this.halted || this.reframing || this.files.busy;
    this.actions.context = () => ({ hasSelection: !!this.image.selectionMask, isGenerating: this.generation.busy });
    this.registerActions();
    this.attachInput();
    new ResizeObserver(() => this.resize()).observe(stage);
    window.addEventListener('resize', () => this.resize());
  }

  get activeTool(): Tool { return this.altHeld && this.baseTool.id === 'brush' ? this.tools.get('eyedropper')! : this.baseTool; }
  get maskEditLayer(): ImageLayer | null { return this.editedMask; }
  get editingPixels(): boolean { return this.reframing; }
  get panHeld(): boolean { return this.panKeyHeld || this.panMode; }

  private setMaskEditLayer(layer: ImageLayer | null): void {
    if (layer === this.editedMask) return;
    this.pickGeneration++;
    this.tools.get('eyedropper')?.cancel();
    this.editedMask = layer;
  }

  toggleLayerVisibility(layer: Layer): void {
    this.finishGesture();
    if (layer instanceof ImageLayer && layer.channels === 1) {
      this.setMaskEditLayer(this.editedMask === layer ? null : layer);
      if (this.editedMask) this.select(layer);
      else this.changed();
    } else if (this.editedMask) {
      this.setMaskEditLayer(null);
      this.changed();
    } else {
      this.changeLayer(layer, 'Toggle layer visibility', () => layer.setVisible(!layer.visible));
    }
  }

  get paintTarget(): ImageLayer | null {
    if (this.selectionMode) return this.image.selectionLayer;
    return this.image.selectedLayers.length === 1 && this.image.selected instanceof ImageLayer ? this.image.selected : null;
  }

  drawingColor(layer: ImageLayer, opacity: number): readonly [number, number, number, number] {
    const color = this.primaryColor;
    const rgb = [1, 3, 5].map((offset) => {
      const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    if (layer.channels === 1) {
      const value = this.maskEditLayer === layer ? rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 : 1;
      return [value, value, value, opacity];
    }
    return [rgb[0], rgb[1], rgb[2], opacity];
  }

  captureSelection(layer: ImageLayer): MaskInput | null {
    const selection = this.image.selectionMask;
    if (!selection || layer === selection) return null;
    this.flushPaint();
    const source = this.compositor.resolve(selection, this.rasterDensity);
    const surface = createSurface(this.gpu.device, 'Drawing selection snapshot', source.bounds, source.scale, source.texture.format);
    const frame = this.gpu.beginFrame();
    try {
      frame.encoder.copyTextureToTexture({ texture: source.texture }, { texture: surface.texture }, [source.texture.width, source.texture.height]);
      frame.submit();
      return { surface, transform: multiply(inverse(selection.worldTransform()), layer.worldTransform()) };
    } catch (error) { surface.texture.destroy(); frame.release(); throw error; }
  }

  setSelectionMode(enabled: boolean): void {
    this.finishGesture();
    if (enabled) {
      if (!this.image.selected.isSelection) this.selectionReturnId = this.image.selected.id;
      const mask = this.image.ensureSelection();
      this.selectionMode = true;
      this.image.select(mask);
    } else {
      this.selectionMode = false;
      if (this.image.selected.isSelection) {
        this.image.selected = this.image.allLayers().find((layer) => layer.id === this.selectionReturnId && !layer.isSelection) ??
          this.image.allLayers().find((layer) => layer instanceof ImageLayer && !layer.isSelection) ?? this.image.root;
      }
      this.changed();
    }
  }

  private async checkSelectionEmpty(selection: ImageLayer): Promise<void> {
    const check = ++this.selectionCheck;
    const documentId = this.image.id;
    const revision = selection.revision;
    const source = selection.source;
    this.flushPaint();
    const empty = await this.readback.isEmpty(this.compositor.resolve(selection, this.rasterDensity));
    if (!empty || check !== this.selectionCheck || this.image.id !== documentId || this.image.selectionLayer !== selection ||
      selection.revision !== revision || selection.source !== source || this.interacting) return;
    this.setSelectionMode(false);
    this.image.deactivateEmptySelection(selection);
    if (this.maskEditLayer === selection) this.setMaskEditLayer(null);
    this.changed();
  }

  private deselect(): void {
    const selection = this.image.selectionMask;
    if (!selection) return;
    this.setSelectionMode(false);
    this.image.deleteSelected(selection);
  }

  private clearSelection(): void {
    const layer = this.paintTarget;
    if (!this.image.selectionMask || !layer) return;
    const snapshots = new Map<string, Surface>();
    let selection: MaskInput | null = null;
    let before: string | undefined;
    try {
      selection = this.captureSelection(layer);
      before = this.image.capturePixels(layer, snapshots);
      // Keep the stamp's antialiased edges outside the layer's pixel buffer.
      const stamp: BrushStamp = {
        x: layer.width / 2, y: layer.height / 2, width: layer.width + 4, height: layer.height + 4,
        radius: 1, hardness: 1, rectangle: true, color: [0, 0, 0, 1],
      };
      this.compositor.enqueue(layer, this.brush.operation([stamp], true, selection));
      const after = this.image.capturePixels(layer, snapshots);
      this.history.push(new UndoOperation(
        'Clear selected pixels',
        { type: 'layer', targetId: layer.id, action: 'pixels', data: { snapshotId: before } },
        { type: 'layer', targetId: layer.id, action: 'pixels', data: { snapshotId: after } },
        snapshots,
      ));
    } catch (error) {
      try {
        this.flushPaint();
        if (before) layer.restorePixels(this.gpu, snapshots.get(before)!);
      } finally { for (const snapshot of snapshots.values()) snapshot.texture.destroy(); }
      throw error;
    } finally { selection?.surface.texture.destroy(); }
  }

  private promoteSelection(): void {
    const selection = this.image.selectionMask;
    if (!selection) return;
    this.setSelectionMode(false);
    this.changeLayer(selection, 'Promote selection to mask', () => {
      selection.setSelection(false);
      if (selection.name === 'Selection') selection.name = 'Mask';
      selection.setVisible(false);
    });
    this.select(selection);
  }

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
    return this.picker.color(this.image.root, point, this.image.frame, this.rasterDensity, this.editedMask);
  }

  setBrushColor(color: string, sampled = false): void { this.setColors(color, this.secondaryColor, sampled); }

  setColors(primary: string, secondary: string, sampled = false): void {
    this.primaryColor = primary;
    this.secondaryColor = secondary;
    if (!sampled) (this.tools.get('eyedropper') as EyedropperTool).colorsChanged();
    this.onColorChange?.(primary, secondary);
  }

  private refreshHover(): void {
    const pointer = this.hoverPointer;
    this.activeTool.hover(pointer && this.pointer?.mode !== 'pan' ?
      { ...pointer, world: this.viewport.screenToWorld(pointer.screen) } : null);
  }

  async pickLayer(point: Point, additive = false): Promise<void> {
    const generation = ++this.pickGeneration;
    const documentId = this.image.id;
    const selected = this.image.selected;
    this.flushPaint();
    const layer = await this.picker.layer(this.image.root, point, this.image.frame, this.rasterDensity, this.editedMask);
    if (!this.halted && generation === this.pickGeneration && this.image.id === documentId && this.activeTool.id === 'transform' &&
      this.image.selected === selected && layer && this.image.allLayers().includes(layer)) this.select(layer, additive ? 'toggle' : 'replace');
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
    if (this.halted || this.reframing || this.files.busy) return;
    try { void Promise.resolve(action()).catch(this.report); }
    catch (error) { this.report(error); }
  }

  changed(): void {
    this.generation?.validate();
    this.files?.sync();
    if (this.editedMask && (this.image.selected !== this.editedMask || !this.image.allLayers().includes(this.editedMask))) {
      this.setMaskEditLayer(null);
    }
    if (!this.image.selectionMask || !this.image.selected.isSelection) this.selectionMode = false;
    this.onChange?.();
    this.refreshHover();
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
        this.generation.validate();
        const density = this.canvas.width / this.viewport.width;
        const stats = this.compositor.render(
          this.image.root, this.context.getCurrentTexture().createView(), this.viewport.bounds(), this.image.frame, this.viewport.scale * density,
          this.image.selectionMask, this.selectionMode, this.editedMask, this.generation.visual,
        );
        this.overlay.replaceChildren();
        if (this.activeTool.id === 'generation') this.activeTool.drawOverlay();
        else (this.tools.get('transform') as TransformTool).drawOverlay(this.activeTool.id === 'transform');
        if (!this.interacting) {
          if (this.previewsReady) { this.previewsReady = false; this.onPreviews?.(); }
          if (this.previewsRequested && !this.previewsRunning) void this.refreshPreviews().catch(this.report);
        }
        this.onFrame?.(stats);
        if ((this.image.selectionMask && !this.editedMask) || this.generation.visual) this.requestRender();
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
    this.generation.cancel();
    this.finishGesture();
    this.pickGeneration++;
    this.tools.get('eyedropper')?.cancel();
    this.previews.clear();
    this.selectionMode = false;
    this.selectionReturnId = null;
    this.setMaskEditLayer(null);
    this.generation.resetLens(width, height);
    this.image.reset(width, height);
    this.queuePreviews();
    this.viewport.fit(this.image.frame);
    this.files.reset();
    this.changed();
  }

  loadDocument(document: LoadedDocument): void {
    this.generation.cancel();
    this.finishGesture();
    this.pickGeneration++;
    this.tools.get('eyedropper')?.cancel();
    this.previews.clear();
    this.selectionMode = false;
    this.selectionReturnId = null;
    this.setMaskEditLayer(null);
    this.image.replace(document.root, document.width, document.height, document.selection, document.activeSelectionId);
    this.generation.resetLens(document.width, document.height);
    this.generation.lens.setTransform(document.generationLens);
    this.selectionMode = this.image.selected.isSelection && !!this.image.selectionMask;
    this.queuePreviews();
    this.viewport.fit(this.image.frame);
  }

  select(layer: Layer, mode: 'replace' | 'toggle' | 'range' = 'replace', order?: Layer[]): void {
    this.pickGeneration++;
    this.finishGesture();
    if (layer.isSelection && !this.image.selected.isSelection) this.selectionReturnId = this.image.selected.id;
    this.image.select(layer, mode, order);
    this.selectionMode = this.image.selected.isSelection;
    if (!this.selectionMode) this.selectionReturnId = this.image.selected.id;
    if (this.image.selectedLayers.length > 1) this.setMaskEditLayer(null);
    this.changed();
  }

  switchTool(id: string): void {
    const tool = this.tools.get(id);
    if (!tool || (tool === this.baseTool && !this.panMode && !this.selectionMode && !this.eraseMode)) return;
    this.finishGesture();
    this.activeTool.hover(null);
    this.pickGeneration++;
    this.baseTool = tool;
    if (tool.id === 'generation') this.setMaskEditLayer(null);
    this.panMode = false;
    this.eraseMode = false;
    this.canvas.style.cursor = this.panHeld ? 'grab' : this.activeTool.cursor;
    if (this.selectionMode) this.setSelectionMode(false);
    else this.changed();
  }

  paint(layer: ImageLayer, stamp: BrushStamp, erase = false, selection: MaskInput | null = null): void {
    let stamps = this.pendingStamps.get(layer);
    if (!stamps) {
      stamps = [];
      this.pendingStamps.set(layer, stamps);
      this.compositor.enqueue(layer, this.brush.operation(stamps, erase, selection));
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
    this.panKeyHeld = held;
    this.updatePanCursor();
  }

  private updatePanCursor(): void {
    if (this.panHeld && this.pointer?.mode === 'tool') {
      this.activeTool.finish();
      this.pointer.mode = 'pan';
    }
    this.brushCursor.hidden = true;
    this.refreshHover();
    this.canvas.style.cursor = this.pointer?.mode === 'pan' ? 'grabbing' : this.panHeld ? 'grab' : this.activeTool.cursor;
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

  recordLayerChanges(layers: readonly Layer[], before: readonly LayerProperties[], label: string): void {
    const after = layers.map((layer) => layer.properties());
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const selection = this.image.selectionState();
    this.history.push(new UndoOperation(
      label,
      { type: 'image', targetId: this.image.id, action: 'layer-properties', data: {
        layers: layers.map((layer, index) => ({ layerId: layer.id, properties: before[index] })), selection,
      } },
      { type: 'image', targetId: this.image.id, action: 'layer-properties', data: {
        layers: layers.map((layer, index) => ({ layerId: layer.id, properties: after[index] })), selection,
      } },
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

  setLayerMask(layer: Layer, mask: Layer): void {
    this.finishGesture();
    const layers = this.image.allLayers();
    if (!layers.includes(layer) || !layers.includes(mask) || !canReferenceLayer(layer, mask)) {
      throw new Error('This mask link would create a circular layer dependency.');
    }
    const existing = layer.filters.find((filter): filter is MaskFilter => filter instanceof MaskFilter);
    if (existing) {
      if (existing.layerId === mask.id) { this.select(layer); return; }
      const before = existing.serialize();
      existing.layerId = mask.id;
      layer.invalidate();
      this.select(layer);
      this.history.push(new UndoOperation(
        'Replace layer mask',
        { type: 'filter', targetId: existing.id, action: 'state', data: { layerId: layer.id, filter: before } },
        { type: 'filter', targetId: existing.id, action: 'state', data: { layerId: layer.id, filter: existing.serialize() } },
      ));
    } else {
      const filter = new MaskFilter();
      filter.layerId = mask.id;
      const index = layer.filters.length;
      layer.addFilter(filter);
      this.select(layer);
      this.history.push(new UndoOperation(
        'Set layer mask',
        { type: 'layer', targetId: layer.id, action: 'remove-filter', data: { filterId: filter.id } },
        { type: 'layer', targetId: layer.id, action: 'add-filter', data: { index, filter: filter.serialize() } },
      ));
    }
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
    this.selectionMode = this.image.selected.isSelection;
  }

  async addImage(name: string, blob: Blob): Promise<void> {
    this.finishGesture();
    const documentId = this.image.id;
    const parent = this.image.destination();
    const layer = await importImage(this.gpu, this.compositor.quads, name, blob);
    await this.files.whenIdle();
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

  private async editPixels(edit: () => void | Promise<void>): Promise<void> {
    if (this.reframing) return;
    this.finishGesture();
    const app = document.getElementById('app');
    const previousInert = app?.inert ?? false;
    this.reframing = true;
    if (app) { app.inert = true; app.setAttribute('aria-busy', 'true'); }
    try {
      this.changed();
      await edit();
    } finally {
      this.reframing = false;
      if (app) { app.inert = previousInert || this.halted; app.removeAttribute('aria-busy'); }
      this.changed();
    }
  }

  private registerActions(): void {
    const register = this.actions.register.bind(this.actions);
    register({ id: 'file.new', label: 'New document…', menu: 'File', execute: () => this.onNewDocument?.() });
    register({ id: 'file.open', label: 'Open…', menu: 'File', execute: () => this.files.open() });
    register({ id: 'file.save', label: 'Save', menu: 'File', execute: () => this.files.save() });
    register({ id: 'file.save-as', label: 'Save as…', menu: 'File', execute: () => this.files.save(true) });
    register({ id: 'file.import', label: 'Add image…', menu: 'File', execute: async () => {
      const image = await window.desktop.openImage();
      if (image) await this.addImage(image.name, new Blob([image.bytes]));
    } });
    register({ id: 'layer.new', label: 'New pixel layer', menu: 'Layer', execute: () => this.image.createPixelLayer() });
    register({ id: 'layer.new-sized', label: 'New sized layer…', menu: 'Layer', execute: () => this.onNewSizedLayer?.() });
    register({ id: 'mask.new', label: 'New mask layer', menu: 'Layer', execute: () => this.image.createMask() });
    register({ id: 'group.new', label: 'New group', menu: 'Layer', execute: () => this.image.add(new GroupLayer('Group')) });
    register({ id: 'history.undo', label: () => `Undo${this.history.canUndo ? ` ${this.history.undoLabel}` : ''}`, menu: 'Edit', enabled: () => this.history.canUndo, execute: () => this.history.undo() });
    register({ id: 'history.redo', label: () => `Redo${this.history.canRedo ? ` ${this.history.redoLabel}` : ''}`, menu: 'Edit', enabled: () => this.history.canRedo, execute: () => this.history.redo() });
    register({
      id: 'layer.duplicate', menu: 'Layer',
      label: () => this.image.selectedLayers.length === 1 && this.image.selected instanceof ImageLayer && this.image.selected.channels === 4 && this.image.selectionMask ?
        'Layer via copy' : this.image.selectedRoots.length > 1 ? 'Duplicate layers' : 'Duplicate layer',
      enabled: () => this.image.selectedRoots.length > 0, execute: () => this.editPixels(() => this.image.duplicateSelected()),
    });
    register({ id: 'layer.group', label: 'Group layers', menu: 'Layer', enabled: () => this.image.selectedRoots.length > 0, execute: () => this.image.groupSelected() });
    register({
      id: 'layer.merge', menu: 'Layer',
      label: () => this.image.selectedRoots.length > 1 ? 'Merge layers' : this.image.selected instanceof GroupLayer ? 'Merge group' : 'Merge down',
      enabled: () => this.image.commands.mergeTargets.length > 0, execute: () => this.image.mergeSelected(),
    });
    register({ id: 'layer.delete', label: () => this.image.selectedRoots.length > 1 ? 'Delete layers' : 'Delete layer', menu: 'Layer', enabled: () => !!this.image.selected.parent, execute: () => this.image.deleteSelected() });
    register({ id: 'layer.rename', label: 'Rename layer', menu: 'Layer', enabled: () => this.image.selectedLayers.length === 1, execute: () => this.onRename?.() });
    for (const [direction, offset] of [['up', 1], ['down', -1]] as const) register({
      id: `layer.${direction}`, label: `Move layer ${direction}`, menu: 'Layer',
      enabled: () => this.image.commands.canStep(offset),
      execute: () => this.image.commands.step(offset),
    });
    register({
      id: 'layer.visibility', menu: 'Layer',
      label: () => {
        const layer = this.image.selected;
        if (layer === this.maskEditLayer) return 'Finish editing mask';
        if (layer instanceof ImageLayer && layer.channels === 1) return 'Edit mask';
        return layer.visible ? 'Hide layer' : 'Show layer';
      },
      execute: () => this.toggleLayerVisibility(this.image.selected),
    });
    register({
      id: 'selection.clear', label: 'Clear selected pixels', menu: 'Edit',
      enabled: () => !!this.image.selectionMask && !!this.paintTarget,
      execute: () => this.clearSelection(),
    });
    const reframe = (mode: ReframeMode, label: string) => register({
      id: `layer.reframe.${mode}`, label, menu: 'Layer', submenu: 'Reframe',
      enabled: () => this.image.selectedLayers.length === 1 && this.image.selected instanceof ImageLayer,
      execute: () => this.editPixels(() => this.image.reframe(this.image.selected as ImageLayer, mode)),
    });
    reframe('normalize', 'Normalize to Canvas');
    reframe('trim', 'Trim Transparent Borders');
    reframe('extend', 'Extend to Canvas');
    for (const filter of this.filters.list()) register({
      id: `filter.${filter.kind}`, label: filter.label, menu: 'Filter', submenu: filter.group,
      enabled: () => this.image.selectedLayers.length === 1, execute: () => this.addFilter(filter.kind),
    });
    register({
      id: 'filter.apply', label: 'Apply first filter', menu: 'Filter',
      enabled: () => this.image.selectedLayers.length === 1 && this.image.selected instanceof ImageLayer && this.image.selected.filters.length > 0,
      execute: () => {
        const layer = this.image.selected;
        if (layer instanceof ImageLayer && layer.filters[0]) this.image.commands.applyFilter(layer, layer.filters[0]);
      },
    });
    register({ id: 'selection.mode', label: () => this.selectionMode ? 'Finish editing selection' : 'Edit selection', menu: 'Select', execute: () => this.setSelectionMode(!this.selectionMode) });
    register({ id: 'selection.all', label: 'Select all', menu: 'Select', execute: () => {
      const selection = this.image.ensureSelection(true);
      if (this.selectionMode) this.image.select(selection);
      this.changed();
    } });
    register({ id: 'selection.deselect', label: 'Deselect', menu: 'Select', enabled: () => !!this.image.selectionMask, execute: () => this.deselect() });
    register({ id: 'selection.promote', label: 'Promote selection to mask', menu: 'Select', enabled: () => !!this.image.selectionMask, execute: () => this.promoteSelection() });
    register({ id: 'drawing.erase', label: () => this.eraseMode ? 'Switch to draw mode' : 'Switch to erase mode', menu: 'Tools', execute: () => {
      this.eraseMode = !this.eraseMode;
      this.changed();
    } });
    register({
      id: 'colors.reset', label: 'Default colors', menu: 'Tools', submenu: 'Colors',
      execute: () => this.setColors('#000000', '#ffffff'),
    });
    register({
      id: 'colors.swap', label: 'Swap primary / secondary colors', menu: 'Tools', submenu: 'Colors',
      execute: () => this.setColors(this.secondaryColor, this.primaryColor),
    });
    register({ id: 'tool.generation', label: 'Generate image', menu: 'Tools', execute: () => this.switchTool('generation') });
    register({
      id: 'selection.remove', label: 'Remove selection', menu: 'Edit',
      enabled: () => this.generation.canRemove, execute: () => this.generation.remove(),
    });
    register({
      id: 'generation.generate', label: 'Generate', menu: 'Tools', submenu: 'Generation',
      enabled: () => this.generation.canGenerate, execute: () => this.generation.generate(),
    });
    register({
      id: 'generation.cancel', label: () => this.generation.removing ? 'Cancel removal' : 'Cancel generation', menu: 'Tools', submenu: 'Generation',
      enabled: () => this.generation.busy, execute: () => this.generation.cancel(),
    });
    register({ id: 'generation.fit', label: 'Fit generation lens to canvas', menu: 'Tools', submenu: 'Generation', enabled: () => !this.generation.busy, execute: () => this.generation.fitLens() });
    register({ id: 'generation.models', label: 'Refresh models', menu: 'Tools', submenu: 'Generation', execute: () => this.generation.refreshModels() });
    register({ id: 'tool.brush', label: 'Brush', menu: 'Tools', execute: () => this.switchTool('brush') });
    register({ id: 'tool.rectangle', label: 'Rectangle', menu: 'Tools', execute: () => this.switchTool('rectangle') });
    register({ id: 'tool.transform', label: 'Move / transform', menu: 'Tools', execute: () => this.switchTool('transform') });
    register({
      id: 'tool.eyedropper', label: 'Eyedropper', menu: 'Tools', execute: () => this.switchTool('eyedropper'),
      hold: {
        press: () => this.setAltHeld(true),
        release: () => this.setAltHeld(false),
      },
    });
    register({
      id: 'view.pan', label: () => this.panMode ? 'Exit pan mode' : 'Pan mode', menu: 'View',
      execute: () => { this.panMode = !this.panMode; this.updatePanCursor(); this.changed(); },
      hold: {
        press: () => this.setPanHeld(true),
        release: () => this.setPanHeld(false),
      },
    });
    register({ id: 'view.fit', label: 'Fit image', menu: 'View', execute: () => this.viewport.fit(this.image.frame) });
    this.actions.bind('D', 'colors.reset');
    this.actions.bind('X', 'colors.swap');
    this.actions.bind('G', 'tool.generation');
    this.actions.bind('Escape', 'generation.cancel', { when: 'isGenerating' });
    this.actions.bind('B', 'tool.brush');
    this.actions.bind('R', 'tool.rectangle');
    this.actions.bind('E', 'drawing.erase');
    this.actions.bind('S', 'selection.mode');
    this.actions.bind('Ctrl+A', 'selection.all');
    this.actions.bind('Ctrl+D', 'selection.deselect');
    this.actions.bind('V', 'tool.transform');
    this.actions.bind('I', 'tool.eyedropper');
    this.actions.bind('Alt', 'tool.eyedropper', { hold: true });
    this.actions.bind('Ctrl+I', 'filter.invert');
    this.actions.bind('Delete', 'layer.delete', { when: '!hasSelection' });
    this.actions.bind('Delete', 'selection.clear', { when: 'hasSelection' });
    this.actions.bind('Ctrl+J', 'layer.duplicate');
    this.actions.bind('Ctrl+G', 'layer.group');
    this.actions.bind('Ctrl+E', 'layer.merge');
    this.actions.bind('Ctrl+Shift+N', 'layer.reframe.normalize');
    this.actions.bind('F2', 'layer.rename');
    this.actions.bind('Space', 'view.pan', { hold: true });
    this.actions.bind('Ctrl+Z', 'history.undo');
    this.actions.bind('Ctrl+Shift+Z', 'history.redo');
    this.actions.bind('Ctrl+Y', 'history.redo');
    this.actions.bind('Ctrl+N', 'file.new');
    this.actions.bind('Ctrl+O', 'file.open');
    this.actions.bind('Ctrl+S', 'file.save');
    this.actions.bind('Ctrl+Shift+S', 'file.save-as');
    this.actions.bind('Ctrl+Shift+O', 'file.import');
  }

  private attachInput(): void {
    const screenPoint = (event: MouseEvent): Point => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pointerData = (event: MouseEvent): ToolPointer => {
      const screen = screenPoint(event);
      return {
        screen, world: this.viewport.screenToWorld(screen),
        pressure: event instanceof PointerEvent && event.pointerType === 'pen' ? event.pressure : 1,
        shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey,
      };
    };
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointerenter', (event) => this.run(() => {
      if (!event.isPrimary) return;
      this.hoverPointer = pointerData(event);
      this.refreshHover();
    }));
    this.canvas.addEventListener('pointerdown', (event) => this.run(() => {
      if (this.pointer || !event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
      event.preventDefault();
      this.pickGeneration++;
      this.finishGesture();
      this.canvas.focus({ preventScroll: true });
      this.setAltHeld(event.altKey);
      const mode = this.panHeld || event.button === 1 ? 'pan' : 'tool';
      const data = pointerData(event);
      this.hoverPointer = data;
      this.pointer = { id: event.pointerId, mode, last: data.screen };
      this.canvas.setPointerCapture(event.pointerId);
      if (mode === 'tool') this.activeTool.pointerDown(data);
      else { this.activeTool.hover(null); this.canvas.style.cursor = 'grabbing'; }
    }));
    this.canvas.addEventListener('pointermove', (event) => this.run(() => {
      if (this.pointer && this.pointer.id !== event.pointerId) return;
      const data = pointerData(event);
      this.hoverPointer = data;
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
      this.hoverPointer = pointerData(event);
      if (this.pointer.mode === 'tool' && ['transform', 'rectangle', 'eyedropper'].includes(this.activeTool.id)) {
        this.activeTool.pointerMove(this.hoverPointer);
      }
      this.finishGesture();
      this.refreshHover();
    }));
    this.canvas.addEventListener('pointercancel', () => this.run(() => this.cancelGesture()));
    this.canvas.addEventListener('lostpointercapture', () => { if (this.pointer) this.run(() => this.cancelGesture()); });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverPointer = null;
      this.activeTool.hover(null);
    });
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.run(() => {
        const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.height : 1;
        this.hoverPointer = pointerData(event);
        if ((event.shiftKey || event.ctrlKey) && this.activeTool instanceof BrushTool) {
          const delta = Math.max(-500, Math.min(500, (event.deltaY || event.deltaX) * units));
          if (event.ctrlKey) this.activeTool.adjustByWheel(event.shiftKey ? 'flow' : 'hardness', delta);
          else this.activeTool.resizeByWheel(delta);
          this.refreshHover();
          return;
        }
        if (this.pointer?.mode === 'tool') this.finishGesture();
        this.viewport.zoomAt(screenPoint(event), Math.exp(-Math.max(-500, Math.min(500, event.deltaY * units)) * 0.002));
        this.refreshHover();
      });
    }, { passive: false });
    window.addEventListener('blur', () => this.run(() => {
      this.hoverPointer = null;
      this.activeTool.hover(null);
      this.finishGesture();
      this.setPanHeld(false);
      this.setAltHeld(false);
    }));
  }
}
