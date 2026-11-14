// appShellZenMobile.test.ts — AppShell zen 移动端适配（spec 2026-10-19 §3.1）源码
// 契约。根 vitest 无 svelte 插件，AppShell 不可挂载——按既有「源码契约断言」先例
// （appShellFontScroll.test.ts/exportPanel.test.ts）锁定接线；popstate 分派语义本身
// 是 layout.ts 纯函数（zenPopAction，layout.test.ts 直测），e2e 由 Task 5 收口。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// i18n 目录（Task 4 域 A 抽取）：抽屉头部文案迁入目录，锚改指 t() key + zh 值逐字节等价
import { messages as zhShell } from './i18n/catalogs/zh-CN/shell';

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
    expect(src).toMatch(/vv-drawer-head[\s\S]{0,300}t\('shell\.drawer\.zen'\)/);
    expect(zhShell['shell.drawer.zen']).toBe('专注模式');
    expect(src).toMatch(/vv-drawer-zen"[\s\S]{0,120}onclick=\{\(\) => toggleZen\(\)\}/);
    expect(src).not.toMatch(/vv-drawer-zen"[\s\S]{0,200}drawerOpen/); // 退出还原进入前开合（spec）
  });
});

describe('zen 目录入口（spec A §4.2/§8 Task 4）：data-zen-side 放行 + closeZenSide 新档 + 退出中性', () => {
  const src = readSrc('src/lib/AppShell.svelte');
  const css = readSrc('src/app.css');

  it('data-zen-side 属性绑定 .vv-shell：关闭态 undefined 不出属性（app.css 放行规则不命中）', () => {
    expect(src).toMatch(
      /class:zen=\{layout\.zen\} data-zen-side=\{zenSide !== 'none' \? zenSide : undefined\}/
    );
  });

  it('onPopstate closeZenSide 分支：关侧后 zenGuard.arm() 重压（镜像 closeOverlay「zen 在场即守卫在顶」不变式，否则下次返回键直接离页）', () => {
    expect(src).toMatch(
      /action === 'closeZenSide'[\s\S]{0,300}closeZenSide\(\);[\s\S]{0,80}zenGuard\.arm\(\)/
    );
  });

  it('toggleZen 退出只重置 zenSide 不关抽屉（中性动作零回滚 drawers 开合位——mLZ-04「进入前开态还原」与浮钮开的抽屉退出后保持两面同时成立，混合场景 F4 落定）', () => {
    const body = src.match(/function toggleZen\(viaPopstate = false\): void \{[\s\S]*?\n[ ]{2}\}/)?.[0] ?? '';
    expect(body).toContain("zenSide = 'none'");
    expect(body).not.toMatch(/drawers\s*=/); // 退出分支体无任何抽屉开合写入
  });

  it('浮钮显隐门=目录数据非空（spec §8 落定 2）+ 断点分流接线（≤900 左抽屉 / ≤600 右抽屉，置位非切换）', () => {
    expect(src).toMatch(
      /\{#if layout\.zen && \(tocEntries\.length > 0 \|\| outlineDefinitions\.length > 0\)\}[\s\S]{0,900}vv-zen-toc-btn/
    );
    expect(src).toMatch(/side === 'left' && isDrawerBreakpoint\(\)[\s\S]{0,120}leftOpen: true/);
    expect(src).toMatch(/side === 'right' && window\.matchMedia\('\(max-width: 600px\)'\)[\s\S]{0,120}rightOpen: true/);
  });

  it('zen 条件放行规则（app.css）：0,4,0 只放行 aside 本体，栏内切换器隐藏，折叠钮不在放行面（spec §8 落定 3——避免持久化写入）', () => {
    expect(css).toContain(".vv-shell.zen[data-zen-side='left'] .vv-side { display: flex; }");
    expect(css).toContain(".vv-shell.zen[data-zen-side='right'] .vv-right { display: flex; }");
    expect(css).toContain(".vv-shell.zen[data-zen-side='left'] .vv-left-switch { display: none; }");
    expect(css).toContain(".vv-shell.zen[data-zen-side='right'] .vv-right-switch { display: none; }");
  });

  it('i18n：zen 浮钮 aria 双键 zh 值（en 键集==zh 键集由聚合机检锁）', () => {
    expect(zhShell['shell.zen.tocLeftAria']).toBe('打开左栏目录');
    expect(zhShell['shell.zen.tocRightAria']).toBe('打开右栏目录');
  });
});
