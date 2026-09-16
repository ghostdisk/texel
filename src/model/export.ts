export type ExportMode = 'single' | 'frames';
export type ExportFormat = 'png' | 'webp' | 'jpeg';

export interface ExportLocation {
  key: string;
  name: string;
}

export interface ExportSettings {
  mode: ExportMode;
  format: ExportFormat;
  scale: number;
  location: ExportLocation | null;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { mode: 'single', format: 'png', scale: 1, location: null };
