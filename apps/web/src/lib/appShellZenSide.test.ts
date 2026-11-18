// appShellZenSide.test.ts — AppShell zen 目录侧（spec A §4.2/§8）源码契约：
// ① 非 toggleZen 路径退出 zen 时的 zenSide 复位（评审 important ⑩）；
// ② zen 目录浮钮随侧栏收边移动（评审 important ⑪）。
//
// 根 vitest 无 svelte 插件，AppShell 不可挂载——按既有「源码契约断言」先例
// （appShellZenEsc.test.ts/appShellZenMobile.test.ts/appShellFontScroll.test.ts）
// 锁定接线；行为面由 e2e b-shell-toc（TOC-04/05）+ b-layout-zen 收口。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

const src = readSrc('src/lib/AppShell.svelte');
const css = src.slice(src.indexOf('<style>'));

describe('zen 退出的侧栏复位（评审 important ⑩：设置中心「重置专注模式」同样退出 zen）', () => {
  it('设置订阅内：zen 转关即复位 zenSide（不经 toggleZen 的退出分支亦不留残留）', () => {
    // 设置中心「重置专注模式」写 draft.layout.zen=false → 应用 → saveSettings →
    // onSettingsChanged 订阅 → settings 副本刷新。此路径不经 toggleZen，故须在订阅
    // 内复位 zenSide，否则非 zen 态仍带 data-zen-side（重进 zen 自发开栏；非 zen 态
    // 首个 Esc 被 closeZenSide 吞掉）。
    expect(src).toMatch(
      /settings = s;[\s\S]{0,600}?if \(!s\.layout\.zen && zenSide !== 'none'\) zenSide = 'none';/
    );
  });

  it('复位口径与 toggleZen 退出分支一致：只复位本态、不关抽屉（中性动作零回滚）', () => {
    // toggleZen 退出分支：zenSide = 'none'; clearTempTimers(); dismissZenToast();
    // 订阅内复位不得引入抽屉开合（关抽屉会违反「退出前开态还原」语义）
    const resetIdx = src.indexOf("if (!s.layout.zen && zenSide !== 'none') zenSide = 'none';");
    expect(resetIdx).toBeGreaterThan(0);
    const slice = src.slice(resetIdx, resetIdx + 200);
    expect(slice).not.toContain('drawers =');
    expect(slice).not.toContain('leftOpen');
    expect(slice).not.toContain('rightOpen');
  });

  it('toggleZen 退出分支的复位仍在（两条路径都复位，无遗漏面）', () => {
    expect(src).toMatch(/zenSide = 'none';\s*clearTempTimers\(\);\s*dismissZenToast\(\);/);
  });
});

describe('zen 目录浮钮随侧栏收边（评审 important ⑪：position:fixed 锚视口缘压住目录条目）', () => {
  it('浮钮仍是 fixed 定位（基态形态不变）', () => {
    expect(css).toMatch(/\.vv-zen-toc-btn \{[^}]*position: fixed;/);
    expect(css).toMatch(/\.vv-zen-toc-left \{[^}]*left: 12px;/);
    expect(css).toMatch(/\.vv-zen-toc-right \{[^}]*right: 12px;/);
  });

  it('桌面档（>900px，两栏在流内）：对应侧开启即外移该侧浮钮（外移量=栏宽）', () => {
    expect(css).toMatch(
      /@media \(min-width: 901px\)[\s\S]{0,400}?\.vv-zen-toc-left\[data-zen-open='1'\] \{\s*left: calc\(var\(--vv-side-w, 260px\) \+ 12px\);/
    );
    expect(css).toMatch(
      /@media \(min-width: 901px\)[\s\S]{0,600}?\.vv-zen-toc-right\[data-zen-open='1'\] \{\s*right: calc\(var\(--vv-right-w, 230px\) \+ 12px\);/
    );
  });

  it('抽屉档（≤900px 左栏 / ≤600px 右栏）：覆盖式抽屉 → 外移量=抽屉宽', () => {
    expect(css).toMatch(
      /@media \(max-width: 900px\)[\s\S]{0,300}?\.vv-zen-toc-left\[data-zen-open='1'\] \{\s*left: calc\(min\(80vw, 300px\) \+ 12px\);/
    );
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]{0,300}?\.vv-zen-toc-right\[data-zen-open='1'\] \{\s*right: calc\(min\(80vw, 300px\) \+ 12px\);/
    );
  });

  it('开关态经按钮自属性 data-zen-open 表达（**不用兄弟选择器 `~`**——Svelte 的 css_unused_selector 分析判其未用并从产物剪除，实测规则消失）', () => {
    expect(src).toMatch(/vv-zen-toc-left[^>]*data-zen-open=\{zenSide === 'left' \? '1' : undefined\}/);
    expect(src).toMatch(/vv-zen-toc-right[^>]*data-zen-open=\{zenSide === 'right' \? '1' : undefined\}/);
    expect(css).not.toMatch(/~\s*\.vv-zen-toc-(left|right)/);
  });

  it('栏宽变量内联在浮钮上（浮钮与 aside 是兄弟节点——aside 上的变量取不到）', () => {
    expect(src).toMatch(
      /class="vv-zen-toc-btn vv-zen-toc-left"[^>]*style="--vv-side-w: \{leftW\}px; --vv-right-w: \{rightW\}px"/s
    );
  });
});
