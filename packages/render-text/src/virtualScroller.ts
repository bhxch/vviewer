// virtualScroller 已上移 @vviewer/core（BUG-16，与 render-binary hex 行虚拟滚动
// 共用同一实现）；本文件保留 re-export shim，code.ts 的相对 import 与包 exports
// 均不变。注意必须经包根导入——vite 对无 exports 字段的包会把 main 当目录前缀
// 解析，深导入 @vviewer/core/src/* 会直接构建失败。
export { virtualScroller, type VirtualScrollerHandle } from '@vviewer/core';
