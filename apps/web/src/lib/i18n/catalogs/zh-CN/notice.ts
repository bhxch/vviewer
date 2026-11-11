// catalogs/zh-CN/notice.ts — notice 域目录（Task 10 域 G：散量状态条一次性提示
// 收尾——openFlow.svelte.ts 打开通道的 showStatusNotice 消息构造点，简报移交项 1）。
// zh 值与被移除字面量逐字节等价（D7）。域目录契约（Interfaces 钉死）：key 三段
// `{域}.{模块}.{语义}`，satisfies 锁首段。
export const domain = 'notice' as const;

export const messages = {
  // —— 打开通道状态提示（notice.openflow.*：openFlow.svelte.ts）——
  'notice.openflow.pickCanceled': '已取消选择文件夹',
  'notice.openflow.noSavedGrant': '没有已保存的文件夹授权',
  'notice.openflow.grantExpired': '文件夹授权已失效，请重新选择',
  'notice.openflow.emptyFolder': '所选文件夹为空',
  'notice.openflow.tabsClosed': '已关闭 {n} 个标签页（挂载已释放）',
  'notice.openflow.urlIsDirectory': 'URL 以 / 结尾：指向目录而非文件，未打开'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
