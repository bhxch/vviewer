// gitUi.ts — Git 段 UI 共用小工具（git 信息面板 Task 3）：GitSection（信息卡 +
// diff 折叠区 + log 列表）与 ViewerPane（blame hover 浮层）双消费，抽此处避免
// 双写漂移。日历日期经 i18n/format（Intl 唯一通道，§4.2——裸 Intl/toLocale* 禁令
// 的存量迁移点；locale 跟随设置语言，时区维持浏览器本地）。
import { formatDate, formatDateTime } from '../i18n/format';

/**
 * store 相对路径 → isogit 树内路径（仓库相对）：GitSection.svelte:103 的既定口径
 * 提升为单源（T2 报告 Interfaces 节「T3 消费面同口径」落位）——isogit filepath
 * （log/blobAt/blame）= HEAD 树内寻址不经 fs 适配层，GitFsAdapter 的 repoDir 前缀
 * 映射管不到，必须由调用方剥前缀；前缀不匹配时原样返回（防御，不猜）。
 */
export function repoRelPath(repoDir: string, filePath: string): string {
  return repoDir === ''
    ? filePath
    : filePath.startsWith(`${repoDir}/`)
      ? filePath.slice(repoDir.length + 1)
      : filePath;
}

/** 相对日期（spec §3.1「短 hash/作者/相对日期/subject」；超月回落日历日期
 * ——formatDate，locale 随当前界面语言）。 */
export function relativeDate(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return formatDate(new Date(ts * 1000));
}

/** commit message → subject（首行；空 message 回落占位）。 */
export function subjectOf(message: string): string {
  const first = message.split('\n', 1)[0]!.trim();
  return first === '' ? '（无说明）' : first;
}

/** 提交详情的日历时间戳（log 展开消费：author/committer 各一行）——formatDateTime，
 * locale 随当前界面语言。 */
export function calendarTime(ts: number): string {
  return formatDateTime(new Date(ts * 1000));
}
