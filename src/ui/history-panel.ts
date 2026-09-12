import type { Editor } from '../editor';
import type { HistoryState } from '../history/undo';
import { icon } from './icons';
import type { IconName } from './icons';

export class HistoryPanel {
  private signature = '';
  private readonly rows = new Map<string, HTMLButtonElement>();

  constructor(private readonly editor: Editor, private readonly container: HTMLElement) {}

  render(): void {
    const history = this.editor.history;
    const states = history.timeline;
    const signature = states.map((state) => state.id).join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.container.replaceChildren();
      this.rows.clear();
      for (const state of states) {
        const row = document.createElement('button');
        row.className = 'history-row';
        const label = document.createElement('span');
        label.textContent = state.label;
        row.append(icon(this.glyph(state)), label);
        row.title = 'Restore: ' + state.label;
        row.onclick = () => this.editor.run(() => {
          this.editor.finishGesture();
          this.editor.history.goTo(state.id);
        });
        row.onkeydown = (event) => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation(); };
        this.container.append(row);
        this.rows.set(state.id, row);
      }
    }
    const blocked = this.editor.actions.blocked?.() ?? false;
    states.forEach((state, index) => {
      const row = this.rows.get(state.id)!;
      row.classList.toggle('current', state.id === history.stateId);
      row.classList.toggle('future', index > history.currentIndex);
      row.setAttribute('aria-current', state.id === history.stateId ? 'step' : 'false');
      row.disabled = blocked;
    });
  }

  private glyph(state: HistoryState): IconName {
    const operation = state.operation;
    if (!operation) return 'document';
    if (state.label === 'Remove selection') return 'remove';
    if (state.label === 'Generate image') return 'generate';
    if (operation.type === 'filter' || operation.action.includes('filter')) return 'settings';
    if (operation.type === 'tool') {
      if (operation.targetId === 'brush') return /eras|clear/i.test(state.label) ? 'eraser' : 'brush';
      if (operation.targetId === 'rectangle') return 'rectangle';
      return 'transform';
    }
    return 'layers';
  }
}
