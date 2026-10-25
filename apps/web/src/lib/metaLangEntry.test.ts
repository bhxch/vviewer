// metaLangEntry.test.ts — renderer-lang-override Task 6：状态栏浮层 + Tab 右键
// 「语言」轻入口（spec §4.2）。轻入口 = 只读文案 + 单一跳转通道（requestMetaLangFocus
// → document CustomEvent → AppShell 监听展开/开抽屉并聚焦语言行）。
//
// 测试形态（前批同款约束）：
// - metaLangFocus.ts 为纯 TS 模块：派发行为 jsdom 直测（真行为面）；
// - ViewerPane/TabBar/AppShell 为 runes 组件（openFlow.svelte 同因）：根 vitest
//   无 svelte 插件不可挂载，按「源码契约断言」先例（watchHealth.test.ts /
//   metaPanelLang.test.ts 同形态）钉住结构面；运行期交互由 e2e 收口。
//
// 单机制不变量（spec §4.2 三入口单机制）：
// - 跳转通道唯一：'vv:focus-meta-lang' 字符串唯一在 metaLangFocus.ts，入口组件
//   只 import 函数（契约锚逐文件断言无字面量复制）；
// - 候选计算仍唯一在 openWithOf 链（rendererCandidatesOfTab）：语言项非候选菜单，
//   入口侧无语言候选计算写点（MetaPanel 候选/渲染器候选不受影响）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VV_FOCUS_META_LANG, requestMetaLangFocus } from './metaLangFocus';

// vitest 会转译 import.meta.url（watchHealth.test.ts 同款双 cwd 兼容根/apps/web）
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

/** 函数体窗口：自签名行至首个列 2 闭合 `}`（内层块均有缩进，watchHealth.test.ts 同款）。 */
function fnWindow(src: string, signature: RegExp): string {
  const fn = src.match(signature);
  expect(fn, `函数窗口未命中：${signature}`).not.toBeNull();
  return fn![0];
}

describe('metaLangFocus 通道（行为直测，jsdom）', () => {
  it('requestMetaLangFocus 派发 VV_FOCUS_META_LANG CustomEvent（监听器收到）', () => {
    let got: Event | null = null;
    const onEvt = (e: Event): void => {
      got = e;
    };
    document.addEventListener(VV_FOCUS_META_LANG, onEvt);
    try {
      requestMetaLangFocus();
    } finally {
      document.removeEventListener(VV_FOCUS_META_LANG, onEvt);
    }
    expect(got).not.toBeNull();
    expect((got as Event | null)!.type).toBe('vv:focus-meta-lang');
  });
});

describe('ViewerPane 状态栏浮层语言项（Task 6 源码契约锚）', () => {
  const src = readSrc('src/lib/ViewerPane.svelte');

  it('浮层尾部固定项：.vv-status-picker-lang + role=menuitem + 文案「语言：{langOverrideText}」', () => {
    const picker = fnWindow(src, /<div class="vv-status-picker"[\s\S]*?<\/div>/);
    expect(picker).toContain('class="vv-status-picker-lang"');
    expect(picker).toContain('role="menuitem"');
    expect(picker).toContain('语言：{langOverrideText}');
    // 固定项在候选 {#each} 之后（菜单尾部，非候选菜单成员）
    expect(picker.indexOf('{/each}')).toBeLessThan(picker.indexOf('vv-status-picker-lang'));
  });

  it('langOverrideText 派生：overrideLang → 「（手动）」，否则 fileMeta.lang 回显、缺省「自动」', () => {
    const derived = fnWindow(
      src,
      /const langOverrideText = \$derived\.by\(\(\) => \{[\s\S]*?\n  \}\);/
    );
    expect(derived).toContain('if (t?.overrideLang) return `${t.overrideLang}（手动）`;');
    expect(derived).toContain("return fileMeta.lang ? `自动（检测 ${fileMeta.lang}）` : '自动';");
  });

  it('focusMetaLang 只派发单通道（关浮层 + requestMetaLangFocus），无通道字面量/候选计算复制', () => {
    const fn = fnWindow(src, /function focusMetaLang\(\): void \{[\s\S]*?\n  \}/);
    expect(fn).toContain('pickerOpen = false;');
    expect(fn).toContain('requestMetaLangFocus();');
    expect(fn).not.toMatch(/setHighlightLang|setRendererOverride|Candidates|CustomEvent/);
    // 通道细节不复制：入口组件无事件名字面量（唯一在 metaLangFocus.ts）
    expect(src).not.toContain('vv:focus-meta-lang');
  });
});

describe('TabBar 右键语言项（Task 6 源码契约锚）', () => {
  const src = readSrc('src/lib/TabBar.svelte');

  it('ctxActions 末项：label「语言：…（在属性面板中修改）」+ onClick 先激活被右键 tab 再走单通道（终审 I-1）', () => {
    const entry = fnWindow(
      src,
      /\{\n        \/\/ 语言轻入口（Task 6）[\s\S]*?\n      \}/
    );
    expect(entry).toContain('语言：${langLabelOf(tab)}（在属性面板中修改）');
    // 文案读被右键 tab（langLabelOf(tab)），落点须同 tab：先 activateTab 再聚焦——
    // 只派发聚焦会落到原激活 tab 的语言行（右键非激活 tab 时跨 tab 错位）
    expect(entry).toContain('activateTab(tab.id);');
    expect(entry.indexOf('requestMetaLangFocus();')).toBeGreaterThan(
      entry.indexOf('activateTab(tab.id);')
    );
  });

  it('langLabelOf：被右键 tab 的 overrideLang → 「（手动）」，否则「自动」（无检测值回显面）', () => {
    const fn = fnWindow(src, /function langLabelOf\(tab: Tab\): string \{[\s\S]*?\n  \}/);
    expect(fn).toContain("return tab.overrideLang !== undefined ? `${tab.overrideLang}（手动）` : '自动';");
    expect(fn).not.toContain('fileMeta'); // 非激活 tab 无 meta 对应面，不读激活态检测值
  });

  it('通道细节不复制：本组件无事件名字面量', () => {
    expect(src).not.toContain('vv:focus-meta-lang');
  });
});

describe('AppShell 跳转消费（Task 6 源码契约锚）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('监听 VV_FOCUS_META_LANG（addEventListener/removeEventListener 成对，effect 清理）', () => {
    expect(src).toContain('document.addEventListener(VV_FOCUS_META_LANG, onFocusMetaLang);');
    expect(src).toContain('document.removeEventListener(VV_FOCUS_META_LANG, onFocusMetaLang);');
    // 通道名经 import（无字面量复制）
    expect(src).toContain("import { VV_FOCUS_META_LANG } from './metaLangFocus';");
    expect(src).not.toContain("'vv:focus-meta-lang'");
  });

  it('移动端先开抽屉（≤600px 同一媒体查询）→ 桌面折叠先展开 → rAF 后聚焦语言行', () => {
    const handler = fnWindow(src, /const onFocusMetaLang = \(\): void => \{[\s\S]*?\n    \};/);
    // FE-2：抽屉开合转移抽在 shellDrawers.ts（openRightDrawerForMetaLang 置位开右抽屉）
    const drawer = handler.indexOf('openRightDrawerForMetaLang(drawers)');
    const expand = handler.indexOf("updateLayout({ rightCollapsed: false })");
    const focus = handler.indexOf('querySelector<HTMLInputElement>(\'input[list="vv-lang-datalist"]\')');
    expect(drawer).toBeGreaterThan(-1); // 移动端：先开右栏抽屉（≤600px 断点条件）
    expect(handler).toContain("window.matchMedia('(max-width: 600px)')");
    expect(expand).toBeGreaterThan(-1); // 桌面：折叠先展开（updateLayout 持久链）
    expect(focus).toBeGreaterThan(-1); // 聚焦 MetaPanel 语言行（Task 5 契约选择器）
    expect(drawer).toBeLessThan(focus); // 先开抽屉再聚焦
    expect(expand).toBeLessThan(focus); // 先展开再聚焦
    expect(handler).toContain('requestAnimationFrame'); // 展开为响应式更新，焦点等一帧
  });
});
