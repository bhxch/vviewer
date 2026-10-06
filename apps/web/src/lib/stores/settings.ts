export interface Settings {
  themeMode: 'light' | 'dark' | 'system';
  excludedPatterns: string[];
  autoRefresh: boolean;
}

const KEY = 'vviewer:settings';
const DEFAULTS: Settings = { themeMode: 'system', excludedPatterns: [], autoRefresh: true };

function defaults(): Settings {
  return { ...DEFAULTS, excludedPatterns: [...DEFAULTS.excludedPatterns] };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaults(), ...(JSON.parse(raw) as Partial<Settings>) } : defaults();
  } catch {
    return defaults();
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
