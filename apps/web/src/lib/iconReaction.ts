// iconReaction.ts — 图标主题设置变更反应（图标主题 spec §3.5，Task 3）。
// sig 公式（theme + scopes 四键序列化）落本纯 .ts 单源：iconTheme.svelte.ts 的
// applyIconsFromSettings 反向引用之做内部 diff——runes 状态家在 .svelte.ts（$state
// 编译约定）、纯逻辑家在本模块（root vitest 无 svelte 插件，本文件可直测而
// .svelte.ts 不可，metaStore.test.ts 先例）；静态依赖保持单向（.svelte.ts → 本
// 模块），本模块对 .svelte.ts 用动态 import 断环。reactToIconsChange 于 AppShell
// onSettingsChanged 订阅链消费（fontsReaction 同款形态）：changed → onIconsChanged
// 恰一次（调用方注入 tabStore.touchActiveTab 做 rev++ 联动）。
import type { Settings } from './stores/settings';

/**
 * icons 设置签名（diff 用）：theme + scopes 四键，无关字段零参与——fontsSig
 * 四元组同款口径（spec §3.5：iconSig = theme id + scopes 序列化）。任何真实
 * settings 的签名恒非空串（含分隔符），故 iconThemeState.sig 初值 '' 保证首调必命中。
 */
export function iconSig(s: Settings): string {
  const i = s.iconThemes;
  return `${i.theme}|${i.scopes.tree ? 1 : 0}|${i.scopes.tabs ? 1 : 0}|${i.scopes.quickOpen ? 1 : 0}|${i.scopes.search ? 1 : 0}`;
}

/**
 * icons 设置变更反应：签名相对 iconThemeState.sig 变化时应用（字体注册/注销 +
 * runtime 换装）并调用 onIconsChanged 恰一次；无关字段变化零应用零触发。返回
 * 是否为 icons 变更。与 fonts 的同步形态差异：字体解析走 IndexedDB/fetch（async），
 * 应用失败 warn 后按未变更返回（签名未落位，后续任一 icons 变更自然重试）；
 * fire-and-forget 形态由 AppShell 侧 void 承接。
 */
export async function reactToIconsChange(s: Settings, onIconsChanged: () => void): Promise<boolean> {
  const mod = await import('./iconTheme.svelte');
  if (iconSig(s) === mod.iconThemeState.sig) return false;
  try {
    await mod.applyIconsFromSettings(s);
  } catch (err) {
    console.warn('[icons] failed to apply icon theme', err);
    return false;
  }
  onIconsChanged();
  return true;
}
