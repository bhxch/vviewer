// gitClient.ts — git worker 客户端：消息协议单源 / 单例 / AbortController 取消 / fs 反向
// 通道路由（git 信息面板 spec，实施计划 Task 1；取消骨架仿 vviewer-highlight 的
// pendingOutline/cancelOutline 通道，highlight/src/client.ts:213-250）。
//
// 架构：isomorphic-git 全部计算在 worker（gitWorker.ts 动态 import，主线程零静态
// isogit 依赖——本文件对 isogit 零感知，保证主线程 chunk 不被 isogit 拖累）。store
// 实例只活在主线程——worker 内 isogit 的每次 fs 调用经反向帧 `{kind:'fs'}` 回主线程，
// 由请求发起时按传入 store 捕获的 GitFsAdapter（store + repoDir 路径映射）供数后
// 回帧放行；路由正确性唯一住在该 per-request 捕获（换源后各请求供数互不串）。
//
// 消息面（brief 冻结：全部 { kind, requestId, … } + AbortController 取消）：
// - 主 → worker：六操作请求（probe-head/last-commit/status/blame/file-log/blob-at）、
//   cancel、fs-result（fs 供数回帧）。
// - worker → 主：result/error（按 requestId 结算）、fs（fs 反向请求）。
//
// 取消语义：方法尾参可选 AbortSignal（T2/T3 以段级 AbortController 传入）。abort 即
// 本地 reject（GitCanceledError）+ 下发 cancel 帧；worker 侧拒收该请求的后续 fs 调用
// 并丢弃迟到结果——长操作（大 pack 读取链）在下一跳 fs 读处断开，isogit promise 链
// 随之 unwind。TreeStore.listChildren 无 signal——列举不可中断为知情降级（spec §2.1）。
//
// 失败恢复：worker onerror/onmessageerror → failAll（reject 在途 + 死亡标记 + 单例
// 剔除）——下次 ensureGitClient 重建新 worker（T2 段内重试钮消费）；与 highlight 单例
// 「失败保持 rejected 不重试」不同，git chunk 拉取失败可重试（该 chunk 不进 precache，
// 首次离线激活失败属预期路径）。
//
// 无 $app 依赖的纯模块（markdownImages.ts:2 先例——vitest 直测的解析前提）：SSR
// 守卫以 window 存在性替代 $app/env 的 browser（ensureGitClient 内，见该处注释）。
import type { TreeStore } from '@bhxch/vviewer-core';
import { translate as t, type MessageKey } from '../i18n/core';
import { GitFsAdapter } from './gitFs';

// ---------- 结果形状（T2/T3 消费面） ----------

/** 末次提交/日志条目公共形状：短 hash 与相对日期由 UI 派生（oid.slice/message 首行）。 */
export interface GitCommitInfo {
  oid: string;
  author: string;
  /** epoch 秒（git author timestamp 原始口径） */
  timestamp: number;
  /** 完整 message（subject = 首行） */
  message: string;
  /** Task 3 增补（可选）：committer 名与时间戳——log 条目展开详情消费（spec §3.4
   *  「author+committer 时间戳」）；可选字段，last-commit 旧消费面零感知。 */
  committer?: string;
  committerTimestamp?: number;
}

export type GitStatus = 'clean' | 'modified' | 'untracked';

/** blame 行归属（Task 3 消费；blame 历史上限 200 截断在 worker 内收口）。 */
export interface GitBlameLine {
  sha: string;
  /** 归一后行号（0 起） */
  line: number;
  /** 该提交连续归属行数 */
  numLines: number;
  author: string;
  timestamp: number;
  message: string;
}

export interface GitBlameResult {
  lines: GitBlameLine[];
  truncated: boolean;
}

export interface GitFileLogResult {
  entries: GitCommitInfo[];
  truncated: boolean;
}

export interface GitBlobAtResult {
  oid: string;
  bytes: Uint8Array;
}

// ---------- 消息协议 ----------

export type GitOpKind = 'probe-head' | 'last-commit' | 'status' | 'blame' | 'file-log' | 'blob-at';

/**
 * worker 内错误的稳定错误码（Worker 错误码化强制面，Task 9）：Worker 内读不到主线程
 * locale 且零 i18n import——worker 产生的面向用户错误以「码 + 参数」上行（诊断
 * message 一律英文，仅日志/调试面），主线程按 WORKER_ERROR_KEYS 映射 git.* 键以
 * 当下 locale 翻译（事件时刻取值快照）。isogit 原生错误无码，message 原样上行。
 */
export type GitWorkerErrorCode =
  | 'canceled'
  | 'fs-encoding'
  | 'fs-readlink'
  | 'fs-write-banned'
  | 'bad-fs-reply-read'
  | 'bad-fs-reply-stat'
  | 'bad-fs-reply-entries'
  | 'unknown-op';

export type GitOpRequest =
  | { kind: 'probe-head'; requestId: number; repoDir: string }
  | { kind: 'last-commit'; requestId: number; repoDir: string; filepath: string }
  | { kind: 'status'; requestId: number; repoDir: string; filepath: string; headBytes: Uint8Array }
  | { kind: 'blame'; requestId: number; repoDir: string; filepath: string; worktreeBytes?: Uint8Array }
  | { kind: 'file-log'; requestId: number; repoDir: string; filepath: string; depth: number }
  | { kind: 'blob-at'; requestId: number; repoDir: string; ref: string; filepath: string };

/** 主 → worker 帧：操作请求 / 取消 / fs 供数回帧。 */
export type GitWorkerIn =
  | GitOpRequest
  | { kind: 'cancel'; requestId: number }
  | { kind: 'fs-result'; requestId: number; fsId: number } & FsReplyPayload;

/** worker → 主 帧：结果 / 错误（带码帧携 code/params 供主线程翻译）/ fs 反向请求。 */
export type GitWorkerOut =
  | { kind: 'result'; requestId: number; op: GitOpKind; payload: unknown }
  | {
      kind: 'error';
      requestId: number;
      op: GitOpKind;
      error: string;
      code?: GitWorkerErrorCode;
      params?: Record<string, string>;
    }
  | { kind: 'fs'; requestId: number; fsId: number; op: 'read' | 'readdir' | 'stat' | 'readlink'; path: string };

/** fs 反向请求的回帧载荷（与 kind:'fs-result' 同帧发送；error 与成功载荷互斥）。
 *  entries 为目录名单 string[]（isogit readdir 消费形状，GitPackIndex 包发现用）。
 *  error 可携 code（评审 C1）：GitFsAdapter 的 ENOENT 转写必须原样过通道——isogit
 *  松散对象读 miss 靠 err.code==='ENOENT' 判「不在此处」回落包读取，剥码即断链。 */
export type FsReplyPayload =
  | { data: Uint8Array }
  | { entries: string[] }
  | { stat: { type: 'file' | 'dir'; size: number } }
  | { error: string; code?: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}

/**
 * worker error 帧错误码 → git.* 目录键（Task 9 Worker 错误码化）：码集合与
 * GitWorkerErrorCode 全等（编译期 Record 锁），值域首段恒 'git'。同值同键复用
 * （Task 4 先例）：fs-encoding/fs-readlink 码映射到 gitFs 主线程同串键。
 */
const WORKER_ERROR_KEYS: Record<GitWorkerErrorCode, MessageKey> = {
  canceled: 'git.canceled',
  'fs-encoding': 'git.fs.encoding',
  'fs-readlink': 'git.fs.readlinkUnavailable',
  'fs-write-banned': 'git.worker.fsWriteBanned',
  'bad-fs-reply-read': 'git.worker.badFsReplyRead',
  'bad-fs-reply-stat': 'git.worker.badFsReplyStat',
  'bad-fs-reply-entries': 'git.worker.badFsReplyEntries',
  'unknown-op': 'git.worker.unknownOp'
};

/** t 的松散签名（Task 7 coreTranslateLoose 先例）：键来自 WORKER_ERROR_KEYS 联合、
 *  参数为 worker 上行的结构化克隆 Record——占位符与键的逐 key 对齐由目录聚合机检
 *  ④（zh/en 占位符相等）与本映射表的键值对锁死。 */
type LooseT = (key: MessageKey, params?: Record<string, string>) => string;
const tLoose = t as unknown as LooseT;

/**
 * worker error 帧 → reject Error：带码帧按 WORKER_ERROR_KEYS 映射 git.* 键以当下
 * locale 翻译（事件时刻取值，Task 4 statusNotice 同口径快照）；无码帧（isogit
 * 原生错误）message 原样上行（英文，外部库内容）。
 */
function workerErrorOf(msg: Extract<GitWorkerOut, { kind: 'error' }>): Error {
  const key = msg.code !== undefined ? WORKER_ERROR_KEYS[msg.code] : undefined;
  if (key !== undefined) return new Error(tLoose(key, msg.params));
  return new Error(msg.error);
}

export class GitCanceledError extends Error {
  constructor() {
    super(t('git.canceled'));
    this.name = 'GitCanceled';
  }
}

export class GitClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  /**
   * requestId → 请求发起时捕获的 fs 供数适配器：fs 反向帧按此路由（worker 不传
   * store）。捕获制（供数身份随请求冻结）——换源后新请求携新 store 建新适配器，
   * 在途请求的 fs 帧仍路由到发起时的旧源，跨 tab 同 repoDir 不同源不串（备案修点；
   * 旧实现的 requestId→repoDir 单键查表在此构造下必串）。请求结算即除名（settle/
   * failWorker），适配器随请求生命周期，无会话级积累。
   */
  private readonly opAdapters = new Map<number, GitFsAdapter>();
  private nextId = 1;
  private disposed = false;
  /** worker 致命失败（脚本加载/消息反序列化）：reject 在途 + 短路后续请求。 */
  private dead = false;
  private deadReason = '';

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (ev: MessageEvent<GitWorkerOut>) => {
      const msg = ev.data;
      if (msg.kind === 'fs') {
        void this.serveFs(msg);
        return;
      }
      const p = this.pending.get(msg.requestId);
      if (!p) return; // 已取消请求的迟到帧：安全落空（骨架同 outline 通道）
      this.settle(msg.requestId);
      if (msg.kind === 'result') p.resolve(msg.payload);
      else p.reject(workerErrorOf(msg));
    };
    // worker 脚本 404/MIME 异常/运行期崩溃：onerror 后不再有回包，统一致命收敛
    this.worker.onerror = (ev: ErrorEvent) => {
      const file = ev.filename ? t('git.client.errorFile', { file: ev.filename }) : '';
      this.failWorker(
        t('git.client.workerError', {
          message: ev.message || t('git.client.scriptLoadFailed'),
          file
        })
      );
    };
    this.worker.onmessageerror = () => {
      this.failWorker(t('git.client.msgDeserializeFailed'));
    };
  }

  // ---------- 六操作（brief 冻结方法面；store 参携带供数绑定——fs 反向帧按请求
  // 发起时捕获的适配器供数，repoDir 保留为消息回显字段；尾参 signal 仍为取消口） ----------

  /** HEAD 分支探测（worker 侧 isogit currentBranch；detached HEAD → ok:true 无 branch）。
   *  isogit 调用只吃 ISO_ARGS 固定寻址（dir:'/' + gitdir:'.git'），repoDir 由 fs 适配
   *  层前缀映射消化——无目录参数面（fixwave 终审 Minor：fileDir 死参数趁触达清噪）。 */
  probeHead(repoDir: string, store: TreeStore, signal?: AbortSignal): Promise<{ ok: boolean; branch?: string }> {
    return this.request(
      'probe-head',
      repoDir,
      store,
      (id) => ({ kind: 'probe-head' as const, requestId: id, repoDir }),
      signal
    ) as Promise<{ ok: boolean; branch?: string }>;
  }

  /** 文件末次提交（filepath 过滤的 log depth 1；无历史 → commit:null——untracked 等）。 */
  lastCommit(repoDir: string, filepath: string, store: TreeStore, signal?: AbortSignal): Promise<{ commit: GitCommitInfo | null }> {
    return this.request(
      'last-commit',
      repoDir,
      store,
      (id) => ({ kind: 'last-commit' as const, requestId: id, repoDir, filepath }),
      signal
    ) as Promise<{ commit: GitCommitInfo | null }>;
  }

  /**
   * 工作区状态三态。headBytes 为工作区文件原始字节（store.read(path) 原始通道全量——
   * 原始字节 hash 对比 HEAD blob，CRLF 不误报；参数名沿用 brief 冻结面）。
   */
  statusOf(
    repoDir: string,
    filepath: string,
    headBytes: Uint8Array,
    store: TreeStore,
    signal?: AbortSignal
  ): Promise<{ status: GitStatus }> {
    return this.request(
      'status',
      repoDir,
      store,
      (id) => ({ kind: 'status' as const, requestId: id, repoDir, filepath, headBytes }),
      signal
    ) as Promise<{ status: GitStatus }>;
  }

  /** 行级 blame（Task 3 实现 worker 逻辑；在途请求可取消）。 */
  blame(
    repoDir: string,
    filepath: string,
    worktreeBytes: Uint8Array | undefined,
    store: TreeStore,
    signal?: AbortSignal
  ): Promise<GitBlameResult> {
    return this.request(
      'blame',
      repoDir,
      store,
      (id) => ({ kind: 'blame' as const, requestId: id, repoDir, filepath, worktreeBytes }),
      signal
    ) as Promise<GitBlameResult>;
  }

  /** 文件历史 log（depth ≤50 由调用方约束；Task 3 实现 worker 逻辑）。 */
  fileLog(repoDir: string, filepath: string, depth: number, store: TreeStore, signal?: AbortSignal): Promise<GitFileLogResult> {
    return this.request(
      'file-log',
      repoDir,
      store,
      (id) => ({ kind: 'file-log' as const, requestId: id, repoDir, filepath, depth }),
      signal
    ) as Promise<GitFileLogResult>;
  }

  /** ref 下某路径的 blob（diff/blame 的 HEAD^ 对比面；Task 3 实现 worker 逻辑）。 */
  blobAt(repoDir: string, ref: string, filepath: string, store: TreeStore, signal?: AbortSignal): Promise<GitBlobAtResult | null> {
    return this.request(
      'blob-at',
      repoDir,
      store,
      (id) => ({ kind: 'blob-at' as const, requestId: id, repoDir, ref, filepath }),
      signal
    ) as Promise<GitBlobAtResult | null>;
  }

  /** 取消全部在途请求（各自以 GitCanceledError reject；worker 侧同步丢弃）。 */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancelById(id);
  }

  /** 终止 worker（会话释放面；后续请求短路拒绝）。单例同步剔除（评审 Minor②，与
   *  failWorker 对齐）——disposed 短路仅挡本实例，ensureGitClient 下次重建新 worker。 */
  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.worker.terminate();
    onClientDead(this);
  }

  // ---------- 内部 ----------

  private request(
    op: GitOpKind,
    repoDir: string,
    store: TreeStore,
    build: (id: number) => GitOpRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new GitCanceledError());
    if (this.dead) return Promise.reject(new Error(t('git.client.unavailable', { reason: this.deadReason })));
    if (signal?.aborted) return Promise.reject(new GitCanceledError());
    const id = this.nextId++;
    // 供数身份随请求捕获（冻结）：适配器持传入 store + repoDir 前缀映射（无状态，
    // 构造轻量），请求结算即随 opAdapters 除名。fs 帧路由只认本捕获——换源（后续
    // 请求传入新 store）不影响在途请求的供数来源（旧 repoDir 单键查表则必串）
    this.opAdapters.set(id, new GitFsAdapter(store, repoDir));
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.cancelById(id);
        reject(new GitCanceledError());
      };
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      // 投递失败（worker 已终止等）：登记面已建，必须就地结算 reject——否则 pending
      // 永不落空（评审 Minor③ 泄漏面）
      if (!this.safePost(build(id))) {
        this.settle(id);
        reject(new Error(t('git.client.unavailablePost')));
      }
    });
  }

  /** 本地 reject + 下发 cancel 帧（worker 丢弃该请求结果并断其 fs 在途调用）。 */
  private cancelById(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.settle(id);
    p.reject(new GitCanceledError());
    this.safePost({ kind: 'cancel', requestId: id });
  }

  private settle(id: number): void {
    this.pending.get(id)?.cleanup();
    this.pending.delete(id);
    this.opAdapters.delete(id);
  }

  private failWorker(reason: string): void {
    if (this.dead || this.disposed) return;
    this.dead = true;
    this.deadReason = reason;
    console.error(`[vviewer] git worker failed: ${reason} (next ensureGitClient rebuilds it)`);
    const err = new Error(t('git.client.unavailable', { reason }));
    for (const [, p] of [...this.pending]) p.reject(err);
    this.pending.clear();
    this.opAdapters.clear();
    // 终止失败 worker（fixwave 终审 Minor，与 dispose:248 对齐）：死亡标记只短路本
    // 实例的新请求，不 terminate 则崩溃中的 worker 若持续 onerror 重入，其内的
    // objectBytes/repoCaches 会话缓存无人释放——terminate 即回收，新实例由下次
    // ensureGitClient 重建。
    this.worker.terminate();
    onClientDead(this);
  }

  /** fs 反向供数：worker 的 isogit fs 调用 → 请求发起时捕获的适配器 → 回帧。 */
  private async serveFs(msg: Extract<GitWorkerOut, { kind: 'fs' }>): Promise<void> {
    let payload: FsReplyPayload;
    try {
      payload = await this.computeFs(msg);
    } catch (e) {
      // code 透传（评审 C1）：适配层的 ENOENT 转写必须在回帧中保留，worker 侧重建
      // Error 时挂回——isogit 的 miss 回落链靠该码分流
      const code = (e as { code?: unknown } | null)?.code;
      payload = {
        error: e instanceof Error ? e.message : String(e),
        ...(typeof code === 'string' ? { code } : {})
      };
    }
    this.safePost({ kind: 'fs-result', requestId: msg.requestId, fsId: msg.fsId, ...payload });
  }

  private async computeFs(msg: Extract<GitWorkerOut, { kind: 'fs' }>): Promise<FsReplyPayload> {
    // 捕获制路由：请求发起时冻结的适配器（换源不追改在途请求的供数来源）
    const adapter = this.opAdapters.get(msg.requestId);
    if (!adapter) {
      // 每请求自建适配器，「无登记」只可能是迟到/未知 requestId 的 fs 帧
      //（请求已 settle 除名或 worker 死亡清表后到达）
      throw new Error(t('git.client.fsNoAdapter', { id: msg.requestId }));
    }
    if (msg.op === 'read') {
      // fs 'read' 恒为原始字节：encoding 由 worker 侧 stub 消化（缓存/解码单点）
      return { data: (await adapter.readFile(msg.path)) as Uint8Array };
    }
    if (msg.op === 'readdir') {
      return { entries: await adapter.readdir(msg.path) };
    }
    if (msg.op === 'stat') {
      const st = await adapter.stat(msg.path);
      return { stat: { type: st.isFile() ? 'file' : 'dir', size: st.size } };
    }
    await adapter.readlink(msg.path); // 恒 throw → error 回帧
    return { error: t('git.fs.readlinkUnavailable') };
  }

  /** 投递帧；false = worker 已终止等 postMessage 失败（调用方各自兜底结算）。 */
  private safePost(msg: GitWorkerIn): boolean {
    try {
      this.worker.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------- 单例（ensureGitClient，brief 冻结签名） ----------

let clientPromise: Promise<GitClient> | null = null;
let currentClient: GitClient | null = null;

/** worker 致命失败时由 GitClient 回调：单例剔除——下次 ensure 重建（可重试语义）。 */
function onClientDead(client: GitClient): void {
  if (currentClient === client) {
    currentClient = null;
    clientPromise = null;
  }
}

async function create(): Promise<GitClient> {
  // 仿 highlightClient.ts:272：Vite 打包为独立 ES module worker chunk；
  // isogit 依赖隔离在 worker 入口的动态 import 内（主线程零静态 import）。
  const worker = new Worker(new URL('./gitWorker.ts', import.meta.url), { type: 'module' });
  const client = new GitClient(worker);
  currentClient = client;
  return client;
}

/**
 * 惰性创建/获取单例；SSR 下返回 null（Worker 仅存在于浏览器端）。首次 ensure 即建
 * worker，worker 启动即动态拉取 isomorphic-git chunk（懒加载时机 = 首次激活 Git 段）。
 * 创建失败不缓存 rejected promise（与 highlight 不同）：下次调用重建——chunk 拉取
 * 失败（离线首用）属可重试路径。
 */
export function ensureGitClient(): Promise<GitClient> | null {
  // SSR 守卫：window 存在性判定（冻结面「SSR 返 null」的同步语义 + 本模块「无 $app
  // 依赖纯模块」可直测前提，二者兼得）。kit 客户端构建 window 恒在、服务端渲染恒无
  // ——与 $app/env 的 browser 等价（highlightClient 静态 import 形态的等价替换）。
  if (typeof window === 'undefined') return null;
  if (!clientPromise) {
    clientPromise = create().catch((e: unknown) => {
      clientPromise = null;
      currentClient = null;
      throw e;
    });
  }
  return clientPromise;
}
