/**
 * code/client.ts — attach 注入态整体（FE-2 自 code.ts 分块迁出，函数体逐字搬移）。
 * 模块级可变单例（attachedClient/attachPhase/attachWaiters/attachedRouter）整块随迁
 * 单点不拆；getHighlightRouter 为 internal 读取面（renderCode/renderCodeWindowed 的
 * chunk 来源选择消费——拆分前为 code.ts 模块内直读 attachedRouter，行为等价）。
 * 本块另承载渲染层公共契约类型（CodeEngine/CodeFileMeta/RenderCodeHandle/
 * CodeRenderOptions——全量与窗口两路径的共用签名）。
 */
import type {
  Encoding,
  ComputeSource,
  ComputeWhere,
  SearchMatch,
  StreamCtx,
  LineMetrics
} from '@bhxch/vviewer-core';
import type { HighlightChunk, HighlightInterval } from '@bhxch/vviewer-highlight';

/** 单次高亮调用的路由上下文（M6 compute 路由 + 阶段 4 chunk 标注；不参与渲染结果本身） */
export interface HighlightCallContext {
  /** 计算来源：远程 store 的文件带服务端 path（auto 策略据此走远程），本地文件缺省 */
  src?: ComputeSource;
  /** 执行位置回调：路由结果（local/remote）到达后调用（状态栏执行位置指示） */
  onWhere?: (where: ComputeWhere) => void;
  /** chunk 子文本窗口语义标注（spec §5.1）：text 即该窗口子文本，返回区间相对 text；
   * 行号平移归渲染侧（mergeChunkLines）。仅 lazy 本地 chunk 路径携带 */
  chunk?: HighlightChunk;
}

/** tree-sitter 高亮客户端最小接口（HighlightClient 结构兼容；测试可注 fake） */
export interface CodeHighlightClient {
  highlight(text: string, lang: string, ctx?: HighlightCallContext): Promise<HighlightInterval[]>;
}

let attachedClient: CodeHighlightClient | null = null;

/** 注入相位：pending=尚未 attach（attach 竞态窗口，等待者挂起）；attached=client
 * 在位；failed=attachHighlightClient(null) 显式解绑（创建失败终态）——即刻放行
 * 等待者走 hljs 兜底，不占超时（区分「还没好」与「不会有」两种 null）。 */
type AttachPhase =
  | { phase: 'pending' }
  | { phase: 'attached' }
  | { phase: 'failed' };
let attachPhase: AttachPhase = { phase: 'pending' };

/** 等待注入的渲染实例（start() 时 client 尚未就绪的挂起点，attach/超时即放行） */
interface AttachWaiter {
  resolve: (client: CodeHighlightClient | null) => void;
  timer: ReturnType<typeof setTimeout>;
}
let attachWaiters: AttachWaiter[] = [];

/**
 * 应用侧注入 HighlightClient 单例（apps/web 启动时调用；传 null 为创建失败解绑
 * 终态——放行全部等待者，后续 waitForAttachedClient 即刻返回 null 不再等待）
 */
export function attachHighlightClient(client: CodeHighlightClient | null): void {
  attachedClient = client;
  attachPhase = client === null ? { phase: 'failed' } : { phase: 'attached' };
  const waiters = attachWaiters;
  attachWaiters = [];
  for (const w of waiters) w.resolve(client);
}

/**
 * 等待高亮客户端注入（P2 CDN 层引入的 attach 竞态修复）：client 由 apps/web
 * 启动预热创建，但 create() 需先走 grammar 资产三层解析链——CDN 层注入后含一次
 * 真实网络 fetch（CI 假域名快速失败，本地/代理环境可耗秒级），「启动预热早于
 * 首个 code tab」不再保证。此前 start()/懒 chunk 泵/markdown 围栏同步读
 * attachedClient，未就绪即落 hljs 兜底且永不恢复（首开文件/围栏引擎错锁——
 * m6 远程高亮与 >2MB 懒高亮家族在 CDN 构建下实测竞态）。现 pending 相位挂起
 * 等待注入（或超时/failed 放行 null → 既有 hljs 兜底路径）；超时上限兜底创建期
 * 永久挂起（如 CDN fetch 无响应）不让渲染无限等。
 */
export function waitForAttachedClient(timeoutMs = 10_000): Promise<CodeHighlightClient | null> {
  if (attachedClient !== null) return Promise.resolve(attachedClient);
  if (attachPhase.phase === 'failed') return Promise.resolve(null); // 解绑终态：不会有 client
  return new Promise((resolve) => {
    const waiter: AttachWaiter = {
      resolve: (client) => {
        clearTimeout(waiter.timer);
        resolve(client);
      },
      timer: setTimeout(() => {
        attachWaiters = attachWaiters.filter((w) => w !== waiter);
        resolve(attachedClient); // 超时放行：仍为 null → 调用方走既有 hljs 兜底
      }, timeoutMs)
    };
    attachWaiters.push(waiter);
  });
}

/** 读取已注入的高亮客户端单例（markdownRenderer 的围栏高亮复用同一注入，无需二次接线） */
export function getHighlightClient(): CodeHighlightClient | null {
  return attachedClient;
}

/** 测试专用：重置注入相位为 pending（模拟「client 尚未创建」的启动窗口）——
 * 生产代码不调用；attachHighlightClient(null) 是失败终态，测试需要重新构造
 * 竞态窗口时经此恢复（code.test/markdownRenderer.test 的 attach 竞态用例）。 */
export function __resetAttachPhaseForTest(): void {
  attachedClient = null;
  attachPhase = { phase: 'pending' };
}

/**
 * 大文件远程高亮路由（BUG-10 → 阶段 4 range 契约）：>2MB lazy 文件按可视区 chunk
 * 问路由（裁决在注入侧 apps/web highlightRouter）。契约：非 null = 该 chunk 的远程
 * 高亮区间（intervals 相对 chunk 首行，baseLine 平移到绝对行；执行位置 remote）；
 * null = 留在该 chunk 的行级 hljs 兜底（注入侧硬护栏：local、本地来源、auto 服务端
 * 不可服务门均拦为 null）；抛错 = 显式 remote 失败（渲染端错误卡片，不静默回退，
 * 与 tree-sitter 分支的 RemoteComputeError 同语义）。
 */
/** 大文件路由 chunk 级结果（spec §5.1）：intervals 相对 chunk 首行；baseLine 为该
 * 首行的全文件 0 基行号（旧服务端响应无此字段时兜 0，此时按全文件区间解释） */
export interface LargeFileHighlightChunk {
  intervals: HighlightInterval[];
  baseLine: number;
}

export type HighlightRouterFn = (
  src: ComputeSource,
  lang: string,
  range?: { startLine: number; lineCount: number }
) => Promise<LargeFileHighlightChunk | null>;

let attachedRouter: HighlightRouterFn | null = null;

/** 应用侧注入大文件路由回调（apps/web 启动时调用；传 null 解绑） */
export function attachHighlightRouter(fn: HighlightRouterFn | null): void {
  attachedRouter = fn;
}

/** 读取已注入的大文件路由回调（internal：renderCode/renderCodeWindowed 的
 * highlightChunk 来源选择消费，行为等价直读 attachedRouter） */
export function getHighlightRouter(): HighlightRouterFn | null {
  return attachedRouter;
}

// 样式说明：虚拟滚动与代码面板的样式统一由 apps/web/src/app.css 提供（单一来源），
// 本模块不再运行时注入 CSS，避免双份定义漂移。

/** 代码高亮引擎实时值：pending = tree-sitter 主路径（整文件或 lazy chunk）已启动但
 * 首个产出未到达（或已取消）；'hljs-block' 类型值保留（历史状态栏兼容）但不再产生 */
export type CodeEngine = 'tree-sitter' | 'hljs' | 'hljs-block' | 'plain' | 'pending';

/** 渲染实例元数据快照（BUG-04：状态栏/属性面板单一来源） */
export interface CodeFileMeta {
  encoding?: Encoding;
  lang?: string | null;
  size: number;
  /** 内容行数（与 wc -l 同口径）：以 \n 结尾的 301 行文件报 301，非 split 产物的 302 */
  lines: number;
}

export interface RenderCodeHandle {
  destroy(): void;
  setScrollTop(top: number): void;
  scrollTop(): number;
  /** 内部滚动容器（.vv-code-pre）：code tab 的滚动持久化接这里而非外层容器 */
  getScrollHost(): HTMLElement;
  /** 当前生效的高亮引擎（实时；状态栏指示器用） */
  getEngine(): CodeEngine;
  /** 高亮计算执行位置（M6：'local'|'remote'；null = 未发生计算路由，如纯文本）。状态栏指示器用 */
  getComputeWhere(): ComputeWhere | null;
  /** 元数据快照（BUG-04）：编码/语言/大小/内容行数（渲染期静态值） */
  getMeta(): CodeFileMeta;
  /** 文件内搜索：行数组扫描（缓存 query×caseSensitive），空 query 返回 []（退出搜索语义） */
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
  /** 跳到第 index 个命中：滚动到该行 + 行级临时高亮（1.5s 或直到下一次跳转） */
  gotoMatch(index: number): void;
  /** 跳到指定行（0 起）并滚动至视口中部 + 行级临时高亮（BUG-09 全局搜索跳转；独立于搜索结果） */
  revealLine(line: number, col?: number): void;
  /** 字符偏移 → 物理行号（deferred 清偿 Task 5，可选扩展）：全量模式 lineOffsets 二分
   * （lineOf）。偏移口径=归一文本（BOM 已剥、CRLF→LF）的 UTF-16 字符偏移（与
   * buildLineOffsets 同源）；边界语义——offset 恰在行尾换行符上归本行（未达下一行
   * 起始）、超文件尾钳末行。仅全量模式提供（窗口模式无全量 lineOffsets，缺席）；
   * 消费方（jsonl 委托降级锚行映射）鸭子探测，缺席回退内容行号直传（向后兼容）。 */
  lineAtOffset?(offset: number): number;
  /** 字节偏移 → 物理行号（spec 2026-10-16 错误身份与字节映射 §4.5，可选扩展）：与
   * lineAtOffset 同款二分与边界语义（行尾终结符归本行、超尾钳末行），域为 post-BOM
   * 逻辑字节偏移（\r\n 记 2 字节单终结符、\n 记 1、lone \r 终结记 1）——与 jsonl
   * 索引 offsets 在 \r\n/\n 文件上逐字节同基，委托锚行映射的精确通道。仅全量模式
   * 提供（窗口模式无全量索引，缺席）；消费方鸭子探测（三级回退首级）。 */
  lineAtByteOffset?(offset: number): number;
}

/** renderCode 选项（双模式共用）：全量模式（现状）与窗口流式模式的差异全部经
 * ctx 字段表达——其余字段语义两模式一致（encoding/highlight/ext/lang/computeSrc/
 * oversizeNotice）。 */
export interface CodeRenderOptions {
  encoding?: Encoding;
  highlight?: boolean;
  ext?: string;
  lang?: string;
  computeSrc?: ComputeSource;
  /** >20MB 纯文本降级的超限提示条开关（BUG-20）；缺省跟随 highlight。
   * renderDegradedCode 传 false：降级卡已存在，不重复提示。 */
  oversizeNotice?: boolean;
  /** 流式读上下文（io-streaming 计划 3 Task 4，spec §4.3）：存在时 renderCode 走
   * 窗口流式模式（buffer 形参仅作语言探测头部样本，不参与渲染）。前置条件：编码
   * 须为 UTF-8（codeRenderer.render 守卫——窗口模式仅 UTF-8/ASCII，见其注释）；
   * ≤2MB 全量走现状路径的守卫补拉同样在 codeRenderer.render 入口完成。 */
  ctx?: StreamCtx;
  /** 项 1（遗留清偿波 3）：流内嗅探判非 UTF-8 的降级出口（codeRenderer.render 注入）：
   * 实现走「判出的非 UTF-8」入口回退同路径（memoizedFullRead 补拉 + redetectWithFull
   * 精判 + 全量重渲）并返回全量重渲实例——窗口实例的方法面转投该实例。缺省（直接
   * 调用面）不嗅探不降级，行为与现状一致。 */
  onEncodingBroken?: () => Promise<RenderCodeHandle>;
  /** 行尺度（字体系统 Task 2，spec §3）：lineHeight 替换 LINE_HEIGHT 常量的全部
   * 消费点（虚拟滚动装配/行占位高度/跳转虚拟坐标，全量与窗口两路径）；缺省回落
   * LINE_HEIGHT=20（直调兼容面）。fontSize 为 cssText 侧字号语义的协议对偶
   * （.vv-code-pre 的实际字号由 --vv-code-font-size 注入驱动）。 */
  lineMetrics?: LineMetrics;
}
