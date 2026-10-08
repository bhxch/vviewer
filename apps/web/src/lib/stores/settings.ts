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
  notify(s);
}

// ---------- 变更订阅（BUG-05 前置基建） ----------
// 普通 .ts 不能用 runes（计划已核实文件后缀），以回调集合实现发布订阅：
// saveSettings 落盘后同步通知；AppShell 等订阅方据此刷新响应式副本。

type SettingsListener = (s: Settings) => void;

const listeners = new Set<SettingsListener>();

/**
 * 订阅设置变更（saveSettings 触发）；返回退订函数。
 * 回调收到的是深一层的副本（excludedPatterns 数组拷贝），订阅方改动不回灌。
 */
export function onSettingsChanged(cb: SettingsListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(s: Settings): void {
  for (const cb of listeners) cb({ ...s, excludedPatterns: [...s.excludedPatterns] });
}
