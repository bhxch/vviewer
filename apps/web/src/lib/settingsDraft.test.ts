// settingsDraft.test.ts — 草稿模型纯函数（settings center spec §3，Task 2）。
// settingsDraft.ts 为纯 .ts 模块（无 runes），vitest 直测：往返等价/校验错误分类
// （未知字段/类型/clamp）/脏态/合并保留缺项/替换整体覆盖/JSON 格式错误。校验语义
// = loadSettings 白名单的镜像（未知字段报告、类型不符、clamp 越界提示截断）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_SCHEMA_VERSION,
  applyJson,
  buildExportFile,
  commit,
  draftToJson,
  exportFileName,
  importGroupDiffs,
  isDirty,
  jsonLineOf,
  mergeDraftOnto,
  mergeImported,
  openDraft,
  parseImportFile,
  replaceImported,
  validateSettings
} from './settingsDraft';
import { DEFAULTS, normalizeSettings, onSettingsChanged, type Settings } from './stores/settings';
import { DEFAULT_LAYOUT } from './layout';

const BASE: Settings = normalizeSettings({});

function aSettings(overrides: Partial<Settings>): Settings {
  return { ...BASE, ...overrides };
}

beforeEach(() => localStorage.removeItem('vviewer:settings'));
afterEach(() => localStorage.removeItem('vviewer:settings'));

describe('openDraft（spec §3：打开深拷贝）', () => {
  it('draft 与源深度独立：含 diagrams.modes/fonts/layout 等嵌套节互不影响', () => {
    const src = aSettings({
      excludedPatterns: ['.git'],
      diagrams: { krokiHost: 'https://k.example.com', krokiVia: 'client', mermaidTheme: 'auto', modes: { mermaid: 'kroki' }, renderers: {} },
      fonts: { uiFamily: 'X', uiSize: 20, codeFamily: 'Y', codeSize: 15 }
    });
    const draft = openDraft(src);
    draft.excludedPatterns.push('node_modules');
    draft.diagrams.modes.mermaid = 'local';
    draft.fonts.uiSize = 28;
    draft.layout.zen = true;
    expect(src.excludedPatterns).toEqual(['.git']);
    expect(src.diagrams.modes).toEqual({ mermaid: 'kroki' });
    expect(src.fonts.uiSize).toBe(20);
    expect(src.layout.zen).toBe(false);
  });
});

describe('往返等价（表单 draft ↔ JSON 文本）', () => {
  it('draftToJson → applyJson 往返后与原 draft 深度相等', () => {
    const src = aSettings({
      themeMode: 'dark',
      excludedPatterns: ['dist'],
      diagrams: { krokiHost: 'https://k.example.com', krokiVia: 'client', mermaidTheme: 'auto', modes: { mermaid: 'source', vega: 'kroki' }, renderers: {} },
      layout: { ...DEFAULT_LAYOUT, leftWidth: 400, zen: false }
    });
    const draft = openDraft(src);
    const target = openDraft(aSettings({}));
    expect(applyJson(target, draftToJson(draft))).toEqual({ ok: true });
    expect(target).toEqual(draft);
  });

  it('draftToJson 为格式化 JSON（2 空格缩进，可读）', () => {
    const text = draftToJson(openDraft(aSettings({ autoRefresh: false })));
    expect(text).toContain('\n  "autoRefresh": false');
    JSON.parse(text); // 不抛
  });
});

describe('applyJson 校验错误分类（spec §3：未知字段/类型不符/clamp 越界，全部阻断）', () => {
  it('未知字段报告且不落盘（顶层与嵌套节）', () => {
    const draft = openDraft(aSettings({ autoRefresh: true }));
    const r = applyJson(draft, JSON.stringify({ autoRefresh: false, foo: 1, fonts: { typo: 'x' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field);
      expect(fields).toContain('foo');
      expect(fields).toContain('fonts.typo');
      expect(r.errors.find((e) => e.field === 'foo')!.message).toContain('未知');
    }
    expect(draft.autoRefresh).toBe(true); // 阻断：draft 未被部分应用
  });

  it('类型不符报告（布尔/数组/枚举/槽格式/策略枚举/host 白名单/modes 键值）', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(
      draft,
      JSON.stringify({
        autoRefresh: 'yes',
        excludedPatterns: 'x',
        themeMode: 'sepia',
        appearanceLight: 'javascript:dark',
        computePolicy: 'quantum',
        diagrams: { krokiHost: 'ftp://x', modes: { mermaid: 'wasm', rust: 'local' } }
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field).sort();
      expect(fields).toEqual([
        'appearanceLight',
        'autoRefresh',
        'computePolicy',
        'diagrams.krokiHost',
        'diagrams.modes.mermaid',
        'diagrams.modes.rust',
        'excludedPatterns',
        'themeMode'
      ]);
    }
  });

  it('clamp 类：字号/栏宽越界报告目标截断值并阻断；范围内小数合法且应用时取整', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(
      draft,
      JSON.stringify({ fonts: { uiFamily: '', uiSize: 999, codeFamily: '', codeSize: 13 }, layout: { leftWidth: 9999 } })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const size = r.errors.find((e) => e.field === 'fonts.uiSize');
      expect(size!.message).toContain('28');
      expect(r.errors.find((e) => e.field === 'layout.leftWidth')!.message).toContain('480');
    }
    const ok = applyJson(draft, JSON.stringify({ fonts: { uiSize: 13.7 } }));
    expect(ok).toEqual({ ok: true });
    expect(draft.fonts.uiSize).toBe(14); // 应用 = 白名单规范化（clampSize 取整）
  });

  it('节整体脏值（fonts: 42）按类型不符报告，不抛异常', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(draft, JSON.stringify({ fonts: 42 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain('fonts');
  });

  it('renderers 校验（spec 2026-10-23 §9.1）：非对象/未知类型/选择面外值报告阻断；合法值通过并落位', () => {
    const draft = openDraft(aSettings({}));
    const bad = applyJson(
      draft,
      JSON.stringify({
        diagrams: { renderers: 42 } // 先整体脏值：报告 diagrams.renderers
      })
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.field)).toContain('diagrams.renderers');
    const badValues = applyJson(
      draft,
      JSON.stringify({ diagrams: { renderers: { rust: 'hpcc', mermaid: 'hpcc', graphviz: 'wasm' } } })
    );
    expect(badValues.ok).toBe(false);
    if (!badValues.ok) {
      const fields = badValues.errors.map((e) => e.field).sort();
      expect(fields).toEqual(['diagrams.renderers.graphviz', 'diagrams.renderers.mermaid', 'diagrams.renderers.rust']);
    }
    expect(draft.diagrams.renderers).toEqual({}); // 阻断：draft 未被部分应用
    const ok = applyJson(draft, JSON.stringify({ diagrams: { renderers: { graphviz: 'hpcc' } } }));
    expect(ok).toEqual({ ok: true });
    expect(draft.diagrams.renderers).toEqual({ graphviz: 'hpcc' });
  });
});

describe('JSON 格式错误（spec §3：停留 JSON 视图标错不丢文本——文本保留由 textarea 承担，此处锁错误形态）', () => {
  it('语法错误：ok:false，单条 field 空串错误，draft 不变', () => {
    const draft = openDraft(aSettings({ autoRefresh: true }));
    const before = draftToJson(draft);
    const r = applyJson(draft, '{ "autoRefresh": }');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.field).toBe('');
      expect(r.errors[0]!.message).toContain('JSON');
    }
    expect(draftToJson(draft)).toBe(before);
  });

  it('非对象 JSON（数字/数组）按格式错误报告', () => {
    const draft = openDraft(aSettings({}));
    expect(applyJson(draft, '42').ok).toBe(false);
    expect(applyJson(draft, '[]').ok).toBe(false);
  });

  it('jsonLineOf：position → 行号（1 起）', () => {
    expect(jsonLineOf('{"a":1,\n"b":2,\n"c":3}', 8)).toBe(2);
    expect(jsonLineOf('{"a":1}', 0)).toBe(1);
  });
});

describe('isDirty（spec §3 脏态）', () => {
  it('打开即 false；任何节改动即 true；改回即 false（深度比较不苛求键序）', () => {
    const src = aSettings({ excludedPatterns: ['.git'], autoRefresh: true });
    const draft = openDraft(src);
    expect(isDirty(draft, src)).toBe(false);
    draft.autoRefresh = false;
    expect(isDirty(draft, src)).toBe(true);
    draft.diagrams.modes.mermaid = 'kroki';
    expect(isDirty(draft, src)).toBe(true);
    const reverted = openDraft(src);
    expect(isDirty(reverted, src)).toBe(false);
  });
});

describe('commit（spec §3：应用统一走 saveSettings）', () => {
  it('落盘 + 触发订阅链；deep copy 入库（draft 后续改动不回灌已提交值）', () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    const draft = openDraft(aSettings({ excludedPatterns: ['.git'] }));
    draft.autoRefresh = false;
    commit(draft);
    expect(cb).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem('vviewer:settings')!);
    expect(stored.autoRefresh).toBe(false);
    draft.autoRefresh = true; // 提交后再改 draft
    expect(JSON.parse(localStorage.getItem('vviewer:settings')!).autoRefresh).toBe(false);
    off();
  });
});

describe('mergeDraftOnto（I-2：应用以 draft 相对出发快照的变更字段合并到最新值——陈旧草稿复活路径防护）', () => {
  it('purge 外部回落后应用不复活已删引用：未改字段保留 base（最新值），改动字段生效', () => {
    // 打开时刻（baseline）：codeFamily 引用字体 'x'；用户在页内只改 uiSize
    const opened = aSettings({ fonts: { uiFamily: '', uiSize: 16, codeFamily: 'x', codeSize: 13 } });
    const draft = openDraft(opened);
    draft.fonts.uiSize = 20;
    // purge 落盘后的最新生效值（base）：引用联动回落空栈
    const afterPurge = aSettings({ fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 } });
    const merged = mergeDraftOnto(afterPurge, opened, draft);
    expect(merged.fonts.codeFamily).toBe(''); // 悬空引用不复活（整体写回 draft 会落 'x'）
    expect(merged.fonts.uiSize).toBe(20); // 用户改动照常生效
    expect(merged.fonts.codeSize).toBe(13);
  });

  it('base=baseline（无外部变更）时结果恒等于 draft——原 commit(draft) 语义不变', () => {
    const opened = aSettings({ themeMode: 'light', autoRefresh: true, excludedPatterns: ['.git'] });
    const draft = openDraft(opened);
    draft.themeMode = 'dark';
    draft.diagrams.modes.mermaid = 'kroki';
    draft.excludedPatterns = ['.git', 'dist'];
    expect(mergeDraftOnto(opened, opened, draft)).toEqual(draft);
  });

  it('节内字段级粒度：同节内未改动的外部回落字段不被覆盖；撞同一字段 draft 胜（后写优先）', () => {
    const opened = aSettings({ layout: { ...DEFAULT_LAYOUT, leftWidth: 360, zen: false } });
    const draft = openDraft(opened);
    draft.layout.leftWidth = 400; // 用户只改宽度
    const afterExternal = aSettings({ layout: { ...DEFAULT_LAYOUT, leftWidth: 360, zen: true } }); // 外部改 zen
    const merged = mergeDraftOnto(afterExternal, opened, draft);
    expect(merged.layout.leftWidth).toBe(400); // 用户改动
    expect(merged.layout.zen).toBe(true); // 外部变更存活（节级粒度会把它冲回 false）

    const draft2 = openDraft(opened);
    draft2.layout.zen = true; // 用户与外部撞同一字段
    expect(mergeDraftOnto(afterExternal, opened, draft2).layout.zen).toBe(true); // draft 值胜
  });

  it('diagrams.modes 键级粒度：未改动的 modes 键保留 base；三个入参不被改动', () => {
    const opened = aSettings({ diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: { mermaid: 'local', vega: 'local' }, renderers: {} } });
    const draft = openDraft(opened);
    draft.diagrams.modes.mermaid = 'kroki';
    const afterExternal = aSettings({ diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: { mermaid: 'local', vega: 'kroki' }, renderers: {} } });
    const merged = mergeDraftOnto(afterExternal, opened, draft);
    expect(merged.diagrams.modes).toEqual({ mermaid: 'kroki', vega: 'kroki' });
    // 入参防御：base/baseline/draft 均不被触碰
    expect(afterExternal.diagrams.modes).toEqual({ mermaid: 'local', vega: 'kroki' });
    expect(draft.diagrams.modes).toEqual({ mermaid: 'kroki', vega: 'local' });
  });
});

describe('mergeImported / replaceImported（Task 3 消费的导入语义，spec §4）', () => {
  it('合并：导入缺项保留现状；在场字段覆盖（规范化后）；未知字段忽略〔I1 勘误：字段=节内字段级，非节整体——uiSize 节内缺项保留 current 而非归节默认〕', () => {
    const layout = { ...DEFAULT_LAYOUT, leftWidth: 400, tabBarVisible: false };
    const current = aSettings({
      excludedPatterns: ['.git', 'node_modules'],
      autoRefresh: true,
      fonts: { uiFamily: 'Keep', uiSize: 20, codeFamily: '', codeSize: 13 },
      layout
    });
    const merged = mergeImported(
      current,
      JSON.parse(JSON.stringify({ autoRefresh: false, fonts: { uiFamily: 'FromImport' }, who: 1 }))
    );
    expect(merged.autoRefresh).toBe(false); // 在场 → 覆盖
    expect(merged.excludedPatterns).toEqual(['.git', 'node_modules']); // 缺项 → 保留
    expect(merged.fonts.uiFamily).toBe('FromImport'); // 在场节字段级覆盖
    expect(merged.fonts.uiSize).toBe(20); // 节内缺项 → 保留 current（I1 字段级口径；节整体覆盖口径下会归节默认 16）
    expect(merged.fonts.codeSize).toBe(13); // 节内缺项 → 保留 current
    expect(merged.layout).toEqual(layout); // 缺项节 → 现状保留
    expect((merged as unknown as Record<string, unknown>).who).toBeUndefined();
  });

  it('I1 字段级合并（终审反例）：导入 {fonts:{codeSize}} 只覆盖该字段，uiFamily 保留 current 非默认栈；数组整组覆盖', () => {
    const current = aSettings({
      excludedPatterns: ['.git'],
      fonts: { uiFamily: 'MyFont, monospace', uiSize: 20, codeFamily: 'MyCode', codeSize: 13 }
    });
    const merged = mergeImported(current, { fonts: { codeSize: 16 } });
    expect(merged.fonts.codeSize).toBe(16); // 在场字段覆盖
    expect(merged.fonts.uiFamily).toBe('MyFont, monospace'); // 非默认栈保留（节整体覆盖口径下会丢）
    expect(merged.fonts.uiSize).toBe(20);
    expect(merged.fonts.codeFamily).toBe('MyCode');
    const arr = mergeImported(current, { excludedPatterns: ['dist', 'build'] });
    expect(arr.excludedPatterns).toEqual(['dist', 'build']); // 数组整组覆盖（不做元素级并集）
  });

  it('I1 节内对象递归一层：diagrams.modes 按图类型键级合并，未在场类型/host 保留 current', () => {
    const current = aSettings({
      diagrams: { krokiHost: 'https://k.example.com', krokiVia: 'client', mermaidTheme: 'auto', modes: { mermaid: 'kroki', vega: 'local' }, renderers: {} }
    });
    const merged = mergeImported(current, { diagrams: { modes: { mermaid: 'source' } } });
    expect(merged.diagrams.krokiHost).toBe('https://k.example.com'); // 节内缺项保留
    expect(merged.diagrams.modes).toEqual({ mermaid: 'source', vega: 'local' }); // 在场键覆盖、缺项键保留
  });

  it('合并：导入字段非法时该字段取规范化结果（校验与报错在 Task 3 对话框层，本函数只规范化）', () => {
    const current = aSettings({ computePolicy: 'remote' });
    const merged = mergeImported(current, { computePolicy: 'quantum', diagrams: 42 });
    expect(merged.computePolicy).toBe('auto'); // 非法 → normalizeSettings 默认，不用现状顶回
    expect(merged.diagrams).toEqual({ krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: {}, renderers: {} }); // 节值非对象 → 规范化全形节整体落位
  });

  it('替换：整体覆盖为规范化结果——缺项/脏字段补默认，不保留现状', () => {
    const current = aSettings({ excludedPatterns: ['.git'], themeMode: 'dark', fonts: { uiSize: 22 } } as Partial<Settings>);
    const replaced = replaceImported({ themeMode: 'light', fonts: { uiSize: 999 } });
    expect(replaced.themeMode).toBe('light');
    expect(replaced.excludedPatterns).toEqual([]); // 现状被整体覆盖
    expect(replaced.fonts).toEqual({ uiFamily: '', uiSize: 28, codeFamily: '', codeSize: 13 }); // clamp 规范化
    expect(replaced.layout).toEqual(DEFAULT_LAYOUT);
    expect(current.themeMode).toBe('dark'); // current 不被触碰
  });

  it('替换：非对象输入回落全默认', () => {
    expect(replaceImported(null)).toEqual(aSettings({}));
    expect(replaceImported('x')).toEqual(aSettings({}));
  });

  it('L1 顺手项：替换/合并不泄漏白名单外未知字段（规范化结果只含已知键）', () => {
    const replaced = replaceImported({ themeMode: 'dark', who: 1, nested: { x: 2 } });
    expect(Object.keys(replaced).sort()).toEqual(Object.keys(aSettings({})).sort());
    const merged = mergeImported(aSettings({}), { autoRefresh: false, who: 1 });
    expect(Object.keys(merged).sort()).toEqual(Object.keys(aSettings({})).sort());
  });
});

describe('Task 3 导出（spec §4：schemaVersion 文件结构与文件名）', () => {
  it('buildExportFile：{ schemaVersion: 1, exportedAt, settings }，settings 深拷贝独立', () => {
    const src = aSettings({ excludedPatterns: ['.git'], autoRefresh: true });
    const file = buildExportFile(src, '2026-10-19T00:00:00.000Z');
    expect(file.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
    expect(file.exportedAt).toBe('2026-10-19T00:00:00.000Z');
    expect(file.settings).toEqual(src);
    src.excludedPatterns.push('node_modules'); // 导出后改源不影响文件
    expect(file.settings.excludedPatterns).toEqual(['.git']);
  });

  it('exportFileName：vviewer-settings-YYYYMMDD.json（本地日期，补零）', () => {
    expect(exportFileName(new Date(2026, 0, 2))).toBe('vviewer-settings-20260102.json');
    expect(exportFileName(new Date(2026, 9, 19))).toBe('vviewer-settings-20261019.json'); // 月份 0 起
  });
});

describe('Task 3 导入解析（spec §4：parse → schemaVersion 检查 → 白名单校验，失败不部分应用）', () => {
  const exported = (settings: unknown, schemaVersion: number | undefined = 1): string =>
    JSON.stringify({ ...(schemaVersion !== undefined ? { schemaVersion } : {}), exportedAt: '2026-10-19T00:00:00.000Z', settings });

  it('合法文件：ok，settings 原样透传（规范化在 merge/replace），无警告', () => {
    const r = parseImportFile(exported({ autoRefresh: false, fonts: { uiSize: 20 } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings).toEqual({ autoRefresh: false, fonts: { uiSize: 20 } });
      expect(r.warnings).toEqual([]);
    }
  });

  it('更高 schemaVersion：警告尽力合并并注记风险，不阻断', () => {
    const r = parseImportFile(exported({}, 2));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain('2');
      expect(r.warnings[0]).toContain('风险');
    }
  });

  it('缺少/非数字 schemaVersion：降级警告按当前版本处理', () => {
    const missing = parseImportFile('{"exportedAt":"2026-10-19T00:00:00.000Z","settings":{}}');
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.warnings[0]).toContain('schemaVersion');
    const bad = parseImportFile(JSON.stringify({ schemaVersion: 'x', exportedAt: '', settings: {} }));
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.warnings[0]).toContain('schemaVersion');
  });

  it('settings 内未知字段：警告（白名单外不落盘），不阻断', () => {
    const r = parseImportFile(exported({ foo: 1 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes('foo') && w.includes('未知'))).toBe(true);
    const nested = parseImportFile(exported({ fonts: { typo: 1 } }));
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.warnings.some((w) => w.includes('fonts.typo'))).toBe(true);
  });

  it('校验失败（类型不符）：报错不部分应用——ok:false 且不含可应用结果', () => {
    const r = parseImportFile(exported({ autoRefresh: 'yes' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain('autoRefresh');
  });

  it('缺 settings 节 / 非对象文件 / JSON 语法错误：格式级报错', () => {
    const noSettings = parseImportFile(JSON.stringify({ schemaVersion: 1 }));
    expect(noSettings.ok).toBe(false);
    if (!noSettings.ok) expect(noSettings.errors[0]!.field).toBe('settings');
    const notObj = parseImportFile('42');
    expect(notObj.ok).toBe(false);
    const syntax = parseImportFile('{');
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) expect(syntax.errors[0]!.field).toBe('');
  });
});

describe('Task 3 变更摘要（spec §4：逐组 diff 列表，仅列导入在场且有差异的组）', () => {
  it('数组元素增删/标量修改/节内字段修改各自入列；缺项组不出现', () => {
    const current = aSettings({ excludedPatterns: ['.git'], autoRefresh: true });
    const diffs = importGroupDiffs(current, {
      excludedPatterns: ['.git', 'dist'],
      autoRefresh: false,
      fonts: { uiSize: 20 }
    });
    const byKey = new Map(diffs.map((d) => [d.key, d]));
    expect(byKey.has('themeMode')).toBe(false); // 缺项组不列
    expect(byKey.get('excludedPatterns')!.added).toEqual(['+ dist']);
    expect(byKey.get('excludedPatterns')!.removed).toEqual([]);
    expect(byKey.get('autoRefresh')!.changed).toEqual(['autoRefresh: true → false']);
    expect(byKey.get('fonts')!.changed).toContain('fonts.uiSize: 16 → 20');
  });

  it('节内嵌套二级（diagrams.modes）diff 带完整路径；无差异组不出现在摘要', () => {
    const current = aSettings({ diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: { mermaid: 'local' }, renderers: {} } });
    const diffs = importGroupDiffs(current, {
      diagrams: { krokiHost: '', modes: { mermaid: 'kroki' }, renderers: {} },
      autoRefresh: true
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.key).toBe('diagrams');
    expect(diffs[0]!.changed).toContain('diagrams.modes.mermaid: local → kroki');
  });

  it('非对象输入返回空摘要', () => {
    expect(importGroupDiffs(aSettings({}), null)).toEqual([]);
    expect(importGroupDiffs(aSettings({}), 42)).toEqual([]);
  });
});

describe('normalizeSettings 导出（loadSettings 白名单的共享规范化入口）', () => {
  it('同一白名单单源：clamp/枚举/modes 剔除与 loadSettings 同口径（行为回归由 settings.test.ts 锁定）', () => {
    const s = normalizeSettings({
      fonts: { uiSize: 3 },
      diagrams: { krokiHost: 'ftp://x', modes: { mermaid: 'wasm', vega: 'kroki' }, renderers: { graphviz: 'hpcc', mermaid: 'hpcc' } },
      autoRefresh: false
    });
    expect(s.fonts.uiSize).toBe(10);
    // renderers 同单源口径：graphviz=hpcc 命中注册表选择面保留，mermaid 无选择面剔除
    expect(s.diagrams).toEqual({ krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: { vega: 'kroki' }, renderers: { graphviz: 'hpcc' } });
    expect(s.autoRefresh).toBe(false);
    // 缺项补默认（Settings 全形返回）
    expect(Object.keys(s).sort()).toEqual(Object.keys(aSettings({})).sort());
  });
});

describe('iconThemes 设置节（图标主题 spec §3.1，Task 3）', () => {
  it('合法值原样通过：theme 三态 + scopes 四键布尔逐键落位', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(
      draft,
      JSON.stringify({ iconThemes: { theme: 'imported:abc12345', scopes: { tree: true, tabs: true, quickOpen: false, search: true } } })
    );
    expect(r).toEqual({ ok: true });
    expect(draft.iconThemes).toEqual({
      theme: 'imported:abc12345',
      scopes: { tree: true, tabs: true, quickOpen: false, search: true }
    });
    expect(applyJson(openDraft(aSettings({})), JSON.stringify({ iconThemes: { theme: 'seti' } })).ok).toBe(true);
  });

  it('脏 theme：validateSettings 阻断报告；normalizeSettings 静默归位 none（白名单外不落盘）', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(draft, JSON.stringify({ iconThemes: { theme: 'bogus' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain('iconThemes.theme');
    const s = normalizeSettings({ iconThemes: { theme: 'bogus' } });
    expect(s.iconThemes.theme).toBe('none');
    expect(normalizeSettings({ iconThemes: { theme: 'vscode:x' } }).iconThemes.theme).toBe('none'); // 外观槽前缀形态不越权
  });

  it('脏 scopes：未知键/非布尔值阻断报告；normalizeSettings 只落四键布尔（未知键剔除、缺键补默认）', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(draft, JSON.stringify({ iconThemes: { scopes: { tree: true, bogus: 1, tabs: 'yes' } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field);
      expect(fields).toContain('iconThemes.scopes.bogus');
      expect(fields).toContain('iconThemes.scopes.tabs');
    }
    const s = normalizeSettings({ iconThemes: { scopes: { tree: false, bogus: 1, tabs: 'yes' } } });
    expect(s.iconThemes.scopes).toEqual({ tree: false, tabs: false, quickOpen: false, search: false });
  });

  it('节整体脏值（iconThemes: 42）按类型不符报告不抛异常；normalizeSettings 回落默认', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(draft, JSON.stringify({ iconThemes: 42 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain('iconThemes');
    expect(normalizeSettings({ iconThemes: 42 }).iconThemes).toEqual({
      theme: 'none',
      scopes: { tree: true, tabs: false, quickOpen: false, search: false }
    });
  });

  it('导出导入 round-trip：iconThemes 节深度保形', () => {
    const src = aSettings({
      iconThemes: { theme: 'seti', scopes: { tree: true, tabs: false, quickOpen: false, search: false } }
    });
    const file = buildExportFile(src, '2026-10-31T00:00:00.000Z');
    const parsed = parseImportFile(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(replaceImported(parsed.settings).iconThemes).toEqual(src.iconThemes);
  });

  it('导入文件侧：scopes 未知键降级警告（白名单外不落盘），类型不符仍阻断', () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-10-31T00:00:00.000Z',
      settings: { iconThemes: { scopes: { tree: true, bogus: 1 } } }
    });
    const r = parseImportFile(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes('iconThemes.scopes.bogus'))).toBe(true);
    const bad = parseImportFile(
      JSON.stringify({ schemaVersion: 1, exportedAt: '', settings: { iconThemes: { scopes: { tabs: 'yes' } } } })
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.field)).toContain('iconThemes.scopes.tabs');
  });
});

describe('storage 设置节（远端下载确认阈值，spec §6.4，计划 2 Task 5）', () => {
  it('默认 512：DEFAULTS 与 normalizeSettings({}) 均 512（BASE 含 storage 节）', () => {
    expect(DEFAULTS.storage).toEqual({ remoteDownloadConfirmMb: 512 });
    expect(normalizeSettings({}).storage).toEqual({ remoteDownloadConfirmMb: 512 });
    expect(BASE.storage).toEqual({ remoteDownloadConfirmMb: 512 });
  });

  it('clamp 双界（1–4096）：0→1 / 4097→4096 / 合法值原样 / 小数取整；脏值（字符串）归默认', () => {
    expect(normalizeSettings({ storage: { remoteDownloadConfirmMb: 0 } }).storage.remoteDownloadConfirmMb).toBe(1);
    expect(normalizeSettings({ storage: { remoteDownloadConfirmMb: 4097 } }).storage.remoteDownloadConfirmMb).toBe(4096);
    expect(normalizeSettings({ storage: { remoteDownloadConfirmMb: 2048 } }).storage.remoteDownloadConfirmMb).toBe(2048);
    expect(normalizeSettings({ storage: { remoteDownloadConfirmMb: 512.7 } }).storage.remoteDownloadConfirmMb).toBe(513);
    expect(normalizeSettings({ storage: { remoteDownloadConfirmMb: 'x' } }).storage.remoteDownloadConfirmMb).toBe(512);
  });

  it('白名单三类问题收集（spec §3 同口径）：节内未知字段/类型不符（节整体+字段）/clamp 越界全阻断', () => {
    const draft = openDraft(aSettings({}));
    const r = applyJson(draft, JSON.stringify({ storage: { typo: 1, remoteDownloadConfirmMb: 99999 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field);
      expect(fields).toContain('storage.typo');
      expect(fields).toContain('storage.remoteDownloadConfirmMb');
      expect(r.errors.find((e) => e.field === 'storage.typo')!.message).toContain('未知');
      expect(r.errors.find((e) => e.field === 'storage.remoteDownloadConfirmMb')!.message).toContain('4096');
    }
    expect(draft.storage.remoteDownloadConfirmMb).toBe(512); // 阻断：draft 未被部分应用
    const typeErr = applyJson(openDraft(aSettings({})), JSON.stringify({ storage: { remoteDownloadConfirmMb: '大' } }));
    expect(typeErr.ok).toBe(false);
    if (!typeErr.ok) expect(typeErr.errors.map((e) => e.field)).toContain('storage.remoteDownloadConfirmMb');
    const wholeErr = applyJson(openDraft(aSettings({})), JSON.stringify({ storage: 42 }));
    expect(wholeErr.ok).toBe(false);
    if (!wholeErr.ok) expect(wholeErr.errors.map((e) => e.field)).toContain('storage');
  });

  it('合法值应用落位；normalizeSettings 静默归位口径一致（校验报告 vs 归一化互补）', () => {
    const draft = openDraft(aSettings({}));
    expect(applyJson(draft, JSON.stringify({ storage: { remoteDownloadConfirmMb: 64 } }))).toEqual({ ok: true });
    expect(draft.storage.remoteDownloadConfirmMb).toBe(64);
    expect(normalizeSettings({ storage: { remoteDownloadConfirmMb: 0 } }).storage).toEqual({ remoteDownloadConfirmMb: 1 });
    expect(normalizeSettings({ storage: 42 }).storage).toEqual({ remoteDownloadConfirmMb: 512 }); // 节脏值回落默认，不抛
  });

  it('导出导入 round-trip：storage 节深度保形（buildExportFile → parseImportFile → replaceImported）', () => {
    const src = aSettings({ storage: { remoteDownloadConfirmMb: 64 } });
    const file = buildExportFile(src, '2026-11-05T00:00:00.000Z');
    expect(file.settings.storage).toEqual({ remoteDownloadConfirmMb: 64 }); // 导出携带新字段
    const parsed = parseImportFile(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(replaceImported(parsed.settings).storage).toEqual({ remoteDownloadConfirmMb: 64 });
    // 导入文件侧：storage 节内未知键降级警告（白名单外不落盘），clamp 越界仍阻断
    const warnFile = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-11-05T00:00:00.000Z',
      settings: { storage: { remoteDownloadConfirmMb: 64, bogus: 1 } }
    });
    const warned = parseImportFile(warnFile);
    expect(warned.ok).toBe(true);
    if (warned.ok) expect(warned.warnings.some((w) => w.includes('storage.bogus'))).toBe(true);
    const clampFile = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-11-05T00:00:00.000Z',
      settings: { storage: { remoteDownloadConfirmMb: 99999 } }
    });
    const clamped = parseImportFile(clampFile);
    expect(clamped.ok).toBe(false);
    if (!clamped.ok) expect(clamped.errors.map((e) => e.field)).toContain('storage.remoteDownloadConfirmMb');
  });
});

describe('rendererDefaults 设置节（多渲染器格式的默认渲染器偏好）', () => {
  it('默认空表：DEFAULTS 与 normalizeSettings({}) 均为 {}', () => {
    expect(DEFAULTS.rendererDefaults).toEqual({});
    expect(normalizeSettings({}).rendererDefaults).toEqual({});
  });

  it('normalizeSettings 白名单：小写扩展名键 + 渲染器 id 形态值（含 \'\' = 内置默认）保留，其余剔除', () => {
    const s = normalizeSettings({
      rendererDefaults: { docx: 'docx', pptx: '', csv: 'foreign-spreadsheet', 'DOCX': 'x', '.md': 'code', xlsx: 42, odt: 'Bad Id' }
    });
    expect(s.rendererDefaults).toEqual({ docx: 'docx', pptx: '', csv: 'foreign-spreadsheet' });
    expect(normalizeSettings({ rendererDefaults: 42 }).rendererDefaults).toEqual({}); // 节脏值回落空表，不抛
    expect(normalizeSettings({ rendererDefaults: ['docx'] }).rendererDefaults).toEqual({});
  });

  it('validateSettings：节非对象/键非小写扩展名/值非渲染器 id 全报告；合法表零报告', () => {
    expect(validateSettings({ rendererDefaults: { docx: 'docx', pptx: '' } })).toEqual([]);
    const fields = validateSettings({ rendererDefaults: { 'DOCX': 'docx', pptx: 3, odt: 'Bad Id' } }).map((i) => i.field);
    expect(fields).toEqual(['rendererDefaults.DOCX', 'rendererDefaults.pptx', 'rendererDefaults.odt']);
    expect(validateSettings({ rendererDefaults: 'docx' }).map((i) => i.field)).toEqual(['rendererDefaults']);
  });

  it("mergeDraftOnto：改回内置默认写 ''（删键不传播），'' 覆盖 latest 中的旧偏好", () => {
    const base = aSettings({ rendererDefaults: { docx: 'docx' } });
    const draft = openDraft(base);
    draft.rendererDefaults.docx = '';
    draft.rendererDefaults.pptx = 'pptx';
    const merged = mergeDraftOnto(base, base, draft);
    expect(merged.rendererDefaults).toEqual({ docx: '', pptx: 'pptx' });
  });

  it('导出导入 round-trip 保形', () => {
    const src = aSettings({ rendererDefaults: { docx: 'docx', xlsx: 'foreign-spreadsheet' } });
    const parsed = parseImportFile(JSON.stringify(buildExportFile(src, '2026-11-09T00:00:00.000Z')));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(replaceImported(parsed.settings).rendererDefaults).toEqual({ docx: 'docx', xlsx: 'foreign-spreadsheet' });
  });
});

describe('SETTINGS_KEYS DEFAULTS 派生（FE-3：白名单对账机械化）', () => {
  it('DEFAULTS 全键经派生白名单：openDraft(DEFAULTS) 全量序列化-校验零 unknown 报告（退回手工清单/漏登记即红）；对照探针仍报告（非恒真）', () => {
    // DEFAULTS 键集 = Object.keys(DEFAULTS) 派生的白名单：全量序列化产物经
    // validateSettings 必零报告（含零「未知字段」）——未来 Settings 新增字段若
    // 白名单退回手工清单漏登记，DEFAULTS 全键序列化里的该字段即被报未知而红
    const issues = validateSettings(JSON.parse(draftToJson(openDraft(DEFAULTS))));
    expect(issues).toEqual([]);
    // 对照断言（防校验器恒返空的假绿）：白名单外探针字段仍被报告为未知字段
    expect(validateSettings({ ...DEFAULTS, __probe: 1 }).map((i) => i.field)).toContain('__probe');
  });
});
