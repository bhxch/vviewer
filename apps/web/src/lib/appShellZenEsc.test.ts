// appShellZenEsc.test.ts — AppShell 桌面 Esc 优先级快照（spec 2026-10-19 §3）源码
// 契约。根 vitest 无 svelte 插件，AppShell 不可挂载——按既有「源码契约断言」先例
// （appShellZenMobile.test.ts/appShellFontScroll.test.ts）锁定接线；三态分派语义
// 本身是 layout.ts 纯函数（zenEscAction，layout.test.ts 直测），行为由 e2e
// b-layout-zen LZ-05 收口。
//
// 背景（Task 5 e2e 发现的缺陷回归锚）：面板容器的 Esc handler 关面板时 Svelte 5
// 把 DOM 更新同步落地，keydown 冒泡到 window 时面板已被移除——onKey 的实时
// DOM 查询恒 false，一次 Esc 会「关面板 + 退 zen」双动作，违反「面板优先只关
// 面板」。修复 = window capture 相监听在面板 handler 动手前快照面板存在性。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('Esc 优先级快照（spec §3：面板优先只关面板，Svelte 5 同步 flush 修正）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('capture 相快照监听在场：Escape 事件先于面板自带 handler 记录面板存在性', () => {
    expect(src).toContain("window.addEventListener('keydown', snapOverlay, true)");
    expect(src).toMatch(/snapOverlay[\s\S]{0,200}escOverlayAtStart = anyOverlayOpen\(\)/);
  });

  it('onKey 的 zenEscAction 消费快照而非实时 DOM 查询（同步 flush 下后者恒 false）', () => {
    expect(src).toContain(
      'const action = zenEscAction({ overlaysOpen: escOverlayAtStart, zen: layout.zen })'
    );
    // onKey 冒泡相内不再实时查面板（chromeMenu 直读状态除外——其无自有 Esc handler）
    expect(src).toMatch(/if \(e\.key === 'Escape'\)[\s\S]{0,400}?escOverlayAtStart/);
  });

  it('快照监听随 effect 卸载清理（capture 标记与注册对称）', () => {
    expect(src).toContain("window.removeEventListener('keydown', snapOverlay, true)");
  });
});

describe('终审修复锚（2026-10-19 波）：合成 Esc 通道对全部 overlay 成立', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('I-3：OVERLAY_SELECTOR 含 .vv-status-picker（zen 下状态栏候选浮层算 overlay——桌面 Esc 只关浮层不退 zen，移动端返回键可关不残留）', () => {
    const sel = src.match(/const OVERLAY_SELECTOR = \[([\s\S]*?)\]\.join/);
    expect(sel).not.toBeNull();
    expect(sel![1]).toContain('.vv-status-picker');
  });

  it('I-2：.vv-ws-pop 容器 onkeydown Esc——合成 Esc 的派发目标恰是 pop 本体，window 兜底的 contains 守卫会挡下，容器通道是唯一到达路径', () => {
    const topbar = readSrc('src/lib/TopBar.svelte');
    expect(topbar).toMatch(
      /class="vv-ws-pop"[\s\S]{0,200}onkeydown=\{\(e\) => \{\s*if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*wsMenuOpen = false;\s*\}\s*\}\}/
    );
    // window 兜底保留（target 在浮层外的物理 Esc 走兜底），与容器通道按 target 互补不双触发
    expect(topbar).toContain('!wsPopEl.contains(e.target)');
  });
});
