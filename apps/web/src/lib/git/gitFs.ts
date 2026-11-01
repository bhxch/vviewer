// gitFs.ts — GitFsAdapter：isomorphic-git fs 接口 → TreeStore read/listChildren 的只读
// 适配层（git 信息面板 spec，实施计划 Task 1）。主线程侧持有 store 实例，经 gitClient
// 的 fs 反向通道为 worker 内 isogit 供数（worker 无法持有结构化克隆的 store 对象）。
//
// isogit 调用形态（brief 冻结）：显式传 `fs: { promises: adapter }` + `dir: '/'` +
// `gitdir: '.git'`——isogit 产出的全部路径相对仓库根（即 store 内 repoPrefix），适配层
// 统一映射 `store.read(repoPrefix + normalize(path))`。
//
// 路径安全（Review Focus）：isogit 内部路径拼接可能产生 `..`（discoverGitdir 对
// gitdir: 相对目标的 join 等）——resolve 语义自实现：逐段消 '.'/'..'，逃出仓库根
// （isogit 视角的 '/'，即 store 内 repoPrefix）即 throw，绝不放行越界读。
//
// 只读承诺（Global Constraints）：writeFile/mkdir/rmdir/unlink/symlink 一律 throw；
// store 无符号链接语义，readlink 同样拒绝（ENOENT 语义，isogit 存在性探测可消化）。
//
// isogit 对 fs 的实调形状（对 node_modules/isomorphic-git/index.js 1.44.8 实测核对）：
// - bindFs 在 FileSystem 构造期 bind 全部 10 个命令——10 个方法必须齐备（缺一即构造
//   期 TypeError 波及所有命令）；isPromiseFs 探测会无参调用 readFile()——async 方法
//   天然返回 rejected promise，可安全消化。
// - readFile 第二参有两形：字符串 'utf8'（discoverGitdir 读 .git 文件，要求返回
//   string——trimRight 消费）与选项对象 { encoding: 'utf8' }（refs/HEAD/config 读）
//   或无 encoding（松散对象/包文件读，要求原始字节）。
// - stat 的存在性探测靠 err.code ∈ {ENOENT, ENOTDIR, *ENS*}（isNotFoundError）；
//   isogit 自己的 NotFoundError.code === 'NotFoundError' 另成一族——store.read 失败
//   统一转写为 code:'ENOENT'，供「松散对象缺失 → 回落包读取」的 isogit 内部链路消化。
//   该码经 fs 反向通道显式透传（回帧 payload.code → worker 侧 frameError 重建挂回），
//   通道任一端剥码即断回落链（评审 C1：packed 仓库 last-commit/status/log 全废）。
// - discoverGitdir 原生处理 `.git` 为文件的 worktree 形态（stat 判 isFile 后读内容
//   跟随 'gitdir: ' 指向）——适配层无需特判。但探测侧（gitProbe）按前缀模型保守
//   挡掉模型外 worktree（gitdir 指向 store 他处，评审 I1 裁决：adapter 单根前缀
//   表达不了，判不可用），能到本适配层的 gitdir: 形态均指向 repoDir 子树内实体。

import type { TreeStore } from '@bhxch/vviewer-core';

/** isogit stat 消费面（FileSystem.exists/statusMatrix 等鸭子读取的最小形状）。 */
export interface GitFsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
}

/**
 * 逐段 resolve（消 '.'/'..'、丢空段）；逃出根（`..` 在空栈上弹出）返回 null。
 * 纯函数，gitProbe 的 gitdir: 目标解析同构复用（worker/主线程各自打包面内单源）。
 */
export function resolveRelPath(p: string): string | null {
  const segs: string[] = [];
  for (const raw of p.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(raw);
  }
  return segs.join('/');
}

/** 带 code:'ENOENT' 的读失败转写：isogit 的 isNotFoundError/存在性探测消费该码。 */
function enoent(path: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? `（${cause.message}）` : '';
  const err = new Error(`git fs ENOENT: ${path}${detail}`);
  (err as { code?: string }).code = 'ENOENT';
  return err;
}

const textDecoder = new TextDecoder();

export class GitFsAdapter {
  /** 归一后的仓库前缀：无前导 '/'、以 '/' 结尾（store 根仓库为 ''）。 */
  private readonly prefix: string;

  /**
   * @param store       文件来源 store（zip/localFs/remote 等，probe 已判定其内可达仓库）
   * @param repoPrefix  仓库根的 store 相对路径（gitProbe 返回的 repoDir，如 '' 或 '/sub/repo'）
   */
  constructor(
    private readonly store: TreeStore,
    repoPrefix: string
  ) {
    const trimmed = repoPrefix.replace(/^\/+|\/+$/g, '');
    this.prefix = trimmed === '' ? '' : `${trimmed}/`;
  }

  /** isogit 路径 → store 相对路径；越界（逃出仓库根）throw。rel 为空（仓库根本身）
   *  时剥掉前缀尾斜杠（store 路径无尾斜杠语义，listChildren('') 即根）。 */
  private mapPath(p: string): string {
    const rel = resolveRelPath(p);
    if (rel === null) throw new Error(`git fs 路径越界（逃出仓库根）: ${p}`);
    if (rel === '') return this.prefix.replace(/\/$/, '');
    return `${this.prefix}${rel}`;
  }

  // ---------- isogit fs promises 面 ----------

  /**
   * encoding 语义对齐 node fs：字符串第二参（discoverGitdir 的 'utf8'）与
   * {encoding:'utf8'} 返回 string；无 encoding/{encoding:null}/'binary' 返回原始字节。
   */
  async readFile(p: string, opts?: string | { encoding?: string | null } | null): Promise<string | Uint8Array> {
    const encoding = typeof opts === 'string' ? opts : (opts?.encoding ?? undefined);
    const storePath = this.mapPath(p);
    let data: Uint8Array;
    try {
      data = await this.store.read(storePath);
    } catch (e) {
      throw enoent(storePath, e);
    }
    if (encoding === 'utf8' || encoding === 'utf-8') return textDecoder.decode(data);
    if (encoding === undefined || encoding === null || encoding === 'binary' || encoding === 'latin1' || encoding === 'ascii') {
      return data;
    }
    throw new Error(`git fs readFile 不支持的 encoding: ${String(encoding)}`);
  }

  /** 经 listChildren(父目录) 推导：kind → isFile/isDirectory，TreeNode.size 透传。 */
  async stat(p: string): Promise<GitFsStat> {
    const rel = resolveRelPath(p);
    if (rel === null) throw enoent(p, new Error('路径越界'));
    if (rel === '') return dirStat(); // 仓库根本身
    const slash = rel.lastIndexOf('/');
    const parent = slash === -1 ? '' : rel.slice(0, slash);
    const name = slash === -1 ? rel : rel.slice(slash + 1);
    const children = await this.listChildrenOf(p, parent);
    const hit = children.find((c) => c.name === name);
    if (!hit) throw enoent(`${this.prefix}${rel}`);
    return hit.kind === 'dir' ? dirStat() : fileStat(hit.size ?? 0);
  }

  /** store 无符号链接语义：与 stat 同形（目录项 kind 已是最终形态）。 */
  async lstat(p: string): Promise<GitFsStat> {
    return this.stat(p);
  }

  /** 目录名单（isogit 消费 string[]——objects/pack 包文件发现等）。 */
  async readdir(p: string): Promise<string[]> {
    const rel = resolveRelPath(p);
    if (rel === null) throw enoent(p, new Error('路径越界'));
    const children = await this.listChildrenOf(p, rel);
    return children.map((c) => c.name);
  }

  async readlink(p: string): Promise<never> {
    throw enoent(p, new Error('store 无符号链接语义，git fs readlink 不可用'));
  }

  // ---------- 只读承诺：写面一律 throw ----------

  async writeFile(): Promise<never> {
    throw new Error('git fs 只读承诺：writeFile 不可用');
  }

  async mkdir(): Promise<never> {
    throw new Error('git fs 只读承诺：mkdir 不可用');
  }

  async rmdir(): Promise<never> {
    throw new Error('git fs 只读承诺：rmdir 不可用');
  }

  async unlink(): Promise<never> {
    throw new Error('git fs 只读承诺：unlink 不可用');
  }

  async symlink(): Promise<never> {
    throw new Error('git fs 只读承诺：symlink 不可用');
  }

  // ---------- 内部 ----------

  /** listChildren 失败（目录不存在/服务器失联）→ ENOENT 转写，路径回填 store 视角。 */
  private async listChildrenOf(p: string, dirRel: string) {
    const storePath = this.mapPath(`/${dirRel}`);
    try {
      return await this.store.listChildren(storePath);
    } catch (e) {
      throw enoent(storePath === '' ? `${p}（目录列表失败）` : storePath, e);
    }
  }
}

function dirStat(): GitFsStat {
  return {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    size: 0,
    mtimeMs: 0
  };
}

function fileStat(size: number): GitFsStat {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    size,
    mtimeMs: 0
  };
}
