/**
 * JSON Lines 渲染器（.jsonl/.ndjson）：行卡片 + 可变高度窗口 + 卡片级懒高亮。
 *
 * 双模式裁决（io-streaming 计划 2 Task 3，spec §4.2）：renderJsonl 第 4 参 ctx
 * 存在且编码属 utf-8（Encoding 联合类型无 ascii——ASCII 为 UTF-8 子集，探测即
 * utf-8）→ **窗口模式**：行索引按字节流式构建（BlockStream 256KB 逐块喂
 * advanceJsonlIndex，首屏确保前 2 块）、行文本=块解码缓存切片、状态条「已加载
 * N 行」（EOF 确认后「共 N 行」，归还 jsonl spec §2.2「总行数未知，滚动到底才
 * 确定」口径）、滚动接近已加载尾部续读。size 未知同样流式（BlockStream 短读
 * 探测 atEnd）；!rangeCapable 的全量视图（ctx.head=全量+同步切片 read）属窗口
 * 模式的退化形态，BlockStream head 预置全部块后零 IO 排空，天然工作。ctx 缺省
 * 或非 UTF-8 → **全量模式**：现状路径行为不动（IO 全量——上层交付整文件
 * buffer，TextDecoder 一次解码 + CRLF 归一；解析流式——卡片进窗口才 JSON.parse）。
 *
 * IO/解析裁决（spec D §2.3）：解析缓存 Map<number, JsonlLineState> 不设上限：
 * 结果字符串体积与原文本同阶（pretty 放大有限），行数已知可全持，逐出只会导致
 * 滚动回看时重复解析，无收益（窗口模式行数渐进，同理只增不减）。
 *
 * 窗口模式行文本三路（简报 Interfaces 对应）：
 * - 单块行 = 块解码缓存（Map<blockIndex, string> LRU 8 ≈ 2MB）文本切片。字节
 *   偏移 → 字符下标经「前缀解码游标」换算：行首/行尾恒为字符边界（终结符是单
 *   字节 ASCII），自游标起的前缀独立 decode 长度即字符增量（块 0 前缀 decode
 *   同样剥 BOM，与整块解码口径一致）；
 * - 跨块行 = 按索引 lengths 拼原始字节后单次解码——块切口可能切开多字节字符，
 *   逐块解码再拼会产出重复 U+FFFD，故拼装必须在字节域进行；
 * - oversized 行（索引层判行字节 ≥1MB）不走拼装——行首 4×64KB 字节解码后截
 *   64KB 字符：块内自行首起至少 4×65536 字节（不足即行已在后续块，拼装范围
 *   同式），其中行首 64K 字符必完整（UTF-8 每字符 ≤4 字节），与全量模式
 *   parseJsonlLine 的 raw.slice(0, 64KB) 逐字符一致；状态直接构造 oversize 形态
 *   （预览 <1MB，若再过 parseJsonlLine 的 encode 阈值会被误判进 JSON.parse）。
 *
 * BOM 裁决（T2→T3 指令①，硬性）：索引层不剥 BOM——窗口模式在索引/解码前剥离
 * 文件头 UTF-8 BOM（EF BB BF；恒在文件头=块 0 首部，无跨块问题）。剥离后索引
 * 偏移为「逻辑字节空间」（文件字节 = 逻辑偏移 + bomLen），取块取数时换回，首行
 * 才能与全量模式（TextDecoder 剥 BOM）解析一致——不剥则首行带 BOM 必 failed。
 *
 * 消费契约（T2→T3 指令②）：finishJsonlIndex 之后不得再 advanceJsonlIndex——
 * indexFinished 置位后续读/拉块全部停机（pullBlock 直返），EOF 后滚动零 IO。
 *
 * 块取数纪律（T1→T3 指令③）：先 await ensureBlock(i) 再 block(i)——head 预置
 * 的部分块（探测头 8KB < 256KB 块）未经整块替换不得进索引/解码。索引喂块统一
 * 走 pullBlock（ensure 后才 advance）；行文本取数依赖不变量「可见行 ⊆ 已喂块」
 * （可见行号 < 已加载行数，行字节范围 ⊆ 已喂字节），并对块 0 部分预置天然免疫
 * （索引有行 ⇒ 块 0 已整块替换）。拉块原子性（fix round 1）：nextFeed 与
 * BlockStream 的 nextBlock 均成功后才推进——read 失败可同块重试，块序列不错位；
 * 滚动期续读失败置停机标志（「下次用户动作才重试」，hex.ts 同口径），杜绝
 * 「失败→重评→仍近尾部→再失败」的无限重试活锁。
 *
 * 块表有界（计划 3 Task 1，计划 2 终审 B1）：BlockStream maxBlocks=16（4MB 原始
 * 字节）——滚动到底原始字节不再全量常驻。被逐出块经 hooks.lineAvailable 把关：
 * 缺块行渲染占位卡、不进解析（防污染 parseCache），maybeContinue 统一重拉后
 * refresh 填充（hexSource「占位+ensure+重拉」同语义）。
 *
 * 尺寸防线（计划 3 Task 2，B1 统一裁决）：窗口模式已确认字节超 STREAM_MAX_BYTES
 * （512MB）→ 续读停机，状态条追加「已达流式上限，建议以 hex 打开」——非失败态
 * （不复用错误卡片）。防线在 IO 之前裁决：size 已知构造即知（零读停机），size
 * 未知随短读探测逐块裁决；超限后 indexFinished 恒假，状态条保持「已加载 N 行」口径。
 *
 * 高亮裁决：卡片级——每张 ok 卡片对自身 pretty 全文调一次
 * getHighlightClient().highlight(pretty, 'json')，窗口外的行永不解析/高亮；
 * pretty 超过 JSONL_HIGHLIGHT_MAX_CHARS（1M 字符）的卡片跳过自动高亮保持纯文本；
 * 区间 → 行 HTML 复用 code.ts 导出的 assignIntervalsToLines + renderLineHtml。
 * 取消语义沿用 code.ts：HighlightCanceledError 静默，不写 DOM、不兜底。
 *
 * 高度模型：复用 window.ts 的 HeightModel/visibleRange（实测前缀和 + 估算外推），
 * DOM 适配层在本模块——rAF 合并一帧内的批量 measure 修正（一帧消费一次 dirty）。
 *
 * 降级视口锚定（SUSP-03，流式硬化 Task 6）：窗口模式流内嗅探判非 UTF-8 降级全量
 * 重渲会整体 replaceChildren——降级出口前经 onViewMove 快照可视首行（锚行，嗅探
 * 时刻窗口实例仍在、DOM 未替换），新实例 mount 完成后按锚行恢复：委托实例
 * revealLine（code 委托形态既有 API、jsonl 两模式本任务补齐），粗定位=前缀和
 * offsetOf + 同步重渲锚行窗口，精调=锚行卡片 data-line 定位 + offsetTop 实测位置
 * （可变行高，不用 scrollTop 直译；offsetTop 相对 viewport 布局原点，须加
 * translateY 才是滚动内容坐标），越界钳到末行。语义=降级后可视首行 ≈ 降级前首行。
 */
import type { Detection, FileSource, RenderedInstance, Renderer, StreamCtx } from '@vviewer/core';
import { redetectWithFull } from '@vviewer/core';
import { HighlightCanceledError, type HighlightInterval } from '@vviewer/highlight';
import { STREAM_MAX_BYTES, createBlockStream, isSuspiciousUtf8Block, memoizedFullRead } from '../blockStream';
import { createTextWindow, type BlockTextEntry } from '../textWindow';
import {
  assignIntervalsToLines,
  buildLineOffsets,
  DECODERS,
  getHighlightClient,
  isAbortError,
  PLAIN_MAX_BYTES,
  renderCode,
  renderLineHtml,
  type CodeFileMeta
} from '../code';
import {
  collapseFor,
  JSONL_COLLAPSE_LINES,
  JSONL_EXPAND_CAP_LINES,
  JSONL_HIGHLIGHT_MAX_CHARS,
  JSONL_OVERSIZE_LINE_BYTES,
  JSONL_OVERSIZE_PREVIEW_BYTES,
  parseJsonlLine,
  splitJsonlLines,
  type JsonlLineState
} from './parse';
import {
  advanceJsonlIndex,
  createJsonlIndex,
  finishJsonlIndex,
  type JsonlIndexState
} from './indexStream';
import { HeightModel, visibleRange } from './window';

/** 封顶卡片的 body 内滚动最大高度（px）：400 行 × 20px 全展开会顶爆窗口滚动
 * 定位（translateY 前缀和失效），封顶展开放卡片内滚动。CSS 缺位时的行为兜底。 */
const JSONL_CAPPED_BODY_MAX_HEIGHT = 480;

/**
 * >200MB 委托 code 纯文本视图的阈值判断（纯函数，导出供单测；真构造 200MB buffer
 * 不现实——计划裁决：阈值单测 + e2e 不覆盖降级路径）。阈值 import 自 code.ts 的
 * PLAIN_MAX_BYTES 同源常量，无本地副本。
 */
export function shouldDelegateToCode(size: number): boolean {
  return size > PLAIN_MAX_BYTES;
}

/** 卡片滚动容器 / 窗口 overscan（与 visibleRange 缺省一致，显式书写便于调参） */
const OVERSCAN = 5;

/** 窗口模式块大小：256KB（spec §4.2：首屏 2 块 = 512KB，滚动近尾部续读） */
const WINDOW_BLOCK_BYTES = 256 * 1024;
/** 块解码缓存 LRU 上限（块数）：8 块 ≈ 2MB 文本（spec §4.2） */
const BLOCK_TEXT_CACHE_MAX = 8;
/** 块表驻留上界（BlockStream maxBlocks，计划 3 Task 1 / 计划 2 终审 B1）：
 * 16×256KB = 4MB 原始字节，滚动到底原始字节不再全量常驻。文本缓存 8 块热集之外留一倍
 * 余量；被逐出块经 lineAvailable 把关 + ensureBlock 重拉（hexSource 同语义）。 */
const WINDOW_STREAM_MAX_BLOCKS = 16;
/** 尺寸防线状态条追加语（非失败态：不复用错误卡片，B1 统一裁决口径） */
const STREAM_LIMIT_NOTICE = ' · 已达流式上限，建议以 hex 打开';

/** 窗口模式内部状态观测口（indexStream.ts internals 同款 WeakMap 模式）：
 * 实例 → 块解码缓存。生产代码不读；单测据此断言 LRU 上限。 */
export interface JsonlWindowedInternals {
  blockTextCache: Map<number, BlockTextEntry>;
}
export const jsonlWindowedInternals = new WeakMap<
  RenderedInstance & { getMeta(): CodeFileMeta },
  JsonlWindowedInternals
>();

/** 双模式渲染核的运行期 API（afterUpdate 钩子的回调面：续读完成后重渲） */
interface ViewRuntimeApi {
  refreshStatus(): void;
  /** 按当前行数重设 spacer 总高（model.total(rowCount)） */
  setSpacerHeight(): void;
  /** 强制重渲当前窗口（update(true)，内部再评估续读） */
  refresh(): void;
  destroyed(): boolean;
}

/** 双模式差异钩子：行数/行文本/状态文案/meta 的模式差异全部收口于此，
 * 卡片渲染管线（解析缓存/高亮/折叠/窗口循环/destroy）两模式共用 */
interface JsonlViewHooks {
  /** 行数（窗口模式随续读增长，全量模式恒定） */
  rowCount(): number;
  /** 行原始文本（stateOf 的解析输入；全量=预切分数组直取，窗口=块缓存切片/拼装） */
  lineAt(i: number): string;
  /** 行 i 渲染所需块是否驻留（窗口模式专用：块表 LRU 逐出后暂不可用；全量不提供）。
   * 返回 false 的行渲染占位卡、不进 stateOf（防不可用文本污染解析缓存），探测到
   * 的缺块由渲染器登记待办、统一 ensureBlock 重拉后 refresh 重渲（hex 同语义）。 */
  lineAvailable?(i: number): boolean;
  /** 索引层已判 oversized 行的直接状态（窗口模式专用；全量不提供走 parseJsonlLine）。
   * 返回 null = 非 oversized，回落 parseJsonlLine。 */
  oversizedState?(i: number): JsonlLineState | null;
  /** 状态条文案（不含失败徽标）：全量恒「共 N 行」；窗口「已加载 N 行」→ EOF 后「共 N 行」 */
  statusText(): string;
  /** 是否已到流末尾（全量恒 true；窗口模式据其决定 rows=0 是否空态早退） */
  streamDone(): boolean;
  /** 窗口更新后的模式钩子（窗口模式：接近已加载尾部续读；全量不提供） */
  afterUpdate?(last: number, api: ViewRuntimeApi): void;
  /** 可视窗口移动通知（update() 写入 curFirst/curLast 后同步回调；窗口模式据此
   * 镜像 curFirst 作降级锚行捕获源——SUSP-03 视口锚定，见 renderJsonlWindowed
   * 的 viewFirst 注） */
  onViewMove?(first: number, last: number): void;
  /** 用户视图动作通知（scroll/resize 事件入口）：窗口模式据此解除续读失败停机
   * ——「下次用户动作才重试」（hex.ts 同口径）；全量不提供 */
  notifyUserAction?(): void;
  /** meta 尺寸/行数（窗口模式两者皆动态） */
  metaSize(): number;
  metaLines(): number;
}

/**
 * 双模式共用渲染核：构建 .vv-jsonl DOM（状态条 + 滚动容器）并驱动可变高度窗口
 * 循环。返回实例含 destroy 与 getMeta（CodeFileMeta 同形状，ViewerPane 鸭子探测
 * 自动消费）。模式差异经 hooks 注入，DOM 结构与事件接线两模式完全一致。
 */
function mountJsonlView(
  target: HTMLElement,
  det: Detection,
  hooks: JsonlViewHooks
): RenderedInstance & { getMeta(): CodeFileMeta; revealLine?(line: number): void } {
  const rows = hooks.rowCount;
  target.classList.add('vv-jsonl');
  const status = document.createElement('div');
  status.className = 'vv-jsonl-status';
  status.setAttribute('aria-live', 'polite'); // 恒挂（失败计数 0→N 时读屏可感知）
  status.title = '失败行数随滚动解析渐进统计'; // 失败计数非首屏终值，口径见 tooltip

  // 解析缓存（惰性填充，不设上限，见模块头）与失败行计数（解析流式的代价：
  // 失败数随窗口解析渐进逼近全量，小文件首屏即终值）
  const parseCache = new Map<number, JsonlLineState>();
  let failedCount = 0;

  function refreshStatus(): void {
    if (failedCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'vv-jsonl-status-failed';
      badge.textContent = ` · ${failedCount} 行解析失败`;
      status.replaceChildren(document.createTextNode(hooks.statusText()), badge);
    } else {
      status.textContent = hooks.statusText();
    }
  }

  const meta = (): CodeFileMeta => ({
    encoding: det.encoding,
    lang: 'json',
    size: hooks.metaSize(),
    lines: hooks.metaLines()
  });

  // rows=0 守卫：全空行文件不进窗口循环（visibleRange 无行可窗口化），空状态即
  // 终态。窗口模式流未到 EOF 时不得早退（后续块可能带来行），交给续读循环。
  if (rows() === 0 && hooks.streamDone()) {
    refreshStatus();
    target.replaceChildren(status);
    return {
      destroy() {
        target.classList.remove('vv-jsonl');
        target.replaceChildren();
      },
      getMeta: meta
    };
  }

  // 滚动容器（.vv-jsonl-scroll）+ spacer/viewport 结构（virtualScroller 同构，
  // 可变高度版自建：offset 来自 HeightModel 前缀和而非 rows*lineHeight）
  const scroll = document.createElement('div');
  scroll.className = 'vv-jsonl-scroll';
  const spacer = document.createElement('div');
  spacer.className = 'vv-virtual-spacer'; // app.css 虚拟滚动惯例类（absolute top:0，按类名自动生效）
  const viewport = document.createElement('div');
  viewport.className = 'vv-virtual-viewport';
  scroll.replaceChildren(spacer, viewport);
  refreshStatus();
  target.replaceChildren(status, scroll);

  const model = new HeightModel();
  let curFirst = -1;
  let curLast = -1;
  let destroyed = false;
  let rafId: number | null = null;

  // 高亮三态：已缓存区间 / 在途行 / 在途 Promise（destroy 时统一 swallow，
  // 防 tab 切换 cancelAll 之后的 unhandled rejection）
  const highlightCache = new Map<number, HighlightInterval[]>();
  const pendingRows = new Set<number>();
  const inFlight = new Set<Promise<unknown>>();
  /** pretty 超高亮输入上限的行（去重：每行只 console.debug 留痕一次） */
  const highlightSkippedRows = new Set<number>();
  /** 已展开（点击过 .vv-jsonl-expand）的行：重渲染窗口时不回退折叠态 */
  const expandedRows = new Set<number>();

  /** 惰性解析：首次进入窗口才 JSON.parse；失败行即时入计数并刷新状态条 */
  function stateOf(i: number): JsonlLineState {
    let st = parseCache.get(i);
    if (st === undefined) {
      // 窗口模式：索引层已判 oversized 的行走直接构造（见模块头三路口径）；
      // 其余行（含 FFFD 膨胀再越限的病态输入）交 parseJsonlLine，与全量同管
      st = hooks.oversizedState?.(i) ?? parseJsonlLine(hooks.lineAt(i));
      parseCache.set(i, st);
      if (st.kind === 'failed') {
        failedCount += 1;
        refreshStatus();
      }
    }
    return st;
  }

  /**
   * 区间 → 可见行 HTML（复用 code.ts 管线）：intervals 相对 pretty 全文，行偏移表
   * 按可见切片构建——切片是全文前缀，前缀偏移与全文一致；折叠/封顶时落在切片总长
   * 之外的区间先过滤丢弃（renderLineHtml 的 end 夹紧只会把这类区间变成空 ts-* span，
   * 见下），切片内起点的区间越出末行行尾的部分仍由夹紧吸收。无缓存产出（未接
   * client / 在途 / 取消）返回 null，调用方回落纯文本转义。
   */
  function highlightedHtml(i: number, visibleLines: string[]): string | null {
    const intervals = highlightCache.get(i);
    if (intervals === undefined) return null;
    const offsets = buildLineOffsets(visibleLines);
    // 切片总长（末行起点 + 末行长）：起点越过它的区间在夹紧后产出空 ts-* span，丢弃
    const limit =
      (offsets[offsets.length - 1] ?? 0) + (visibleLines[visibleLines.length - 1]?.length ?? 0);
    const visible = intervals.filter((iv) => iv.start < limit);
    if (visible.length === 0) return null;
    const byLine = new Map(
      assignIntervalsToLines(visible, offsets).map((a) => [a.line, a.segs])
    );
    return visibleLines.map((l, k) => renderLineHtml(l, byLine.get(k))).join('\n');
  }

  /** 卡片级高亮请求（幂等）：结果到达后仅当卡片仍在窗口内才重绘 */
  function requestHighlight(i: number, pretty: string): void {
    if (pendingRows.has(i) || highlightCache.has(i)) return;
    // 输入上限防护：深嵌套小行 pretty 可放大数倍（单行 <1MB、pretty 数 MB），
    // 超限跳过自动高亮保持纯文本（防 worker 载荷与主线程卡顿），每行只 debug 一次
    if (pretty.length > JSONL_HIGHLIGHT_MAX_CHARS) {
      if (!highlightSkippedRows.has(i)) {
        highlightSkippedRows.add(i);
        console.debug('[jsonl] pretty 超过高亮输入上限（>1M 字符），本卡保持纯文本', i);
      }
      return;
    }
    const client = getHighlightClient();
    if (!client) return; // 未接线（App 未启动高亮/单测）：保持纯文本
    pendingRows.add(i);
    const p = client.highlight(pretty, 'json').then(
      (intervals) => {
        inFlight.delete(p);
        pendingRows.delete(i);
        if (destroyed) return;
        highlightCache.set(i, intervals);
        redrawCardIfVisible(i);
      },
      (err: unknown) => {
        inFlight.delete(p);
        pendingRows.delete(i);
        // 取消 ≠ 失败（code.ts 同语义）：静默不写 DOM；其余错误本卡保持纯文本，
        // 也不抛未处理 rejection（卡片级高亮是增强，不该以报错形态打扰），
        // 但 debug 留痕便于诊断
        if (destroyed || err instanceof HighlightCanceledError) return;
        console.debug('[jsonl] 卡片高亮失败，本卡保持纯文本', err);
      }
    );
    inFlight.add(p);
  }

  function redrawCardIfVisible(i: number): void {
    if (i < curFirst || i > curLast) return;
    const el = viewport.querySelector(`[data-line="${i}"]`);
    if (el) {
      el.replaceWith(buildCard(i));
      scheduleMeasure();
    }
  }

  /** 卡片骨架：gutter(1 起行号) + pre body。实卡与「块被逐出」占位卡共用结构 */
  function cardSkeleton(i: number): { card: HTMLElement; body: HTMLElement } {
    const card = document.createElement('div');
    card.className = 'vv-jsonl-card';
    // 口径：data-line 是 0 基「内容行」序号——切行时已剔除空行/纯空白行，
    // 与原文件行号可相差空行数（gutter 展示号 = data-line + 1，同口径）
    card.dataset.line = String(i);
    const gutter = document.createElement('span');
    gutter.className = 'vv-jsonl-gutter';
    gutter.textContent = String(i + 1);
    const body = document.createElement('pre');
    body.className = 'vv-jsonl-body';
    card.append(gutter, body);
    return { card, body };
  }

  /** 单卡构建：gutter + pre body + 徽标/截断提示/展开按钮按状态挂载 */
  function buildCard(i: number): HTMLElement {
    // 行所需块被块表 LRU 逐出的暂态（lineAvailable 探测）：占位卡——hex「占位 +
    // ensure + 重拉」同型，重拉完成后 refresh 重渲实卡；不进 stateOf（防不可用
    // 文本被 JSON.parse 出错误状态污染解析缓存）
    const { card, body } = cardSkeleton(i);
    if (hooks.lineAvailable !== undefined && !hooks.lineAvailable(i)) return card;
    const st = stateOf(i);

    if (st.kind === 'failed') {
      card.classList.add('vv-jsonl-card-failed');
      card.title = st.reason;
      body.textContent = st.raw; // 巨行（>64KB）时 parse 层已截（truncated 标记）
      card.append(makeBadge('解析失败'));
      if (st.truncated) card.append(makeBadge('行过长，已截断（前 64KB）'));
      return card;
    }
    if (st.kind === 'oversize') {
      body.textContent = st.raw; // 64KB 预览（parse 层已截）
      card.append(makeBadge('行过大（>1MB）'));
      return card;
    }

    // ok 卡片：pretty 行数组切片（T1 口径：prettyLines 以「每行以换行符收尾」计，
    // 可能 = 真实行数 + 1；Array.slice 自动容忍越界恰好全显）。折叠初始态恒 40 行
    // （spec：pretty 后超 40 行默认折叠显示首 40 行，capped 与否不影响初始态）；
    // 展开态全显，封顶卡片（prettyLines>400）截到 400 行，超出走卡片内滚动。
    const realLines = st.pretty.split('\n');
    const c = collapseFor(st.prettyLines);
    const expanded = expandedRows.has(i);
    const visibleLines = expanded
      ? (c.capped ? JSONL_EXPAND_CAP_LINES : st.prettyLines)
      : c.visibleLines;
    const slice = realLines.slice(0, visibleLines);
    const html = highlightedHtml(i, slice);
    if (html !== null) body.innerHTML = html;
    else {
      body.textContent = slice.join('\n');
      requestHighlight(i, st.pretty); // 高亮只发一次（pendingRows 幂等），到达后重绘
    }

    if (expanded && c.capped) {
      // 封顶展开：DOM 已截 400 行再挂卡片内滚动 + 截断提示（N = min(400, 实际行数)，
      // 恰边界（prettyLines=真实+1）不虚报）
      const cap = document.createElement('div');
      cap.className = 'vv-jsonl-cap';
      cap.textContent = `已截断显示（${Math.min(JSONL_EXPAND_CAP_LINES, realLines.length)} 行）`;
      card.append(cap);
      body.style.maxHeight = `${JSONL_CAPPED_BODY_MAX_HEIGHT}px`;
      body.style.overflowY = 'auto';
    }
    if (!expanded && st.prettyLines > JSONL_COLLAPSE_LINES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vv-jsonl-expand';
      btn.textContent = '展开全部';
      btn.addEventListener('click', () => {
        if (destroyed) return;
        expandedRows.add(i);
        redrawCardIfVisible(i); // 全量重渲染该卡片（简单化：不做渐进展开）
      });
      card.append(btn);
    }
    return card;
  }

  function makeBadge(text: string): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'vv-jsonl-badge';
    badge.textContent = text;
    return badge;
  }

  function renderCards(first: number, last: number): void {
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) frag.append(buildCard(i));
    viewport.replaceChildren(frag);
    scheduleMeasure();
  }

  const api: ViewRuntimeApi = {
    refreshStatus,
    setSpacerHeight() {
      spacer.style.height = `${model.total(rows())}px`;
    },
    refresh: () => update(true),
    destroyed: () => destroyed
  };

  /** 窗口循环：滚动/resize → visibleRange → 仅窗口内卡片重绘 + transform 定位 */
  function update(force = false): void {
    if (destroyed) return;
    const { first, last } = visibleRange(model, scroll.scrollTop, scroll.clientHeight, rows(), OVERSCAN);
    if (!force && first === curFirst && last === curLast) return;
    curFirst = first;
    curLast = last;
    hooks.onViewMove?.(first, last); // SUSP-03：锚行捕获源（curFirst 镜像上报）
    viewport.style.transform = `translateY(${model.offsetOf(first)}px)`;
    renderCards(first, last);
    hooks.afterUpdate?.(last, api); // 窗口模式：接近已加载尾部触发续读
  }

  /**
   * 测量修正合并：rAF 一帧一次，批量 measure 后消费 dirty（T2 约定——公开 dirty
   * 由 DOM 适配层置回 false，内部前缀重建标记模型自清）。jsdom 无布局恒 0：跳过
   * 防 0 高污染模型（真实浏览器 offsetHeight 恒正）。
   */
  function scheduleMeasure(): void {
    if (rafId !== null || destroyed) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (destroyed) return;
      for (const el of viewport.children) {
        const h = (el as HTMLElement).offsetHeight;
        if (h > 0) model.measure(Number((el as HTMLElement).dataset.line), h);
      }
      if (model.dirty) {
        spacer.style.height = `${model.total(rows())}px`;
        viewport.style.transform = `translateY(${model.offsetOf(curFirst)}px)`;
        model.dirty = false;
      }
    });
  }

  const onScroll = (): void => {
    hooks.notifyUserAction?.(); // 用户动作：解除续读停机（如有），随后重评单次重试
    update();
  };
  scroll.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => {
    hooks.notifyUserAction?.();
    update();
  });
  ro.observe(scroll);

  spacer.style.height = `${model.total(rows())}px`;
  update(true);

  return {
    destroy() {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      ro.disconnect();
      scroll.removeEventListener('scroll', onScroll);
      // 在途高亮统一 swallow（含 HighlightCanceledError）：tab 切换后 reject 落地
      // 不得成为 unhandled rejection（请求本身不发 cancel，靠 destroyed 拦回写）
      for (const p of inFlight) p.catch(() => {});
      inFlight.clear();
      pendingRows.clear();
      highlightSkippedRows.clear();
      parseCache.clear();
      highlightCache.clear();
      expandedRows.clear();
      scroll.remove();
      target.classList.remove('vv-jsonl');
    },
    // SUSP-03：按 0 基内容行号恢复视口（降级锚定的恢复面；两模式通用）。越界钳到
    // 末行、空窗口 no-op。粗定位=前缀和 offsetOf（实测优先、未测估算外推）+ 同步
    // 重渲锚行窗口（不等异步 scroll 事件，恢复面确定性）；精调=锚行卡片 data-line
    // 定位 + offsetTop 实测位置——offsetTop 相对 viewport 布局原点（transform 不改
    // 布局偏移），须加 translateY（= offsetOf(curFirst)）才是滚动内容坐标：估算与
    // 实测偏差大时粗定位会让锚行漂出视口，精调把它钉回视口顶。锚行未入窗（极端
    // 漂移）保持粗定位，后续滚动事件链自然收敛。
    revealLine(line: number): void {
      if (destroyed || rows() === 0) return;
      const n = Math.max(0, Math.min(line, rows() - 1));
      scroll.scrollTop = model.offsetOf(n);
      update(true);
      const card = viewport.querySelector<HTMLElement>(`[data-line="${n}"]`);
      if (card !== null) scroll.scrollTop = model.offsetOf(curFirst) + card.offsetTop;
    },
    getMeta: meta
  };
}

/**
 * 项 1（遗留清偿波 3）流内嗅探降级出口（jsonlRenderer.render 注入，窗口模式专用）：
 * 流内嗅探判非 UTF-8 时调用——实现走「判出的非 UTF-8」入口回退同路径（memoizedFullRead
 * 补拉 + redetectWithFull 精判 + 全量重渲，>200MB 委托 code 同款）并返回全量重渲实例。
 * 注入在渲染器入口：source/det（redetectWithFull 就地翻转）只在该层可见。缺省（直接
 * 调用面）不嗅探不降级，行为与现状一致。
 */
export interface JsonlWindowedDowngrade {
  onEncodingBroken?: () => Promise<RenderedInstance & { getMeta(): CodeFileMeta }>;
}

/**
 * SUSP-03 降级视口锚定恢复：在「新实例 mount 完成（DOM 可查）之后」调用（降级
 * IIFE 内 await onEncodingBroken 返回后）——按锚行把降级产物滚回原可视首行，语义
 * = 降级后可视首行 ≈ 降级前首行（不回顶）。锚行 <0（首拉期降级：窗口尚未 mount、
 * 视口本就顶置）跳过，现状行为不变。
 *
 * 恢复委托实例的 revealLine（行号锚定，0 基内容行号同口径）：renderCode 委托形态
 * 既有该 API；jsonl 全量形态由本任务在 mountJsonlView 补齐——其内部才是简报裁决
 * 的「data-line 定位 + offsetTop 实测位置」精调面（全量实例是虚拟窗口，mount 后
 * 锚行卡片通常不在 DOM，外部裸 querySelector 必空手而归，故粗定位必须借实例的
 * HeightModel）。实例无 revealLine 的形态（空文件等）跳过——与现状等价，不做半
 * 吊子恢复。
 *
 * 行号域换算（deferred 清偿 Task 5）：anchorLine 是 jsonl 内容行号（索引层剔空行），
 * code revealLine 收物理行号（含空行）——含空行文件直传会向上漂移「锚行前空行数」。
 * 故委托 code 分支以锚行字节偏移（anchorByteOffset = index.offsets[anchorLine] +
 * bomLen，调用方在索引可见处换算）经实例 lineAtOffset（全量模式 lineOffsets 二分）
 * 映射物理行号再 reveal；实例无 lineAtOffset（旧产物/非全量形态）或偏移不可得
 * （anchorByteOffset <0）回退内容行号直传（现状行为，向后兼容）。偏移口径注：
 * jsonl offsets 是字节偏移（CRLF 记 2 字节单终结符）；code lineOffsets 是剥 BOM +
 * CRLF→LF 归一文本的 UTF-16 字符偏移——两侧仅在「非 BOM 纯 ASCII + LF」主态逐字
 * 节精确（>200MB 委托 JSONL 的常态）；带 BOM 时 +bomLen 的 3 字节越界由锚行长度
 * 吸收（锚行 ≥3 字节即仍二分归锚行），但重多字节/全 CRLF 文件的字节-字符差与
 * CRLF 差随锚行**之前所有行累计**、不被锚行长度吸收——偏移量仅为「锚行前累计差
 * ÷ 平均行长」量级的粗定位，可偏多行乃至远端（粗定位语义下仍收敛于 revealLine
 * 精调）。精确映射需字节→字符换算（code 侧持字节域行索引），随后续立项。
 */
function restoreViewportAfterDegrade(
  full: RenderedInstance & { getMeta(): CodeFileMeta },
  anchorLine: number,
  anchorByteOffset = -1
): void {
  if (anchorLine < 0) return;
  const reveal = (full as { revealLine?: (line: number) => void }).revealLine;
  if (typeof reveal !== 'function') return;
  const lineAtOffset = (full as { lineAtOffset?: (offset: number) => number }).lineAtOffset;
  if (anchorByteOffset >= 0 && typeof lineAtOffset === 'function') {
    reveal.call(full, lineAtOffset.call(full, anchorByteOffset));
    return;
  }
  reveal.call(full, anchorLine);
}

/**
 * JSONL 渲染本体（双模式入口）：ctx 存在且 UTF-8 → 窗口流式；否则全量模式
 * （现状路径：!ctx 兼容 / 非 UTF-8 编码，行为逐字节不动）。
 */
export async function renderJsonl(
  buffer: Uint8Array,
  target: HTMLElement,
  det: Detection,
  ctx?: StreamCtx,
  downgrade?: JsonlWindowedDowngrade
): Promise<RenderedInstance & { getMeta(): CodeFileMeta }> {
  if (ctx !== undefined && (det.encoding ?? 'utf-8') === 'utf-8') {
    return renderJsonlWindowed(ctx, target, det, downgrade);
  }
  // —— 全量模式（现状路径，行为不动）——
  // 解码 + 归一（code.ts L537 同款：DECODERS 表 + fatal:false；标签异常容错回落 utf-8）
  let text: string;
  try {
    text = new TextDecoder(DECODERS[det.encoding ?? 'utf-8'], { fatal: false }).decode(buffer);
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
  text = text.replace(/\r\n?/g, '\n'); // CRLF/CR → LF（行索引/高亮偏移全在归一文本上）
  const lines = splitJsonlLines(text); // 丢弃空行/纯空白行（JSONL 惯例）
  const totalRows = lines.length;

  return mountJsonlView(target, det, {
    rowCount: () => totalRows,
    lineAt: (i) => lines[i] ?? '',
    statusText: () => `共 ${totalRows} 行`,
    streamDone: () => true,
    metaSize: () => buffer.length,
    metaLines: () => totalRows
  });
}

/**
 * 窗口模式：BlockStream（256KB）逐块喂 advanceJsonlIndex 流式构建行索引，行文本
 * 经块解码缓存切片/字节拼装，滚动接近已加载尾部续读（spec §4.2）。
 */
async function renderJsonlWindowed(
  ctx: StreamCtx,
  target: HTMLElement,
  det: Detection,
  downgrade?: JsonlWindowedDowngrade
): Promise<RenderedInstance & { getMeta(): CodeFileMeta }> {
  // 实例级取消信号（code.ts 同款，流式硬化 Task 3）：destroy 时取消全部在飞块读
  const readAbort = new AbortController();
  const bs = createBlockStream(ctx, WINDOW_BLOCK_BYTES, {
    maxBlocks: WINDOW_STREAM_MAX_BLOCKS,
    signal: readAbort.signal
  });
  const index: JsonlIndexState = createJsonlIndex(JSONL_OVERSIZE_LINE_BYTES);
  // BOM 剥离（T2→T3 指令①）：恒在文件头=块 0 首，无跨块问题；剥离后索引偏移为
  // 逻辑字节空间，文件字节 = 逻辑偏移 + bomLen
  let bomLen = 0;
  let nextFeed = 0; // 下一个待喂索引的块号
  // 消费契约（T2→T3 指令②）：finishJsonlIndex 之后不得再 advanceJsonlIndex——
  // 此标志后续读全部停机，EOF 确认后滚动零 IO
  let indexFinished = false;
  // 尺寸防线（STREAM_MAX_BYTES，计划 3 Task 2 / B1 统一裁决）：已确认字节超限 →
  // 续读停机。防线在 IO 之前裁决（size 已知构造即知——零读停机；size 未知随
  // 短读探测逐块裁决）。非失败态：不复用错误卡片，仅状态条追加 hex 建议
  let limitReached = false;
  // 项 1（遗留清偿波 3）：流内嗅探判非 UTF-8（head 误判 utf-8 形态）——置位后停喂
  //（防 U+FFFD 扩散），降级经注入出口异步进行。已喂的干净前缀在降级完成前保持可读。
  // 无降级通道（downgrade 缺省）不嗅探：行为与现状一致
  let encodingBroken = false;
  // SUSP-03 降级锚行：窗口实例经 onViewMove 上报的可视首行（curFirst 镜像）。
  // -1 = 窗口尚未 mount（首拉期降级：视口本就顶置，恢复跳过、现状行为不变）
  let viewFirst = -1;
  let downgradePromise: Promise<void> | null = null;
  // 降级产物（全量重渲实例）：窗口实例的 meta lines 委托与复合销毁转投它
  //（ViewerPane 只持窗口实例——render 已先于滚动期降级返回）
  let fullInst: RenderedInstance & { getMeta(): CodeFileMeta } | null = null;

  const startsWithBom = (b: Uint8Array<ArrayBuffer>): boolean =>
    b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

  /** 尺寸防线判定（STREAM_MAX_BYTES）：已确认字节超限 → true。pullBlock 与首屏
   * 并行预取共享同一裁决面——A1 预取发起在 IO 之前必须过同一道闸，超限文件维持
   * 「零读停机」面（防线在 IO 之前裁决，见上注）。 */
  const overStreamLimit = (): boolean =>
    bs.confirmedBytes > STREAM_MAX_BYTES ||
    (ctx.size === null && bs.confirmedBytes >= STREAM_MAX_BYTES);

  /** EOF 收口：atEnd 且已确认字节全部喂完（200-回退全量底座/全量视图需喂到文件尾） */
  function maybeFinish(): void {
    if (indexFinished) return;
    if (bs.atEnd() && nextFeed * bs.blockSize >= bs.confirmedBytes) {
      finishJsonlIndex(index); // 提交悬挂尾行；此后不再 advance（见上契约）
      indexFinished = true;
    }
  }

  /**
   * 拉取下一块（至多一个新块）并喂入索引。块喂入前必经 ensureBlock——head 预置
   * 的部分块（探测头 8KB < 256KB 块）未经整块替换不得进索引/解码（T1→T3 指令③：
   * 未 ensure 的 block(i) 对 head 预置部分块返回截断字节）。
   * 原子性（fix round 1）：ensureBlock 失败上抛时 nextFeed 不推进（ensure 成功后
   * 到 advance 之间无 await、无失败点），配合 BlockStream nextBlock 的成功后推进，
   * 重试（用户滚动动作再触发）拉同一块，块序列不错位。
   */
  const pullBlock = async (): Promise<void> => {
    if (indexFinished || limitReached || encodingBroken) return;
    // 尺寸防线（STREAM_MAX_BYTES）：size 已知超限即停（confirmedBytes 构造即 size，
    // 零读停机面）；size 未知达限即停（项 5 恰界收紧：旧判定 > 允许越限一块 ≤256KB
    // 才停）——不发起会越限的块读。恰等于上限的已知尺寸文件不受影响（> 不触发），
    // 可完整流式至 EOF
    if (overStreamLimit()) {
      limitReached = true; // 超限停机：loadedBytes 不再增长（续读面与 maybeContinue 同步封闭）
      return;
    }
    maybeFinish(); // size 已知空文件：0 块即 EOF，无需任何拉取
    if (indexFinished) return;
    const i = nextFeed;
    const raw = await bs.ensureBlock(i);
    let chunk = raw;
    if (i === 0 && startsWithBom(raw)) {
      bomLen = 3; // 索引/解码前剥离（见上裁决）
      chunk = raw.subarray(3);
    }
    // 项 1：喂块面流内嗅探（每块一次性判定，零非法块不重复嗅探）——单块非法序列
    // 超阈判非 UTF-8：停喂（本块不入索引，干净前缀不受影响），降级经注入出口异步
    // 进行（与「判出的非 UTF-8」入口回退同路径，见 JsonlWindowedDowngrade 注）
    if (downgrade?.onEncodingBroken !== undefined && isSuspiciousUtf8Block(chunk)) {
      encodingBroken = true;
      // SUSP-03 锚行捕获：嗅探判脏此刻窗口实例仍在（降级出口替换 DOM 前可读
      // curFirst），经 viewFirst 闭包快照取值，不改 onEncodingBroken 签名。
      // 锚行字节偏移（deferred 清偿 Task 5）同点换算（index/bomLen 唯一可见处）：
      // 委托 code 形态经实例 lineAtOffset 映射物理行号（restoreViewportAfterDegrade）；
      // 锚行越出已喂索引时置 -1（防御，viewFirst 恒被 visibleRange 钳内理论不可达）
      const anchorLine = viewFirst;
      const anchorByteOffset =
        anchorLine >= 0 && anchorLine < index.offsets.length
          ? index.offsets[anchorLine]! + bomLen
          : -1;
      const p = (async () => {
        fullInst = await downgrade.onEncodingBroken!();
        // 恢复时点 = 新实例 mount 完成（DOM 可查）之后（见 restoreViewportAfterDegrade）
        restoreViewportAfterDegrade(fullInst, anchorLine, anchorByteOffset);
      })();
      downgradePromise = p;
      // 滚动期降级无等待面：空 catch 防 unhandled rejection（首拉期降级经下方
      // await 原始 promise，拒绝照常上抛走渲染期读失败面）
      p.catch(() => {});
      return;
    }
    advanceJsonlIndex(index, chunk);
    nextFeed = i + 1; // 喂入成功才推进
    maybeFinish();
  };

  const rows = (): number => index.offsets.length;

  // 文本窗口（计划 3 Task 2 公共抽取：块解码缓存 LRU + 前缀解码游标 + 跨块字节域
  // 拼装，textWindow.ts）：blockAt 注入 BlockStream 块表取数——驻留性由
  // lineAvailable/has 把关（缺块行在 buildCard 已被占位，不到取数面）
  const win = createTextWindow({
    blockSize: WINDOW_BLOCK_BYTES,
    maxBlocks: BLOCK_TEXT_CACHE_MAX,
    blockAt: (b) => bs.block(b)
  });

  /**
   * 行文本（stateOf 的行来源，见模块头三路）：单块行=块文本缓存切片；跨块行=按
   * 索引 lengths 拼原始字节后单次解码（块切口不打碎跨块多字节字符）；oversized
   * 行不走拼装——行首 4×64KB 字节解码后截 64KB 字符（与全量 parseJsonlLine 的
   * 64KB 字符截断逐字符一致）。解码/拼装面全部经 textWindow（公共抽取）。
   */
  function rawLine(i: number): string {
    const len = index.lengths[i]!;
    const startFile = index.offsets[i]! + bomLen;
    const endFile = startFile + len;
    if (index.oversized.has(i)) {
      // 4×64KB 字节前缀内行首 64K 字符必完整（UTF-8 每字符 ≤4 字节）
      const previewEnd = Math.min(endFile, startFile + JSONL_OVERSIZE_PREVIEW_BYTES * 4);
      return win.decode(win.gather(startFile, previewEnd)).slice(0, JSONL_OVERSIZE_PREVIEW_BYTES);
    }
    const b0 = Math.floor(startFile / win.blockSize);
    const b1 = Math.floor((endFile - 1) / win.blockSize);
    if (b0 !== b1) return win.decode(win.gather(startFile, endFile));
    const entry = win.entryOf(b0);
    const off = startFile - b0 * win.blockSize;
    const cs = win.charOffsetOf(entry, b0, off);
    const ce = win.charOffsetOf(entry, b0, off + len);
    return entry.text.slice(cs, ce);
  }

  let pulling = false;
  // 续读失败停机（fix round 1）：失败后 refresh 重评仍近尾部会无限重试（活锁——
  // CPU 空转），置位后停止自动续读；用户滚动/resize 动作（notifyUserAction）解除，
  // 重评时单次重试（hex.ts「下次用户动作才重试」口径）
  let continueFailed = false;
  // 回看重拉失败停机（M-3 与 code.ts reloadFailed 同款闩）：失败后任何自动
  // update/refresh 不得重试重拉（防活锁），用户滚动/resize 动作（notifyUserAction）
  // 解除后单次重试。当前「失败不 refresh ⇒ 无自动重评」虽已使重试只挂在用户动作上，
  // 但该等价性依赖「jsonl 无其他自动 refresh 入口」的实现细节——闩显式落下使与
  // code.ts 的停机纪律同款，未来新增自动 refresh 面（渐进扫描等）不再依赖隐性约束
  let reloadFailed = false;
  // 回看重拉待办（计划 3 Task 1，B1 块表有界化配套）：lineAvailable 探测到缺块时
  // 登记（Set 去重），maybeContinue 统一 ensureBlock 后 refresh 重渲。同步渲染路径
  // 不能 await——缺块行先渲染占位卡，补块到达由下一次 update 填充（hex「占位 +
  // ensure + 重拉」同型）。
  const pendingReload = new Set<number>();

  /** 行 i 所需块号区间 [b0, b1]：含 oversized 预览跨块（预览字节同样必须驻留） */
  function lineBlockSpan(i: number): [number, number] {
    const startFile = index.offsets[i]! + bomLen;
    const len = index.lengths[i]!;
    const end = index.oversized.has(i)
      ? Math.min(startFile + len, startFile + JSONL_OVERSIZE_PREVIEW_BYTES * 4)
      : startFile + len;
    const b0 = Math.floor(startFile / bs.blockSize);
    return [b0, Math.floor((end - 1) / bs.blockSize)];
  }

  /**
   * 滚动接近已加载尾部（可视末行距尾 ≤ OVERSCAN×2 行）→ 续读下一块并重渲
   * （spec §4.2「滚动接近已加载尾部续读」）。一次一块：完成后 refresh 重评，
   * 仍近尾部则再次触发直至余量充足/EOF。渲染期首拉失败走 render 上抛（读失败
   * 面）；滚动期续读失败自兜底（hex.ts 滚动期 ensure 同口径）：保留已加载内容、
   * 不落错误卡片、debug 留痕，并置停机标志（见上）。
   */
  function maybeContinue(lastVisible: number, api: ViewRuntimeApi): void {
    // 回看重拉优先于续读：缺块占位卡等待补块（与 EOF/尾部距离无关——回看发生在
    // 已加载坐标区，逐块 ensure 后一次 refresh 填充全部占位行）。reloadFailed 停机
    // 闩与 continueFailed 同款：失败后任何自动 update/refresh 不得重试重拉（防活锁），
    // 用户滚动/resize 动作（notifyUserAction）解除后单次重试
    if (pendingReload.size > 0 && !pulling && !reloadFailed && !encodingBroken && !api.destroyed()) {
      const targets = [...pendingReload];
      pendingReload.clear();
      pulling = true;
      void (async () => {
        try {
          for (const b of targets) await bs.ensureBlock(b);
        } catch (err) {
          if (isAbortError(err)) { pulling = false; return; } // 取消（AbortError 身份）：静默，闩不动、不回填待办；pulling 复位（code.ts 同款；判定收紧见 code.ts isAbortError 注）
          for (const b of targets) pendingReload.add(b); // 未完成块回待办（占位卡维持）
          reloadFailed = true;
          console.debug('[jsonl] 回看重拉失败，已停机（滚动后重试）', err);
          pulling = false;
          return; // 失败停机不 refresh（下次用户动作再试，续读失败同口径——防活锁）
        }
        pulling = false;
        if (api.destroyed()) return;
        api.refresh(); // 重渲：占位卡换实卡
      })();
      return;
    }
    if (indexFinished || limitReached || encodingBroken || pulling || continueFailed || api.destroyed()) return;
    if (lastVisible < rows() - OVERSCAN * 2) return; // 距尾部余量充足
    pulling = true;
    void (async () => {
      try {
        await pullBlock();
      } catch (err) {
        if (isAbortError(err)) { pulling = false; return; } // 取消（AbortError 身份）：静默，闩不动；pulling 复位（code.ts 同款；判定收紧见 code.ts isAbortError 注）
        continueFailed = true; // 停机：杜绝「失败→refresh 重评→仍近尾部→再失败」活锁
        console.debug('[jsonl] 流式续读失败，已停机（滚动后重试）', err);
      }
      pulling = false;
      if (api.destroyed()) return;
      if (encodingBroken) return; // 项 1：判非 UTF-8——降级重渲进行中/已完成，窗口面停评
      api.refreshStatus();
      api.setSpacerHeight();
      api.refresh(); // 重渲 + 再评估（停机时 maybeContinue 直返；未停机仍近尾部则续读下一块）
    })();
  }

  // 首屏确保前 2 块（spec §4.2）——A1 并行预取：prefetchThrough(1) 一次 RTT 并发
  // 发出前两块的读（size 未知内部退化为逐块顺序等价；不足两块钳到实际末块/EOF），
  // 喂入仍逐块 pullBlock（ensureBlock 命中已驻留块零 IO，喂入序约束不变）。预取
  // 前置过同一道尺寸防线闸（overStreamLimit）——超限文件维持零读停机面。失败上抛
  // 走渲染期读失败面（dispatcher 口径）。已本地化（全量视图 head 预置全部块 /
  // 200-回退切全量 / 短读已确认 EOF）时排空剩余已确认块——零 IO，仅把索引喂到
  // 文件尾，状态条直接落「共 N 行」。
  if (overStreamLimit()) {
    limitReached = true; // 构造即超限：零读停机（防线在 IO 之前，同 pullBlock 裁决面）
  } else {
    await bs.prefetchThrough(1);
  }
  await pullBlock();
  await pullBlock();
  while (!indexFinished && !encodingBroken && bs.atEnd()) await pullBlock();
  // 项 1：首拉即判非 UTF-8（脏块落在前两块）——降级在此收口：补拉失败经 await
  // 原样上抛（渲染期读失败面，入口回退同口径）；成功直接返回全量重渲实例
  if (encodingBroken && downgradePromise !== null) {
    await downgradePromise;
    return fullInst!;
  }

  const instance = mountJsonlView(target, det, {
    rowCount: rows,
    lineAt: rawLine,
    // 块表 LRU 把关（计划 3 Task 1）：行所需块全部驻留才可渲染/解析；缺块登记
    // 待办并渲染占位卡，maybeContinue 统一重拉后 refresh 填充
    lineAvailable: (i) => {
      const [b0, b1] = lineBlockSpan(i);
      let ok = true;
      for (let b = b0; b <= b1; b++) {
        if (!bs.has(b)) {
          ok = false;
          pendingReload.add(b);
        }
      }
      return ok;
    },
    // 索引层已判 oversized（行字节 ≥1MB）：直接构造 parseJsonlLine 的 oversize
    // 形态——预览 <1MB，若再过 parseJsonlLine 的 encode 阈值会被误判进 JSON.parse
    oversizedState: (i) => (index.oversized.has(i) ? { kind: 'oversize', raw: rawLine(i) } : null),
    statusText: () =>
      (indexFinished ? `共 ${rows()} 行` : `已加载 ${rows()} 行`) +
      (limitReached ? STREAM_LIMIT_NOTICE : ''),
    streamDone: () => indexFinished,
    afterUpdate: maybeContinue,
    // SUSP-03：可视窗口移动上报（降级锚行捕获源，见 viewFirst 注）
    onViewMove: (first) => { viewFirst = first; },
    // 用户动作解除续读/回看停机（单次重试）——code.ts onUserScroll 同口径
    notifyUserAction: () => { continueFailed = false; reloadFailed = false; },
    // 项 D（遗留清偿波 3）：降级后 size 转投全量实例——`ctx.size ?? bs.confirmedBytes`
    // 仍指旧底座，size 未知文件降级后状态栏 size 停在判脏前缀字节数；对齐 code 整体
    // 转投口径（metaLines 同款），降级底座 length 即全量字节数
    metaSize: () => fullInst?.getMeta().size ?? (ctx.size ?? bs.confirmedBytes),
    // 项 1：降级后行数转投全量实例（窗口索引停在判脏前缀，ViewerPane 的 meta 轮询
    // 面须读到全量重渲的行数；encoding 经 det 就地翻转、size 经 ctx.size 天然正确）
    metaLines: () => fullInst?.getMeta().lines ?? rows()
  });
  jsonlWindowedInternals.set(instance, { blockTextCache: win.entries });
  // 项 1：复合销毁——降级产物（全量重渲实例）随宿主一并销毁（ViewerPane 只持窗口
  // 实例）。先毁全量面再走窗口面清理：全量面销毁会摘 target 的 vv-jsonl 类，窗口
  // 面重复移除幂等无害
  const ownDestroy = instance.destroy;
  instance.destroy = () => {
    readAbort.abort(); // 在飞块读即时取消（code.ts 同款：DEG-08 排队根因的修复面）
    fullInst?.destroy();
    ownDestroy();
  };
  return instance;
}

export const jsonlRenderer: Renderer = {
  id: 'jsonl',
  label: 'JSON Lines',
  extensions: ['jsonl', 'ndjson'],
  // streaming（io-streaming 计划 2 Task 4）：dispatcher 只交付 head + StreamCtx，远端
  // jsonl 打开即进窗口模式。回退面均在渲染器内自处（spec §4.2/§5）：非 UTF-8 → 全量
  // 模式（下方探测头补拉保证全量字节在手）；!rangeCapable 的全量视图（ctx.head=全量
  // +同步切片 read）属窗口模式退化形态，BlockStream 零 IO 排空。
  streaming: true,
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection, ctx?: StreamCtx) {
    // 非 UTF-8 全量回退的探测头补拉（回退矩阵收口）：streaming 分支（capable 且
    // size>1MB 或 size 未知）只交付 8KB 探测头作 buffer，窗口模式不收（编码非 UTF-8）
    // ——全量路径若直接解码头部即静默截断。head 未覆盖全文件（size 未知无法排除截断，
    // 或 head 短于 size）时经 ctx.read 拉全量再走下游：>200MB 委托检查也因此对全量
    // 生效，与 streaming 前的交付形态逐字节一致（hex size-未知回退同款 {0,MAX} 形态，
    // Range 端点由服务端钳制）。head 即全量（兼容路径/!capable 全量视图/capable≤1MB
    // 直读——ctx.head.length === ctx.size）不触发，零额外读。
    if (
      ctx !== undefined &&
      (det.encoding ?? 'utf-8') !== 'utf-8' &&
      (ctx.size === null || ctx.head.length < ctx.size)
    ) {
      const head = buffer; // 探测头（head 即全量时守卫不触发，此处必为文件前缀）
      // 项 6（retry 免重拉）：补拉按 ctx 记忆——错误卡片 retry 重入 render 不再
      // 重复全量下载（memoizedFullRead，见 blockStream.ts 注）
      buffer = await memoizedFullRead(ctx);
      // I-2 补拉后编码精判：capable 且 size 未知/超限时 det 仅由 8KB head 判定，截断
      // 多字节可双向误判（误判 gb18030 直接解码即整文件 mojibake）——以全量重算翻转
      // （dispatcher redetectWithFull 同款共享 helper）。误判 gb18030 翻转 utf-8 后，
      // 下方 renderJsonl 以 det.encoding 现值裁决 → 自然落窗口模式（渐进、正确解码）
      redetectWithFull(source, head, buffer, det);
    }
    if (shouldDelegateToCode(buffer.byteLength)) {
      // >200MB：JSONL 逐行解析/逐卡高亮的内存与主线程成本失控，委托 code 纯文本
      // 虚拟滚动（沿用其超限提示条与实例扩展；encoding/ext 透传保证非 UTF-8 解码
      // 一致与状态栏语言段正确）。仅对全量 buffer 生效——窗口模式 buffer 形参是
      // 探测头，永不触发（code 渲染器流式化为计划 3，届时由其 streaming 路径承接）
      return renderCode(buffer, target, { encoding: det.encoding, ext: det.ext, highlight: false, oversizeNotice: true });
    }
    if (ctx === undefined) return renderJsonl(buffer, target, det); // 兼容路径：无流上下文
    return renderJsonl(buffer, target, det, ctx, {
      // 项 1（遗留清偿波 3）：流内嗅探判非 UTF-8 的降级出口——与上方「判出的
      // 非 UTF-8」入口回退同路径（memoizedFullRead 补拉 + redetectWithFull 精判 +
      // 全量重渲；>200MB 委托 code 同款）。注入在渲染器入口：source/det（精判就地
      // 翻转 det.encoding）只在该层可见。head 样本取 ctx.head（dispatcher 交付的
      // 探测头，与入口回退的 redetect 样本同源）
      onEncodingBroken: async () => {
        const full = await memoizedFullRead(ctx);
        redetectWithFull(source, ctx.head, full, det);
        if (shouldDelegateToCode(full.byteLength)) {
          return renderCode(full, target, { encoding: det.encoding, ext: det.ext, highlight: false, oversizeNotice: true });
        }
        return renderJsonl(full, target, det, undefined); // ctx 缺省 → 全量路径（现状）
      }
    });
  }
};
