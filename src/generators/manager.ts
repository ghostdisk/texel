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
import type { GenerationLens } from '../generation/lens';

export class GeneratorManager {
  readonly service = new AIRequestService();
  readonly generators = new Map<string, Generator>();
  private current: Generator | null = null;
  private readonly controls: TransformControls;
  private readonly window: GeneratorWindow;

  constructor(private readonly editor: Editor) {
    for (const generator of [
      new ImageGenerator(editor, this.service),
      new BackgroundRemovalGenerator(editor, this.service),
      new ObjectRemovalGenerator(editor, this.service),
      new InpaintGenerator(editor, this.service),
    ]) this.generators.set(generator.id, generator);
    this.controls = new TransformControls(editor, () => this.active!.lens, () => !!this.active && !this.active.busy, undefined, false);
    this.window = new GeneratorWindow(editor, this);
    this.service.onChange = () => {
      for (const generator of this.generators.values()) generator.chooseDefaultModel();
      this.window.update();
      this.editor.changed();
    };
  }

  get active(): Generator | null { return this.current; }
  get lens(): GenerationLens { return this.generators.get('image')!.lens; }
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
    for (const generator of this.generators.values()) generator.lens.fit(width, height);
  }

  validate(): void {
    this.current?.validate();
    this.window.update();
  }

  pointerDown(pointer: ToolPointer): boolean {
    return !!this.current && this.controls.pointerDown(pointer);
  }

  pointerMove(pointer: ToolPointer): void { if (this.controls.active) this.controls.pointerMove(pointer); }

  finish(): void {
    const change = this.controls.finish();
    if (change) this.current?.recordLensTransform(change.before);
  }

  cancelGesture(): void { this.controls.cancel(); }

  hover(pointer: ToolPointer | null): boolean {
    if (!this.current || !pointer || !this.controls.wantsPointer(pointer)) return false;
    this.controls.hover(pointer);
    return true;
  }

  drawOverlay(): void { if (this.current) this.controls.drawOverlay(); }

  documentChanging(): void {
    if (this.current) this.close();
  }
}
