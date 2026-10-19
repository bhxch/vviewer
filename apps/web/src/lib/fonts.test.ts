// fonts.test.ts — 字体预设清单与设置面板字体节契约（字体系统 spec §4，Task 3）。
// 根 vitest 无 svelte 插件（exportPanel.test.ts 同款约束）：SettingsPanel 无法
// 挂载，面板部分按既有「源码契约断言」先例锁定结构/接线；运行时行为由 e2e
// （字体系统 Task 6 b-fonts.spec）兜底。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CODE_FONT_PRESETS,
  CUSTOM_FONT_SENTINEL,
  FONT_SPECIMEN,
  UI_FONT_PRESETS,
  fontFamilyOptions,
  type FontPreset
} from './fonts';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('预设清单形状（spec §4：UI 组 8 项 / 代码组 10 项）', () => {
  it('UI 组 8 项：值即 spec 清单原文，label/value 非空且值唯一，无默认占位项', () => {
    expect(UI_FONT_PRESETS).toHaveLength(8);
    expect(UI_FONT_PRESETS.map((p) => p.value)).toEqual([
      'system-ui',
      '微软雅黑',
      'PingFang SC',
      'Noto Sans CJK SC',
      '思源黑体',
      'Segoe UI',
      'Roboto',
      'Helvetica Neue'
    ]);
    for (const p of UI_FONT_PRESETS) {
      expect(p.label.trim()).not.toBe('');
      expect(p.value.trim()).not.toBe('');
    }
    expect(new Set(UI_FONT_PRESETS.map((p) => p.value)).size).toBe(UI_FONT_PRESETS.length);
  });

  it("代码组 10 项：首项为默认占位（value ''、label 默认等宽栈），其余为 spec 清单原文", () => {
    expect(CODE_FONT_PRESETS).toHaveLength(10);
    expect(CODE_FONT_PRESETS[0]).toEqual({ value: '', label: '默认等宽栈' });
    expect(CODE_FONT_PRESETS.slice(1).map((p) => p.value)).toEqual([
      'JetBrains Mono',
      'Fira Code',
      'Cascadia Code',
      'Consolas',
      'Menlo',
      'SF Mono',
      'Source Code Pro',
      'Sarasa Mono SC',
      'Noto Sans Mono CJK SC'
    ]);
    expect(new Set(CODE_FONT_PRESETS.map((p) => p.value)).size).toBe(CODE_FONT_PRESETS.length);
  });

  it('样张常量（spec §4）：中英数易混形字符齐全——Task 3 预览/Task 5 管理列表共用', () => {
    expect(FONT_SPECIMEN).toBe('AaBbYyZz 0123 永江流千里 0OIl1|');
  });
});

describe('fontFamilyOptions（两槽下拉装配：默认 + 预设组 + 自定义哨兵）', () => {
  it("UI 槽：默认项（value ''）居首、预设组保持清单序、自定义哨兵收尾，值唯一", () => {
    const opts = fontFamilyOptions(UI_FONT_PRESETS);
    expect(opts[0]).toEqual({ value: '', label: '默认' });
    expect(opts.slice(1, -1)).toEqual(UI_FONT_PRESETS.map((p) => ({ ...p })));
    expect(opts.at(-1)).toEqual({ value: CUSTOM_FONT_SENTINEL, label: '自定义…' });
    expect(new Set(opts.map((o) => o.value)).size).toBe(opts.length);
  });

  it("代码槽：spec 默认项「默认等宽栈」并入默认选项位标签（不产生重复 value ''）", () => {
    const opts = fontFamilyOptions(CODE_FONT_PRESETS);
    expect(opts[0]).toEqual({ value: '', label: '默认等宽栈' });
    expect(opts.filter((o) => o.value === '')).toHaveLength(1);
    expect(opts.at(-1)?.label).toBe('自定义…');
  });

  it('哨兵值不与任何真实预设值冲突', () => {
    for (const p of [...UI_FONT_PRESETS, ...CODE_FONT_PRESETS]) {
      expect(p.value).not.toBe(CUSTOM_FONT_SENTINEL);
    }
  });
});

describe('SettingsPanel 字体节源码契约（两槽四输入 + persist 接线 + 节序）', () => {
  const src = readSrc('src/lib/SettingsPanel.svelte');

  it('字体节位于图表之后、界面主题之前（外观簇：图表 → 字体 → 界面主题）', () => {
    const chart = src.indexOf('vv-settings-label">图表<');
    const fonts = src.indexOf('vv-settings-label">字体<');
    const theme = src.indexOf('vv-settings-label">界面主题<');
    expect(chart).toBeGreaterThan(-1);
    expect(fonts).toBeGreaterThan(chart);
    expect(theme).toBeGreaterThan(fonts);
  });

  it('两槽四输入：族下拉/自定义手输/字号 number 各×2，aria-label 可寻址', () => {
    expect(src).toContain('aria-label="界面字体族"');
    expect(src).toContain('aria-label="代码字体族"');
    expect(src).toContain('aria-label="自定义界面字体族"');
    expect(src).toContain('aria-label="自定义代码字体族"');
    expect(src).toContain('aria-label="界面字号（px）"');
    expect(src).toContain('aria-label="代码字号（px）"');
    expect(src.match(/type="number"/g)?.length).toBe(2);
    // 自定义手输×2（图表节的 kroki host 也有一个既有 type="text"，不计入）
    expect(src.match(/type="text"\s*\n\s*value=\{uiFamily\}/g)?.length).toBe(1);
    expect(src.match(/type="text"\s*\n\s*value=\{codeFamily\}/g)?.length).toBe(1);
  });

  it('消费 fonts.ts 装配源：预设清单/选项装配/哨兵/样张均接入', () => {
    expect(src).toContain("from './fonts'");
    expect(src).toContain('UI_FONT_PRESETS');
    expect(src).toContain('CODE_FONT_PRESETS');
    expect(src).toContain('fontFamilyOptions');
    expect(src).toContain('CUSTOM_FONT_SENTINEL');
    expect(src).toContain('FONT_SPECIMEN');
  });

  it('字号 clamp 即时：number input min/max 绑定 settings 的 UI/CODE_SIZE_RANGE，输入经 clamp 落盘', () => {
    expect(src).toContain('UI_SIZE_RANGE');
    expect(src).toContain('CODE_SIZE_RANGE');
    expect(src).toMatch(/min=\{UI_SIZE_RANGE\[0\]\}\s*max=\{UI_SIZE_RANGE\[1\]\}/);
    expect(src).toMatch(/min=\{CODE_SIZE_RANGE\[0\]\}\s*max=\{CODE_SIZE_RANGE\[1\]\}/);
    expect(src).toContain('function onSizeInput');
    expect(src).toMatch(/Math\.min\(range\[1\], Math\.max\(range\[0\]/);
  });

  it('自定义/预设切换：select 值派生（自定义态显哨兵），onFamilyChange 切手输框显隐', () => {
    expect(src.match(/CUSTOM_FONT_SENTINEL : \w+Family/g)?.length).toBe(2);
    expect(src).toContain('function onFamilyChange');
    expect(src).toContain('function onFamilyInput');
  });

  it('保存走面板既有 persist 链：fresh.fonts 四字段写入（saveSettings 即触发 Task 1 注入/Task 2 重渲染）', () => {
    expect(src).toMatch(/fresh\.fonts = \{ uiFamily, uiSize, codeFamily, codeSize \};/);
  });

  it('手输实时预览样张（spec §4）：fontFamilyValue 同源转义 + FONT_SPECIMEN 渲染', () => {
    expect(src.match(/vv-settings-font-sample/g)?.length).toBe(2);
    expect(src).toContain('style:font-family={fontFamilyValue(');
    expect(src).toContain('style:font-size=');
  });
});

describe('接线契约（theme.ts 导出面 / app.css 样式类）', () => {
  it('theme.ts 导出 fontFamilyValue（面板样张预览与注入同源转义，不复制实现）', () => {
    expect(readSrc('src/lib/theme.ts')).toMatch(/export function fontFamilyValue\(/);
  });

  it('app.css：字体节样张样式类存在（消费 --ui-* token 惯例）', () => {
    expect(readSrc('src/app.css')).toContain('.vv-settings-font-sample');
  });
});
