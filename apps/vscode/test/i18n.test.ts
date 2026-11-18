// i18n.test.ts — 扩展 i18n 目录契约（spec H T2）。
//
// 覆盖面（计划 T2 Step 1 明列）：zh == en 键集、占位符集合相等、locale 选择。
// 纪律同 apps/web 的聚合机检（catalogs.aggregate.test.ts 四断言的扩展侧同款）：
// ①键集相等 ②key 三段（域.模块.语义）③占位符集合相等 ④域首段在扩展自有域集内。
import { describe, expect, it } from 'vitest';
import { CATALOGS, getLocale, pickLocale, setLocale, t, translate } from '../src/i18n/core';
import { en } from '../src/i18n/catalogs/en';
import { zhCN } from '../src/i18n/catalogs/zh-CN';

/** 扩展自有域集（不复用 apps/web 的 12 域全集） */
const EXTENSION_DOMAINS = ['shell', 'viewer', 'notice', 'errors'];

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

describe('i18n · 目录一致性', () => {
  it('zh 与 en 键集完全相等', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it('key 三段且首段在扩展自有域集内', () => {
    for (const key of Object.keys(zhCN)) {
      const parts = key.split('.');
      expect(parts, `key ${key} 非三段`).toHaveLength(3);
      expect(EXTENSION_DOMAINS, `key ${key} 首段越域`).toContain(parts[0]);
    }
  });

  it('逐 key 占位符集合相等', () => {
    for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
      expect(placeholders(en[key]), `key ${key} 占位符集合不等`).toEqual(placeholders(zhCN[key]));
    }
  });

  it('双目录经门面暴露且键集一致', () => {
    expect(Object.keys(CATALOGS['zh-CN']).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    expect(CATALOGS['zh-CN']).toBe(zhCN);
    expect(CATALOGS.en).toBe(en);
  });
});

describe('i18n · locale 选择', () => {
  it('zh* → zh-CN；其余 → en', () => {
    expect(pickLocale('zh')).toBe('zh-CN');
    expect(pickLocale('zh-CN')).toBe('zh-CN');
    expect(pickLocale('zh-TW')).toBe('zh-CN');
    expect(pickLocale('ZH-cn')).toBe('zh-CN');
    expect(pickLocale('en')).toBe('en');
    expect(pickLocale('en-US')).toBe('en');
    expect(pickLocale('de')).toBe('en');
    expect(pickLocale(undefined)).toBe('en');
    expect(pickLocale(null)).toBe('en');
  });

  it('当前 locale 可切换（setLocale/getLocale）', () => {
    const before = getLocale();
    setLocale('zh-CN');
    expect(getLocale()).toBe('zh-CN');
    setLocale('en');
    expect(getLocale()).toBe('en');
    setLocale(before);
  });
});

describe('i18n · 取值', () => {
  it('按 locale 取值', () => {
    expect(translate('errors.render.failed', undefined, 'zh-CN')).toBe('渲染失败');
    expect(translate('errors.render.failed', undefined, 'en')).toBe('Rendering failed');
  });

  it('占位符替换；未提供的占位符保留原样（漏参可发现）', () => {
    expect(translate('viewer.document.tooLarge', { limit: '200MB' }, 'zh-CN')).toContain('200MB');
    expect(translate('viewer.document.tooLarge', undefined, 'zh-CN')).toContain('{limit}');
    expect(translate('notice.export.saved', { path: '/tmp/a.html' }, 'en')).toBe('Exported to /tmp/a.html');
  });

  it('t() 走当前 locale', () => {
    setLocale('zh-CN');
    expect(t('errors.common.unknown')).toBe('发生未知错误');
    setLocale('en');
    expect(t('errors.common.unknown')).toBe('An unknown error occurred');
  });
});
