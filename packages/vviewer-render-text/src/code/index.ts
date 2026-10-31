/**
 * code/index.ts — code 渲染器装配与汇总（FE-2 自 code.ts 分块迁出，函数体逐字
 * 搬移）。DAG 顶层：codeRenderer（render 入口的窗口/全量分派与守卫补拉）+
 * renderDegradedCode（markdown/html 超大输入降级共用入口）+ 子模块 export * 汇总
 * 与包级再导出（isAbortError/HighlightInterval——消费方经 src/code.ts façade 的
 * 导入面零改动）。
 */
import {
  getRemoteBase,
  getRemoteMeta,
  isAbortError,
  redetectWithFull,
  type Renderer,
  type Detection,
  type FileSource,
  type RenderedInstance,
  type StreamCtx,
  type LineMetrics,
  type Encoding,
  type ComputeSource,
  type ComputeWhere,
  type SearchMatch
} from '@bhxch/vviewer-core';
import { memoizedFullRead } from '../blockStream';
import { TREE_SITTER_MAX_BYTES, MARKUP_MAX_BYTES } from './strategy';
import { renderCode } from './renderCode';
import type { CodeEngine, CodeFileMeta, RenderCodeHandle } from './client';

export * from './strategy';
export * from './chunks';
export * from '@bhxch/vviewer-highlight/lines';
export * from './client';
export * from './renderCode';
export * from './renderCodeWindowed';

export type { HighlightInterval } from '@bhxch/vviewer-highlight';

/**
 * 取消错误身份判定（单源，spec 2026-10-16 错误身份与字节映射 §4.3）：实现与契约
 * 文档在 @bhxch/vviewer-core（dispatch/errors），此处再导出保持本包内 jsonl 与
 * web 层 ViewerPane 的既有导入路径零变动。
 */
export { isAbortError };

// 样式说明：虚拟滚动与代码面板的样式统一由 apps/web/src/app.css 提供（单一来源），
// 本模块不再运行时注入 CSS，避免双份定义漂移。

export const codeRenderer: Renderer = {
  id: 'code',
  label: '代码/文本',
  // 注 1：不含 'svg'——svg 归 @bhxch/vviewer-render-media 的 imageRenderer（消毒预览），registry 拒绝重复注册
  // 注 2：不含 'md'/'markdown'/'html'/'htm'——M3 起归 markdownRenderer/htmlRenderer（M1-M2 期间暂由 code 承接）
  extensions: [
    'txt', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'csv',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'xml',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'sh', 'bash', 'zsh', 'fish', 'sql',
    'lua', 'php', 'pl', 'swift', 'dart', 'vue', 'svelte', 'gradle', 'cmake', 'properties', 'gitignore',
    'license', 'makefile', 'diff', 'patch'
  ],
  // streaming（io-streaming 计划 3 Task 4，spec §4.3）：dispatcher 只交付 head +
  // StreamCtx，code 打开即走窗口流式（>2MB/size 未知）或入口守卫补拉全量（≤2MB/非
  // UTF-8）。回退面均在 render 内自处（下方守卫）；!rangeCapable 的全量视图 ctx 属
  // 窗口模式退化形态，BlockStream 零 IO 排空。
  streaming: true,
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection, ctx?: StreamCtx, opts?: { signal?: AbortSignal; lineMetrics?: LineMetrics; langOverride?: string }) {
    // 远端文件（M5 RemoteStore）的服务端检测头纠偏：X-VV-Lang/X-VV-Encoding
    // 与 languages.json 同源，比本地扩展名表/编码启发式更准（无扩展名脚本等）。
    // opts.lang 有值时 renderCode 直接采用、跳过 detectLanguage；服务端无检测头时
    // 回落 det.lang（dispatcher 的 extless 回退链写入的 shebang 语言，握手点 1）。
    // 手动高亮语言（spec §4.1，opts.langOverride）再优先于服务端检测头：用户显式
    // 指定 ≠ 一切自动识别，故置于 meta.lang 之前。
    const meta = getRemoteMeta(source.storeId, source.path);
    // M6 compute 路由：只有远程 store 的文件带服务端 path（auto 策略据此走远程高亮）
    const computeSrc: ComputeSource | undefined =
      getRemoteBase(source.storeId) !== undefined ? { path: source.path, storeId: source.storeId } : undefined;
    let encoding = meta?.encoding ?? det.encoding;
    const renderOpts = {
      encoding,
      highlight: true,
      ext: det.ext,
      lang: opts?.langOverride ?? meta?.lang ?? det.lang ?? undefined,
      computeSrc,
      // 行尺度（字体系统 Task 2）：ViewerPane 按 settings.fonts.codeSize 经 dispatch
      // 透传；缺省 undefined → renderCode 回落 LINE_HEIGHT（降级重渲路径随展开保留）
      lineMetrics: opts?.lineMetrics
    };
    // 窗口流式候选：ctx 存在且 UTF-8 且 size>2MB 或 size 未知（spec §4.3 高亮分界）。
    // detect 收口：窗口模式仅 UTF-8/ASCII（Encoding 无 ascii——ASCII 为 UTF-8 子集，
    // 探测即 utf-8）；非 UTF-8 不入此分支，全量回退后 dispatcher 终审 F2 以全量重算
    // detect 编码精判——O(n) 全量扫描只发生在全量路径，设计内解决遗留
    const windowed =
      ctx !== undefined &&
      (encoding ?? 'utf-8') === 'utf-8' &&
      (ctx.size === null || ctx.size > TREE_SITTER_MAX_BYTES);
    let inst: RenderCodeHandle;
    if (windowed && ctx !== undefined) {
      inst = renderCode(buffer, target, {
        ...renderOpts,
        ctx,
        // 项 1（遗留清偿波 3）：流内嗅探判非 UTF-8 的降级出口——与下方全量守卫的
        // 「判出的非 UTF-8」回退同路径（memoizedFullRead 补拉 + redetectWithFull 精判
        // + 全量重渲）。注入在渲染器入口：source/det（精判就地翻转 det.encoding）只在
        // 该层可见；head 样本取 ctx.head（dispatcher 交付的探测头，与入口回退同源）
        onEncodingBroken: async () => {
          const full = await memoizedFullRead(ctx);
          await redetectWithFull(source, ctx.head, full, det);
          return renderCode(full, target, { ...renderOpts, encoding: det.encoding });
        }
      });
    } else {
      // 全量路径守卫补拉（回退矩阵收口，同 jsonl/hex 形态）：streaming 分支只交付
      // 8KB 探测头作 buffer（capable 且 size>1MB 或 size 未知），head 未覆盖全文件
      // （size 未知无法排除截断，或 head 短于 size）时经 ctx.read 拉全量再走下游——
      // 覆盖非 UTF-8 解码回退与 ≤2MB tree-sitter 全量两场景（指令①），否则 8KB 探测
      // 头静默截断。head 即全量（兼容路径/!capable 全量视图/capable≤1MB 直读——
      // buffer.byteLength === ctx.size）不触发，零额外读。读失败在此 await 处 reject
      //（dispatcher 已把 ctx.read 失败标为 DispatchReadError → 调用方读取失败面，
      // 评审指令①口径：不落「错误卡片 + 8KB probe 重试」截断活面）。
      if (ctx !== undefined && (ctx.size === null || buffer.byteLength < ctx.size)) {
        const head = buffer; // 探测头（head 即全量时守卫不触发，此处必为文件前缀）
        // 项 6（retry 免重拉）：补拉按 ctx 记忆——错误卡片 retry 重入 render 不再
        // 重复全量下载（memoizedFullRead，见 blockStream.ts 注）
        buffer = await memoizedFullRead(ctx);
        // I-2 补拉后编码精判：capable 且 size 未知/超限时 det 仅由 8KB head 判定，
        // 截断多字节可双向误判（误判 gb18030 直接解码即整文件 mojibake）——以全量
        // 重算翻转（dispatcher redetectWithFull 同款共享 helper），encoding 随之重取
        //（服务端 X-VV-Encoding 头仍最优先），下游 renderCode 以现值解码
        await redetectWithFull(source, head, buffer, det);
        encoding = meta?.encoding ?? det.encoding;
        renderOpts.encoding = encoding;
      }
      inst = renderCode(buffer, target, renderOpts);
    }
    // 窗口模式首拉完成面：首块/本地化排空失败 → 销毁半装配实例（防空壳 scroller
    // 泄漏）后 rethrow——DispatchReadError 直抛调用方读取失败面，非读失败走渲染错误
    // 卡片（dispatcher catch，重试动作经 renderCtx 透传 ctx——评审指令②已验证）
    const ready = (inst as { whenReady?: Promise<void> }).whenReady;
    if (ready !== undefined) {
      try {
        await ready;
      } catch (err) {
        inst.destroy();
        throw err;
      }
    }
    // getScrollHost/getEngine 供 ViewerPane 接滚动持久化与引擎指示器；
    // getComputeWhere 供状态栏执行位置指示（M6）；search/gotoMatch 供 SearchPanel（Task 6）；
    // getMeta 供状态栏/属性面板元数据（BUG-04）；revealLine 供全局搜索跳转（BUG-09）。
    // 结构化扩展 RenderedInstance（Omit 去旧 search 签名避免交叉双签名冲突），不动 core。
    const instance: Omit<RenderedInstance, 'search'> & {
      getScrollHost(): HTMLElement;
      getEngine(): CodeEngine;
      getComputeWhere(): ComputeWhere | null;
      getMeta(): CodeFileMeta;
      search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
      gotoMatch(index: number): void;
      revealLine(line: number, col?: number): void;
    } = {
      destroy() {
        inst.destroy();
      },
      getScrollHost() {
        return inst.getScrollHost();
      },
      getEngine() {
        return inst.getEngine();
      },
      getComputeWhere() {
        return inst.getComputeWhere();
      },
      getMeta() {
        return inst.getMeta();
      },
      search(query, opts) {
        return inst.search(query, opts);
      },
      gotoMatch(index) {
        inst.gotoMatch(index);
      },
      revealLine(line, col) {
        inst.revealLine(line, col);
      }
    };
    return instance;
  }
};

// ---------- 超大输入降级（markdown/html 富文本渲染器共用） ----------

/**
 * 超大文件降级视图：提示卡 + 代码视图纵向排布，替代富文本渲染管线。
 * markdown/html 的净化/DOM 遍历管线对超大输入无分块能力，> MARKUP_MAX_BYTES 时
 * 调用方跳过富文本管线走这里：markdown 降级纯文本（highlight: false），html 降级
 * 源码视图——降级而非拒绝，查看器语义下内容仍可读。错误卡复用 core showErrorCard
 * 的 .vv-error-* 结构语义；.vv-degraded* 样式由 apps/web/src/app.css 提供。
 */
export function renderDegradedCode(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: { name: string; mode: string; encoding?: Encoding; ext?: string; highlight?: boolean }
): RenderCodeHandle {
  target.classList.add('vv-degraded');
  const card = document.createElement('div');
  card.className = 'vv-error-card vv-oversize-card';
  const title = document.createElement('div');
  title.className = 'vv-error-title';
  title.textContent = '文件过大，已降级显示';
  const detail = document.createElement('div');
  detail.className = 'vv-error-detail';
  detail.textContent = `文件超过 ${MARKUP_MAX_BYTES / 1024 / 1024}MB，富文本渲染已跳过（避免长时间阻塞），已降级为${opts.mode}视图（代码视图/纯文本查看）。`;
  const meta = document.createElement('div');
  meta.className = 'vv-error-meta';
  meta.textContent = opts.name;
  card.append(title, detail, meta);
  const content = document.createElement('div');
  content.className = 'vv-degraded-content';
  target.replaceChildren(card, content);
  return renderCode(buffer, content, {
    encoding: opts.encoding,
    highlight: opts.highlight,
    ext: opts.ext,
    oversizeNotice: false // 降级卡已存在：不再叠加 >20MB 纯文本提示条（BUG-20 防重复）
  });
}
