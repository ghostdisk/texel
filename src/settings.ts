import { DEFAULT_THEME, THEMES, themeById } from './themes';

export interface AppSettings {
  theme: string;
}

export class SettingsStore {
  private value: AppSettings = { theme: DEFAULT_THEME };
  private readonly listeners = new Set<() => void>();
  private saves = Promise.resolve();

  constructor(private readonly report: (error: unknown) => void) {}

  get settings(): Readonly<AppSettings> { return this.value; }
  get theme(): string { return this.value.theme; }
  get canvasBackground(): string {
    return getComputedStyle(document.documentElement).getPropertyValue('--canvas-background-default').trim();
  }

  setTheme(themeId: string): void {
    const theme = themeById(themeId);
    if (theme.id === this.value.theme) return;
    this.value = { ...this.value, theme: theme.id };
    this.applyTheme();
    for (const listener of this.listeners) listener();
    const snapshot = { ...this.value };
    this.saves = this.saves.then(() => window.desktop.updateSettings(snapshot)).then(() => undefined).catch(this.report);
  }

  async load(): Promise<void> {
    try {
      const stored = await window.desktop.getSettings();
      if (stored) this.value = { ...this.value, theme: themeById(stored.theme).id };
    } catch (error) { this.report(error); }
    this.applyTheme();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyTheme(): void {
    const root = document.documentElement;
    root.classList.remove(...THEMES.map((theme) => theme.className));
    const theme = themeById(this.value.theme);
    root.classList.add(theme.className);
    const background = getComputedStyle(root).getPropertyValue('--app-bg').trim();
    void window.desktop.setWindowTheme({ dark: theme.dark, background }).catch(this.report);
  }
}
