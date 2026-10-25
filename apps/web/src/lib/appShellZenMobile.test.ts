// appShellZenMobile.test.ts — AppShell zen 移动端适配（spec 2026-10-19 §3.1）源码
// 契约。根 vitest 无 svelte 插件，AppShell 不可挂载——按既有「源码契约断言」先例
// （appShellFontScroll.test.ts/exportPanel.test.ts）锁定接线；popstate 分派语义本身
// 是 layout.ts 纯函数（zenPopAction，layout.test.ts 直测），e2e 由 Task 5 收口。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('zen 返回键拦截（spec §3.1：进入 pushState 守卫，popstate 同一状态机分派）', () => {
  const src = readSrc('src/lib/AppShell.svelte');
  // FE-2 拆分锚随迁：守卫历史项状态机（pushState 守卫/back 消费/reload 认领）抽在
  // zenGuard.ts 纯模块（状态转移由 zenGuard.test.ts 直测锁定），AppShell 保留
  // popstate 事件接线——锚定对象迁至新位置的，readSrc 改指新位置、断言逐字保留
  const guard = readSrc('src/lib/zenGuard.ts');

  it('进入 zen 压入 {vvZen:1} 守卫，且以抽屉断点（≤900px）为门——桌面 history 不动', () => {
    expect(src).toContain('zenPopAction'); // popstate 与桌面 Esc（zenEscAction）同源分派
    expect(guard).toContain("history.pushState({ vvZen: 1 }, '')");
    expect(src).toContain("'(max-width: 900px)'"); // 守卫门 = 既有抽屉断点
    // 非 popstate 通道退出（浮钮/菜单/Esc/快捷键）：回退消费守卫项，返回键语义回归原生
    expect(guard).toContain('history.back()');
  });

  it('popstate 监听在场：exitZen 分支标记经 popstate（不再 history.back）、closeOverlay 分支关面板后重压守卫', () => {
    expect(src).toContain("window.addEventListener('popstate', onPopstate)");
    expect(src).toContain("window.removeEventListener('popstate', onPopstate)");
    expect(src).toMatch(/action === 'exitZen'[\s\S]{0,200}toggleZen\(true\)/);
    // FE-2：armZenGuard 归 zenGuard 状态机（zenGuard.arm），关面板后重压语义不变
    expect(src).toMatch(/closeTopOverlayForZen\(\);\s*zenGuard\.arm\(\)/);
  });

  it('reload 落 zen：认领跨 reload 存活的守卫项（history.state.vvZen），无困死路径', () => {
    expect(guard).toMatch(/history\.state[\s\S]{0,80}vvZen/);
  });
});

describe('zen 退出浮钮（spec §3.1：≥44px 触控、半透、桌面无此钮）', () => {
  const src = readSrc('src/lib/AppShell.svelte');
  const css = src.slice(src.indexOf('<style>'));

  it('浮钮渲染接线：zen 在场渲染、点击 toggleZen 退出', () => {
    expect(src).toMatch(/class="vv-zen-exit"[\s\S]{0,200}onclick=\{\(\) => toggleZen\(\)\}/);
    expect(src).toMatch(/\{#if layout\.zen\}[\s\S]{0,400}vv-zen-exit/);
  });

  it('基线 display:none——桌面无此钮（断点内媒体查询才渲染视觉）', () => {
    expect(css).toMatch(/\.vv-zen-exit,\s*\.vv-drawer-head \{\s*display: none;/);
  });

  it('≤900px 块内：44px 触控 + 半透（0.55）+ 状态栏上方避让（bottom ≥ 28px）', () => {
    // zen 移动端媒体查询块是组件样式的最后一个断点块
    const block = css.slice(css.lastIndexOf('@media (max-width: 900px)'));
    const rule = block.match(/\.vv-zen-exit \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1] ?? '';
    expect(body).toContain('width: 44px');
    expect(body).toContain('height: 44px');
    expect(body).toContain('opacity: 0.55');
    const bottom = /bottom: (\d+)px/.exec(body);
    expect(bottom).not.toBeNull();
    expect(Number(bottom![1])).toBeGreaterThanOrEqual(28); // 状态栏（~22px 高，zen 保留）上方
  });
});

describe('移动端 zen 入口（spec §3.1：布局菜单项 + ☰ 抽屉头部回落挂点）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('抽屉头部「专注模式」项接同一 toggleZen（与桌面 chrome 菜单同源），不动抽屉开合态', () => {
    expect(src).toMatch(/vv-drawer-head[\s\S]{0,300}专注模式/);
    expect(src).toMatch(/vv-drawer-zen"[\s\S]{0,120}onclick=\{\(\) => toggleZen\(\)\}/);
    expect(src).not.toMatch(/vv-drawer-zen"[\s\S]{0,200}drawerOpen/); // 退出还原进入前开合（spec）
  });
});
