// gitClient.ts — git worker 客户端：消息协议单源 / 单例 / AbortController 取消 / fs 反向
// 通道路由（git 信息面板 spec，实施计划 Task 1；取消骨架仿 vviewer-highlight 的
// pendingOutline/cancelOutline 通道，highlight/src/client.ts:213-250）。
//
// 架构：isomorphic-git 全部计算在 worker（gitWorker.ts 动态 import，主线程零静态
// isogit 依赖——本文件对 isogit 零感知，保证主线程 chunk 不被 isogit 拖累）。store
// 实例只活在主线程——worker 内 isogit 的每次 fs 调用经反向帧 `{kind:'fs'}` 回主线程，
// 由 bindFs 登记的 GitFsAdapter（store + repoDir 路径映射）供数后回帧放行。
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
import { browser } from '$app/env';
import type { TreeStore } from '@bhxch/vviewer-core';
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

export type GitOpRequest =
  | { kind: 'probe-head'; requestId: number; repoDir: string; fileDir: string }
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

/** worker → 主 帧：结果 / 错误 / fs 反向请求。 */
export type GitWorkerOut =
  | { kind: 'result'; requestId: number; op: GitOpKind; payload: unknown }
  | { kind: 'error'; requestId: number; op: GitOpKind; error: string }
  | { kind: 'fs'; requestId: number; fsId: number; op: 'read' | 'readdir' | 'stat' | 'readlink'; path: string };

/** fs 反向请求的回帧载荷（与 kind:'fs-result' 同帧发送；error 与成功载荷互斥）。
 *  entries 为目录名单 string[]（isogit readdir 消费形状，GitPackIndex 包发现用）。 */
export type FsReplyPayload =
  | { data: Uint8Array }
  | { entries: string[] }
  | { stat: { type: 'file' | 'dir'; size: number } }
  | { error: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}

export class GitCanceledError extends Error {
  constructor() {
    super('git 请求已取消');
    this.name = 'GitCanceled';
  }
}

export class GitClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  /** requestId → repoDir：fs 反向帧路由到 bindFs 登记的适配器（worker 不传 store）。 */
  private readonly opRepos = new Map<number, string>();
  private readonly stores = new Map<string, TreeStore>();
  private readonly adapters = new Map<string, GitFsAdapter>();
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
      else p.reject(new Error(msg.error));
    };
    // worker 脚本 404/MIME 异常/运行期崩溃：onerror 后不再有回包，统一致命收敛
    this.worker.onerror = (ev: ErrorEvent) => {
      const file = ev.filename ? `（${ev.filename}）` : '';
      this.failWorker(`worker 错误：${ev.message || '脚本加载失败'}${file}`);
    };
    this.worker.onmessageerror = () => {
      this.failWorker('worker 消息反序列化失败（onmessageerror）');
    };
  }

  /**
   * 登记 repoDir → store 的 fs 供数（T2 probe 命中后调用；同 repoDir 重复登记以最新
   * store 为准——同仓库多 tab 换源场景）。GitFsAdapter 懒建并复用（路径映射无状态）。
   */
  bindFs(repoDir: string, store: TreeStore): void {
    this.stores.set(repoDir, store);
    this.adapters.delete(repoDir); // 换源强制重建（store 实例身份变化）
  }

  // ---------- 六操作（brief 冻结方法面；尾参 signal 为取消口） ----------

  /** HEAD 分支探测（worker 侧 isogit currentBranch；detached HEAD → ok:true 无 branch）。 */
  probeHead(repoDir: string, fileDir: string, signal?: AbortSignal): Promise<{ ok: boolean; branch?: string }> {
    return this.request(
      'probe-head',
      repoDir,
      (id) => ({ kind: 'probe-head' as const, requestId: id, repoDir, fileDir }),
      signal
    ) as Promise<{ ok: boolean; branch?: string }>;
  }

  /** 文件末次提交（filepath 过滤的 log depth 1；无历史 → commit:null——untracked 等）。 */
  lastCommit(repoDir: string, filepath: string, signal?: AbortSignal): Promise<{ commit: GitCommitInfo | null }> {
    return this.request(
      'last-commit',
      repoDir,
      (id) => ({ kind: 'last-commit' as const, requestId: id, repoDir, filepath }),
      signal
    ) as Promise<{ commit: GitCommitInfo | null }>;
  }

  /**
   * 工作区状态三态。headBytes 为工作区文件原始字节（store.read(path) 原始通道全量——
   * 原始字节 hash 对比 HEAD blob，CRLF 不误报；参数名沿用 brief 冻结面）。
   */
  statusOf(repoDir: string, filepath: string, headBytes: Uint8Array, signal?: AbortSignal): Promise<{ status: GitStatus }> {
    return this.request(
      'status',
      repoDir,
      (id) => ({ kind: 'status' as const, requestId: id, repoDir, filepath, headBytes }),
      signal
    ) as Promise<{ status: GitStatus }>;
  }

  /** 行级 blame（Task 3 实现 worker 逻辑；在途请求可取消）。 */
  blame(
    repoDir: string,
    filepath: string,
    worktreeBytes?: Uint8Array,
    signal?: AbortSignal
  ): Promise<GitBlameResult> {
    return this.request(
      'blame',
      repoDir,
      (id) => ({ kind: 'blame' as const, requestId: id, repoDir, filepath, worktreeBytes }),
      signal
    ) as Promise<GitBlameResult>;
  }

  /** 文件历史 log（depth ≤50 由调用方约束；Task 3 实现 worker 逻辑）。 */
  fileLog(repoDir: string, filepath: string, depth: number, signal?: AbortSignal): Promise<GitFileLogResult> {
    return this.request(
      'file-log',
      repoDir,
      (id) => ({ kind: 'file-log' as const, requestId: id, repoDir, filepath, depth }),
      signal
    ) as Promise<GitFileLogResult>;
  }

  /** ref 下某路径的 blob（diff/blame 的 HEAD^ 对比面；Task 3 实现 worker 逻辑）。 */
  blobAt(repoDir: string, ref: string, filepath: string, signal?: AbortSignal): Promise<GitBlobAtResult | null> {
    return this.request(
      'blob-at',
      repoDir,
      (id) => ({ kind: 'blob-at' as const, requestId: id, repoDir, ref, filepath }),
      signal
    ) as Promise<GitBlobAtResult | null>;
  }

  /** 取消全部在途请求（各自以 GitCanceledError reject；worker 侧同步丢弃）。 */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancelById(id);
  }

  /** 终止 worker（会话释放面；后续请求短路拒绝）。 */
  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.worker.terminate();
    this.stores.clear();
    this.adapters.clear();
  }

  // ---------- 内部 ----------

  private request(op: GitOpKind, repoDir: string, build: (id: number) => GitOpRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new GitCanceledError());
    if (this.dead) return Promise.reject(new Error(`git worker 不可用：${this.deadReason}`));
    if (signal?.aborted) return Promise.reject(new GitCanceledError());
    const id = this.nextId++;
    this.opRepos.set(id, repoDir);
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
      this.worker.postMessage(build(id));
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
    this.opRepos.delete(id);
  }

  private failWorker(reason: string): void {
    if (this.dead || this.disposed) return;
    this.dead = true;
    this.deadReason = reason;
    console.error(`[vviewer] git worker 失败：${reason}（下次 ensureGitClient 重建）`);
    const err = new Error(`git worker 不可用：${reason}`);
    for (const [, p] of [...this.pending]) p.reject(err);
    this.pending.clear();
    this.opRepos.clear();
    onClientDead(this);
  }

  /** fs 反向供数：worker 的 isogit fs 调用 → bindFs 登记的适配器 → 回帧。 */
  private async serveFs(msg: Extract<GitWorkerOut, { kind: 'fs' }>): Promise<void> {
    let payload: FsReplyPayload;
    try {
      payload = await this.computeFs(msg);
    } catch (e) {
      payload = { error: e instanceof Error ? e.message : String(e) };
    }
    this.safePost({ kind: 'fs-result', requestId: msg.requestId, fsId: msg.fsId, ...payload });
  }

  private async computeFs(msg: Extract<GitWorkerOut, { kind: 'fs' }>): Promise<FsReplyPayload> {
    const repoDir = this.opRepos.get(msg.requestId);
    const store = repoDir !== undefined ? this.stores.get(repoDir) : undefined;
    if (!store || repoDir === undefined) {
      throw new Error(`fs 供数无登记：repoDir 未绑定（requestId=${msg.requestId}）`);
    }
    let adapter = this.adapters.get(repoDir);
    if (!adapter) {
      adapter = new GitFsAdapter(store, repoDir);
      this.adapters.set(repoDir, adapter);
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
    return { error: 'git fs readlink 不可用' };
  }

  private safePost(msg: GitWorkerIn): void {
    try {
      this.worker.postMessage(msg);
    } catch {
      // worker 已终止等场景：结算路径已各自 reject，此处静默
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
  if (!browser) return null;
  if (!clientPromise) {
    clientPromise = create().catch((e: unknown) => {
      clientPromise = null;
      currentClient = null;
      throw e;
    });
  }
  return clientPromise;
}
