import type { ComputePolicy } from '@vviewer/core';

export interface Settings {
  themeMode: 'light' | 'dark' | 'system';
  /** 亮/暗模式下各自记忆的代码主题（键名需存在于 @vviewer/highlight 的 themes.json） */
  codeThemeLight: string;
  codeThemeDark: string;
  excludedPatterns: string[];
  autoRefresh: boolean;
  /** 计算策略（M6）：auto=远程文件优先远程计算（失败回退本地）；local/remote=显式指定 */
  computePolicy: ComputePolicy;
}

const KEY = 'vviewer:settings';
const DEFAULTS: Settings = {
  themeMode: 'system',
  codeThemeLight: 'onelight',
  codeThemeDark: 'serika-dark',
  excludedPatterns: [],
  autoRefresh: true,
  computePolicy: 'auto'
};

const POLICIES: readonly ComputePolicy[] = ['auto', 'local', 'remote'];

function defaults(): Settings {
  return { ...DEFAULTS, excludedPatterns: [...DEFAULTS.excludedPatterns] };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const s = { ...defaults(), ...(JSON.parse(raw) as Partial<Settings>) };
    // computePolicy 白名单校验：旧版本/手改 localStorage 的非法值回落默认
    if (!POLICIES.includes(s.computePolicy)) s.computePolicy = DEFAULTS.computePolicy;
    return s;
  } catch {
    return defaults();
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
