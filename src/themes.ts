export interface ThemeDefinition {
  id: string;
  name: string;
  family: string;
  className: string;
  dark: boolean;
}

export const THEMES: readonly ThemeDefinition[] = [
  { id: 'texel', name: 'Texel', family: 'Built in', className: 'theme-texel', dark: true },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', family: 'Catppuccin', className: 'theme-catppuccin-latte', dark: false },
  { id: 'catppuccin-frappe', name: 'Catppuccin Frappé', family: 'Catppuccin', className: 'theme-catppuccin-frappe', dark: true },
  { id: 'catppuccin-macchiato', name: 'Catppuccin Macchiato', family: 'Catppuccin', className: 'theme-catppuccin-macchiato', dark: true },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', family: 'Catppuccin', className: 'theme-catppuccin-mocha', dark: true },
];

export const DEFAULT_THEME = 'texel';

export function themeById(id: string): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
