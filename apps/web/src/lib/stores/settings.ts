export interface Settings {
  themeMode: 'light' | 'dark' | 'system';
  excludedPatterns: string[];
  autoRefresh: boolean;
}

const KEY = 'vviewer:settings';
const DEFAULTS: Settings = { themeMode: 'system', excludedPatterns: [], autoRefresh: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
