// tree-sitter 高亮 Worker 入口：side-effect 导入 serveWorker（包内检测 Worker 环境自启动），
// 经 Vite `new Worker(new URL(...))` 打包为独立 ES module chunk，web-tree-sitter 一并打包进 Worker。
import '@vviewer/highlight/src/worker';
