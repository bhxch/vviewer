// format.ts — Intl 格式化 helper（§4.2：全项目唯一 Intl 通道，其余模块禁裸
// Intl/toLocale* ——ESLint 规则 D6 分期，Task 10 激活，本文件是唯一豁免点）。
// locale 跟随当前 i18n locale：'zh-CN' 原样，'en' 取 'en-US'（D15 en 呈现口径）。
// 时区语义：不传 timeZone = 浏览器本地时区——消费面是 git 时间戳（author/
// committer epoch 秒），git 日期是仓库本地日历语义，不涉跨时区换算（§4.2 明示
// 「维持浏览器本地时区展示」）；这与 aelrova 业务时间戳强制 timeZone
// （Asia/Shanghai 常量）的差异缘由在此记档：业务单据时刻需要钉死时区，仓库
// 本地历史不需要。
import { getLocale, type Locale } from './core';

/** locale → Intl tag 映射（'en' 逻辑名 → en-US 区域呈现） */
const INTL_LOCALE_OF: Record<Locale, string> = { 'zh-CN': 'zh-CN', en: 'en-US' };

const DATE_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  ...DATE_OPTS,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
};

// formatter 实例缓存（locale × 两 opt 形态至多 4 个——git log 列表逐行调用，
// Intl.DateTimeFormat 构造是热点面，实例复用零收益损失）
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterOf(kind: 'date' | 'dateTime'): Intl.DateTimeFormat {
  const locale = INTL_LOCALE_OF[getLocale()];
  const cacheKey = `${kind}:${locale}`;
  let f = FORMATTER_CACHE.get(cacheKey);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, kind === 'date' ? DATE_OPTS : DATETIME_OPTS);
    FORMATTER_CACHE.set(cacheKey, f);
  }
  return f;
}

/** 纯日期（gitUi.relativeDate 超月回落面消费；zh-CN 2026/11/11 形态） */
export function formatDate(d: Date): string {
  return formatterOf('date').format(d);
}

/** 日期+时间（gitUi.calendarTime 消费；zh-CN 2026/11/11 08:09:10 形态，24 小时制） */
export function formatDateTime(d: Date): string {
  return formatterOf('dateTime').format(d);
}
