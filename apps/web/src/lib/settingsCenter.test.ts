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
    expect(src).toMatch(/import \{[^}]*type Component[^}]*\} from 'svelte'/);
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
    expect(src).toMatch(/if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.shiftKey && !e\.altKey && e\.key === ','\)\s*\{\s*e\.preventDefault\(\);\s*toggleSettingsCenter\(\);/);
  });

  it('OVERLAY_SELECTOR 入册 .vv-settings-center，退役 .vv-settings（zen Esc 优先级判定依赖）', () => {
    expect(src).toContain("'.vv-settings-center'");
    expect(src).not.toMatch(/'\.vv-settings'/); // 精确旧条目不得残留（-center 前缀不算）
  });

  it('⚙ 入口经 TopBar onsettings 回调切换新页；关闭统一走组件实例 requestClose（脏态裁决不绕过）', () => {
    expect(src).toMatch(/onsettings=\{\(\) => toggleSettingsCenter\(\)\}/);
    expect(src).toMatch(/bind:this=\{settingsCenterEl\}/);
    expect(src).toMatch(/toggleSettingsCenter[\s\S]{0,200}settingsCenterEl\?\.requestClose\(\)/);
  });
});

describe('草稿模型与 UI/JSON 双视图接线（settings center spec §3，Task 2）', () => {
  const src = readSrc('src/lib/SettingsCenter.svelte');

  it('消费 settingsDraft 全接口：openDraft/draftToJson/applyJson/isDirty/commit', () => {
    expect(src).toContain("from './settingsDraft'");
    for (const fn of ['openDraft', 'draftToJson', 'applyJson', 'isDirty', 'commit']) {
      expect(src).toMatch(new RegExp(`\\b${fn}\\(`));
    }
  });

  it('视图切换：表单/JSON 双钮（aria-pressed），表单→JSON 即重序列化、JSON→表单先 parse+校验', () => {
    expect(src).toMatch(/aria-pressed=\{view === 'form'\}/);
    expect(src).toMatch(/aria-pressed=\{view === 'json'\}/);
    // 表单→JSON：丢弃手编缓冲 = 显示 draft 的格式化序列化
    expect(src).toMatch(/function showJson[\s\S]{0,200}jsonDirtyBuffer = null/);
    // JSON→表单：applyJson 失败置 jsonErrors 停留（不丢文本——文本存于手编缓冲）
    expect(src).toMatch(/function leaveJson[\s\S]{0,300}if \(!r\.ok\)\s*\{\s*jsonErrors = r\.errors;\s*return false;/);
  });

  it('JSON 视图：等宽 textarea + 行号栏，手编缓冲原样保留（非法标错不丢文本）', () => {
    expect(src).toContain('aria-label="设置 JSON"');
    expect(src).toContain('vv-sc-gutter');
    expect(src).toMatch(/jsonDirtyBuffer = \(e\.currentTarget as HTMLTextAreaElement\)\.value/);
  });

  it('应用/放弃统一入口：应用走 commit（saveSettings 链）并刷新脏态基准；放弃还原 openDraft', () => {
    expect(src).toMatch(/function doApply[\s\S]*?commit\(draft\);[\s\S]*?applied = loadSettings\(\);/);
    expect(src).toMatch(/function doDiscard[\s\S]*?draft = openDraft\(applied\);/);
    expect(src).toContain('disabled={!canApply}');
  });

  it('脏态关闭确认（spec §3）：requestClose 导出 + 确认条（应用并关闭/放弃并关闭）', () => {
    expect(src).toMatch(/export function requestClose\(\): void/);
    expect(src).toMatch(/role="alertdialog"/);
    expect(src).toContain('应用并关闭');
    expect(src).toContain('放弃并关闭');
    // 全部关闭路径（✕/容器 Esc/窗兜底 Esc）均走 requestClose 而非直关
    expect(src).toMatch(/onclick=\{requestClose\}/);
    expect(src).toMatch(/onRootKeydown[\s\S]{0,200}requestClose\(\)/);
    expect(src).toMatch(/!rootEl\.contains\(e\.target\)[\s\S]{0,120}requestClose\(\)/);
  });

  it('节组件 touch 契约落点：节改动只使 JSON 派生失效（不落盘），落盘统一在应用', () => {
    expect(src).toMatch(/function touch\(\): void\s*\{\s*jsonDirtyBuffer = null;/);
  });
});

describe('评审带入项（Task 1+2 review：M1 必做 / L2·L6 顺手）', () => {
  const appearance = readSrc('src/lib/settings/AppearanceSection.svelte');
  const src = readSrc('src/lib/SettingsCenter.svelte');

  it('M1：外观组亮暗模式三态控件（spec §2 外观组定义；TopBar 快切并存双写同字段）', () => {
    expect(appearance).toContain('aria-label="亮暗模式"');
    for (const v of ['system', 'light', 'dark']) {
      expect(appearance).toContain(`value="${v}"`);
    }
    expect(appearance).toMatch(/draft\.themeMode = /); // 写 draft（非直写 saveSettings）
    expect(appearance).toMatch(/draft\.themeMode = [^;]+;\s*touch\(\)/);
  });

  it('L2：应用成功后复位脏态关闭确认条（残留即失实）', () => {
    // 有界匹配：确认条复位必须落在 doApply 函数体内（后文「继续编辑」钮也有
    // confirmClose = false，无界 [\s\S]*? 会空泛命中）
    expect(src).toMatch(/function doApply[\s\S]{0,900}?confirmClose = false;/);
  });

  it('L6：应用成功后 draft 以规范化 applied 重建（非法 krokiHost 等应用后不再永脏）', () => {
    expect(src).toMatch(/applied = loadSettings\(\);[\s\S]{0,300}?draft = openDraft\(applied\);/);
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
