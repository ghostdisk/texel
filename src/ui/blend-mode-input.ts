import type { BlendMode } from '../model/layers';
import { icon } from './icons';

interface BlendModeInputOptions {
  preview: (mode: BlendMode | null) => void;
  change: (mode: BlendMode) => void;
}

export class BlendModeInput {
  private readonly element = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly label = document.createElement('span');
  private readonly panel = document.createElement('div');
  private readonly choices: HTMLButtonElement[] = [];
  private previewResetTimer = 0;

  constructor(private readonly select: HTMLSelectElement, private readonly options: BlendModeInputOptions) {
    this.element.className = 'blend-mode-input';
    this.button.type = 'button';
    this.button.className = 'blend-mode-button';
    this.button.setAttribute('aria-label', select.getAttribute('aria-label') ?? 'Layer blend mode');
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.append(this.label, icon('chevron-down'));
    this.panel.className = 'blend-mode-menu';
    this.panel.id = 'blend-mode-menu-' + crypto.randomUUID();
    this.panel.popover = 'auto';
    this.panel.role = 'listbox';
    this.panel.setAttribute('aria-label', 'Layer blend mode');
    this.button.setAttribute('aria-controls', this.panel.id);
    for (const group of select.querySelectorAll('optgroup')) this.addGroup(group);
    this.button.onclick = () => this.panel.matches(':popover-open') ? this.panel.hidePopover() : this.show();
    this.button.onkeydown = (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      this.show();
      const selected = this.choices.findIndex((choice) => choice.ariaSelected === 'true');
      this.choices[Math.max(0, selected)]?.focus();
    };
    this.panel.addEventListener('toggle', () => {
      const open = this.panel.matches(':popover-open');
      this.button.setAttribute('aria-expanded', String(open));
      if (!open) this.preview(null);
    });
    this.element.append(this.button, this.panel);
    select.hidden = true;
    select.after(this.element);
  }

  sync(value: BlendMode, disabled: boolean): void {
    this.select.value = value;
    this.button.disabled = disabled;
    this.label.textContent = this.select.selectedOptions[0]?.textContent ?? value;
    for (const choice of this.choices) choice.ariaSelected = String(choice.dataset.blendMode === value);
    if (disabled && this.panel.matches(':popover-open')) this.panel.hidePopover();
  }

  private addGroup(group: HTMLOptGroupElement): void {
    const container = document.createElement('div');
    container.className = 'blend-mode-group';
    container.role = 'group';
    container.setAttribute('aria-label', group.label);
    const label = document.createElement('div');
    label.className = 'blend-mode-group-label';
    label.textContent = group.label;
    container.append(label);
    for (const option of group.querySelectorAll('option')) {
      const choice = document.createElement('button');
      const mode = option.value as BlendMode;
      choice.type = 'button';
      choice.className = 'blend-mode-option';
      choice.role = 'option';
      choice.dataset.blendMode = mode;
      choice.textContent = option.textContent;
      choice.onpointerenter = () => this.preview(mode);
      choice.onpointerleave = () => this.schedulePreviewReset();
      choice.onfocus = () => this.preview(mode);
      choice.onclick = () => {
        this.options.change(mode);
        this.panel.hidePopover();
        this.button.focus();
      };
      choice.onkeydown = (event) => this.navigate(event, choice);
      this.choices.push(choice);
      container.append(choice);
    }
    this.panel.append(container);
  }

  private show(): void {
    if (this.button.disabled || this.panel.matches(':popover-open')) return;
    this.panel.showPopover();
    const anchor = this.button.getBoundingClientRect();
    this.panel.style.width = `${Math.max(anchor.width, 168)}px`;
    const bounds = this.panel.getBoundingClientRect();
    this.panel.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)) + 'px';
    this.panel.style.top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 8)) + 'px';
  }

  private preview(mode: BlendMode | null): void {
    window.clearTimeout(this.previewResetTimer);
    this.previewResetTimer = 0;
    this.options.preview(mode);
  }

  private schedulePreviewReset(): void {
    window.clearTimeout(this.previewResetTimer);
    this.previewResetTimer = window.setTimeout(() => this.preview(null), 0);
  }

  private navigate(event: KeyboardEvent, choice: HTMLButtonElement): void {
    const index = this.choices.indexOf(choice);
    let target = index;
    if (event.key === 'ArrowDown') target = Math.min(this.choices.length - 1, index + 1);
    else if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = this.choices.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      this.panel.hidePopover();
      this.button.focus();
      return;
    } else return;
    event.preventDefault();
    this.choices[target]?.focus();
  }
}
