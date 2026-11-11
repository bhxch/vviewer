// format.test.ts — Intl 唯一通道单测（§4.2）：locale 跟随（zh-CN 原样 / en →
// en-US）与月日时分秒形态锚。日期值断言用正则形态而非字面值——本地时区无关
// （format.ts 不传 timeZone，git 时间戳仓库本地语义，CI 时区不定）。
import { afterEach, describe, expect, it } from 'vitest';
import { setLocaleInternal } from './core';
import { formatDate, formatDateTime } from './format';

afterEach(() => setLocaleInternal('zh-CN'));

describe('i18n format（Intl 唯一通道）', () => {
  const d = new Date(2026, 10, 11, 8, 9, 10); // 本地时区构造，格式断言只看形态

  it('zh-CN：2026/11/11 与 2026/11/11 08:09:10 形态（24 小时制）', () => {
    expect(formatDate(d)).toBe('2026/11/11');
    expect(formatDateTime(d)).toBe('2026/11/11 08:09:10');
  });

  it('en：locale 跟随切 en-US（mm/dd/yyyy 形态）', () => {
    setLocaleInternal('en');
    expect(formatDate(d)).toBe('11/11/2026');
    expect(formatDateTime(d)).toMatch(/^11\/11\/2026,? 08:09:10/);
  });

  it('formatter 缓存随 locale 复用（往返切换结果稳定）', () => {
    expect(formatDate(d)).toBe('2026/11/11');
    setLocaleInternal('en');
    expect(formatDate(d)).toBe('11/11/2026');
    setLocaleInternal('zh-CN');
    expect(formatDate(d)).toBe('2026/11/11');
  });
});
