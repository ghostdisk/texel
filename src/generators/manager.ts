import type { Editor } from '../editor';
import { AIRequestService } from '../generation/service';
import type { GenerationVisual } from '../gpu/generation-overlay';
import type { ToolPointer } from '../tools/tool';
import { TransformControls } from '../tools/transform-controls';
import { GeneratorWindow } from '../ui/generator-window';
import { Generator } from './generator';
import { BackgroundRemovalGenerator } from './background-removal-generator';
import { ImageGenerator } from './image-generator';
import { InpaintGenerator } from './inpaint-generator';
import { ObjectRemovalGenerator } from './object-removal-generator';
import { ModelTypeGenerator } from './model-type-generator';
import { ExpandGenerator } from './expand-generator';
import { GenerationLens } from '../generation/lens';
import { multiply, transformPoint } from '../model/geometry';
import type { Matrix } from '../model/geometry';

export class GeneratorManager {
  readonly service = new AIRequestService();
  readonly generators = new Map<string, Generator>();
  readonly lens: GenerationLens;
  private current: Generator | null = null;
  private readonly controls: TransformControls;
  private readonly window: GeneratorWindow;

  constructor(private readonly editor: Editor) {
    this.lens = new GenerationLens(1, 1, () => this.editor.changed());
    for (const generator of [
      new ImageGenerator(editor, this.service, this.lens),
      new BackgroundRemovalGenerator(editor, this.service, this.lens),
      new ObjectRemovalGenerator(editor, this.service, this.lens),
      new InpaintGenerator(editor, this.service, this.lens),
      new ModelTypeGenerator(editor, this.service, this.lens, { id: 'enhance', label: 'Upscale / Enhance', resultName: 'Enhanced image', modelTypes: ['restore', 'upscale'] }),
      new ExpandGenerator(editor, this.service, this.lens),
      new ModelTypeGenerator(editor, this.service, this.lens, { id: 'extract-structure', label: 'Extract Structure', resultName: 'Extracted structure', modelTypes: ['structure-extraction'] }),
      new ModelTypeGenerator(editor, this.service, this.lens, { id: 'relight-recolor', label: 'Relight / Recolor', resultName: 'Relit image', modelTypes: ['lighting-color'], prompt: 'Prompt' }),
    ]) this.generators.set(generator.id, generator);
    this.controls = new TransformControls(editor, () => this.lens, () => !!this.active && !this.active.busy,
      undefined, { interiorHit: false, preserveAspectByDefault: false });
    this.window = new GeneratorWindow(editor, this);
    this.service.onChange = () => {
      for (const generator of this.generators.values()) generator.chooseDefaultModel();
      this.window.update();
      this.editor.changed();
    };
  }

  get active(): Generator | null { return this.current; }
  get busy(): boolean { return !!this.current?.busy; }
  get visual(): GenerationVisual | null { return this.current?.visual ?? null; }

  async refreshModels(): Promise<void> {
    await this.service.refreshModels();
    for (const generator of this.generators.values()) generator.chooseDefaultModel();
    this.window.update();
  }

  open(id: string): void {
    const generator = this.generators.get(id);
    if (!generator) return;
    if (this.current === generator) {
      this.window.show(generator);
      return;
    }
    this.close();
    this.current = generator;
    generator.onChange = () => this.window.update();
    generator.open();
    this.window.show(generator);
    this.editor.changed();
  }

  close(): void {
    const generator = this.current;
    if (!generator) return;
    this.controls.cancel();
    if (generator instanceof ExpandGenerator) generator.cancelGesture();
    generator.close();
    this.current = null;
    this.window.hide();
    this.editor.changed();
  }

  cancel(): void { this.current?.cancel(); }
  apply(): void { this.current?.apply(); }
  generate(): Promise<void> { return this.current?.run() ?? Promise.resolve(); }
  fitLens(): void { this.current?.fitLens(); }

  resetLens(width: number, height: number): void {
    this.lens.fit(width, height);
  }

  scaleLens(widthScale: number, heightScale: number): void {
    const scale: Matrix = [widthScale, 0, 0, heightScale, 0, 0];
    this.lens.setTransform(multiply(scale, this.lens.transform));
  }

  validate(): void {
    this.current?.validate();
    this.window.update();
  }

  pointerDown(pointer: ToolPointer): boolean {
    if (!this.current) return false;
    return this.controls.pointerDown(pointer) || this.current instanceof ExpandGenerator && this.current.pointerDown(pointer);
  }

  pointerMove(pointer: ToolPointer): void {
    if (this.controls.active) this.controls.pointerMove(pointer);
    else if (this.current instanceof ExpandGenerator) this.current.pointerMove(pointer);
  }

  finish(): void {
    const change = this.controls.finish();
    if (change) this.current?.recordLensTransform(change.before);
    if (this.current instanceof ExpandGenerator) this.current.finishGesture();
  }

  cancelGesture(): void {
    this.controls.cancel();
    if (this.current instanceof ExpandGenerator) this.current.cancelGesture();
  }

  hover(pointer: ToolPointer | null): boolean {
    if (!this.current || !pointer) return false;
    if (this.controls.wantsPointer(pointer)) { this.controls.hover(pointer); return true; }
    if (this.current instanceof ExpandGenerator && this.current.wantsPointer(pointer)) {
      this.current.hover(pointer);
      return true;
    }
    return false;
  }

  drawOverlay(): void {
    const generator = this.current;
    if (!generator) return;
    if (generator instanceof ExpandGenerator) generator.drawOutputFrame();
    const frame = generator.frame;
    if (frame.canonicalWidth > generator.lens.width + 0.0001 || frame.canonicalHeight > generator.lens.height + 0.0001) {
      const corners = [
        { x: 0, y: 0 }, { x: frame.width, y: 0 },
        { x: frame.width, y: frame.height }, { x: 0, y: frame.height },
      ].map((point) => this.editor.viewport.worldToScreen(transformPoint(frame.transform, point)));
      const rectangle = document.createElementNS(this.editor.overlay.namespaceURI, 'polygon');
      rectangle.setAttribute('points', corners.map((point) => `${point.x},${point.y}`).join(' '));
      rectangle.setAttribute('class', 'generation-expanded-lens');
      this.editor.overlay.append(rectangle);
    }
    this.controls.drawOverlay();
  }

  documentChanging(): void {
    if (this.current) this.close();
  }
}
