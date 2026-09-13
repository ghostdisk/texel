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
  { id: 'dracula', name: 'Dracula', family: 'Dracula', className: 'theme-dracula', dark: true },
  { id: 'nord', name: 'Nord', family: 'Nord', className: 'theme-nord', dark: true },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', family: 'Gruvbox', className: 'theme-gruvbox-dark', dark: true },
  { id: 'tokyo-night', name: 'Tokyo Night', family: 'Tokyo Night', className: 'theme-tokyo-night', dark: true },
  { id: 'rose-pine', name: 'Rosé Pine', family: 'Rosé Pine', className: 'theme-rose-pine', dark: true },
  { id: 'solarized-dark', name: 'Solarized Dark', family: 'Solarized', className: 'theme-solarized-dark', dark: true },
  { id: 'solarized-light', name: 'Solarized Light', family: 'Solarized', className: 'theme-solarized-light', dark: false },
  { id: 'one-dark', name: 'One Dark', family: 'Atom', className: 'theme-one-dark', dark: true },
  { id: 'github-dark', name: 'GitHub Dark', family: 'GitHub', className: 'theme-github-dark', dark: true },
  { id: 'github-light', name: 'GitHub Light', family: 'GitHub', className: 'theme-github-light', dark: false },
];

export const DEFAULT_THEME = 'texel';

export function themeById(id: string): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
