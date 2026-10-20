// nav.ts — 设置中心分组导航的 context 通道（settings center spec §2.1/§2.2：
// 「关于」与「存储与数据」两节互链跳转）。SettingsCenter setContext 提供
// (id) => activeId = id；各节组件初始化期调用 useSettingsNav() 取用。
import { getContext } from 'svelte';

export type SettingsNav = (groupId: string) => void;

export const SETTINGS_NAV_KEY = 'vv-settings-nav';

/** 取分组导航函数（仅设置中心节组件初始化期调用） */
export function useSettingsNav(): SettingsNav {
  return getContext<SettingsNav>(SETTINGS_NAV_KEY);
}
