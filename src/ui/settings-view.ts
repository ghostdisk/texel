import type { SettingsStore } from '../settings';
import { THEMES } from '../themes';

export class SettingsView {
  private readonly dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
  private readonly grid = document.querySelector<HTMLElement>('#theme-grid')!;
  private readonly canvasBackground = document.querySelector<HTMLInputElement>('#canvas-background')!;
  private readonly resetCanvasBackground = document.querySelector<HTMLButtonElement>('#reset-canvas-background')!;

  constructor(private readonly settings: SettingsStore) {
    document.querySelector<HTMLButtonElement>('#close-settings')!.onclick = () => this.dialog.close();
    this.canvasBackground.onchange = () => settings.setCanvasBackground(this.canvasBackground.value);
    this.resetCanvasBackground.onclick = () => settings.setCanvasBackground(null);
    this.render();
    settings.subscribe(() => this.sync());
  }

  open(): void {
    this.sync();
    this.dialog.showModal();
  }

  openCanvasBackground(): void {
    this.open();
    this.canvasBackground.focus();
  }

  private render(): void {
    for (const theme of THEMES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `theme-card ${theme.className}`;
      card.dataset.theme = theme.id;
      card.innerHTML = `
        <span class="theme-preview" aria-hidden="true">
          <span class="theme-preview-titlebar"></span>
          <span class="theme-preview-sidebar"><i></i><i></i><i></i></span>
          <span class="theme-preview-workspace"><i></i><i></i></span>
        </span>
        <span class="theme-card-copy"><strong>${theme.name}</strong><small>${theme.family}</small></span>`;
      card.onclick = () => this.settings.setTheme(theme.id);
      this.grid.append(card);
    }
    this.sync();
  }

  private sync(): void {
    this.canvasBackground.value = this.settings.canvasBackground;
    this.resetCanvasBackground.disabled = this.settings.customCanvasBackground === null;
    for (const card of this.grid.querySelectorAll<HTMLButtonElement>('.theme-card')) {
      const selected = card.dataset.theme === this.settings.theme;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    }
  }
}
