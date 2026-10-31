import { createRegistry, createDispatcher, GENERATED_EXTENSIONS, getRemoteBase, type Dispatcher, type Registry, type FileSource } from '@vviewer/core';
import { codeRenderer, attachHighlightRouter } from '@vviewer/render-text';
// markdown 渲染组合包（@vviewer/markdown）：渲染器与注入缝的实现单源。装配语义
// 与 render-text 转出口时期一致（render-text/markdown/* 现为对组合包的纯转出口）。
import {
  markdownRenderer,
  setMarkdownBackend,
  setMarkdownImageResolver,
  setDiagramOptions,
  setHighlightFence,
  setResolveRemoteBase,
  renderMarkdownBody
} from '@vviewer/markdown';
// 围栏高亮桥（HighlightClient worker 单例 → 围栏 HTML）：实现留在 render-text
// （client attach 于其 code 模块，桥必须与 attach 同包），经组合包 setHighlightFence
// 注入——同一实例只走这一条路径，包内默认主线程高亮器不参与（不双轨化）。
import { fenceToHtml } from '@vviewer/render-text/markdown/markdownRenderer';
import { DEFAULT_KROKI_HOST, resolveDiagramType } from '@vviewer/render-diagram';
import { htmlRenderer } from '@vviewer/render-text/html';
import { imageRenderer } from '@vviewer/render-media';
import { avRenderer } from '@vviewer/render-media/av';
import { pdfRenderer } from '@vviewer/render-doc';
import { docxRenderer } from '@vviewer/render-doc/docx';
import { xlsxRenderer } from '@vviewer/render-doc/xlsx';
import { pptxRenderer } from '@vviewer/render-doc/pptx';
import { hexRenderer } from '@vviewer/render-binary';
import { archiveRenderer } from '@vviewer/render-archive';
import { configureLibarchive } from '@vviewer/render-archive/libarchiveStore';
import { jsonlRenderer } from '@vviewer/render-text/jsonl';
import { browser } from '$app/env';
import { ensureHighlightClient, computeRouter } from './highlightClient';
import { routeLargeFileHighlight } from './highlightRouter';
import { resolveImageBlobUrl } from './markdownImages';
import { hasNonDiagramFence } from './markdownFence';
import { loadSettings } from './stores/settings';
import { loadCapabilities, loadDiagramCapabilities } from './serverCapsCache';
import { effectiveMode, resolveMermaidTheme } from './theme';

// BUG-22 启发式的单测锚（实现抽在 markdownFence.ts——无 $app 依赖的纯模块，
// markdownImages.ts 同款抽出模式；viewer.ts 转出口径一致）
export { hasNonDiagramFence };

/** M1 渲染器注册表：代码/文本、markdown、html 沙箱预览、图片（含消毒后的 SVG）、音视频。
 * M4 追加：PDF（render-doc）、hex/结构树（render-binary）、压缩包 zip/tar/7z/rar
 * （render-archive，libarchive worker 走静态拷贝的 /libarchive/worker-bundle.js）、
 * Office 三件套 docx/xlsx/pptx（render-doc，pptx 为文本提纲降级路径）。 */
export const registry: Registry = createRegistry();
registry.install(codeRenderer);
registry.install(markdownRenderer);
registry.install(htmlRenderer);
registry.install(imageRenderer);
registry.install(avRenderer);
registry.install(pdfRenderer);
registry.install(docxRenderer);
registry.install(xlsxRenderer);
registry.install(pptxRenderer);
registry.install(hexRenderer);
registry.install(archiveRenderer);
// JSON Lines 渲染器（.jsonl/.ndjson）：注册于生成物 fallback 之前——installFallbackExtensions
// 冲突跳过语义保证生成物不会覆盖专有注册（与 hex/archive 等专有渲染器同序原则）
registry.install(jsonlRenderer);

// C 项：手工清单之外的语法类扩展名由生成物补充（专有渲染器已先注册，冲突跳过）。
const fallback = registry.installFallbackExtensions('code', GENERATED_EXTENSIONS);
if (fallback.added.length > 0) {
  console.debug(`[viewer] generated extensions → code: +${fallback.added.length} (skipped ${fallback.skipped.length})`);
}

// libarchive worker 路径：worker bundle + wasm 由 vite 插件拷到 static/libarchive/
// （见 vite.config.ts copyLibarchiveAssets），仅存 URL 字符串，首次解包时才起 worker
if (browser) {
  configureLibarchive({ workerUrl: `${import.meta.env.BASE_URL}libarchive/worker-bundle.js` });
}

export const dispatcher: Dispatcher = createDispatcher(registry);

// M2：应用启动即预热 tree-sitter 高亮 Worker（握手 + 资产就绪早于首个 code tab；
// 失败只告警一次，渲染端对 code.ts 的 attachHighlightClient 保持未注入 → 降级 hljs）
if (browser) {
  ensureHighlightClient()?.catch((e: unknown) => {
    console.warn('[highlight] client 初始化失败，代码高亮降级 hljs', e);
  });
  // BUG-10：>2MB 文件问路由（local/无 path/auto 门在注入侧硬拦为本地——server-served
  // auto 不限大小走服务端，本地来源恒 hljs 分块零 POST；裁决注释见 highlightRouter.ts）
  attachHighlightRouter(routeLargeFileHighlight);
}

// ---------- markdown 渲染组合包接线（@vviewer/markdown，自 render-text 转出口切换） ----------

// 围栏高亮单一路径：app 的 tree-sitter worker client（highlightClient create →
// attachHighlightClient 注入 render-text code 模块）经 fenceToHtml 桥为组合包的
// HighlightFence。SSR/测试环境不渲染 markdown，不注入即保持包内默认值（不触达）。
if (browser) {
  setHighlightFence(fenceToHtml);
}

// 远程计算来源决策注入缝（组合包不依赖 @vviewer/core 的 getRemoteBase）：远程
// store 文件（core 远程注册表有 remote base）向注入后端传 {path, storeId}，本地
// 恒 null——原 markdownRenderer 渲染路径内联判断的等价形态。纯注册表查询无
// 浏览器依赖，不入 browser 门（与渲染期原行为一致：任何环境都可裁决）。
setResolveRemoteBase((source) =>
  getRemoteBase(source.storeId) !== undefined ? { path: source.path, storeId: source.storeId } : null
);

// ---------- markdown 正文引擎接入 compute 路由（M7 Task 2，M6 遗留） ----------

/** 在途远程 markdown 渲染的中止控制器（cancelMarkdownRemote 随 tab 切换一并 abort，对齐 highlight 的 remoteAbort 模式）。 */
let markdownRemoteAbort: AbortController | null = null;

/** tab 切换/重渲染时取消在途远程 markdown 请求（不留无主连接）。 */
export function cancelMarkdownRemote(): void {
  markdownRemoteAbort?.abort();
  markdownRemoteAbort = null;
}

/**
 * 远程 markdown：POST /api/compute/markdown（Bearer），body {text, options}。
 * 未连接服务器抛错——router 的 auto 会回退本地 markdown-it；显式 remote 如实
 * 报错不静默回退（与远程高亮同一语义）。wikilinks 不开启：与本地引擎能力对齐
 * （markdown-it 无 wikilinks，开启会让 auto 回退前后渲染结果不一致）。
 * abort 抛错经 router 折叠：auto 回退本地、remote 走错误卡片（既有路径）。
 */
async function remoteMarkdown(text: string): Promise<string> {
  const call = computeRouter.remoteCall('/api/compute/markdown');
  if (!call) throw new Error('未连接服务器，无法远程渲染 markdown');
  // 挂 tab 级 abort：cancelMarkdownRemote（tab 切换/重渲染）时中止在途请求
  const ac = new AbortController();
  markdownRemoteAbort = ac;
  try {
    const res = await fetch(call.url, {
      method: 'POST',
      headers: { ...call.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text, options: undefined }),
      signal: ac.signal
    });
    if (!res.ok) throw new Error(`远程 markdown 渲染失败: HTTP ${res.status}`);
    const data = (await res.json()) as { html: string };
    return data.html;
  } finally {
    if (markdownRemoteAbort === ac) markdownRemoteAbort = null;
  }
}

/**
 * 注入 markdown 正文后端：renderer 只认注入的 fn，路由裁决与回退全在这里——
 * routeMarkdown 按 policy × compute 能力 × 服务端 path 裁决（auto 失败回退本地
 * markdown-it；remote 失败如实抛错 → ViewerPane 错误卡片），comrak 返回的 HTML
 * 由 renderer 走 sanitize+enrich+pipeline 全管线。
 */
if (browser) {
  setMarkdownBackend(async ({ text, src }) => {
    // BUG-22：auto 下含 fenced code block 的 markdown 留本地——围栏二级高亮仍由
    // 本地 hljs 完成（markdownRenderer fenceToHtml），「远程 comrak 正文 + 本地 hljs
    // 围栏」的组合会让「渲染: 远程」指示与实际语义割裂，且违背偏差 #5 的裁决精神
    // （带注入语言的内容留本地）。spec §2.5 细化（hasNonDiagramFence，纯函数见
    // markdownFence.ts）：仅「非图表语言或无语言」围栏才强制留本地；纯图表/math
    // 围栏文档路由服务端——原生子集（graphviz/svgbob）服务端直出，其余图表语言
    // 客户端管线接管，高亮语义无损（图表围栏本就跳过 hljs/tree-sitter）。行首
    // ≤3 空格的 ```/~~~ 启发式检测（代码块内的假围栏会误判，门控只损失远程机会、
    // 不损正确性）；显式 remote 仍远程。
    const policy = loadSettings().computePolicy;
    const localOnly = policy === 'auto' && hasNonDiagramFence(text);
    const res = await computeRouter.routeMarkdown(
      src,
      text,
      undefined,
      () => Promise.resolve(renderMarkdownBody(text)),
      src && !localOnly ? (t) => remoteMarkdown(t) : undefined
    );
    if (!res.ok) throw new Error(res.error ?? 'markdown 渲染失败');
    return { html: res.data ?? '', where: res.where };
  });
}

// ---------- markdown 相对图片解析（终审 M3：相对图片 404；L4 大小上限） ----------

if (browser) {
  // 相对图片 → 同 store 文件 blob URL：store 读失败（不存在/无权限）抛错由 renderer
  // 捕获后保留原 src（404 现状）；URL 随渲染实例 destroy 释放（renderer 侧 revoke）。
  // 解析逻辑（路径规范 + 大小上限）抽在 markdownImages.ts（无 $app 依赖，可单测）。
  setMarkdownImageResolver(async (src, source) =>
    // 组合包 resolver 形参为 FileSourceLike（结构子集，无 store 字段）；Renderer
    // 路径透传的实参恒为完整 FileSource（含 store），收窄取用。
    resolveImageBlobUrl((source as FileSource).store, source.path, src)
  );
}

// ---------- markdown 图表渲染选项注入（spec 2026-10-19 §2.1/§2.3，Task 6） ----------

if (browser) {
  // getDiagramOptions 每次 render 调用一次 → 闭包直读 loadSettings（routeMarkdown
  // 同款模式），设置变更即时生效且 renderer 不持副本。krokiHost 空串回退注册表
  // 默认主机；mermaid 主题与 vv:appearance-applied 派发值同源（resolveMermaidTheme，
  // theme.ts）；模式三级回退：用户覆盖 → 注册表 defaultMode → 'local'。
  // spec §8.3（Task 5）能力消费同样闭包内现读（连接发生在模块装载后，顶层快照
  // 会把连接前的空集永久钉死）：serverDiagramOf 按 health diagrams 子集（类型 id
  // 归一后比对），krokiProxy 按 capabilities 'kroki-proxy' 恒宣告项；remoteCall
  // 透传 computeRouter 缝（remoteMarkdown 同款 {url, headers} 形态）。
  setDiagramOptions(() => {
    const s = loadSettings();
    const mode = effectiveMode(s.themeMode);
    return {
      krokiHost: s.diagrams.krokiHost || DEFAULT_KROKI_HOST,
      // mermaid 主题（spec §9.2）：'auto' = 跟随外观亮暗（resolveMermaidTheme，外观
      // 切换经 vv:appearance-applied 即时重画）；显式五枚举原样——settings 保存路径
      // 的显式变更经 vv:diagram-settings-applied 即时重画（AppShell 派发）。
      mermaidTheme: s.diagrams.mermaidTheme === 'auto' ? resolveMermaidTheme(mode) : s.diagrams.mermaidTheme,
      krokiVia: s.diagrams.krokiVia,
      serverDiagramOf: (lang) => loadDiagramCapabilities().includes(resolveDiagramType(lang)?.id ?? lang),
      krokiProxy: loadCapabilities().includes('kroki-proxy'),
      remoteCall: (path) => computeRouter.remoteCall(path),
      modeOf: (lang) => s.diagrams.modes[lang] ?? resolveDiagramType(lang)?.defaultMode ?? 'local',
      // 本地渲染器覆盖（spec §9.1）：键归一为注册表 id（别名 dot 同命中 graphviz），
      // 值经 loadSettings 白名单（仅注册表 renderers 选择面）；未配置返回 undefined
      // = 注册表默认渲染器 viz-js。
      rendererOf: (lang) => s.diagrams.renderers[resolveDiagramType(lang)?.id ?? lang]
    };
  });
}

// dev-only HMR 防线（遗留 T14）：本模块是装配单例来源（registry、libarchive worker
// 配置、markdown backend/图片 resolver 注入），Vite 局部热替换会重跑装配——重复
// install 与新旧模块状态并存。decline 使变更冒泡为整页刷新，杜绝半新半旧状态；
// 生产构建 import.meta.hot 恒为 undefined，分支不存在。vite 8 起 SSR module
// runner 也给出 truthy 的 import.meta.hot 但无 accept.decline——加 SSR 收窄；
// 浏览器端 decline 自 accept 属性挪为 hot.decline() 顶级方法（运行时存在，见
// vite/dist/client 的 HMRContext），但 types/hot.d.ts 漏声明——受控断言补缺口。
if (!import.meta.env.SSR && import.meta.hot) {
  (import.meta.hot as unknown as { decline(): void }).decline();
}
