import { icon } from './icons';
import type { IconName } from './icons';

export class Popover {
  readonly element = document.createElement('div');
  readonly button = document.createElement('button');
  readonly panel = document.createElement('div');

  constructor(label: string, glyph: IconName = 'chevron-down', iconOnly = false) {
    this.element.className = 'popover-control';
    this.button.type = 'button';
    this.button.className = iconOnly ? 'icon-button' : 'popover-button';
    this.button.append(icon(glyph));
    if (!iconOnly) this.button.append(document.createTextNode(label));
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-expanded', 'false');
    this.panel.id = 'popover-' + crypto.randomUUID();
    this.panel.className = 'popover-panel';
    this.panel.popover = 'auto';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', label);
    this.button.setAttribute('aria-controls', this.panel.id);
    this.button.onclick = () => {
      if (this.panel.matches(':popover-open')) this.panel.hidePopover();
      else this.show();
    };
    this.button.onkeydown = (event) => {
      if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.show();
        this.panel.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
      }
    };
    this.panel.addEventListener('toggle', () => this.button.setAttribute('aria-expanded', String(this.panel.matches(':popover-open'))));
    this.element.append(this.button, this.panel);
  }

  show(): void {
    this.panel.showPopover();
    const anchor = this.button.getBoundingClientRect(), bounds = this.panel.getBoundingClientRect();
    this.panel.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)) + 'px';
    this.panel.style.top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - bounds.height - 8)) + 'px';
  }
}
