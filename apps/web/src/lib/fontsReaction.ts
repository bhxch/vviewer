// fontsReaction.ts — fonts 设置变更反应（字体系统 spec 2026-10-19 §2.3，Task 2）。
// TopBar 的 onSettingsChanged 订阅处消费（applyAppearanceFromSettings 同调用层）：
// fonts 签名 diff 命中 → applyFontsFromSettings 注入 style#vv-font + 触发激活 tab
// 重渲染回调。rev++ 动作（tabStore.touchActiveTab）以回调注入——openFlow.svelte 为
// runes 模块 vitest 无插件不可编译（highlightRouter 测试同款约束），本模块保持
// 纯逻辑可单测（fontsReaction.test 断言「fonts 变更 → 重渲染触发」契约）。
import type { Settings } from './stores/settings';
import { applyFontsFromSettings } from './theme';

/**
 * fonts 设置变更反应：签名变化时注入 style#vv-font 并调用 onFontsChanged 恰一次
 * （调用方注入激活 tab rev++）；无关字段变化零注入零触发。返回是否为 fonts 变更。
 */
export function reactToFontsChange(s: Settings, onFontsChanged: () => void): boolean {
  const changed = applyFontsFromSettings(s);
  if (changed) onFontsChanged();
  return changed;
}
