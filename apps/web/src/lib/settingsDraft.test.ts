// settingsDraft.test.ts — 草稿模型纯函数（settings center spec §3，Task 2）。
// settingsDraft.ts 为纯 .ts 模块（无 runes），vitest 直测：往返等价/校验错误分类
// （未知字段/类型/clamp）/脏态/合并保留缺项/替换整体覆盖/JSON 格式错误。校验语义
// = loadSettings 白名单的镜像（未知字段报告、类型不符、clamp 越界提示截断）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyJson,
  commit,
  draftToJson,
  isDirty,
  jsonLineOf,
  mergeImported,
  openDraft,
  replaceImported
} from './settingsDraft';
import { normalizeSettings, onSettingsChanged, type Settings } from './stores/settings';
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
      diagrams: { krokiHost: 'https://k.example.com', modes: { mermaid: 'kroki' } },
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
      diagrams: { krokiHost: 'https://k.example.com', modes: { mermaid: 'source', vega: 'kroki' } },
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

describe('mergeImported / replaceImported（Task 3 消费的导入语义，spec §4）', () => {
  it('合并：导入缺项保留现状；在场字段级覆盖（规范化后）；未知字段忽略', () => {
    const layout = { ...DEFAULT_LAYOUT, leftWidth: 400, topBarVisible: false };
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
    expect(merged.fonts.uiSize).toBe(16); // 节内缺项 → 该节默认值（节整体覆盖口径）
    expect(merged.layout).toEqual(layout); // 缺项节 → 现状保留
    expect((merged as unknown as Record<string, unknown>).who).toBeUndefined();
  });

  it('合并：导入字段非法时该字段归位默认（校验与报错在 Task 3 对话框层，本函数只规范化）', () => {
    const current = aSettings({ computePolicy: 'remote' });
    const merged = mergeImported(current, { computePolicy: 'quantum', diagrams: 42 });
    expect(merged.computePolicy).toBe('auto'); // 非法 → normalizeSettings 默认，不用现状顶回
    expect(merged.diagrams).toEqual({ krokiHost: '', modes: {} });
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
});

describe('normalizeSettings 导出（loadSettings 白名单的共享规范化入口）', () => {
  it('同一白名单单源：clamp/枚举/modes 剔除与 loadSettings 同口径（行为回归由 settings.test.ts 锁定）', () => {
    const s = normalizeSettings({
      fonts: { uiSize: 3 },
      diagrams: { krokiHost: 'ftp://x', modes: { mermaid: 'wasm', vega: 'kroki' } },
      autoRefresh: false
    });
    expect(s.fonts.uiSize).toBe(10);
    expect(s.diagrams).toEqual({ krokiHost: '', modes: { vega: 'kroki' } });
    expect(s.autoRefresh).toBe(false);
    // 缺项补默认（Settings 全形返回）
    expect(Object.keys(s).sort()).toEqual(Object.keys(aSettings({})).sort());
  });
});
