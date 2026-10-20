// fontsPanel.test.ts — 字体管理 UI（设置中心「字体」节下半，字体系统 Task 5）。
// 根 vitest 无 svelte 插件，设置中心组件/AppShell 无法挂载——节组件沿用「源码
// 契约断言」先例（fonts.test.ts / exportPanel.test.ts 同形态）锁定结构与接线
// （2026-10-19 设置中心计划 Task 1 起，SettingsPanel 字体节迁移至
// lib/settings/FontsSection.svelte）；运行时行为由字体系统 Task 6 的 e2e
// （b-fonts.spec）兜底。数据流集成以 fake-indexeddb + mock FontFace/document.fonts
// 桩（fontsStore.test.ts 同款）直走 store API × fonts.ts 纯装配，锁定面板消费的
// 组合语义（列表渲染源/启停出列/删除回落信号）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { CODE_FONT_PRESETS, CUSTOM_FONT_SENTINEL, fontFamilyOptions, mergedFamilyOptions } from './fonts';
import { addFontFromFile, deleteFont, listFontRecords, setEnabledFont } from './stores/fontsStore';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('FontsSection 网络字体管理区源码契约（字体节下半）', () => {
  const src = readSrc('src/lib/settings/FontsSection.svelte');

  it('消费 fontsStore 全管线：列表/URL 添加/上传/启停/删除 + 名称推导同源', () => {
    expect(src).toContain("from '../stores/fontsStore'");
    for (const fn of ['listFontRecords', 'addFontFromUrl', 'addFontFromFile', 'setEnabledFont', 'deleteFont', 'stemOf']) {
      expect(src).toContain(fn);
    }
  });

  it('URL 添加表单：地址输入 + 名称（可选）输入，提交走 addFontFromUrl', () => {
    expect(src).toContain('aria-label="网络字体地址"');
    expect(src).toContain('aria-label="网络字体名称（可选）"');
    expect(src).toMatch(/function onFontUrlSubmit/);
    expect(src).toMatch(/addFontFromUrl\(url, explicit \|\| undefined\)/);
  });

  it('上传入口：input accept 白名单 .ttf/.otf/.woff/.woff2，change 走 addFontFromFile', () => {
    expect(src).toContain('accept=".ttf,.otf,.woff,.woff2"');
    expect(src).toMatch(/function onFontFileChange/);
    expect(src).toMatch(/addFontFromFile\(file\)/);
  });

  it('列表行：启停开关/体积/删除齐备且 aria-label 按名可寻址', () => {
    expect(src).toContain('aria-label="启用网络字体 {rec.name}"');
    expect(src).toContain('aria-label="删除网络字体 {rec.name}"');
    expect(src).toContain('formatFontSize(rec.size)');
    expect(src).toContain('class="vv-settings-fonts"');
    expect(src).toContain('暂无网络字体');
  });

  it('样张以该字体渲染：fontFamilyValue(rec.name, 默认栈) 同源转义内联 + FONT_SPECIMEN', () => {
    expect(src).toContain('style:font-family={fontFamilyValue(rec.name, DEFAULT_UI_FONT_STACK)}');
  });

  it('错误态重试（spec §6）：失败暂存（url 键去重）+ 重试/忽略钮', () => {
    expect(src).toContain('fontFailures');
    expect(src).toMatch(/fontFailures = fontFailures\.filter\(\(f\) => f\.url !== url\)/);
    expect(src).toMatch(/function retryFont/);
    expect(src).toMatch(/function dismissFontFailure/);
    expect(src).toContain('aria-label="重试添加网络字体 {f.name}"');
    expect(src).toContain('aria-label="忽略网络字体 {f.name}"');
  });

  it('删除被引用字体：比对 deleteFont 返回记录的 name，槽位回落默认并提示（draft+touch 链）', () => {
    expect(src).toMatch(/gone = await deleteFont\(rec\.id\)/);
    expect(src).toMatch(/draft\.fonts\.uiFamily === gone\.name/);
    expect(src).toMatch(/draft\.fonts\.codeFamily === gone\.name/);
    expect(src).toMatch(/draft\.fonts\.\w+ = ''/);
    expect(src).toContain('回落默认');
  });

  it('两槽下拉合并源：uiOptions/codeOptions 派生自 mergedFamilyOptions × enabledFontNames（仅启用项）', () => {
    expect(src).toContain('mergedFamilyOptions');
    expect(src).toMatch(/mergedFamilyOptions\(fontFamilyOptions\(UI_FONT_PRESETS\), enabledFontNames\)/);
    expect(src).toMatch(/mergedFamilyOptions\(fontFamilyOptions\(CODE_FONT_PRESETS\), enabledFontNames\)/);
    expect(src).toMatch(/filter\(\(r\) => r\.enabled\)/);
  });

  it('网络字体名不是自定义态：isCustomFamily 认网络名，列表载入后纠偏手输模式', () => {
    expect(src).toMatch(/function isCustomFamily\([^)]*networkNames/);
    expect(src).toMatch(/networkNames\.has\(draft\.fonts\.uiFamily\)/);
    expect(src).toMatch(/networkNames\.has\(draft\.fonts\.codeFamily\)/);
  });
});

describe('台账顺手修（字体节遗留，随节迁移）', () => {
  const src = readSrc('src/lib/settings/FontsSection.svelte');

  it('Low-1：字号 clamp 后同步输入框显示（clamped===现值时 Svelte 不重渲 value）', () => {
    expect(src).toMatch(/inp\.value = String\(clamped\)/);
  });

  it('Low-2：手输清空（空串=默认栈语义）退出自定义态回预设视图，select 不停留「自定义…」', () => {
    expect(src).toMatch(/if \(v === ''\) uiCustomMode = false/);
    expect(src).toMatch(/if \(v === ''\) codeCustomMode = false/);
  });
});

describe('AppShell 启动恢复契约（loadEnabledFontFaces）', () => {
  it('onMount 启动期调用且不阻断启动（void + catch 告警）', () => {
    const src = readSrc('src/lib/AppShell.svelte');
    expect(src).toContain("import { loadEnabledFontFaces } from './stores/fontsStore'");
    expect(src).toMatch(/void loadEnabledFontFaces\(\)\.catch\(/);
  });
});

// ---- 数据流集成桩（fontsStore.test.ts 同款） ----
let failLoads = false;

class FakeFontFace {
  loaded = false;
  constructor(
    public family: string,
    public source: ArrayBuffer
  ) {}
  load(): Promise<FakeFontFace> {
    if (failLoads) return Promise.reject(new Error('OpenType parsing failed'));
    this.loaded = true;
    return Promise.resolve(this);
  }
}

beforeEach(() => {
  failLoads = false;
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    value: { add: () => {}, delete: () => {} },
    configurable: true
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('面板数据流集成（store × 装配：fake-indexeddb）', () => {
  it('添加→列表（入库序）→启用项进下拉选项→停用出列→删除返回回落信号', async () => {
    const a = await addFontFromFile(new File([new Uint8Array([1])], 'Alpha.ttf'));
    const b = await addFontFromFile(new File([new Uint8Array([2])], 'Beta.ttf'));
    let records = await listFontRecords();
    expect(records.map((r) => r.name)).toEqual(['Alpha', 'Beta']);

    // 面板选项装配口径：仅 enabled 项进选项，插在预设组与哨兵之间
    const options = (): string[] =>
      mergedFamilyOptions(
        fontFamilyOptions(CODE_FONT_PRESETS),
        records.filter((r) => r.enabled).map((r) => r.name)
      ).map((o) => o.value);
    expect(options()).toContain('Alpha');
    expect(options()).toContain('Beta');
    expect(options().at(-1)).toBe(CUSTOM_FONT_SENTINEL);

    // 停用 Alpha → 下拉出列；槽位引用不受影响（浏览器回退显示）
    await setEnabledFont(a.id, false);
    records = await listFontRecords();
    expect(options()).not.toContain('Alpha');
    expect(options()).toContain('Beta');

    // 删除被引用字体 → deleteFont 返回记录（面板比对槽位后回落 ''）
    const gone = await deleteFont(b.id);
    expect(gone?.name).toBe('Beta');
    const slot: string = 'Beta'; // 模拟 fresh.fonts.codeFamily
    expect(gone !== null && slot === gone.name).toBe(true); // 面板回落条件命中
  });

  it('与预设值撞车的字体名不重复进下拉（装配层跳过）', async () => {
    await addFontFromFile(new File([new Uint8Array([1])], 'Consolas.ttf'));
    const records = await listFontRecords();
    const values = mergedFamilyOptions(
      fontFamilyOptions(CODE_FONT_PRESETS),
      records.filter((r) => r.enabled).map((r) => r.name)
    ).map((o) => o.value);
    expect(values.filter((v) => v === 'Consolas')).toHaveLength(1);
  });
});
