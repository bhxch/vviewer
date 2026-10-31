// worker.js — tree-sitter 围栏高亮 Worker 入口（两行）：引擎与消息协议全部来自
// @vviewer/highlight（init 握手由主线程 HighlightClient 发起，引擎配置随握手透传；
// serveWorker 自带「非 worker 环境调用为 no-op」守卫）。本文件是给宿主打包器编译
// 的 worker 源（vite `?worker` / new Worker(new URL(...), { type: 'module' })），
// 以同一字面形态存在于 src/ 与发布包 dist/src/、dist/ 三处（pack copies 双写，
// 见 tools/pack-packages.mjs 本包条目注记）。
import { serveWorker } from '@vviewer/highlight';

serveWorker();
