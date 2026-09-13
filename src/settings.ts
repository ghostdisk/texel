import { DEFAULT_THEME, THEMES, themeById } from './themes';

export interface AppSettings {
  theme: string;
}

export class SettingsStore {
  private value: AppSettings = { theme: DEFAULT_THEME };
  private readonly listeners = new Set<() => void>();

  get settings(): Readonly<AppSettings> { return this.value; }
  get theme(): string { return this.value.theme; }

  setTheme(themeId: string): void {
    const theme = themeById(themeId);
    if (theme.id === this.value.theme) return;
    this.value = { ...this.value, theme: theme.id };
    this.applyTheme();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyTheme(): void {
    const root = document.documentElement;
    root.classList.remove(...THEMES.map((theme) => theme.className));
    root.classList.add(themeById(this.value.theme).className);
  }
}
