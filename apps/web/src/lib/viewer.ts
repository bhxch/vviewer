import { createRegistry, createDispatcher, GENERATED_EXTENSIONS, getRemoteBase, type Dispatcher, type Registry, type FileSource } from '@bhxch/vviewer-core';
import { codeRenderer, attachHighlightRouter } from '@bhxch/vviewer-render-text';
import { createDiagramFileRenderers } from '@bhxch/vviewer-render-text/diagramFile';
import { createForeignFileRenderers, NESTED_ATTACHMENT_STORE } from './foreignRenderers';
// markdown 渲染组合包（@bhxch/vviewer-markdown）：渲染器与注入缝的实现单源。装配语义
// 与 render-text 转出口时期一致（render-text/markdown/* 现为对组合包的纯转出口）。
import {
  markdownRenderer,
  setMarkdownBackend,
  setMarkdownImageResolver,
  setDiagramOptions,
  setHighlightFence,
  setResolveRemoteBase,
  renderMarkdownBody
} from '@bhxch/vviewer-markdown';
// 围栏高亮桥（HighlightClient worker 单例 → 围栏 HTML）：实现留在 render-text
// （client attach 于其 code 模块，桥必须与 attach 同包），经组合包 setHighlightFence
// 注入——同一实例只走这一条路径，包内默认主线程高亮器不参与（不双轨化）。
import { fenceToHtml } from '@bhxch/vviewer-render-text/markdown/markdownRenderer';
import { DEFAULT_KROKI_HOST, resolveDiagramType } from '@bhxch/vviewer-render-diagram';
import { htmlRenderer } from '@bhxch/vviewer-render-text/html';
import { imageRenderer } from '@bhxch/vviewer-render-media';
import { avRenderer } from '@bhxch/vviewer-render-media/av';
import { pdfRenderer } from '@bhxch/vviewer-render-doc';
import { docxRenderer } from '@bhxch/vviewer-render-doc/docx';
import { xlsxRenderer } from '@bhxch/vviewer-render-doc/xlsx';
import { pptxRenderer } from '@bhxch/vviewer-render-doc/pptx';
import { hexRenderer } from '@bhxch/vviewer-render-binary';
import { archiveRenderer } from '@bhxch/vviewer-render-archive';
import { configureLibarchive } from '@bhxch/vviewer-render-archive/libarchiveStore';
import { jsonlRenderer } from '@bhxch/vviewer-render-text/jsonl';
import { downloadNestedAttachment, markForeignNestedDepth, FOREIGN_NESTED_DEPTH_LIMIT, type NestedDispatch } from '@bhxch/vviewer-render-foreign';
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
 * Office 三件套 docx/xlsx/pptx（render-doc，pptx 为文本提纲降级路径）。
 * Task 5 追加（spec 2026-11-04-file-viewer-integration §5.1）：图表文件 29 型
 * （id diagram-<type>），必须先于 codeRenderer 安装（generated 补空位铁律，见下）。
 * 计划 3 Task 2 追加（spec §6.3）：file-viewer 桥接第一波 10 组 41 扩展名 + 计划 4
 * Task 2 第二波 10 组 75 扩展名（jxl 不绑定，wasm 自 hex 转移；id foreign-<group>），
 * 同铁律下居 codeRenderer 之前（diagram 块之后）。 */
export const registry: Registry = createRegistry();

/** 图表文件 server 分支的远端调用通道（DiagramFileRenderOpts.remoteCall 执行缝）：
 * md 管线同源的 computeRouter 描述缝（{url, headers}，与 setDiagramOptions 注入点
 * 同一封装）在此代 fetch——传输面与 remoteMarkdown 同款（鉴权头 + JSON body +
 * 非 2xx 抛错 + JSON 解析）；未连接服务器 reject（server 模式由渲染端按
 * server→local→kroki 链降级）。 */
function diagramFileRemoteCall(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const call = computeRouter.remoteCall(path);
  if (!call) return Promise.reject(new Error('未连接服务器，无法服务端渲染图表'));
  return (async () => {
    const res = await fetch(call.url, {
      method: init?.method ?? 'POST',
      headers: { ...call.headers, 'content-type': 'application/json' },
      body: JSON.stringify(init?.body)
    });
    if (!res.ok) throw new Error(`服务端图表渲染失败: HTTP ${res.status}`);
    return res.json();
  })();
}

// 图表文件渲染器（29 型按映射序逐个 install）置顶安装：installFallbackExtensions 按
// 「专有先注册、generated 补空位」跳过已认领扩展名，顺序颠倒则 code 的 generated 补
// 空位先行认领 dot/mermaid/mmd/bpmn/dbml 等（均在 GENERATED_EXTENSIONS 内；gv/d2
// 不在其列，不依赖此序），diagram install 抛 RegistryError（装配序锚：render-text
// test/diagramFile.test.ts「装配序锚」组）。
for (const r of createDiagramFileRenderers({ remoteCall: diagramFileRemoteCall })) registry.install(r);

// ---------- file-viewer 桥接渲染器（spec §6.3：计划 3 Task 2 第一波 10 组 41 扩展名 + 计划 4 Task 2 第二波 10 组 75 扩展名） ----------

/** 嵌套附件分派（spec §6.4 数据画像 B 组：email 嵌套附件 → vviewer dispatcher
 * byExtension 承接，pdf/image/docx 等本地强项；深度限 3 由桥接层 renderNested 以
 * 显式 depth 形参强制——T2 评审 M1 精化：本实现收到 depth 后先登记到 target
 * （markForeignNestedDepth，桥接 render 启动时读回），再经 dispatch 分派；此处
 * depth 超限检查为防御性双闸（正常链路桥接层已拦截）。byExtension 无渲染器
 * 的附件回落下载（不落错误卡片）；有渲染器时的渲染失败由 dispatch 既有错误卡片面
 * 承接（落在 nested target 内）。合成 source 无 store（buffer 直传路径不触 store 面，
 * rangeCapable 探测读空对象即 false；sibling 解析经桥接层 read 探测兜 null）。 */
const foreignNestedDispatch: NestedDispatch = async (data, name, target, signal, depth) => {
  if (depth > FOREIGN_NESTED_DEPTH_LIMIT) {
    downloadNestedAttachment(data, name);
    return;
  }
  const i = name.lastIndexOf('.');
  const ext = i < 0 ? '' : name.slice(i + 1).toLowerCase();
  if (!registry.byExtension(ext)) {
    downloadNestedAttachment(data, name);
    return;
  }
  const source: FileSource = {
    storeId: 'foreign-nested',
    storeLabel: '嵌套附件',
    path: name,
    name,
    store: NESTED_ATTACHMENT_STORE
  };
  // 深度登记（M1 契约）：target 与嵌套渲染实例一一对应（兄弟并发各持独立 target、
  // 错误重试同 target 复读同值），桥接 render 以它读回自身深度，链式传递闭环。
  markForeignNestedDepth(target, depth);
  // 窄型收窄（运行时不变量）：foreign 嵌套回调的字节源自 foreign 渲染器侧
  // ArrayBuffer（renderNestedBuffer 的 nestedBuffer）→ 桥接层 new Uint8Array 包装，
  // 恒为 ArrayBuffer backed，无 SharedArrayBuffer 面。
  await dispatcher.dispatch(source, data as Uint8Array<ArrayBuffer>, target, { signal });
};

// 桥接块必须先于 codeRenderer 安装（generated 补空位铁律）：eml/fods 在
// GENERATED_EXTENSIONS 内、tsv 已自 code 内置清单原子移除（与本次装配同一 commit），
// 第二波 geojson/kml/gpx/typ/typst/sig 同居 GENERATED_EXTENSIONS（自兜底转移）、
// wasm 已自 hex 清单原子移除（同 commit）——顺序颠倒即被 code/hex 抢注。
// @file-viewer/* 全动态 import（foreignRenderers.ts 内），主 chunk 零混入
// （Review Focus 4，T4 门禁锚）。
for (const r of createForeignFileRenderers({ nestedDispatch: foreignNestedDispatch })) registry.install(r);
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

// 默认渲染器偏好（设置「打开方式」节，settings.rendererDefaults）：闭包现读设置
// （setDiagramOptions 同款——「应用」后下一次选路即时生效，不持快照）。
// registry.byExtension 只在偏好 id 属于该扩展名候选时采用，否则回落扩展名所有者；
// dispatcher 选路、确认门文案、嵌套附件分派同经 byExtension，偏好一致生效。
// '' = 内置默认。SSR 无 localStorage，不注入即恒为所有者。
if (browser) {
  registry.setPreferenceResolver((ext) => loadSettings().rendererDefaults[ext] || undefined);
}

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

// ---------- markdown 渲染组合包接线（@bhxch/vviewer-markdown，自 render-text 转出口切换） ----------

// 围栏高亮单一路径：app 的 tree-sitter worker client（highlightClient create →
// attachHighlightClient 注入 render-text code 模块）经 fenceToHtml 桥为组合包的
// HighlightFence。SSR/测试环境不渲染 markdown，不注入即保持包内默认值（不触达）。
if (browser) {
  setHighlightFence(fenceToHtml);
}

// 远程计算来源决策注入缝（组合包不依赖 @bhxch/vviewer-core 的 getRemoteBase）：远程
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
