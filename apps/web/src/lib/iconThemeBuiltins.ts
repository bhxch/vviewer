/**
 * iconThemeBuiltins.ts — 内置图标主题 loader 注册（图标主题 spec §2.3「预置 Seti
 * 不走导入：构建期静态 import，以内置实体形态参与选择器」的落地，Task 4）。
 *
 * 'seti' vendor 资产动态 import（theme.ts BUILTIN_APPEARANCES 先例）：manifest
 * JSON 独立 chunk 不进主包；woff 经 Vite `?url` 变换落哈希资产，运行时 fetch →
 * ArrayBuffer（BuiltinIconThemeLoader 契约的 fonts 字节形态，iconTheme.svelte.ts
 * 换装消费）。清单在 loader 内过 normalizeIconTheme 归一——vendor JSON 是原始
 * 数据面，查表五 Map 由归一化产出（IndexedDB 导入通道同先例）。
 *
 * 注册形态：模块顶层调 setBuiltinIconThemeLoader 单点注入，AppShell 静态 import
 * 本模块（副作用 import）——模块求值先于 onMount 首调 applyIconsFromSettings，
 * 时序成立。未知主题键返回 null（回退无图标，白名单已挡脏值，防御性兜底）。
 */
import { normalizeIconTheme } from '@bhxch/vviewer-highlight';
import { setBuiltinIconThemeLoader, type BuiltinIconThemeLoader } from './iconTheme.svelte';

const BUILTIN_ICON_THEMES: Record<string, BuiltinIconThemeLoader> = {
  seti: async () => {
    const [manifestMod, fontUrlMod] = await Promise.all([
      import('@bhxch/vviewer-highlight/assets/vscode-icons/seti/seti-icon-theme.json'),
      import('@bhxch/vviewer-highlight/assets/vscode-icons/seti/seti.woff?url')
    ]);
    const data = await (await fetch(fontUrlMod.default)).arrayBuffer();
    return {
      manifest: normalizeIconTheme(manifestMod.default),
      fonts: [{ data }]
    };
  }
};

setBuiltinIconThemeLoader((theme) => {
  const loader = BUILTIN_ICON_THEMES[theme];
  return loader !== undefined ? loader(theme) : Promise.resolve(null);
});
