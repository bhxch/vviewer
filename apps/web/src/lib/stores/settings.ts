export interface Settings {
  themeMode: 'light' | 'dark' | 'system';
  /** 亮/暗模式下各自记忆的代码主题（键名需存在于 @vviewer/highlight 的 themes.json） */
  codeThemeLight: string;
  codeThemeDark: string;
  excludedPatterns: string[];
  autoRefresh: boolean;
}

const KEY = 'vviewer:settings';
const DEFAULTS: Settings = {
  themeMode: 'system',
  codeThemeLight: 'onelight',
  codeThemeDark: 'serika-dark',
  excludedPatterns: [],
  autoRefresh: true
};

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
