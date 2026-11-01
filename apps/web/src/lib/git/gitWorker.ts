// gitWorker.ts — git worker 入口 + serve 骨架（git 信息面板 spec，实施计划 Task 1）：
// side-effect 自启动仿 vviewer-highlight 包内 worker（highlight/src/worker.ts:100-103/186
// 的 inWorker() 检测 + serveWorker），经 Vite `new Worker(new URL(...), {type:'module'})`
// 打包为独立 ES module chunk（highlightClient.ts:272 先例）。
//
// 依赖隔离：isomorphic-git 仅经 `import('./gitIso')` 动态引入（worker 启动即拉 chunk，
// 懒加载时机 = ensureGitClient 首建 worker，即首次激活 Git 段）；主线程零静态 isogit
// import。chunk 拉取失败不粘滞——iso 保持 null，下一次操作重新 import（可重试）。
//
// fs 供数：TreeStore 实例只活在主线程——isogit 的每次 fs 调用经反向帧 `{kind:'fs'}`
// 回主线程（gitClient 的 fs 路由 → GitFsAdapter → store），回帧放行。worker 侧缓存
// （Global Constraints「会话级 worker 内存缓存」）：.git/objects 下非 .pack 路径的原始
// 字节（松散对象/idx 不可变，无 LRU，worker 生命周期即会话）；.pack 与解析态 idx 由
// isogit 自身的共享 cache 对象（repoCaches，逐 repoDir）缓存，避免双份内存。
//
// 取消：cancel 帧标记 abortedOps；在途 fs 反向调用立即 reject，isogit promise 链随
// 之 unwind，迟到结果不回帧（client 已 reject）。TreeStore.listChildren 无 signal——
// 列举不可中断为知情降级（spec §2.1）。
import type { PromiseFsClient } from 'isomorphic-git';
import type {
  FsReplyPayload,
  GitBlameResult,
  GitCommitInfo,
  GitFileLogResult,
  GitOpRequest,
  GitStatus,
  GitWorkerIn,
  GitWorkerOut
} from './gitClient';
import {
  BLAME_MAX_COMMITS,
  blameWalk,
  normalizeBlobText,
  splitLines,
  type BlameHistoryEntry
} from './gitDiff';

/** isogit 命名空间（经 gitIso 懒加载边界的 re-export 形状）。 */
type IsoGit = typeof import('./gitIso');

/** worker 上下文（仅真实 Worker/jsdom 环境存在 self）。 */
type WorkerCtx = {
  onmessage: ((ev: MessageEvent<GitWorkerIn>) => void) | null;
  postMessage: (msg: GitWorkerOut) => void;
};

function workerCtx(): WorkerCtx | null {
  return (globalThis as { self?: WorkerCtx }).self ?? null;
}

function inWorker(): boolean {
  // jsdom/Node 下没有 WorkerGlobalScope，不会误绑 onmessage（仿 highlight/worker.ts:100）
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
}

// ---------- isogit 懒加载（失败不粘滞） ----------

let iso: IsoGit | null = null;

async function ensureIso(): Promise<IsoGit> {
  if (iso) return iso;
  const mod = await import('./gitIso');
  iso = mod;
  return mod;
}

// ---------- worker 侧状态 ----------

interface FsWaiter {
  requestId: number;
  resolve: (r: { kind: 'fs-result'; requestId: number; fsId: number } & FsReplyPayload) => void;
  reject: (e: unknown) => void;
}

const fsWaiters = new Map<number, FsWaiter>();
const abortedOps = new Set<number>();
/** 在途操作登记：cancel 帧的守卫（评审 Minor①）——迟到取消（操作已结算/未知 id）
 *  不再入 abortedOps，杜绝 Set 无限累积；runOp finally 与 cancel 守卫双端收口。 */
const activeOps = new Set<number>();
let nextFsId = 1;

/** 会话级对象字节缓存：.git/objects 下非 .pack（松散对象/idx 不可变；.pack 由 isogit
 *  共享 cache 持有，避免双份）。 */
const objectBytes = new Map<string, Uint8Array>();
/** isogit 共享 cache（解析态 pack idx + packfile 字节），逐 repoDir。 */
const repoCaches = new Map<string, Record<string, unknown>>();

function repoCache(repoDir: string): Record<string, unknown> {
  let c = repoCaches.get(repoDir);
  if (!c) {
    c = {};
    repoCaches.set(repoDir, c);
  }
  return c;
}

function canceled(): Error {
  const e = new Error('git 请求已取消');
  e.name = 'GitCanceled';
  return e;
}

/** fs 回帧错误重建：code 原样挂回（评审 C1）——适配层 ENOENT 转写经通道到这里不能
 *  剥码，isogit 松散对象/ref 的 miss 回落链（err.code==='ENOENT' 分流）靠它闭合。 */
function frameError(r: { error: string; code?: string }): Error {
  const e = new Error(r.error);
  if (r.code !== undefined) (e as { code?: string }).code = r.code;
  return e;
}

// ---------- fs 反向通道（isogit 可见的 promises 面） ----------

/** worker 侧仅做键形规范化（剥前导 '/'）；store 前缀映射与越界断言单点在主线程适配层。 */
function canonPath(p: string): string {
  return p.replace(/^\/+/, '');
}

function cacheableObjectPath(key: string): boolean {
  return key.startsWith('.git/objects/') && !key.endsWith('.pack');
}

/**
 * isogit fs promises 面（bindFs 构造期 bind 全部 10 命令——写五件齐备但恒 throw，
 * 只读承诺 worker 侧双保险；isPromiseFs 探测的无参 readFile() 调用由 async 拒绝消化）。
 * 形状对齐 isogit 的 PromiseFsClient['promises']（方法面 Function 级鸭子）。
 */
function makeFs(requestId: number, post: (m: GitWorkerOut) => void): { promises: PromiseFsClient['promises'] } {
  const ask = (op: 'read' | 'readdir' | 'stat' | 'readlink', path: string): Promise<{ kind: 'fs-result'; requestId: number; fsId: number } & FsReplyPayload> => {
    if (abortedOps.has(requestId)) return Promise.reject(canceled());
    const fsId = nextFsId++;
    return new Promise((resolve, reject) => {
      fsWaiters.set(fsId, { requestId, resolve, reject });
      post({ kind: 'fs', requestId, fsId, op, path });
    });
  };
  const readRaw = async (path: string): Promise<Uint8Array> => {
    const key = canonPath(path);
    const hit = cacheableObjectPath(key) ? objectBytes.get(key) : undefined;
    if (hit) return hit;
    const r = await ask('read', key);
    if ('error' in r) throw frameError(r);
    if (!('data' in r)) throw new Error('fs read 回帧缺 data');
    if (cacheableObjectPath(key)) objectBytes.set(key, r.data);
    return r.data;
  };
  const decoder = new TextDecoder();
  const writeBan = (name: string) => async (): Promise<never> => {
    throw new Error(`git fs 只读承诺：worker 侧 ${name} 不可用`);
  };
  return {
    promises: {
    // isogit 两调用形：字符串 'utf8'（discoverGitdir 读 .git 文件，须返回 string）与
    // 选项对象 {encoding:'utf8'}（refs/HEAD 读）；其余（对象/包）返回原始字节。
    readFile: async (path: string, opts?: string | { encoding?: string | null } | null): Promise<string | Uint8Array> => {
      const raw = await readRaw(path);
      const encoding = typeof opts === 'string' ? opts : (opts?.encoding ?? undefined);
      if (encoding === 'utf8' || encoding === 'utf-8') return decoder.decode(raw);
      if (encoding === undefined || encoding === null) return raw;
      // isogit 只产 utf8/无编码两形（1.44.8 实测）；未知 encoding 硬失败，与主线程
      // 适配层同款行为（评审 Minor④ 一致性），避免静默按原始字节歧义
      throw new Error(`git fs readFile 不支持的 encoding: ${String(encoding)}`);
    },
    writeFile: writeBan('writeFile'),
    mkdir: writeBan('mkdir'),
    rmdir: writeBan('rmdir'),
    unlink: writeBan('unlink'),
    symlink: writeBan('symlink'),
    stat: async (path: string) => {
      const r = await ask('stat', canonPath(path));
      if ('error' in r) throw frameError(r);
      if (!('stat' in r)) throw new Error('fs stat 回帧缺 stat');
      const { type, size } = r.stat;
      return {
        isFile: () => type === 'file',
        isDirectory: () => type === 'dir',
        isSymbolicLink: () => false,
        size,
        mtimeMs: 0
      };
    },
    lstat: async (path: string) => {
      const r = await ask('stat', canonPath(path));
      if ('error' in r) throw frameError(r);
      if (!('stat' in r)) throw new Error('fs stat 回帧缺 stat');
      const { type, size } = r.stat;
      return {
        isFile: () => type === 'file',
        isDirectory: () => type === 'dir',
        isSymbolicLink: () => false,
        size,
        mtimeMs: 0
      };
    },
    readdir: async (path: string): Promise<string[]> => {
      const r = await ask('readdir', canonPath(path));
      if ('error' in r) throw frameError(r);
      if (!('entries' in r)) throw new Error('fs readdir 回帧缺 entries');
      return r.entries;
    },
    readlink: async (path: string) => {
      const r = await ask('readlink', canonPath(path));
      if ('error' in r) throw frameError(r);
      throw new Error('git fs readlink 不可用');
    }
    }
  };
}

// ---------- 操作实现（六操作齐备：T2 probe-head/last-commit/status + T3
// blame/file-log/blob-at——diff 视图的两侧字节由调用方经 blob-at 取得后主线程
// unifiedDiff，diff 不设 op） ----------

function isIsoNotFound(e: unknown): boolean {
  return (e as { code?: string }).code === 'NotFoundError' || (e as { name?: string }).name === 'NotFoundError';
}

function toCommitInfo(entry: {
  oid: string;
  commit: {
    message: string;
    author: { name: string; timestamp: number };
    committer: { name: string; timestamp: number };
  };
}): GitCommitInfo {
  return {
    oid: entry.oid,
    author: entry.commit.author.name,
    timestamp: entry.commit.author.timestamp,
    message: entry.commit.message,
    // Task 3 增补（log 展开详情消费 author+committer 时间戳）；接口可选字段，旧
    // 消费面零感知
    committer: entry.commit.committer.name,
    committerTimestamp: entry.commit.committer.timestamp
  };
}

const ISO_ARGS = { dir: '/' as const, gitdir: '.git' as const };

/**
 * blob-at 的 ref 解析：'HEAD' / 40 位完整 oid / '<base>^'（首父——'<base>' 为空或
 * 'HEAD' 时解析 HEAD；否则按完整 oid 取 commit）。根提交无父 → null（clean 模式下
 * 意为「文件由末次提交新增」，调用方以空基线 diff）。ref 不可解析（iso NotFound）
 * → null。
 */
async function resolveRefish(
  isoGit: IsoGit,
  fs: { promises: PromiseFsClient['promises'] },
  cache: Record<string, unknown>,
  ref: string
): Promise<string | null> {
  if (ref.endsWith('^')) {
    const base = ref.slice(0, -1);
    const baseOid =
      base === '' || base === 'HEAD'
        ? await isoGit.resolveRef({ fs, ...ISO_ARGS, ref: 'HEAD' })
        : base;
    const commit = await isoGit.readCommit({ fs, ...ISO_ARGS, oid: baseOid, cache });
    return commit.commit.parent[0] ?? null;
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  try {
    return await isoGit.resolveRef({ fs, ...ISO_ARGS, ref });
  } catch (e) {
    if (isIsoNotFound(e)) return null;
    throw e;
  }
}

async function handleOp(isoGit: IsoGit, msg: GitOpRequest, fs: { promises: PromiseFsClient['promises'] }): Promise<unknown> {
  const cache = repoCache(msg.repoDir);
  switch (msg.kind) {
    case 'probe-head': {
      // HEAD 可读性已在主线程 probe 判定；此处解析分支名（detached → ok:true 无 branch；
      // HEAD 悬挂/仓库半损坏 → ok:false，段内显示不可用而非报错卡）。
      // currentBranch/resolveRef 仅读 refs（无对象库访问），isogit API 无 cache 参数。
      try {
        const branch = await isoGit.currentBranch({ fs, ...ISO_ARGS, fullname: false });
        return branch !== undefined ? { ok: true, branch } : { ok: true };
      } catch {
        return { ok: false };
      }
    }
    case 'last-commit': {
      try {
        const commits = await isoGit.log({ fs, ...ISO_ARGS, filepath: msg.filepath, depth: 1, cache });
        const first = commits[0];
        return { commit: first ? toCommitInfo(first) : null };
      } catch (e) {
        // 路径在 HEAD 无历史（untracked/新文件）→ isogit log 抛 NotFoundError——
        // 口径同「无历史 → commit:null」（注释头既定），T2 信息卡对未跟踪文件消费
        if (isIsoNotFound(e)) return { commit: null };
        throw e;
      }
    }
    case 'status': {
      // 原始字节比对（Global Constraints）：hashBlob(工作区字节) vs HEAD blob oid——
      // CRLF/BOM 原样入 hash，不误报；HEAD 无该路径 → untracked。
      // resolveRef 仅读 refs 无 cache 参数；readBlob 走对象库，共享 cache 生效。
      const headOid = await isoGit.resolveRef({ fs, ...ISO_ARGS, ref: 'HEAD' });
      try {
        const blob = await isoGit.readBlob({ fs, ...ISO_ARGS, oid: headOid, filepath: msg.filepath, cache });
        const { oid } = await isoGit.hashBlob({ object: msg.headBytes });
        return { status: (oid === blob.oid ? 'clean' : 'modified') satisfies GitStatus };
      } catch (e) {
        if (isIsoNotFound(e)) return { status: 'untracked' satisfies GitStatus };
        throw e;
      }
    }
    case 'file-log': {
      // 文件历史（spec §3.4）：isogit log filepath 过滤。截断探测用 depth+1 探针——
      // log 恰好返回 depth 条时无法区分「恰好」与「还有」，多取一条即精确。
      try {
        const want = Math.max(1, Math.min(msg.depth, 200));
        const commits = await isoGit.log({ fs, ...ISO_ARGS, filepath: msg.filepath, depth: want + 1, cache });
        const truncated = commits.length > want;
        const entries = commits.slice(0, want).map(toCommitInfo);
        return { entries, truncated } satisfies GitFileLogResult;
      } catch (e) {
        if (isIsoNotFound(e)) return { entries: [], truncated: false } satisfies GitFileLogResult; // untracked：无历史
        throw e;
      }
    }
    case 'blob-at': {
      // ref 下某路径的 blob（diff 基准面）：ref 支持 'HEAD'、40 位完整 oid、'<ref>^'
      // （首父，clean 模式 HEAD^ 对比与 log 首条目的逐提交 diff 消费）；树内无此路径
      // 或 ref 不可解析 → null（调用方以「该时点无此文件」分流，如末次提交新增文件
      // 的 HEAD^ 侧 = 空）。
      try {
        const oid = await resolveRefish(isoGit, fs, cache, msg.ref);
        if (oid === null) return null;
        const blob = await isoGit.readBlob({ fs, ...ISO_ARGS, oid, filepath: msg.filepath, cache });
        return { oid: blob.oid, bytes: blob.blob };
      } catch (e) {
        if (isIsoNotFound(e)) return null;
        throw e;
      }
    }
    case 'blame': {
      // 行级 blame（spec §3.2，自研）：log(filepath, depth=上限+1 探针) 逆序（旧→新）
      // 逐提交 readBlob，归一切行后 blameWalk 推进行归属。归一口径见 gitDiff.ts 头
      // 注释：blob 与工作区字节都先 normalizeBlobText（BOM 剥+CRLF→LF，渲染行域），
      // 输出行号与渲染 data-line 同域——hover 按 dataset.line 直查。工作区字节在场
      // （调用方经 store.read 原始通道取得）时最终域 = 工作区，新增行落「未提交」
      // 哨兵。untracked（HEAD 无此路径）→ 空归属。
      try {
        const commits = await isoGit.log({
          fs,
          ...ISO_ARGS,
          filepath: msg.filepath,
          depth: BLAME_MAX_COMMITS + 1,
          cache
        });
        const truncated = commits.length > BLAME_MAX_COMMITS;
        const walked = commits.slice(0, BLAME_MAX_COMMITS);
        if (walked.length === 0) return { lines: [], truncated } satisfies GitBlameResult;
        const history: BlameHistoryEntry[] = [];
        for (const c of [...walked].reverse()) {
          const blob = await isoGit.readBlob({ fs, ...ISO_ARGS, oid: c.oid, filepath: msg.filepath, cache });
          history.push({
            oid: c.oid,
            author: c.commit.author.name,
            timestamp: c.commit.author.timestamp,
            message: c.commit.message,
            lines: splitLines(normalizeBlobText(blob.blob))
          });
        }
        const worktreeLines =
          msg.worktreeBytes !== undefined ? splitLines(normalizeBlobText(msg.worktreeBytes)) : null;
        return blameWalk(history, worktreeLines, truncated);
      } catch (e) {
        if (isIsoNotFound(e)) return { lines: [], truncated: false } satisfies GitBlameResult;
        throw e;
      }
    }
    default: {
      const k: string = (msg as { kind: string }).kind;
      throw new Error(`未知 git 请求 kind: ${k}`);
    }
  }
}

// ---------- serve 骨架（仿 highlight serveWorker：排队/报错/迟到帧落空） ----------

async function runOp(msg: GitOpRequest, post: (m: GitWorkerOut) => void): Promise<void> {
  activeOps.add(msg.requestId); // cancel 守卫基线：iso 拉取期间到达的取消也能对上号
  try {
    const isoGit = await ensureIso(); // 拉取失败 → error 帧；下一次操作重新 import
    if (abortedOps.has(msg.requestId)) return;
    const payload = await handleOp(isoGit, msg, makeFs(msg.requestId, post));
    if (abortedOps.has(msg.requestId)) return; // 已取消：client 已 reject，迟到结果不回帧
    post({ kind: 'result', requestId: msg.requestId, op: msg.kind, payload });
  } catch (e) {
    if (abortedOps.has(msg.requestId)) return;
    post({ kind: 'error', requestId: msg.requestId, op: msg.kind, error: e instanceof Error ? e.message : String(e) });
  } finally {
    activeOps.delete(msg.requestId);
    abortedOps.delete(msg.requestId);
  }
}

export function serveGitWorker(): void {
  const ctx = workerCtx();
  if (!ctx) return;
  ctx.onmessage = (ev: MessageEvent<GitWorkerIn>) => {
    const msg = ev.data;
    if (msg.kind === 'fs-result') {
      const w = fsWaiters.get(msg.fsId);
      if (!w) return;
      fsWaiters.delete(msg.fsId);
      // C1：error 帧走 reject 路径——重建时必须挂回 code（适配层 ENOENT 转写经此
      // 抵达 isogit 的 FileSystem.read → isNotFoundError → null 语义），裸 new Error
      // 剥码即断「松散对象 miss → 回落」与可选文件（shallow/packed-refs）容错链
      if ('error' in msg) w.reject(frameError(msg));
      else w.resolve(msg);
      return;
    }
    if (msg.kind === 'cancel') {
      // 迟到取消（操作已结算或未知 id）：不入 abortedOps（评审 Minor① 泄漏面收口）
      if (!activeOps.has(msg.requestId)) return;
      abortedOps.add(msg.requestId);
      // 在途 fs 反向调用立即 reject → isogit promise 链 unwind（长操作在下一跳 fs 读断开）
      for (const [fsId, w] of [...fsWaiters]) {
        if (w.requestId === msg.requestId) {
          fsWaiters.delete(fsId);
          w.reject(canceled());
        }
      }
      return;
    }
    void runOp(msg, (m) => ctx.postMessage(m));
  };
}

if (inWorker()) {
  serveGitWorker();
  // worker 启动即拉 isogit chunk（懒加载时机 = ensureGitClient 首建 worker）；失败静默，
  // iso 保持 null——首次操作时重试 import（可重试语义）
  void ensureIso().catch(() => {});
}
