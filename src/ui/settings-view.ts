import type { SettingsStore } from '../settings';
import { THEMES } from '../themes';

export class SettingsView {
  private readonly dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
  private readonly grid = document.querySelector<HTMLElement>('#theme-grid')!;
  private readonly canvasBackground = document.querySelector<HTMLInputElement>('#canvas-background')!;
  private readonly resetCanvasBackground = document.querySelector<HTMLButtonElement>('#reset-canvas-background')!;
  private readonly openRouterKey = document.querySelector<HTMLInputElement>('#openrouter-key')!;
  private readonly openRouterStatus = document.querySelector<HTMLElement>('#openrouter-key-status')!;
  private readonly removeOpenRouterKey = document.querySelector<HTMLButtonElement>('#remove-openrouter-key')!;
  private readonly falKey = document.querySelector<HTMLInputElement>('#fal-key')!;
  private readonly falStatus = document.querySelector<HTMLElement>('#fal-key-status')!;
  private readonly removeFalKey = document.querySelector<HTMLButtonElement>('#remove-fal-key')!;

  constructor(private readonly settings: SettingsStore) {
    document.querySelector<HTMLButtonElement>('#close-settings')!.onclick = () => this.dialog.close();
    this.canvasBackground.onchange = () => settings.setCanvasBackground(this.canvasBackground.value);
    this.resetCanvasBackground.onclick = () => settings.setCanvasBackground(null);
    document.querySelector<HTMLButtonElement>('#save-openrouter-key')!.onclick = () => void this.saveOpenRouterKey();
    this.removeOpenRouterKey.onclick = () => void this.saveOpenRouterKey(true);
    document.querySelector<HTMLButtonElement>('#save-fal-key')!.onclick = () => void this.saveFalKey();
    this.removeFalKey.onclick = () => void this.saveFalKey(true);
    this.render();
    settings.subscribe(() => this.sync());
  }

  open(): void {
    this.sync();
    void this.syncOpenRouter();
    void this.syncFal();
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

  private async syncOpenRouter(): Promise<void> {
    try {
      const status = await window.desktop.openRouterKeyStatus();
      const configured = !!status?.configured;
      this.openRouterStatus.textContent = configured ? 'Connected' : 'Not configured';
      this.removeOpenRouterKey.disabled = !configured;
      this.openRouterKey.placeholder = configured ? 'Key stored securely' : 'sk-or-…';
    } catch (error) { this.openRouterStatus.textContent = error instanceof Error ? error.message : String(error); }
  }

  private async saveOpenRouterKey(remove = false): Promise<void> {
    try {
      const status = await window.desktop.setOpenRouterKey(remove ? '' : this.openRouterKey.value);
      this.openRouterKey.value = '';
      this.openRouterStatus.textContent = status?.configured ? 'Connected' : 'Not configured';
      this.removeOpenRouterKey.disabled = !status?.configured;
      this.openRouterKey.placeholder = status?.configured ? 'Key stored securely' : 'sk-or-…';
    } catch (error) { this.openRouterStatus.textContent = error instanceof Error ? error.message : String(error); }
  }

  private async syncFal(): Promise<void> {
    try {
      const status = await window.desktop.falKeyStatus();
      const configured = !!status?.configured;
      this.falStatus.textContent = configured ? 'Connected' : 'Not configured';
      this.removeFalKey.disabled = !configured;
      this.falKey.placeholder = configured ? 'Key stored securely' : 'key ID:key secret';
    } catch (error) { this.falStatus.textContent = error instanceof Error ? error.message : String(error); }
  }

  private async saveFalKey(remove = false): Promise<void> {
    try {
      const status = await window.desktop.setFalKey(remove ? '' : this.falKey.value);
      this.falKey.value = '';
      this.falStatus.textContent = status?.configured ? 'Connected' : 'Not configured';
      this.removeFalKey.disabled = !status?.configured;
      this.falKey.placeholder = status?.configured ? 'Key stored securely' : 'key ID:key secret';
    } catch (error) { this.falStatus.textContent = error instanceof Error ? error.message : String(error); }
  }
}
