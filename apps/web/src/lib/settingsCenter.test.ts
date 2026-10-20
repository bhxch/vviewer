// settingsCenter.test.ts — 统一设置中心骨架与既有节迁移（settings center spec §2）。
// 根 vitest 无 svelte 插件，SettingsCenter/各节组件不可挂载——按既有「源码契约断言」
// 先例（fonts.test.ts / appShellZenEsc.test.ts 同形态）锁定分组注册表形状、组序、
// 五节组件 props 契约与 AppShell/TopBar 接线；运行时行为由 Task 5 e2e
// b-settings-center.spec 收口。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('SettingsCenter 分组注册表（spec §2 定稿序的在 Task 1 在场组）', () => {
  const src = readSrc('src/lib/SettingsCenter.svelte');

  it('注册表数组驱动：{ id, label, content } 形态，content 为 svelte Component（新分组零骨架改动）', () => {
    expect(src).toMatch(/interface SettingsGroup|type SettingsGroup/);
    expect(src).toContain("import type { Component } from 'svelte'");
    expect(src).toMatch(/content: Component<\{ draft: Settings; touch\(\): void \}>/);
    // 注册表本体是 const 数组（非 if/else 散落分支）
    expect(src).toMatch(/const groups: SettingsGroup\[\] = \[/);
  });

  it('组序（spec §2 定稿序，Task 1 在场组）：外观→字体→图表→搜索与排除→自动刷新→计算', () => {
    const ids = ['appearance', 'fonts', 'diagrams', 'search', 'autorefresh', 'compute'];
    const pos = ids.map((id) => src.indexOf(`id: '${id}'`));
    for (const p of pos) expect(p).toBeGreaterThan(-1);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    const labels = ['外观', '字体', '图表', '搜索与排除', '自动刷新', '计算'];
    const lpos = labels.map((l) => src.indexOf(`label: '${l}'`));
    for (const p of lpos) expect(p).toBeGreaterThan(-1);
    expect([...lpos].sort((a, b) => a - b)).toEqual(lpos);
  });

  it('左导航与右内容均由注册表 each 驱动（含键盘 ↑↓ 切组，spec §2 分组导航键盘可达）', () => {
    expect(src).toMatch(/\{#each groups as g \(g\.id\)\}/);
    expect(src).toMatch(/ArrowDown|ArrowUp/);
  });

  it('全屏 overlay 骨架：dialog 角色 + 容器/窗兜底双 Esc 通道 + 关闭焦点还原', () => {
    expect(src).toContain('class="vv-settings-center"');
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-label="设置"/);
    // 容器 keydown（合成 Esc 派发目标即根元素）+ window 兜底（target 在面板外），
    // 与 SettingsPanel/GlobalSearchPanel 同仓库 dialog 模式
    expect(src).toMatch(/function onRootKeydown[\s\S]*?e\.key === 'Escape'/);
    expect(src).toMatch(/!rootEl\.contains\(e\.target\)/);
    expect(src).toMatch(/document\.activeElement/); // 关闭前记录焦点，卸载后还原
  });
});

describe('五节组件契约（既有 SettingsPanel 五节片段组件化，统一 { draft, touch } props）', () => {
  const cases: readonly [string, string[]][] = [
    ['AppearanceSection.svelte', ['亮色界面主题', '暗色界面主题', '代码主题', '导入主题', 'themeOptions']],
    ['FontsSection.svelte', ['界面字体族', '代码字体族', '界面字号（px）', '代码字号（px）', '网络字体地址']],
    ['DiagramsSection.svelte', ['Kroki 服务地址', '渲染模式', 'DIAGRAM_TYPES']],
    ['SearchSection.svelte', ['添加排除规则', '删除排除规则', '加入预设排除规则', '暂无排除规则']],
    ['AutoRefreshSection.svelte', ['自动刷新', 'type="checkbox"']],
    ['ComputeSection.svelte', ['计算策略', 'auto', 'local', 'remote']]
  ];

  for (const [file, tokens] of cases) {
    it(`${file}：draft/touch props 契约 + 既有字段绑定迁移（同 schema 字段同绑定语义）`, () => {
      const src = readSrc(`src/lib/settings/${file}`);
      expect(src).toMatch(/draft: Settings; touch\(\): void/);
      expect(src).toMatch(/touch\(\)/);
      for (const t of tokens) expect(src).toContain(t);
    });
  }
});

describe('AppShell 接线（Ctrl+, 双入口 + overlay 判定入册）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('SettingsCenter 由 AppShell 挂载（{#if} 条件挂载，在 DOM 即开）', () => {
    expect(src).toContain("import SettingsCenter from './SettingsCenter.svelte'");
    expect(src).toMatch(/\{#if settingsCenterOpen\}[\s\S]*?<SettingsCenter/);
  });

  it('Ctrl+, 全局键位改指新页（AppShell onKey 内，非输入焦点才接管——原 TopBar 语义）', () => {
    expect(src).toMatch(/e\.key === ','/);
    expect(src).toMatch(/settingsCenterOpen = !settingsCenterOpen/);
  });

  it('OVERLAY_SELECTOR 入册 .vv-settings-center，退役 .vv-settings（zen Esc 优先级判定依赖）', () => {
    expect(src).toContain("'.vv-settings-center'");
    expect(src).not.toMatch(/'\.vv-settings'/); // 精确旧条目不得残留（-center 前缀不算）
  });

  it('⚙ 入口经 TopBar onsettings 回调切换新页', () => {
    expect(src).toMatch(/onsettings=\{\(\) => \(settingsCenterOpen = !settingsCenterOpen\)\}/);
  });
});

describe('TopBar 精简（spec §2：⚙+亮暗快切保留，代码主题/计算策略迁出）', () => {
  const src = readSrc('src/lib/TopBar.svelte');

  it('SettingsPanel 挂点退役：不再 import/挂载，Ctrl+, 监听移除（职责归 AppShell）', () => {
    expect(src).not.toContain('SettingsPanel');
    expect(src).not.toMatch(/settingsOpen/);
    expect(src).not.toMatch(/e\.key === ','/);
  });

  it('代码主题下拉与计算策略下拉迁出（aria-label 不再出现于 TopBar）', () => {
    expect(src).not.toContain('计算策略');
    expect(src).not.toContain('代码主题');
    expect(src).not.toContain('themeOptions');
  });

  it('亮暗快切与注入订阅链保留（cycleTheme + applyAppearance/applyFonts + fonts reaction）', () => {
    expect(src).toContain('function cycleTheme');
    expect(src).toContain('applyAppearanceFromSettings');
    expect(src).toContain('applyFontsFromSettings');
    expect(src).toContain('reactToFontsChange');
  });

  it('⚙ 按钮改走 onsettings 回调（props 声明）', () => {
    expect(src).toMatch(/onsettings\(\): void/);
    expect(src).toMatch(/aria-label="设置"[\s\S]{0,80}onclick=\{onsettings\}|onclick=\{onsettings\}[\s\S]{0,80}aria-label="设置"/);
  });
});
