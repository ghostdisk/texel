import type { Layer } from '../model/layers';

export interface LayerDragPosition {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  target: Element | null;
}

interface LayerDragCallbacks {
  begin(layer: Layer, row: HTMLElement): boolean;
  move(position: LayerDragPosition): 'alias' | 'grabbing' | 'not-allowed';
  drop(position: LayerDragPosition): void;
  end(): void;
  error(error: unknown): void;
}

interface LayerGesture {
  layer: Layer;
  row: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  started: boolean;
}

/** Layer gestures stay in the app, independent of native button and OS drag behavior. */
export class LayerPointerDrag {
  private gesture: LayerGesture | null = null;
  private scrollFrame = 0;
  private scrollTime = 0;
  private suppressClick = false;

  constructor(private readonly tree: HTMLElement, private readonly callbacks: LayerDragCallbacks) {
    window.addEventListener('pointermove', (event) => this.run(() => this.move(event)), true);
    window.addEventListener('pointerup', (event) => this.run(() => this.release(event)), true);
    window.addEventListener('pointercancel', (event) => {
      if (event.pointerId === this.gesture?.pointerId) this.finish();
    }, true);
    window.addEventListener('lostpointercapture', (event) => {
      if (event.pointerId === this.gesture?.pointerId) this.finish();
    }, true);
    window.addEventListener('blur', () => this.finish());
    window.addEventListener('keydown', (event) => {
      if (!this.gesture) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.finish();
      } else if (event.key === 'Shift') this.run(() => this.modifier(true));
    }, true);
    window.addEventListener('keyup', (event) => {
      if (event.key === 'Shift') this.run(() => this.modifier(false));
    }, true);
    window.addEventListener('click', (event) => {
      if (!this.suppressClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    tree.addEventListener('scroll', () => {
      if (this.gesture?.started) this.run(() => this.update());
    });
  }

  bind(row: HTMLElement, layer: Layer): void {
    row.draggable = false;
    row.ondragstart = (event) => event.preventDefault();
    row.onpointerdown = (event) => {
      if (this.gesture || !layer.parent || !event.isPrimary || event.button !== 0) return;
      const control = event.target instanceof Element ?
        event.target.closest('input, textarea, select, [contenteditable="true"], button:not(.select-layer)') : null;
      if (control) return;
      // Shift normally affects text selection and button focus before native dragging starts.
      if (event.shiftKey) event.preventDefault();
      this.gesture = {
        layer, row, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, started: false,
      };
    };
  }

  cancel(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    document.body.classList.remove('layer-pointer-drag');
    document.body.style.removeProperty('--layer-drag-cursor');
    if (gesture?.row.hasPointerCapture(gesture.pointerId)) gesture.row.releasePointerCapture(gesture.pointerId);
  }

  private finish(): void {
    this.cancel();
    this.callbacks.end();
  }

  private run(action: () => void): void {
    try { action(); }
    catch (error) { this.finish(); this.callbacks.error(error); }
  }

  private position(gesture: LayerGesture): LayerDragPosition {
    return {
      clientX: gesture.clientX, clientY: gesture.clientY, shiftKey: gesture.shiftKey,
      target: document.elementFromPoint(gesture.clientX, gesture.clientY),
    };
  }

  private update(): void {
    if (!this.gesture?.started) return;
    const cursor = this.callbacks.move(this.position(this.gesture));
    document.body.style.setProperty('--layer-drag-cursor', cursor);
  }

  private modifier(shiftKey: boolean): void {
    if (!this.gesture) return;
    this.gesture.shiftKey = shiftKey;
    this.update();
  }

  private move(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;
    gesture.shiftKey = event.shiftKey;
    if (!gesture.started) {
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 5) return;
      if (!this.callbacks.begin(gesture.layer, gesture.row) || this.gesture !== gesture || !gesture.row.isConnected) {
        this.finish();
        return;
      }
      gesture.started = true;
      gesture.row.setPointerCapture(gesture.pointerId);
      window.getSelection()?.removeAllRanges();
      document.body.classList.add('layer-pointer-drag');
      this.scrollTime = performance.now();
      this.scrollFrame = requestAnimationFrame((time) => this.run(() => this.scroll(time)));
    }
    event.preventDefault();
    event.stopPropagation();
    this.update();
  }

  private release(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.started) { this.cancel(); return; }
    event.preventDefault();
    event.stopPropagation();
    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;
    gesture.shiftKey = event.shiftKey;
    const position = this.position(gesture);
    // Capture retargets the synthetic click to the source row; a drop must not select it.
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    this.cancel();
    try { this.callbacks.drop(position); }
    finally { this.callbacks.end(); }
  }

  private scroll(time: number): void {
    this.scrollFrame = 0;
    const gesture = this.gesture;
    if (!gesture?.started) return;
    const elapsed = Math.min(50, time - this.scrollTime) / 1000;
    this.scrollTime = time;
    const bounds = this.tree.getBoundingClientRect();
    if (gesture.clientX >= bounds.left && gesture.clientX <= bounds.right &&
      gesture.clientY >= bounds.top - 24 && gesture.clientY <= bounds.bottom + 24) {
      const direction = gesture.clientY < bounds.top + 24 ? -Math.min(1, (bounds.top + 24 - gesture.clientY) / 24) :
        gesture.clientY > bounds.bottom - 24 ? Math.min(1, (gesture.clientY - bounds.bottom + 24) / 24) : 0;
      const previous = this.tree.scrollTop;
      this.tree.scrollTop += direction * 360 * elapsed;
      if (this.tree.scrollTop !== previous) this.update();
    }
    if (this.gesture?.started) this.scrollFrame = requestAnimationFrame((next) => this.run(() => this.scroll(next)));
  }
}
