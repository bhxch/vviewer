// catalogs/en/notice.ts — notice 域 en 目录（D15：全量覆盖，插值占位符与 zh 一致，
// 聚合机检锁键集/占位符逐 key 相等）。词汇表（Global Constraints）：打开 Open/
// 文件夹 Folder/标签页 Tab/关闭 Close。
export const domain = 'notice' as const;

export const messages = {
  // —— 打开通道状态提示（notice.openflow.*：openFlow.svelte.ts）——
  'notice.openflow.pickCanceled': 'Folder selection canceled',
  'notice.openflow.noSavedGrant': 'No saved folder grant',
  'notice.openflow.grantExpired': 'Folder grant has expired, please select again',
  'notice.openflow.emptyFolder': 'The selected folder is empty',
  'notice.openflow.tabsClosed': 'Closed {n} tabs (mount released)',
  'notice.openflow.urlIsDirectory': 'URL ends with /: it points to a directory, not a file — not opened'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
