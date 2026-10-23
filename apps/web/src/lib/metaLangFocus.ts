// metaLangFocus.ts — 语言轻入口跳转通道（renderer-lang-override spec §4.2，Task 6）。
// 状态栏浮层与 Tab 右键菜单的「语言」项共用唯一派发函数与事件名：AppShell 侧监听
// 后展开右栏（移动端先开抽屉）并聚焦 MetaPanel 语言行。事件总线通道（document
// CustomEvent）是 C 项约束同款——两入口与 MetaPanel 无组件父子链，不经 props。
// 单机制不变量：事件名字符串唯一在本文件，入口侧只 import 函数，不复制通道细节。

/** 语言轻入口跳转事件名（AppShell 侧 document 监听） */
export const VV_FOCUS_META_LANG = 'vv:focus-meta-lang';

/** 请求聚焦属性面板语言行（入口侧唯一动作：派发即返回，展开/聚焦由 AppShell 裁决） */
export function requestMetaLangFocus(): void {
  document.dispatchEvent(new CustomEvent(VV_FOCUS_META_LANG));
}
