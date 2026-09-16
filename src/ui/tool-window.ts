import type { Editor } from '../editor';
import type { Tool } from '../tools/tool';
import { icon } from './icons';

/** Shared floating window host for tools launched from menus. */
export class ToolWindow {
  private readonly window = document.createElement('section');
  private readonly title = document.createElement('strong');
  private readonly body = document.createElement('div');
  private tool: Tool | null = null;

  constructor(private readonly editor: Editor) {
    this.window.className = 'generation-window tool-window';
    this.window.hidden = true;
    this.window.setAttribute('role', 'dialog');
    const header = document.createElement('header');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.append(icon('close'));
    close.setAttribute('aria-label', 'Close tool');
    close.onclick = () => this.editor.closeToolPopup();
    header.append(this.title, close);
    this.dragWindow(header);
    this.body.className = 'generation-window-body tool-window-body';
    this.window.append(header, this.body);
    document.body.append(this.window);
  }

  sync(tool: Tool | null): void {
    if (!tool?.popup) {
      this.window.hidden = true;
      this.tool = null;
      this.body.replaceChildren();
      return;
    }
    if (this.tool !== tool) {
      this.tool = tool;
      this.title.textContent = tool.label;
      this.window.setAttribute('aria-label', tool.label);
      this.body.replaceChildren();
      tool.drawPopup(this.body);
    }
    this.window.hidden = false;
    tool.syncPopup();
  }

  private dragWindow(handle: HTMLElement): void {
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || event.target instanceof Element && event.target.closest('button')) return;
      const bounds = this.window.getBoundingClientRect();
      const offsetX = event.clientX - bounds.left, offsetY = event.clientY - bounds.top;
      handle.setPointerCapture(event.pointerId);
      handle.onpointermove = (move) => {
        this.window.style.right = 'auto';
        this.window.style.left = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, move.clientX - offsetX)) + 'px';
        this.window.style.top = Math.max(42, Math.min(window.innerHeight - 80, move.clientY - offsetY)) + 'px';
      };
      handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; };
    };
  }
}
