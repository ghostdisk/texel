export interface ThemeDefinition {
  id: string;
  name: string;
  family: string;
  className: string;
  dark: boolean;
}

export const THEMES: readonly ThemeDefinition[] = [
  { id: 'texel', name: 'Texel', family: 'Built in', className: 'theme-texel', dark: true },
];

export const DEFAULT_THEME = 'texel';

export function themeById(id: string): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
