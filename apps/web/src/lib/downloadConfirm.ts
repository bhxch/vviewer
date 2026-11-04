// downloadConfirm.ts — 远端下载确认门决策纯函数（计划 2 Task 6，spec §6.4）。
// 无 runes 纯 .ts 模块（vitest 直测）：shouldConfirm 为「total > 阈值先确认后下载」
// 的单源决策（四边界锚：null false / ≤阈值 false / >阈值 true / 阈值 1 字节时
// 1MB true）；mbToBytes 为 settings「远端下载确认阈值」（MB 计）与源 size（字节）
// 的换算单源——阈值以字节比较，MB 值未换算即被四号锚抓住。消费方 ViewerPane
// 渲染 effect：泵启动前过门，超阈值远端来源显示确认卡（DownloadConfirmCard）。
// size 未知（null）不适用确认门（无前置数字，直接不定态下载——spec 裁决）。

/** MB → 字节（settings MB 字段与源 size 字节值的换算单源） */
export function mbToBytes(mb: number): number {
  return mb * 1024 * 1024;
}

/**
 * 确认门决策（spec §6.4：total > 阈值时先确认后下载，知情自担无独立硬上限）：
 * - size null（store 无法预知）：false——不定态下载不经确认门；
 * - size ≤ thresholdBytes：false（等界不确认，严比较）；
 * - size > thresholdBytes：true——泵启动前显示确认卡。
 */
export function shouldConfirm(size: number | null, thresholdBytes: number): boolean {
  if (size === null) return false;
  return size > thresholdBytes;
}
