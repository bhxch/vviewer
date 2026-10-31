<!-- npm 发布名：@bhxch/vviewer-markdown-highlight-worker（发布名统一 @bhxch/vviewer- 前缀，规则单点在 tools/pack-packages.mjs；monorepo 内部名保持 @vviewer/） -->
# @vviewer/markdown-highlight-worker

`@vviewer/markdown` 的零配置 worker 高亮装配包：把「tree-sitter 围栏高亮」从
主线程挪进 Web Worker——worker 入口、协议端（init 握手/看门狗/同语言请求去重/
批量取消）与区间→行 HTML 装配全部现成，宿主只写一行接入。worker 失败链与包内
默认高亮器一致：该块降级 hljs → 原文；取消（tab 切换）静默跳过。

## 快速上手

```ts
import { attachMarkdownHighlightWorker } from '@vviewer/markdown-highlight-worker';

const handle = attachMarkdownHighlightWorker({
  init: {
    // 必须以 /grammars/ 结尾（manifest 与 wasm 同目录的发布布局契约）；离线形态
    // 改传 grammars/queries 直传（WorkerInit 全参数见 @vviewer/highlight）
    grammarsBase: 'https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@0.1.0/grammars/',
    runtimeDir: 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25/',
  },
});

// 之后 @vviewer/markdown 的所有 markdown 视图代码块高亮自动走本 worker；
// 不想用了：
handle.dispose(); // 解绑注入缝（回落包内默认主线程高亮器）并终止 worker
```

## API

- `attachMarkdownHighlightWorker(options?)` → handle：自建 worker + 构造 fence +
  注入 `setHighlightFence` 模块缝（对 `@vviewer/markdown` 全部视图生效）。
- `createMarkdownHighlightFence(worker, options?)` → handle：已有 Worker 实例时
  用（自管 `?worker` 构造、进程池等形态）；只返回 `{ fence, client, dispose }`，
  不触碰注入缝。
- `intervalsToLineHtml(code, intervals)`：区间→行 HTML 纯函数（自管 client 的
  进阶宿主复用；类名 `ts-<capture>` 与 markdown.css 的 `.ts-*` 映射段同源）。
- handle：`{ fence, client, dispose }`；`fence` 亦可经
  `createMarkdownView(el, { highlightFence: handle.fence })` 注入单视图。

options：`init`（WorkerInit 透传 HighlightClient：grammarsBase/grammars、
queriesBase/queries、runtimeDir、debug 探针）、`makeWorker`（worker 构造覆盖）、
`onWorkerError`（错误上报，如状态栏一次性提示）。

## worker 文件的三种消费形态

worker 必须是独立 JS 文件，本包以源码形态提供（`src/worker.js`，两行
`serveWorker()`），发布包内同文件存在于包根与 `./src/` 两处：

1. **Vite（推荐）**：`attachMarkdownHighlightWorker()` 直接用——包内缺省构造
   `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`，
   Vite 会识别该模式并以 worker 形态编译依赖内文件。
2. **自管构造**：`createMarkdownHighlightFence(new MyWorker(), …)`，worker 由
   宿主打包器语法自建，如 Vite 的
   `import MdWorker from '@vviewer/markdown-highlight-worker/worker.js?worker'`。
3. **webpack/其它**：标准 `new Worker(new URL(…, import.meta.url), { type: 'module' })`
   指向本包 `worker.js`（经 makeWorker 覆盖传入）。

## 边界与注意

- **CSP**：站点需放行 `worker-src`（含 blob: 时对应 blob 包装形态）。
- **CDN 直引本包**（无打包器）：worker URL 与页面跨域被浏览器禁止——需
  fetch→Blob→`createObjectURL` 包装，或自托管本包文件。无打包器场景建议退回
  `@vviewer/markdown` 包内默认主线程高亮器（不 attach 即是）。
- **取消语义**：`HighlightCanceledError` 重抛给管线（静默跳过该块、不 hljs
  兜底）；同语言并发请求由 client 去重（取消前一个未完成者）。
- 本包不含 wasm 资产；grammar/查询/runtime 来源由 `init` 决定（默认 jsdelivr
  CDN 的 `@bhxch/vviewer-grammars-full`）。
