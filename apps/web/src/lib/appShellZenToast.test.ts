// appShellZenToast.test.ts — zen 专注模式可见入口与进入提示（Toast）源码契约。
// 背景（2026-10-23 用户反馈）：桌面进 zen 只有快捷键 Ctrl+Alt+Z 与右键菜单，退出
// 通道（Esc）不可发现——补 TopBar 可见按钮（tooltip 写明进出双方式）+ 进入时
// Toast 告知退出通道。根 vitest 无 svelte 插件，AppShell/TopBar 不可挂载——按既有
// 「源码契约断言」先例（appShellZenMobile.test.ts/appShellZenEsc.test.ts）锁定接线；
// 进出场行为由 e2e b-layout-zen 收口。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('zen 进入提示 Toast（退出通道发现性）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('toggleZen 进入分支弹 toast，文案按断点分支（桌面快捷键 / 移动端浮钮+返回键）', () => {
    expect(src).toMatch(
      /if \(zen\) \{\s*showZenToast\(\s*isDrawerBreakpoint\(\)/
    );
    expect(src).toContain('已进入专注模式：按 Esc 或 Ctrl+Alt+Z 退出');
    expect(src).toContain('已进入专注模式：点右下角 ✕ 或按返回键退出');
  });

  it('退出 zen 立即收回 toast（dismissZenToast）——提示语义只属于 zen 在场期间，不残留盖在恢复的 chrome 上', () => {
    expect(src).toMatch(/else \{\s*clearTempTimers\(\);\s*dismissZenToast\(\);\s*\}/);
  });

  it('reload 落 zen 同样提示（恢复态用户与首次进入同样需要发现性）', () => {
    // onMount 的 layout.zen 分支（zenGuard 认领/补压之后——FE-2：armZenGuard 归
    // zenGuard 状态机）同样走 showZenToast
    expect(src).toMatch(/zenGuard\.arm\(\);[\s\S]{0,200}showZenToast\(/);
  });

  it('toast 渲染块：role=status（AT 播报）、4.5s 自动消退、定时器随卸载清理', () => {
    expect(src).toMatch(/\{#if zenToast\}[\s\S]{0,300}class="vv-toast" role="status"/);
    expect(src).toMatch(/showZenToast[\s\S]{0,300}setTimeout/);
    expect(src).toContain('if (zenToastTimer !== null) clearTimeout(zenToastTimer)');
  });

  it('样式：顶部居中避开热区/临时条，pointer-events none 不拦截其下交互', () => {
    const css = src.slice(src.indexOf('<style>'));
    const rule = css.match(/\.vv-toast \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1] ?? '';
    expect(body).toContain('position: fixed');
    expect(body).toContain('top: 40px'); // 热区 0-10px / 临时条 fixed top:0 之下
    expect(body).toContain('pointer-events: none');
  });
});

describe('TopBar 专注模式可见入口（进出双提示）', () => {
  const src = readSrc('src/lib/TopBar.svelte');
  const shell = readSrc('src/lib/AppShell.svelte');

  it('props 接线：zen 态与切换回调归 AppShell（toggleZen 所在地），本组件只发回调', () => {
    expect(src).toMatch(/zen = false,\s*onToggleZen/);
    expect(shell).toContain('zen={layout.zen}');
    expect(shell).toContain('onToggleZen={() => toggleZen()}');
  });

  it('按钮 title 同时写明进入与退出方式（快捷键 + zen 内退出通道），文案随 zen 态切换', () => {
    expect(src).toContain('专注模式（Ctrl+Alt+Z）：隐藏顶栏/标签栏与两侧面板，进入后按 Esc 或 Ctrl+Alt+Z 退出');
    expect(src).toContain('退出专注模式（Esc 或 Ctrl+Alt+Z）');
    expect(src).toMatch(/\{zen \? '退出专注' : '专注'\}/);
  });
});
