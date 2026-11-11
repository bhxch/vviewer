// core.test.ts — i18n 纯层单测（D4 双模块裁决：全部单测落 core.ts——根 vitest 无
// svelte 插件，纯 .ts 不得 import runes，index.svelte.ts 胶水以源码契约锚文本断言
// 承接）。覆盖简报 Step 1 清单：未知 key 抛错 / en 缺键回落 zh / interpolate 漏参
// 保留 / 严格签名（@ts-expect-error 无占位符传参）/ 占位符名推导。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLocale,
  interpolate,
  LOCALES,
  lookupMessage,
  onChange,
  setLocaleInternal,
  translate,
  type Locale
} from './core';
import { messages as zhMessages } from './catalogs/zh-CN';
import { messages as enMessages } from './catalogs/en';

// 用例间 locale 归位（模块级纯变量，泄漏会污染后续用例的 zh 断言）
afterEach(() => setLocaleInternal('zh-CN'));

describe('i18n core（纯 TS 层）', () => {
  it('LOCALES 常量：zh-CN / en（D3：不设 auto，默认 zh-CN）', () => {
    expect(LOCALES).toEqual(['zh-CN', 'en']);
    expect(getLocale()).toBe('zh-CN');
  });

  it('未知 key 抛错（aelrova「未知文案 key」同款，错误信息带 key；类型层由 @ts-expect-error 承接）', () => {
    // @ts-expect-error 故意传入不存在的 key 验证运行时抛错
    expect(() => translate('settings.no.such.key')).toThrow(/未知文案 key（settings\.no\.such\.key）/);
  });

  it('zh 查表 + 占位符插值：translate 取目录值并替换 {占位符}', () => {
    expect(translate('settings.language.label')).toBe(zhMessages['settings.language.label']);
    expect(translate('a11y.boundary.detail', { message: 'boom' })).toBe('渲染期发生未捕获异常：boom');
  });

  it('setLocaleInternal 切 en 后 translate 取 en 值；getLocale 同步', () => {
    setLocaleInternal('en');
    expect(getLocale()).toBe('en');
    expect(translate('settings.language.label')).toBe(enMessages['settings.language.label']);
  });

  it('en 缺键回落 zh（D15 安全网；机制经 lookupMessage 注入目录直测——交付态 en 键集==zh 键集，translate 层缺键场景不可构造）', () => {
    const zhOnly: Record<Locale, Record<string, string>> = {
      'zh-CN': { 'settings.language.label': '界面语言' },
      en: {} // en 侧缺键
    };
    expect(lookupMessage('en', 'settings.language.label', zhOnly)).toBe('界面语言');
    // zh 侧命中优先级：locale 命中值优先于回落值
    const both: Record<Locale, Record<string, string>> = {
      'zh-CN': { k: '中文' },
      en: { k: 'English' }
    };
    expect(lookupMessage('en', 'k', both)).toBe('English');
    expect(lookupMessage('zh-CN', 'k', both)).toBe('中文');
    // 两侧皆缺 → undefined（translate 据此抛错）
    expect(lookupMessage('en', 'no.such', { 'zh-CN': {}, en: {} })).toBeUndefined();
  });

  it('interpolate：未提供的占位符保留原样（漏参可发现），无占位符模板零影响', () => {
    expect(interpolate('{greeting}，{name}', { greeting: '哈喽' })).toBe('哈喽，{name}');
    expect(interpolate('无占位符', { x: 1 })).toBe('无占位符');
    expect(interpolate('{n}', { n: 0 })).toBe('0'); // 数字参数 String 化
  });

  it('严格签名（类型层，@ts-expect-error 由 pnpm typecheck 复核）：无占位符文案禁止传参', () => {
    // @ts-expect-error 无占位符 key 传参 → args 须为空元组，编译期拒绝
    expect(translate('settings.language.label', { x: 1 })).toBe(zhMessages['settings.language.label']);
  });

  it('占位符名推导（类型层）：参数名必须与文案串 {message} 严格对齐，错名/漏名编译期拒绝', () => {
    // @ts-expect-error 占位符名为 message，传错名 msg 不满足编译期签名
    expect(translate('a11y.boundary.detail', { msg: 'x' })).toContain('{message}');
    // @ts-expect-error 有占位符文案必须传参对象（空元组不满足）
    expect(translate('a11y.boundary.detail')).toContain('{message}');
  });

  it('onChange 发布订阅：setLocaleInternal 触发回调、退订后不再触发', () => {
    const cb = vi.fn();
    const off = onChange(cb);
    setLocaleInternal('en');
    expect(cb).toHaveBeenCalledWith('en');
    off();
    setLocaleInternal('zh-CN');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
