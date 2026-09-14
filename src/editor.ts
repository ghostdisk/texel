import { ActionRegistry } from './actions';
import { EditorClipboard } from './clipboard';
import { DocumentFiles } from './files/document-files';
import type { LoadedDocument } from './files/txl';
import { GeneratorManager } from './generators/manager';
import { FilterRegistry } from './filters/filter';
import type { Filter } from './filters/filter';
import { BlurFilter } from './filters/blur-filter';
import { SmartBlurFilter } from './filters/smart-blur-filter';
import { BrightnessContrastFilter } from './filters/brightness-contrast-filter';
import { HueSaturationFilter } from './filters/hue-saturation-filter';
import { CurvesFilter } from './filters/curves-filter';
import { ExposureFilter } from './filters/exposure-filter';
import { WhiteBalanceFilter } from './filters/white-balance-filter';
import { GrayscaleFilter } from './filters/grayscale-filter';
import { LevelsFilter } from './filters/levels-filter';
import { PosterizeFilter } from './filters/posterize-filter';
import { SharpenFilter } from './filters/sharpen-filter';
import { InvertFilter } from './filters/invert-filter';
import { BorderFilter } from './filters/border-filter';
import { DropShadowFilter } from './filters/drop-shadow-filter';
import { MaskFilter } from './filters/mask-filter';
import { createSurface } from './gpu/surface';
import type { Surface } from './gpu/surface';
import type { MaskInput } from './gpu/mask';
import { MaskRenderer } from './gpu/mask';
import { Brush } from './gpu/brush';
import type { BrushStamp } from './gpu/brush';
import { RetouchBrush } from './gpu/retouch';
import type { RetouchInput, RetouchStamp } from './gpu/retouch';
import { PathRenderer } from './gpu/path';
import { Compositor } from './gpu/compositor';
import { LayerReframer } from './gpu/reframe';
import type { RenderStats } from './gpu/compositor';
import type { Gpu } from './gpu/device';
import { importImage } from './gpu/images';
import { GpuReadback } from './gpu/readback';
import type { SampledColor } from './gpu/readback';
import { PixelPicker } from './gpu/picking';
import { LayerPreviews } from './ui/layer-previews';
import { UndoOperation, UndoStack } from './history/undo';
import type { JsonObject, UndoDirection } from './history/undo';
import { ImageDocument } from './model/image-document';
import type { ReframeMode } from './model/image-document';
import { GroupLayer, ImageLayer, Layer, canReferenceLayer } from './model/layers';
import type { LayerProperties } from './model/layers';
import { inverse, multiply, unionBounds } from './model/geometry';
import type { Matrix, Point } from './model/geometry';
import { applyWorldTransform, around, translation, worldBounds } from './model/precision';
import type { Guide, PrecisionState } from './model/precision';
import { BrushTool } from './tools/brush-tool';
import { BrushLikeTool } from './tools/brush-like-tool';
import { RectangleTool } from './tools/rectangle-tool';
import { EllipseTool } from './tools/ellipse-tool';
import { FreehandLassoTool } from './tools/freehand-lasso-tool';
import { PolygonLassoTool } from './tools/polygon-lasso-tool';
import { FillTool } from './tools/fill-tool';
import { CloneStampTool, HealingBrushTool } from './tools/retouch-tool';
import { TextTool } from './tools/text-tool';
import { CropTool } from './tools/crop-tool';
import { TransformTool } from './tools/transform-tool';
import { EyedropperTool } from './tools/eyedropper-tool';
import type { Tool, ToolPointer } from './tools/tool';
import { Viewport } from './viewport';
import { EditorDocument } from './editor-document';

interface PointerGesture {
  id: number;
  mode: 'tool' | 'pan' | 'generator';
  button: number;
  last: Point;
  travel: number;
}

interface SelectionContentState {
  documentId: string;
  layer: ImageLayer;
  source: Surface;
  revision: number;
  outputRevision: number;
  rootRevision: number;
}

interface SelectionTransformTargets {
  primary: ImageLayer;
  layers: readonly Layer[];
}

export class Editor {
  readonly compositor: Compositor;
  readonly layerReframer: LayerReframer;
  readonly layerMasks: MaskRenderer;
  readonly brush: Brush;
  readonly retouch: RetouchBrush;
  readonly paths: PathRenderer;
  readonly filters = new FilterRegistry();
  readonly actions: ActionRegistry;
  readonly clipboard: EditorClipboard;
  readonly generators: GeneratorManager;
  readonly files: DocumentFiles;
  readonly documents: EditorDocument[] = [];
  private currentDocument!: EditorDocument;
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
  onGuideSettings?: () => void;
  onOpenSettings?: () => void;
  onOpenAbout?: () => void;
  onCanvasBackgroundSettings?: () => void;
  onCommandPalette?: () => void;
  onDocumentsChange?: () => void;
  commitEdits?: () => void;
  private scheduledFrame = 0;
  private pendingStamps = new Map<ImageLayer, BrushStamp[]>();
  private pendingRetouchStamps = new Map<ImageLayer, RetouchStamp[]>();
  private pointer: PointerGesture | null = null;
  private hoverPointer: ToolPointer | null = null;
  private context: GPUCanvasContext;
  private lastMenus = '';
  private reframing = false;
  private selectionCheck: Promise<void> | null = null;
  private checkedSelection: SelectionContentState | null = null;
  private floatingSelection: {
    documentId: string;
    layer: ImageLayer;
    source: Surface;
    revision: number;
    selection: ImageLayer;
    selectionSource: Surface;
    selectionRevision: number;
  } | null = null;
  private floatingSelectionPromise: Promise<SelectionTransformTargets | null> | null = null;
  private suppressContextMenu = false;
  private canvasBackground: GPUColorDict = { r: 0.067, g: 0.082, b: 0.118, a: 1 };

  constructor(
    readonly gpu: Gpu,
    readonly canvas: HTMLCanvasElement,
    readonly stage: HTMLElement,
    readonly overlay: SVGSVGElement,
    readonly brushCursor: HTMLElement,
    readonly toolModeCursor: HTMLElement,
    readonly report: (error: unknown) => void,
  ) {
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not create a WebGPU canvas.');
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device: gpu.device, format, alphaMode: 'opaque', colorSpace: 'srgb' });
    this.compositor = new Compositor(gpu, format);
    this.layerReframer = new LayerReframer(gpu, this.compositor.quads);
    this.layerMasks = new MaskRenderer(gpu);
    this.brush = new Brush(gpu);
    this.retouch = new RetouchBrush(gpu);
    this.paths = new PathRenderer(gpu);
    this.readback = new GpuReadback(gpu);
    this.previews = new LayerPreviews(this.readback);
    this.picker = new PixelPicker(this.compositor, this.readback);
    this.filters.register({ kind: 'blur', label: 'Gaussian blur', group: 'Blur', create: (id) => new BlurFilter(id) });
    this.filters.register({ kind: 'smart-blur', label: 'Smart blur', group: 'Blur', create: (id) => new SmartBlurFilter(id) });
    this.filters.register({ kind: 'brightness-contrast', label: 'Brightness / contrast', group: 'Adjustments', create: (id) => new BrightnessContrastFilter(id) });
    this.filters.register({ kind: 'hue-saturation', label: 'Hue / saturation', group: 'Adjustments', create: (id) => new HueSaturationFilter(id) });
    this.filters.register({ kind: 'curves', label: 'Curves', group: 'Adjustments', create: (id) => new CurvesFilter(id) });
    this.filters.register({ kind: 'exposure', label: 'Exposure', group: 'Adjustments', create: (id) => new ExposureFilter(id) });
    this.filters.register({ kind: 'white-balance', label: 'White balance', group: 'Adjustments', create: (id) => new WhiteBalanceFilter(id) });
    this.filters.register({ kind: 'grayscale', label: 'Grayscale', group: 'Adjustments', create: (id) => new GrayscaleFilter(id) });
    this.filters.register({ kind: 'levels', label: 'Levels', group: 'Adjustments', create: (id) => new LevelsFilter(id) });
    this.filters.register({ kind: 'posterize', label: 'Posterize', group: 'Adjustments', create: (id) => new PosterizeFilter(id) });
    this.filters.register({ kind: 'sharpen', label: 'Sharpen', group: 'Effects', create: (id) => new SharpenFilter(id) });
    this.filters.register({ kind: 'border', label: 'Border', group: 'Effects', create: (id) => new BorderFilter(id) });
    this.filters.register({ kind: 'drop-shadow', label: 'Drop shadow', group: 'Effects', create: (id) => new DropShadowFilter(id) });
    this.filters.register({ kind: 'invert', label: 'Invert', group: 'Adjustments', create: (id) => new InvertFilter(id) });
    this.filters.register({ kind: 'mask', label: 'Mask', create: (id) => new MaskFilter(id) });
    this.currentDocument = this.createDocumentSession();
    this.documents.push(this.currentDocument);
    this.actions = new ActionRegistry(report);
    this.clipboard = new EditorClipboard(this);
    this.baseTool = new BrushTool(this);
    this.tools.set(this.activeTool.id, this.activeTool);
    this.tools.set('rectangle', new RectangleTool(this));
    this.tools.set('ellipse', new EllipseTool(this));
    this.tools.set('freehand-lasso', new FreehandLassoTool(this));
    this.tools.set('polygon-lasso', new PolygonLassoTool(this));
    this.tools.set('fill', new FillTool(this));
    this.tools.set('clone-stamp', new CloneStampTool(this));
    this.tools.set('healing-brush', new HealingBrushTool(this));
    this.tools.set('text', new TextTool(this));
    this.tools.set('crop', new CropTool(this));
    this.tools.set('transform', new TransformTool(this));
    this.tools.set('eyedropper', new EyedropperTool(this));
    this.generators = new GeneratorManager(this);
    this.files = new DocumentFiles(this);
    this.attachDocument(this.currentDocument);
    this.actions.beforeExecute = (action) => {
      if (!action.id.startsWith('polygon.')) this.finishGesture();
    };
    this.actions.blocked = () => this.halted || this.reframing || this.files.busy;
    this.actions.context = () => ({
      hasSelection: !!this.image.selectionMask,
      canSelectionLayer: !!this.selectionPixelTarget,
      isGenerating: this.generators.busy,
      isCropping: this.activeTool.id === 'crop',
      hasPolygonPath: this.activeTool.id === 'polygon-lasso' && (this.activeTool as PolygonLassoTool).hasPath,
      canApplyPolygon: this.activeTool.id === 'polygon-lasso' && (this.activeTool as PolygonLassoTool).canApply,
      isTransforming: this.activeTool.id === 'transform' && this.image.selectedRoots.length > 0,
    });
    this.registerActions();
    this.attachInput();
    new ResizeObserver(() => this.resize()).observe(stage);
    window.addEventListener('resize', () => this.resize());
  }

  get activeTool(): Tool { return this.altHeld && this.baseTool.supportsAltEyedropper ? this.tools.get('eyedropper')! : this.baseTool; }
  get document(): EditorDocument { return this.currentDocument; }
  get image(): ImageDocument { return this.currentDocument.image; }
  get history(): UndoStack { return this.currentDocument.history; }
  get viewport(): Viewport { return this.currentDocument.viewport; }
  get showGrid(): boolean { return this.currentDocument.showGrid; }
  set showGrid(value: boolean) { this.currentDocument.showGrid = value; }
  get showGuides(): boolean { return this.currentDocument.showGuides; }
  set showGuides(value: boolean) { this.currentDocument.showGuides = value; }
  get snapping(): boolean { return this.currentDocument.snapping; }
  set snapping(value: boolean) { this.currentDocument.snapping = value; }
  get maskEditLayer(): ImageLayer | null { return this.editedMask; }
  get editingPixels(): boolean { return this.reframing; }
  get panHeld(): boolean { return this.panKeyHeld || this.panMode; }
  get generatorTarget(): Layer {
    if (!this.image.selected.isSelection) return this.image.selected;
    return this.image.allLayers().find((layer) => layer.id === this.selectionReturnId) ?? this.image.root;
  }

  setCanvasBackground(color: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    const channel = (offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    this.canvasBackground = { r: channel(1), g: channel(3), b: channel(5), a: 1 };
    this.requestRender();
  }

  private createDocumentSession(): EditorDocument {
    const document = new EditorDocument(
      this.gpu, this.compositor, this.filters, this.layerReframer, this.layerMasks, () => this.flushPaint(),
      (owner, operation, direction) => this.applyUndo(owner, operation, direction),
    );
    const rect = this.stage.getBoundingClientRect();
    document.viewport.width = Math.max(1, rect.width);
    document.viewport.height = Math.max(1, rect.height);
    return document;
  }

  private attachDocument(document: EditorDocument): void {
    document.image.onInvalidated = () => { if (document === this.currentDocument) this.requestRender(); };
    document.image.onChange = () => {
      if (document === this.currentDocument) this.changed();
      else this.onDocumentsChange?.();
    };
    document.history.onChange = () => {
      if (document !== this.currentDocument) { this.onDocumentsChange?.(); return; }
      this.pickGeneration++;
      this.queuePreviews();
      this.changed();
      this.checkSelectionEmpty();
    };
    document.viewport.onChange = () => {
      if (document !== this.currentDocument) return;
      this.refreshHover();
      this.requestRender();
    };
  }

  private storeDocumentState(): void {
    const document = this.currentDocument;
    document.selectionMode = this.selectionMode;
    document.selectionReturnId = this.selectionReturnId;
    document.editedMaskId = this.editedMask?.id ?? null;
    if (this.generators) document.generationLens = [...this.generators.lens.transform] as Matrix;
  }

  activateDocument(document: EditorDocument): void {
    if (document === this.currentDocument || !this.documents.includes(document)) return;
    this.finishGesture();
    this.storeDocumentState();
    this.generators.documentChanging();
    this.pickGeneration++;
    this.tools.get('eyedropper')?.cancel();
    this.previews.clear();
    this.currentDocument = document;
    this.floatingSelection = null;
    this.floatingSelectionPromise = null;
    this.selectionMode = document.selectionMode && !!document.image.selectionLayer;
    this.selectionReturnId = document.selectionReturnId;
    this.editedMask = document.editedMaskId ?
      (document.image.allLayers().find((layer) => layer.id === document.editedMaskId && layer instanceof ImageLayer) as ImageLayer | undefined) ?? null : null;
    this.generators.resetLens(document.image.width, document.image.height);
    if (document.generationLens) this.generators.lens.setTransform(document.generationLens);
    const rect = this.stage.getBoundingClientRect();
    if (document.viewport.width !== rect.width || document.viewport.height !== rect.height) {
      document.viewport.resize(Math.max(1, rect.width), Math.max(1, rect.height));
    }
    this.canvas.style.cursor = this.panHeld ? 'grab' : this.activeTool.cursor;
    this.queuePreviews();
    this.changed();
    this.onDocumentsChange?.();
  }

  activateRelativeDocument(offset: number): void {
    if (this.documents.length < 2) return;
    const index = this.documents.indexOf(this.currentDocument);
    this.activateDocument(this.documents[(index + offset + this.documents.length) % this.documents.length]);
  }

  reorderDocument(document: EditorDocument, index: number): void {
    const previous = this.documents.indexOf(document);
    if (previous < 0) return;
    const target = Math.max(0, Math.min(index, this.documents.length - 1));
    if (target === previous) return;
    this.documents.splice(previous, 1);
    this.documents.splice(target, 0, document);
    this.onDocumentsChange?.();
  }

  createDocument(width: number, height: number): EditorDocument {
    const document = this.createDocumentSession();
    document.image.reset(width, height);
    document.viewport.fit(document.image.frame);
    document.savedState = document.history.stateId;
    this.attachDocument(document);
    this.documents.push(document);
    this.activateDocument(document);
    return document;
  }

  addLoadedDocument(loaded: LoadedDocument): EditorDocument {
    const document = this.createDocumentSession();
    document.image.replace(loaded.root, loaded.width, loaded.height, loaded.selection, loaded.activeSelectionId, loaded.precision);
    document.generationLens = [...loaded.generationLens] as Matrix;
    document.selectionMode = document.image.selected.isSelection && !!document.image.selectionMask;
    document.viewport.fit(document.image.frame);
    document.savedState = document.history.stateId;
    this.attachDocument(document);
    this.documents.push(document);
    this.activateDocument(document);
    return document;
  }

  closeDocument(document: EditorDocument): void {
    const index = this.documents.indexOf(document);
    if (index < 0) return;
    if (this.documents.length === 1) this.createDocument(1000, 750);
    if (document === this.currentDocument) {
      const next = this.documents[index + 1] ?? this.documents[index - 1];
      if (next) this.activateDocument(next);
    }
    this.documents.splice(this.documents.indexOf(document), 1);
    document.dispose(this.compositor);
    this.onDocumentsChange?.();
    this.changed();
  }

  disposeDocuments(): void {
    this.generators.documentChanging();
    this.halted = true;
    this.finishGesture();
    for (const document of this.documents.splice(0)) document.dispose(this.compositor);
    this.clipboard.dispose();
  }

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
    return this.image.selectedLayers.length === 1 && this.image.selected instanceof ImageLayer && this.image.selected.pixelEditable ? this.image.selected : null;
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
    const surface = source.snapshot('Drawing selection snapshot');
    return { surface, transform: multiply(inverse(selection.worldTransform()), layer.worldTransform()) };
  }

  setSelectionMode(enabled: boolean): void {
    this.finishGesture();
    if (enabled) {
      if (!this.image.selected.isSelection) this.selectionReturnId = this.image.selected.id;
      this.image.ensureSelection();
    }
    this.selectionMode = enabled;
    this.checkSelectionEmpty();
    this.changed();
  }

  private checkSelectionEmpty(): void {
    if (this.selectionCheck || this.interacting || this.reframing || this.halted) return;
    const image = this.image;
    const selection = image.selectionLayer;
    if (!selection) { this.checkedSelection = null; this.floatingSelection = null; return; }
    const checked = this.checkedSelection;
    const sameContent = checked?.documentId === image.id && checked.layer === selection &&
      checked.source === selection.source && checked.revision === selection.revision;
    if (sameContent && checked.outputRevision === selection.outputRevision && checked.rootRevision === image.root.revision) return;
    this.flushPaint();
    const output = this.compositor.resolve(selection, this.rasterDensity);
    if (sameContent && checked.outputRevision === selection.outputRevision) {
      checked.rootRevision = image.root.revision;
      return;
    }
    const state: SelectionContentState = {
      documentId: image.id, layer: selection, source: selection.source, revision: selection.revision,
      outputRevision: selection.outputRevision, rootRevision: image.root.revision,
    };
    // Hold the exact pixels being checked: edits and undo can replace the live surface during readback.
    const snapshot = output.snapshot('Selection occupancy');
    this.selectionCheck = this.readback.isEmpty(snapshot).then((empty) => {
      if (this.image !== image || image.id !== state.documentId || image.selectionLayer !== selection ||
        selection.source !== state.source || selection.revision !== state.revision || selection.outputRevision !== state.outputRevision ||
        image.root.revision !== state.rootRevision || this.interacting || this.reframing || this.halted) return;
      this.checkedSelection = state;
      const active = image.selectionMask;
      if (empty) {
        image.deactivateEmptySelection(selection);
        this.floatingSelection = null;
        if (active) {
          this.selectionMode = false;
          if (this.maskEditLayer === selection) this.setMaskEditLayer(null);
          if (image.isSelected(selection)) {
            image.selected = image.allLayers().find((layer) => layer.id === this.selectionReturnId && !layer.isSelection) ?? image.root;
          }
        }
      } else image.activateSelection(selection);
      if (image.selectionMask !== active) this.changed();
    }).catch(this.report).finally(() => {
      snapshot.destroy();
      this.selectionCheck = null;
      this.requestRender();
    });
  }

  deselect(): void {
    const selection = this.image.selectionLayer;
    if (!selection) return;
    this.setSelectionMode(false);
    this.image.deleteSelected(selection);
  }

  clearSelectedPixels(layer = this.paintTarget): void {
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
      } finally { for (const snapshot of snapshots.values()) snapshot.destroy(); }
      throw error;
    } finally { selection?.surface.destroy(); }
  }

  get selectionPixelTarget(): ImageLayer | null {
    if (!this.image.selectionMask || this.image.selectedLayers.length !== 1) return null;
    const selected = this.image.selected;
    const candidate = selected.isSelection ?
      this.image.allLayers().find((layer) => layer.id === this.selectionReturnId) : selected;
    return candidate instanceof ImageLayer && candidate.channels === 4 && !!candidate.parent ? candidate : null;
  }

  private async layerViaSelection(cut: boolean): Promise<void> {
    const layer = this.selectionPixelTarget;
    const selection = this.image.selectionMask;
    if (!layer || !selection) return;
    await this.editPixels(async () => {
      const copy = await this.image.commands.layerViaSelection(layer, selection, cut);
      if (copy) this.rememberFloatingSelection(copy, selection);
    });
  }

  private rememberFloatingSelection(layer: ImageLayer, selection: ImageLayer): void {
    this.floatingSelection = {
      documentId: this.image.id, layer, source: layer.source, revision: layer.revision,
      selection, selectionSource: selection.source, selectionRevision: selection.revision,
    };
  }

  async selectionTransformTargets(): Promise<SelectionTransformTargets | null> {
    const selection = this.image.selectionMask;
    const existing = this.floatingSelection;
    if (selection && existing && this.hasFloatingSelection) return { primary: existing.layer, layers: [existing.layer, selection] };
    if (this.floatingSelectionPromise) return this.floatingSelectionPromise;
    this.floatingSelection = null;
    const target = this.selectionPixelTarget;
    if (!selection || !target?.pixelEditable) return null;
    const documentId = this.image.id;
    const prepare = (async () => {
      const layer = await this.image.commands.layerViaSelection(target, selection, true, false);
      if (!layer || this.image.id !== documentId || !layer.parent || this.image.selectionMask !== selection) return null;
      this.rememberFloatingSelection(layer, selection);
      this.selectionMode = false;
      this.changed();
      return { primary: layer, layers: [layer, selection] as readonly Layer[] };
    })();
    this.floatingSelectionPromise = prepare;
    try { return await prepare; }
    finally { if (this.floatingSelectionPromise === prepare) this.floatingSelectionPromise = null; }
  }

  get hasFloatingSelection(): boolean {
    const floating = this.floatingSelection;
    return !!floating && floating.documentId === this.image.id && this.image.selectionMask === floating.selection &&
      this.selectionPixelTarget === floating.layer && !!floating.layer.parent && this.image.allLayers().includes(floating.layer) &&
      floating.layer.source === floating.source && floating.layer.revision === floating.revision &&
      floating.selection.source === floating.selectionSource && floating.selection.revision === floating.selectionRevision;
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
    const hover = pointer && this.pointer?.mode !== 'pan' ?
      { ...pointer, world: this.viewport.screenToWorld(pointer.screen) } : null;
    this.activeTool.hover(hover);
    const generatorHover = this.generators.hover(hover);
    const modes = !generatorHover && this.activeTool.supportsDrawingModes && !this.panHeld && !!hover && (this.selectionMode || this.eraseMode);
    this.toolModeCursor.hidden = !modes;
    if (!modes || !hover) return;
    this.toolModeCursor.style.left = `${hover.screen.x + 12}px`;
    this.toolModeCursor.style.top = `${hover.screen.y + 12}px`;
    for (const icon of this.toolModeCursor.querySelectorAll<HTMLElement>('[data-mode]')) {
      icon.hidden = icon.dataset.mode === 'selection' ? !this.selectionMode : !this.eraseMode;
    }
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
    if (this.baseTool.supportsAltEyedropper) {
      if (this.pointer?.mode === 'tool') this.finishGesture();
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
    this.generators?.validate();
    this.files?.sync();
    if (this.editedMask && (this.image.selected !== this.editedMask || !this.image.allLayers().includes(this.editedMask))) {
      this.setMaskEditLayer(null);
    }
    if (!this.image.selectionLayer) this.selectionMode = false;
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
      this.pendingRetouchStamps.clear();
      this.run(() => {
        this.generators.validate();
        const density = this.canvas.width / this.viewport.width;
        const stats = this.compositor.render(
          this.image.root, this.context.getCurrentTexture().createView(), this.viewport.bounds(), this.image.frame, this.viewport.scale * density,
          this.canvasBackground, this.image.selectionMask, this.selectionMode, this.editedMask, this.generators.visual,
        );
        this.overlay.replaceChildren();
        this.drawPrecisionOverlay();
        if (this.activeTool.id === 'crop') this.activeTool.drawOverlay();
        else if (this.activeTool.id === 'transform') this.activeTool.drawOverlay();
        else {
          this.activeTool.drawOverlay();
          (this.tools.get('transform') as TransformTool).drawOverlay(false);
        }
        this.generators.drawOverlay();
        if (!this.interacting) {
          this.checkSelectionEmpty();
          if (this.previewsReady) { this.previewsReady = false; this.onPreviews?.(); }
          if (this.previewsRequested && !this.previewsRunning) void this.refreshPreviews().catch(this.report);
        }
        this.onFrame?.(stats);
        if ((this.image.selectionMask && !this.editedMask) || this.generators.visual) this.requestRender();
      });
    });
  }

  private drawPrecisionOverlay(): void {
    const addLine = (a: Point, b: Point, className: string) => {
      const line = document.createElementNS(this.overlay.namespaceURI, 'line');
      line.setAttribute('x1', String(a.x));
      line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x));
      line.setAttribute('y2', String(b.y));
      line.setAttribute('class', className);
      this.overlay.append(line);
    };
    if (this.showGrid) {
      const visible = this.viewport.bounds();
      const left = Math.max(0, visible.x), top = Math.max(0, visible.y);
      const right = Math.min(this.image.width, visible.x + visible.width);
      const bottom = Math.min(this.image.height, visible.y + visible.height);
      let spacing = this.image.gridSize;
      while (spacing * this.viewport.scale < 8 || (right - left + bottom - top) / spacing > 300) spacing *= 2;
      for (let x = Math.ceil(left / spacing) * spacing; x <= right; x += spacing) {
        addLine(this.viewport.worldToScreen({ x, y: 0 }), this.viewport.worldToScreen({ x, y: this.image.height }), 'document-grid');
      }
      for (let y = Math.ceil(top / spacing) * spacing; y <= bottom; y += spacing) {
        addLine(this.viewport.worldToScreen({ x: 0, y }), this.viewport.worldToScreen({ x: this.image.width, y }), 'document-grid');
      }
    }
    if (this.showGuides) for (const guide of this.image.guides) {
      if (guide.axis === 'vertical') {
        const x = this.viewport.worldToScreen({ x: guide.position, y: 0 }).x;
        if (x >= 0 && x <= this.viewport.width) addLine({ x, y: 0 }, { x, y: this.viewport.height }, 'document-guide');
      } else {
        const y = this.viewport.worldToScreen({ x: 0, y: guide.position }).y;
        if (y >= 0 && y <= this.viewport.height) addLine({ x: 0, y }, { x: this.viewport.width, y }, 'document-guide');
      }
    }
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
    this.generators.documentChanging();
    this.finishGesture();
    this.pickGeneration++;
    this.tools.get('eyedropper')?.cancel();
    this.previews.clear();
    this.selectionMode = false;
    this.selectionReturnId = null;
    this.setMaskEditLayer(null);
    this.generators.resetLens(width, height);
    this.image.reset(width, height);
    this.queuePreviews();
    this.viewport.fit(this.image.frame);
    this.files.reset();
    this.changed();
  }

  loadDocument(document: LoadedDocument): void {
    this.generators.documentChanging();
    this.finishGesture();
    this.pickGeneration++;
    this.tools.get('eyedropper')?.cancel();
    this.previews.clear();
    this.selectionMode = false;
    this.selectionReturnId = null;
    this.setMaskEditLayer(null);
    this.image.replace(document.root, document.width, document.height, document.selection, document.activeSelectionId, document.precision);
    this.generators.resetLens(document.width, document.height);
    this.generators.lens.setTransform(document.generationLens);
    this.selectionMode = this.image.selected.isSelection && !!this.image.selectionMask;
    this.queuePreviews();
    this.viewport.fit(this.image.frame);
  }

  select(layer: Layer, mode: 'replace' | 'toggle' | 'range' = 'replace', order?: Layer[]): void {
    this.pickGeneration++;
    this.finishGesture();
    if (layer.isSelection && !this.image.selected.isSelection) this.selectionReturnId = this.image.selected.id;
    this.image.select(layer, mode, order);
    if (!this.image.selected.isSelection) this.selectionReturnId = this.image.selected.id;
    if (this.image.selectedLayers.length > 1) this.setMaskEditLayer(null);
    this.changed();
  }

  switchTool(id: string): void {
    const tool = this.tools.get(id);
    if (!tool || (tool === this.baseTool && !this.panMode && !this.selectionMode && !this.eraseMode)) return;
    const previous = this.activeTool;
    this.finishGesture();
    previous.hover(null);
    if (previous.id === 'crop' && tool !== previous) previous.cancel();
    this.pickGeneration++;
    this.baseTool = tool;
    if (tool.id === 'crop' || tool.id === 'text') this.setMaskEditLayer(null);
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

  paintRetouch(layer: ImageLayer, stamp: RetouchStamp, input: RetouchInput): void {
    let stamps = this.pendingRetouchStamps.get(layer);
    if (!stamps) {
      stamps = [];
      this.pendingRetouchStamps.set(layer, stamps);
      const batch = stamps;
      const operation = this.retouch.operation(batch, input);
      this.compositor.enqueue(layer, operation);
    }
    stamps.push(stamp);
  }

  flushPaint(): void {
    this.compositor.flush();
    this.pendingStamps.clear();
    this.pendingRetouchStamps.clear();
  }

  finishGesture(): void {
    const pointer = this.pointer;
    this.pointer = null;
    this.commitEdits?.();
    if (pointer?.mode === 'generator') this.generators.finish();
    else this.activeTool.finish();
    this.flushPaint();
    if (pointer && this.canvas.hasPointerCapture(pointer.id)) this.canvas.releasePointerCapture(pointer.id);
    this.canvas.style.cursor = this.panHeld ? 'grab' : this.activeTool.cursor;
    this.checkSelectionEmpty();
    this.requestRender();
  }

  cancelGesture(): void {
    const pointer = this.pointer;
    this.pointer = null;
    if (pointer?.mode === 'generator') this.generators.cancelGesture();
    else this.activeTool.cancel();
    if (pointer && this.canvas.hasPointerCapture(pointer.id)) this.canvas.releasePointerCapture(pointer.id);
    this.changed();
  }

  setPanHeld(held: boolean): void {
    this.panKeyHeld = held;
    this.updatePanCursor();
  }

  private updatePanCursor(): void {
    if (this.panHeld && (this.pointer?.mode === 'tool' || this.pointer?.mode === 'generator')) {
      if (this.pointer.mode === 'generator') this.generators.finish();
      else if (!(this.activeTool instanceof PolygonLassoTool && this.activeTool.hasPath)) this.activeTool.finish();
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

  async nudgeSelection(dx: number, dy: number): Promise<void> {
    await this.changeSelectedGeometry('Nudge', (_visible, layers) => {
      const operation = translation(dx, dy);
      for (const layer of layers) applyWorldTransform(layer, operation);
    });
  }

  async alignSelection(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): Promise<void> {
    await this.changeSelectedGeometry('Align ' + mode, (visible, layers) => {
      const bounds = visible.map(worldBounds);
      const target = visible.length === 1 ? this.image.frame : unionBounds(bounds);
      for (let index = 0; index < visible.length; index++) {
        const bounds = worldBounds(visible[index]);
        let dx = 0, dy = 0;
        if (mode === 'left') dx = target.x - bounds.x;
        if (mode === 'center') dx = target.x + target.width / 2 - bounds.x - bounds.width / 2;
        if (mode === 'right') dx = target.x + target.width - bounds.x - bounds.width;
        if (mode === 'top') dy = target.y - bounds.y;
        if (mode === 'middle') dy = target.y + target.height / 2 - bounds.y - bounds.height / 2;
        if (mode === 'bottom') dy = target.y + target.height - bounds.y - bounds.height;
        const operation = translation(dx, dy);
        if (visible.length === 1 && layers.length > 1) for (const layer of layers) applyWorldTransform(layer, operation);
        else applyWorldTransform(visible[index], operation);
      }
    });
  }

  async distributeSelection(axis: 'horizontal' | 'vertical'): Promise<void> {
    await this.changeSelectedGeometry(`Distribute ${axis} centers`, (visible) => {
      if (visible.length < 3) return;
      const entries = visible.map((layer) => {
        const bounds = worldBounds(layer);
        return { layer, center: axis === 'horizontal' ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2 };
      }).sort((a, b) => a.center - b.center);
      const first = entries[0].center;
      const interval = (entries[entries.length - 1].center - first) / (entries.length - 1);
      for (let index = 1; index < entries.length - 1; index++) {
        const offset = first + interval * index - entries[index].center;
        applyWorldTransform(entries[index].layer, translation(axis === 'horizontal' ? offset : 0, axis === 'vertical' ? offset : 0));
      }
    });
  }

  async rotateSelection(clockwise: boolean): Promise<void> {
    await this.changeSelectedGeometry(clockwise ? 'Rotate 90° clockwise' : 'Rotate 90° counterclockwise', (visible, layers) => {
      const bounds = unionBounds(visible.map(worldBounds));
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const operation = around(center, clockwise ? [0, 1, -1, 0, 0, 0] : [0, -1, 1, 0, 0, 0]);
      for (const layer of layers) applyWorldTransform(layer, operation);
    });
  }

  async flipSelection(axis: 'horizontal' | 'vertical'): Promise<void> {
    await this.changeSelectedGeometry(axis === 'horizontal' ? 'Flip horizontally' : 'Flip vertically', (visible, layers) => {
      const bounds = unionBounds(visible.map(worldBounds));
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const operation = around(center, axis === 'horizontal' ? [-1, 0, 0, 1, 0, 0] : [1, 0, 0, -1, 0, 0]);
      for (const layer of layers) applyWorldTransform(layer, operation);
    });
  }

  setPrecisionState(state: PrecisionState, label: string): void {
    this.finishGesture();
    const before = this.image.precisionState();
    this.image.setPrecisionState(state);
    const after = this.image.precisionState();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.history.push(new UndoOperation(
      label,
      { type: 'image', targetId: this.image.id, action: 'precision', data: before as unknown as JsonObject },
      { type: 'image', targetId: this.image.id, action: 'precision', data: after as unknown as JsonObject },
    ));
  }

  addGuide(axis: Guide['axis'], position: number): void {
    const state = this.image.precisionState();
    state.guides.push({ axis, position });
    this.setPrecisionState(state, 'Add guide');
  }

  updateGuide(index: number, guide: Guide): void {
    const state = this.image.precisionState();
    if (!state.guides[index]) return;
    state.guides[index] = guide;
    this.setPrecisionState(state, 'Edit guide');
  }

  deleteGuide(index: number): void {
    const state = this.image.precisionState();
    if (!state.guides[index]) return;
    state.guides.splice(index, 1);
    this.setPrecisionState(state, 'Delete guide');
  }

  private async changeSelectedGeometry(label: string, mutate: (visible: readonly Layer[], layers: readonly Layer[]) => void): Promise<void> {
    this.finishGesture();
    const hasSelection = !!this.image.selectionMask;
    const selection = await this.selectionTransformTargets();
    if (hasSelection && !selection) return;
    const visible = selection ? [selection.primary] : this.image.selectedRoots;
    const layers = selection?.layers ?? visible;
    if (!layers.length) return;
    const before = layers.map((layer) => layer.properties());
    try { mutate(visible, layers); }
    catch (error) {
      for (let index = 0; index < layers.length; index++) layers[index].setProperties(before[index]);
      throw error;
    }
    this.recordLayerChanges(layers, before, selection ? label + ' selected pixels' : layers.length > 1 ? label + ' layers' : label + ' layer');
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

  private applyUndo(document: EditorDocument, operation: UndoOperation, direction: UndoDirection): void {
    if (document !== this.currentDocument) throw new Error('Cannot edit the history of an inactive document.');
    this.flushPaint();
    const image = document.image;
    const payload = operation.payload(direction);
    if (payload.type === 'image') image.applyUndo(operation, direction);
    else if (payload.type === 'layer') {
      const layer = image.find(payload.targetId);
      layer.applyUndo(operation, direction, { gpu: this.gpu, filters: this.filters });
      if (!layer.isSelection) image.selected = layer;
    } else if (payload.type === 'filter') {
      const layer = image.find(String(payload.data.layerId));
      const filter = layer.filters.find((item) => item.id === payload.targetId);
      if (!filter) throw new Error('Undo filter no longer exists.');
      filter.applyUndo(operation, direction);
      layer.invalidate();
      if (!layer.isSelection) image.selected = layer;
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

  async editPixels(edit: () => void | Promise<void>): Promise<void> {
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
    register({ id: 'file.close', label: 'Close document', menu: 'File', separatorBefore: true, execute: () => this.files.closeDocument() });
    register({ id: 'file.export-png', label: 'PNG image…', menu: 'File', submenu: 'Export', execute: () => this.files.exportImage('png') });
    register({ id: 'file.export-webp', label: 'WebP image…', menu: 'File', submenu: 'Export', execute: () => this.files.exportImage('webp') });
    register({ id: 'file.import', label: 'Add image…', menu: 'File', execute: async () => {
      const image = await window.desktop.openImage();
      if (image) await this.addImage(image.name, new Blob([image.bytes]));
    } });
    register({ id: 'command.palette', label: 'Command palette…', menu: 'Edit', execute: () => this.onCommandPalette?.() });
    register({ id: 'settings.open', label: 'Settings…', menu: 'File', separatorBefore: true, execute: () => this.onOpenSettings?.() });
    register({ id: 'settings.canvas-background', label: 'Canvas background…', execute: () => this.onCanvasBackgroundSettings?.() });
    register({ id: 'help.repository', label: 'GitHub repository', menu: 'Help', execute: async () => { await window.desktop.openRepository(); } });
    register({ id: 'help.about', label: 'About Texel', menu: 'Help', separatorBefore: true, execute: () => this.onOpenAbout?.() });
    register({ id: 'layer.new', label: 'New pixel layer', menu: 'Layer', execute: () => this.image.createPixelLayer() });
    register({ id: 'layer.new-text', label: 'New text layer', menu: 'Layer', execute: () => (this.tools.get('text') as TextTool).createAt() });
    register({ id: 'layer.new-sized', label: 'New sized layer…', menu: 'Layer', execute: () => this.onNewSizedLayer?.() });
    register({ id: 'mask.new', label: 'New mask layer', menu: 'Layer', execute: () => this.image.createMask() });
    register({ id: 'group.new', label: 'New group', menu: 'Layer', execute: () => this.image.add(new GroupLayer('Group')) });
    register({ id: 'history.undo', label: () => `Undo${this.history.canUndo ? ` ${this.history.undoLabel}` : ''}`, menu: 'Edit', enabled: () => this.history.canUndo, execute: () => this.history.undo() });
    register({ id: 'history.redo', label: () => `Redo${this.history.canRedo ? ` ${this.history.redoLabel}` : ''}`, menu: 'Edit', enabled: () => this.history.canRedo, execute: () => this.history.redo() });
    register({
      id: 'clipboard.cut', label: 'Cut', menu: 'Edit', separatorBefore: true,
      enabled: () => this.clipboard.canCut, execute: () => this.editPixels(() => this.clipboard.cut()),
    });
    register({
      id: 'clipboard.copy', label: 'Copy', menu: 'Edit', enabled: () => this.clipboard.canCopy,
      execute: () => this.editPixels(() => this.clipboard.copy()),
    });
    register({ id: 'clipboard.paste', label: 'Paste', menu: 'Edit', execute: () => this.editPixels(() => this.clipboard.paste()) });
    register({
      id: 'layer.duplicate', menu: 'Layer', separatorBefore: true,
      label: () => this.image.selectedRoots.length > 1 ? 'Duplicate layers' : 'Duplicate layer',
      enabled: () => this.image.selectedRoots.length > 0 && !this.image.selected.isSelection,
      execute: () => this.editPixels(() => this.image.duplicateSelected()),
    });
    register({ id: 'layer.group', label: 'Group layers', menu: 'Layer', enabled: () => this.image.selectedRoots.length > 0 && !this.image.selected.isSelection, execute: () => this.image.groupSelected() });
    register({
      id: 'layer.merge', menu: 'Layer',
      label: () => this.image.selectedRoots.length > 1 ? 'Merge layers' : this.image.selected instanceof GroupLayer ? 'Merge group' : 'Merge down',
      enabled: () => this.image.commands.mergeTargets.length > 0, execute: () => this.image.mergeSelected(),
    });
    register({
      id: 'selection.layer-copy', label: 'Layer via Copy', menu: 'Layer',
      enabled: () => !!this.selectionPixelTarget, execute: () => this.layerViaSelection(false),
    });
    register({
      id: 'selection.layer-cut', label: 'Layer via Cut', menu: 'Layer',
      enabled: () => !!this.selectionPixelTarget?.pixelEditable, execute: () => this.layerViaSelection(true),
    });
    register({ id: 'layer.rename', label: 'Rename layer', menu: 'Layer', enabled: () => this.image.selectedLayers.length === 1, execute: () => this.onRename?.() });
    register({ id: 'layer.delete', label: () => this.image.selectedRoots.length > 1 ? 'Delete layers' : 'Delete layer', menu: 'Layer', enabled: () => !!this.image.selected.parent, execute: () => this.image.deleteSelected() });
    const reframe = (mode: ReframeMode, label: string, separatorBefore = false) => register({
      id: `layer.reframe.${mode}`, label, menu: 'Layer', submenu: 'Reframe', separatorBefore,
      enabled: () => this.image.selectedLayers.length === 1 && this.image.selected instanceof ImageLayer && this.image.selected.pixelEditable,
      execute: () => this.editPixels(() => this.image.reframe(this.image.selected as ImageLayer, mode)),
    });
    reframe('normalize', 'Normalize to Canvas', true);
    reframe('trim', 'Trim Transparent Borders');
    reframe('extend', 'Extend to Canvas');
    const canTransform = () => this.image.selectionMask ? !!this.selectionPixelTarget?.pixelEditable : this.image.selectedRoots.length > 0;
    for (const [id, label, dx, dy] of [
      ['left', 'Nudge left', -1, 0], ['right', 'Nudge right', 1, 0],
      ['up', 'Nudge up', 0, -1], ['down', 'Nudge down', 0, 1],
    ] as const) register({
      id: `transform.nudge-${id}`, label, menu: 'Layer', submenu: 'Transform', enabled: canTransform,
      execute: () => this.nudgeSelection(dx, dy),
    });
    for (const [id, label, dx, dy] of [
      ['left', 'Nudge left 10 px', -10, 0], ['right', 'Nudge right 10 px', 10, 0],
      ['up', 'Nudge up 10 px', 0, -10], ['down', 'Nudge down 10 px', 0, 10],
    ] as const) register({
      id: `transform.nudge-${id}-10`, label, menu: 'Layer', submenu: 'Transform', enabled: canTransform,
      execute: () => this.nudgeSelection(dx, dy),
    });
    for (const mode of ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const) register({
      id: `transform.align-${mode}`, label: `Align ${mode}`, menu: 'Layer', submenu: 'Align', enabled: canTransform,
      execute: () => this.alignSelection(mode),
    });
    register({
      id: 'transform.distribute-horizontal', label: 'Distribute horizontal centers', menu: 'Layer', submenu: 'Distribute',
      enabled: () => !this.image.selectionMask && this.image.selectedRoots.length >= 3, execute: () => this.distributeSelection('horizontal'),
    });
    register({
      id: 'transform.distribute-vertical', label: 'Distribute vertical centers', menu: 'Layer', submenu: 'Distribute',
      enabled: () => !this.image.selectionMask && this.image.selectedRoots.length >= 3, execute: () => this.distributeSelection('vertical'),
    });
    register({ id: 'transform.rotate-cw', label: 'Rotate 90° clockwise', menu: 'Layer', submenu: 'Transform', enabled: canTransform, execute: () => this.rotateSelection(true) });
    register({ id: 'transform.rotate-ccw', label: 'Rotate 90° counterclockwise', menu: 'Layer', submenu: 'Transform', enabled: canTransform, execute: () => this.rotateSelection(false) });
    register({ id: 'transform.flip-horizontal', label: 'Flip horizontally', menu: 'Layer', submenu: 'Transform', enabled: canTransform, execute: () => this.flipSelection('horizontal') });
    register({ id: 'transform.flip-vertical', label: 'Flip vertically', menu: 'Layer', submenu: 'Transform', enabled: canTransform, execute: () => this.flipSelection('vertical') });
    for (const [direction, offset] of [['up', 1], ['down', -1]] as const) register({
      id: `layer.${direction}`, label: () => `Move ${this.image.selectedRoots.length > 1 ? 'layers' : 'layer'} ${direction}`, menu: 'Layer', separatorBefore: direction === 'up',
      enabled: () => this.image.commands.canStep(offset),
      execute: () => this.image.commands.step(offset),
    });
    register({
      id: 'layer.visibility', menu: 'Layer',
      enabled: () => this.image.selectedLayers.length === 1,
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
      execute: () => this.clearSelectedPixels(),
    });
    for (const filter of this.filters.list()) register({
      id: `filter.${filter.kind}`, label: filter.label, menu: 'Filter', submenu: filter.group,
      enabled: () => this.image.selectedLayers.length === 1, execute: () => this.addFilter(filter.kind),
    });
    register({
      id: 'filter.apply', label: 'Apply first filter', menu: 'Filter',
      enabled: () => this.image.selectedLayers.length === 1 && this.image.selected instanceof ImageLayer && this.image.selected.pixelEditable && this.image.selected.filters.length > 0,
      execute: () => {
        const layer = this.image.selected;
        if (layer instanceof ImageLayer && layer.filters[0]) this.image.commands.applyFilter(layer, layer.filters[0]);
      },
    });
    register({ id: 'selection.mode', label: () => this.selectionMode ? 'Finish editing selection' : 'Edit selection', menu: 'Select', execute: () => this.setSelectionMode(!this.selectionMode) });
    register({ id: 'selection.all', label: 'Select all', menu: 'Select', execute: () => {
      this.image.ensureSelection(true);
      this.changed();
    } });
    register({ id: 'selection.deselect', label: 'Deselect', menu: 'Select', enabled: () => !!this.image.selectionLayer, execute: () => this.deselect() });
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
    register({ id: 'generator.image', label: 'Image generator', menu: 'Tools', submenu: 'Generators', execute: () => this.generators.open('image') });
    register({ id: 'generator.object-removal', label: 'Object removal', menu: 'Tools', submenu: 'Generators', execute: () => this.generators.open('object-removal') });
    register({ id: 'generator.inpaint', label: 'Inpaint', menu: 'Tools', submenu: 'Generators', execute: () => this.generators.open('inpaint') });
    register({
      id: 'generator.generate', label: 'Generate', menu: 'Tools', submenu: 'Generators',
      enabled: () => !!this.generators.active?.canGenerate, execute: () => this.generators.generate(),
    });
    register({
      id: 'generator.apply', label: 'Apply generator result', menu: 'Tools', submenu: 'Generators',
      enabled: () => !!this.generators.active?.canApply, execute: () => this.generators.apply(),
    });
    register({
      id: 'generator.cancel', label: 'Cancel generator request', menu: 'Tools', submenu: 'Generators',
      enabled: () => this.generators.busy, execute: () => this.generators.cancel(),
    });
    register({
      id: 'generator.close', label: 'Close generator', menu: 'Tools', submenu: 'Generators',
      enabled: () => !!this.generators.active, execute: () => this.generators.close(),
    });
    register({ id: 'generator.fit', label: 'Fit generator lens to canvas', menu: 'Tools', submenu: 'Generators', enabled: () => !!this.generators.active && !this.generators.busy, execute: () => this.generators.fitLens() });
    register({ id: 'generator.models', label: 'Refresh AI models', menu: 'Tools', submenu: 'Generators', execute: () => this.generators.refreshModels() });
    register({ id: 'tool.brush', label: 'Brush', menu: 'Tools', execute: () => this.switchTool('brush') });
    register({ id: 'tool.rectangle', label: 'Rectangle', menu: 'Tools', execute: () => this.switchTool('rectangle') });
    register({ id: 'tool.ellipse', label: 'Ellipse', menu: 'Tools', execute: () => this.switchTool('ellipse') });
    register({ id: 'tool.freehand-lasso', label: 'Freehand Lasso', menu: 'Tools', execute: () => this.switchTool('freehand-lasso') });
    register({ id: 'tool.polygon-lasso', label: 'Polygon Lasso', menu: 'Tools', execute: () => this.switchTool('polygon-lasso') });
    register({ id: 'tool.fill', label: 'Fill', menu: 'Tools', execute: () => this.switchTool('fill') });
    register({ id: 'tool.clone-stamp', label: 'Clone Stamp', menu: 'Tools', execute: () => this.switchTool('clone-stamp') });
    register({ id: 'tool.healing-brush', label: 'Healing Brush', menu: 'Tools', execute: () => this.switchTool('healing-brush') });
    register({ id: 'tool.text', label: 'Text', menu: 'Tools', execute: () => { this.setSelectionMode(false); this.switchTool('text'); } });
    register({
      id: 'polygon.apply', label: 'Apply polygon', menu: 'Tools', submenu: 'Polygon Lasso',
      enabled: () => this.activeTool.id === 'polygon-lasso' && (this.activeTool as PolygonLassoTool).canApply,
      execute: () => (this.tools.get('polygon-lasso') as PolygonLassoTool).apply(),
    });
    register({
      id: 'polygon.cancel', label: 'Cancel polygon', menu: 'Tools', submenu: 'Polygon Lasso',
      enabled: () => this.activeTool.id === 'polygon-lasso' && (this.activeTool as PolygonLassoTool).hasPath,
      execute: () => (this.tools.get('polygon-lasso') as PolygonLassoTool).cancel(),
    });
    register({
      id: 'polygon.remove-point', label: 'Remove last polygon point', menu: 'Tools', submenu: 'Polygon Lasso',
      enabled: () => this.activeTool.id === 'polygon-lasso' && (this.activeTool as PolygonLassoTool).hasPath,
      execute: () => (this.tools.get('polygon-lasso') as PolygonLassoTool).removeLast(),
    });
    register({
      id: 'tool.crop', label: 'Crop', menu: 'Tools',
      enabled: () => !this.generators.busy, execute: () => this.switchTool('crop'),
    });
    register({
      id: 'crop.apply', label: 'Apply crop', menu: 'Tools', submenu: 'Crop',
      enabled: () => this.activeTool.id === 'crop' && (this.tools.get('crop') as CropTool).canApply,
      execute: () => (this.tools.get('crop') as CropTool).apply(),
    });
    register({
      id: 'crop.cancel', label: 'Cancel crop', menu: 'Tools', submenu: 'Crop',
      enabled: () => this.activeTool.id === 'crop', execute: () => (this.tools.get('crop') as CropTool).cancel(),
    });
    register({ id: 'tool.transform', label: 'Move / transform', menu: 'Tools', execute: () => this.switchTool('transform') });
    register({
      id: 'tool.eyedropper', label: 'Eyedropper', menu: 'Tools', execute: () => this.switchTool('eyedropper'),
      hold: {
        press: () => this.setAltHeld(true),
        release: () => this.setAltHeld(false),
      },
    });
    register({
      id: 'view.next-document', label: 'Next document', menu: 'View',
      enabled: () => this.documents.length > 1, execute: () => this.activateRelativeDocument(1),
    });
    register({
      id: 'view.previous-document', label: 'Previous document', menu: 'View',
      enabled: () => this.documents.length > 1, execute: () => this.activateRelativeDocument(-1),
    });
    register({
      id: 'view.pan', label: () => this.panMode ? 'Exit pan mode' : 'Pan mode', menu: 'View',
      separatorBefore: true,
      execute: () => { this.panMode = !this.panMode; this.updatePanCursor(); this.changed(); },
      hold: {
        press: () => this.setPanHeld(true),
        release: () => this.setPanHeld(false),
      },
    });
    register({ id: 'view.fit', label: 'Fit image', menu: 'View', execute: () => this.viewport.fit(this.image.frame) });
    register({
      id: 'view.grid', label: () => this.showGrid ? 'Hide grid' : 'Show grid', menu: 'View',
      execute: () => { this.showGrid = !this.showGrid; this.changed(); },
    });
    register({
      id: 'view.guides', label: () => this.showGuides ? 'Hide guides' : 'Show guides', menu: 'View',
      execute: () => { this.showGuides = !this.showGuides; this.changed(); },
    });
    register({
      id: 'view.snapping', label: () => this.snapping ? 'Disable snapping' : 'Enable snapping', menu: 'View',
      execute: () => { this.snapping = !this.snapping; this.changed(); },
    });
    register({ id: 'view.guide-settings', label: 'Grid and guides…', menu: 'View', execute: () => this.onGuideSettings?.() });
    this.actions.bind('D', 'colors.reset');
    this.actions.bind('X', 'colors.swap');
    this.actions.bind('G', 'generator.image');
    this.actions.bind('Escape', 'generator.cancel', { when: 'isGenerating' });
    this.actions.bind('B', 'tool.brush');
    this.actions.bind('R', 'tool.rectangle');
    this.actions.bind('O', 'tool.ellipse');
    this.actions.bind('L', 'tool.freehand-lasso');
    this.actions.bind('P', 'tool.polygon-lasso');
    this.actions.bind('F', 'tool.fill');
    this.actions.bind('K', 'tool.clone-stamp');
    this.actions.bind('H', 'tool.healing-brush');
    this.actions.bind('T', 'tool.text');
    this.actions.bind('Enter', 'polygon.apply', { when: 'canApplyPolygon' });
    this.actions.bind('Escape', 'polygon.cancel', { when: 'hasPolygonPath' });
    this.actions.bind('Backspace', 'polygon.remove-point', { when: 'hasPolygonPath' });
    this.actions.bind('C', 'tool.crop');
    this.actions.bind('Enter', 'crop.apply', { when: 'isCropping' });
    this.actions.bind('Escape', 'crop.cancel', { when: 'isCropping && !isGenerating' });
    this.actions.bind('E', 'drawing.erase');
    this.actions.bind('S', 'selection.mode');
    this.actions.bind('Ctrl+A', 'selection.all');
    this.actions.bind('Ctrl+D', 'selection.deselect');
    this.actions.bind('V', 'tool.transform');
    this.actions.bind('ArrowLeft', 'transform.nudge-left', { when: 'isTransforming', repeat: true });
    this.actions.bind('ArrowRight', 'transform.nudge-right', { when: 'isTransforming', repeat: true });
    this.actions.bind('ArrowUp', 'transform.nudge-up', { when: 'isTransforming', repeat: true });
    this.actions.bind('ArrowDown', 'transform.nudge-down', { when: 'isTransforming', repeat: true });
    this.actions.bind('Shift+ArrowLeft', 'transform.nudge-left-10', { when: 'isTransforming', repeat: true });
    this.actions.bind('Shift+ArrowRight', 'transform.nudge-right-10', { when: 'isTransforming', repeat: true });
    this.actions.bind('Shift+ArrowUp', 'transform.nudge-up-10', { when: 'isTransforming', repeat: true });
    this.actions.bind('Shift+ArrowDown', 'transform.nudge-down-10', { when: 'isTransforming', repeat: true });
    this.actions.bind('I', 'tool.eyedropper');
    this.actions.bind('Alt', 'tool.eyedropper', { hold: true });
    this.actions.bind('Ctrl+I', 'filter.invert');
    this.actions.bind('Delete', 'layer.delete', { when: '!hasSelection' });
    this.actions.bind('Delete', 'selection.clear', { when: 'hasSelection' });
    this.actions.bind('Ctrl+J', 'layer.duplicate');
    this.actions.bind('Ctrl+J', 'selection.layer-copy', { when: 'canSelectionLayer' });
    this.actions.bind('Ctrl+Shift+J', 'selection.layer-cut', { when: 'canSelectionLayer' });
    this.actions.bind('Ctrl+G', 'layer.group');
    this.actions.bind('Ctrl+E', 'layer.merge');
    this.actions.bind('Ctrl+F', 'layer.reframe.normalize');
    this.actions.bind('Insert', 'layer.new');
    this.actions.bind('Ctrl+Shift+N', 'layer.new');
    this.actions.bind('F2', 'layer.rename');
    this.actions.bind('Space', 'view.pan', { hold: true });
    this.actions.bind('Ctrl+Z', 'history.undo');
    this.actions.bind('Ctrl+Shift+Z', 'history.redo');
    this.actions.bind('Ctrl+Y', 'history.redo');
    this.actions.bind('Ctrl+N', 'file.new');
    this.actions.bind('Ctrl+O', 'file.open');
    this.actions.bind('Ctrl+S', 'file.save');
    this.actions.bind('Ctrl+Shift+S', 'file.save-as');
    this.actions.bind('Ctrl+W', 'file.close');
    this.actions.bind('Ctrl+Tab', 'view.next-document');
    this.actions.bind('Ctrl+Shift+Tab', 'view.previous-document');
    this.actions.bind('Ctrl+Shift+O', 'file.import');
    this.actions.bind('Ctrl+P', 'command.palette');
    this.actions.bind('Ctrl+X', 'clipboard.cut');
    this.actions.bind('Ctrl+C', 'clipboard.copy');
    this.actions.bind('Ctrl+V', 'clipboard.paste');
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
        shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey,
      };
    };
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointerenter', (event) => this.run(() => {
      if (!event.isPrimary) return;
      this.hoverPointer = pointerData(event);
      this.refreshHover();
    }));
    this.canvas.addEventListener('pointerdown', (event) => this.run(() => {
      if (this.pointer || !event.isPrimary || ![0, 1, 2].includes(event.button)) return;
      event.preventDefault();
      if (event.button === 2) this.suppressContextMenu = false;
      this.pickGeneration++;
      if (!(this.activeTool instanceof PolygonLassoTool && this.activeTool.hasPath)) this.finishGesture();
      this.canvas.focus({ preventScroll: true });
      this.setAltHeld(event.altKey);
      const data = pointerData(event);
      const mode = this.panHeld || event.button === 1 || event.button === 2 ? 'pan' :
        this.generators.pointerDown(data) ? 'generator' : 'tool';
      this.hoverPointer = data;
      this.pointer = { id: event.pointerId, mode, button: event.button, last: data.screen, travel: 0 };
      this.canvas.setPointerCapture(event.pointerId);
      if (mode === 'tool') this.activeTool.pointerDown(data);
      else if (mode === 'generator') this.activeTool.hover(null);
      else { this.activeTool.hover(null); this.canvas.style.cursor = 'grabbing'; }
    }));
    this.canvas.addEventListener('pointermove', (event) => this.run(() => {
      if (this.pointer && this.pointer.id !== event.pointerId) return;
      const data = pointerData(event);
      this.hoverPointer = data;
      this.refreshHover();
      if (this.pointer?.mode === 'pan') {
        const dx = data.screen.x - this.pointer.last.x;
        const dy = data.screen.y - this.pointer.last.y;
        this.pointer.travel += Math.hypot(dx, dy);
        if (this.pointer.button !== 2 || this.pointer.travel >= 3) this.viewport.pan(dx, dy);
        this.pointer.last = data.screen;
        return;
      }
      if (this.pointer?.mode === 'generator') {
        this.generators.pointerMove(data);
        this.pointer.last = data.screen;
        return;
      }
      if (this.pointer?.mode !== 'tool') return;
      const coalesced = event.getCoalescedEvents?.() ?? [];
      for (const sample of coalesced.length ? coalesced : [event]) this.activeTool.pointerMove(pointerData(sample));
      this.pointer.last = data.screen;
    }));
    this.canvas.addEventListener('pointerup', (event) => this.run(() => {
      if (this.pointer?.id !== event.pointerId) return;
      this.hoverPointer = pointerData(event);
      if (this.pointer.mode === 'pan' && this.pointer.button === 2 && this.pointer.travel >= 3) this.suppressContextMenu = true;
      if (this.pointer.mode === 'tool' && ['transform', 'rectangle', 'ellipse', 'freehand-lasso', 'crop', 'eyedropper', 'clone-stamp', 'healing-brush'].includes(this.activeTool.id)) {
        this.activeTool.pointerMove(this.hoverPointer);
      }
      if (this.activeTool instanceof PolygonLassoTool && this.activeTool.hasPath) {
        const pointer = this.pointer;
        this.pointer = null;
        if (this.canvas.hasPointerCapture(pointer.id)) this.canvas.releasePointerCapture(pointer.id);
        this.canvas.style.cursor = this.panHeld ? 'grab' : this.activeTool.cursor;
        this.requestRender();
        this.refreshHover();
        return;
      }
      this.finishGesture();
      this.refreshHover();
    }));
    this.canvas.addEventListener('pointercancel', () => this.run(() => this.cancelGesture()));
    this.canvas.addEventListener('lostpointercapture', () => { if (this.pointer) this.run(() => this.cancelGesture()); });
    this.canvas.addEventListener('dblclick', (event) => this.run(() => {
      if (event.button !== 0 || !(this.activeTool instanceof PolygonLassoTool) || !this.activeTool.hasPath) return;
      event.preventDefault();
      this.activeTool.apply();
    }));
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverPointer = null;
      this.refreshHover();
    });
    this.canvas.addEventListener('contextmenu', (event) => this.run(() => {
      event.preventDefault();
      if (this.suppressContextMenu) { this.suppressContextMenu = false; return; }
      this.finishGesture();
      const point = pointerData(event).world;
      const frame = this.image.frame;
      if (point.x < frame.x || point.y < frame.y || point.x >= frame.x + frame.width || point.y >= frame.y + frame.height) {
        const items = this.actions.menuItems(['settings.canvas-background']);
        void window.desktop.openContextMenu(items, event.clientX, event.clientY).catch(this.report);
        return;
      }
      if (!this.image.selectionMask) return;
      const items = this.actions.menuItems(['selection.promote', 'selection.layer-copy', 'selection.layer-cut']);
      void window.desktop.openContextMenu(items, event.clientX, event.clientY).catch(this.report);
    }));
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.run(() => {
        const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.height : 1;
        this.hoverPointer = pointerData(event);
        if ((event.shiftKey || event.ctrlKey) && this.activeTool instanceof BrushLikeTool) {
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
