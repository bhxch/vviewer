// gitIso.ts — isomorphic-git 懒加载边界（worker 专用模块，主线程零 import）：
// isogit 浏览器构建引用裸 `Buffer.from/concat/isBuffer`（松散对象/包 delta 解码路径，
// 对 1.44.8 产物实测核对），浏览器无 Buffer 全局——本模块在动态 import isogit 之前
// 以 npm buffer 包注入 globalThis.Buffer（仅 worker 作用域，主线程零污染）。经
// gitWorker.ts 的 `import('./gitIso')` 单点引入：buffer + isogit 同图落 git-engine
// chunk（vite.config.ts codeSplitting groups），worker 入口 chunk 保持极小且可 precache。
import { Buffer } from 'buffer';

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

export * from 'isomorphic-git';
