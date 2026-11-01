// gitProbe.ts — git 仓库可用性探测（主线程 store.read 直读，零 worker 启动成本——brief
// 裁决）：从文件目录向上 ≤5 级读 `.git/HEAD`，命中即返回仓库根（repoDir）；模块级
// 目录缓存 + 负缓存（同会话不重试）。
//
// 裁决备案（Review Focus）：可用性只随目录定（.git 在不在），缓存不掺 HEAD 内容——
// 切分支不影响可用性判定，HEAD 现值由信息卡读取时经 worker 现取。
//
// `.git` 为文件的 worktree 形态（Global Constraints v1）：读 `gitdir: <path>` 指向并
// 在 store 内可达（指向目录下再读 HEAD 成功）才判可用；不可达/路径逃逸 → 本级不命中
// 继续向上（外层可能是独立仓库）。isogit 的 discoverGitdir 对该形态原生支持，worker
// 侧无需特判。
//
// 来源天然不可用推演（补充上下文实测口径）：url/single 来源的 path 无目录层级（文件
// 自身目录 = 根），probe 在根读 `.git/HEAD`——single/url store 只对自身唯一文件可读，
// 其余 throw → 未命中负缓存，行为自然正确；zip 来源若含完整 .git 则 probe 与后续
// worker 链路天然可用（无需来源特判）。服务端侧：/api/file 读取不过滤 dot 路径
//（storage LocalFs「寻址/读取不过滤」），默认配置下列表也含 dot 条目；--hidden 服务器
// 下仅 stat 型推导受限（isogit 松散对象/包读取走 read 通道，不受影响）。
//
// 失败口径：探测把一切读取失败（404/解析失败/store 瞬态失联）视为「此处无 .git」——
// 失联会话内 git 段不出现且负缓存不重试，重开文件亦然（知情取舍：探测通道保持零
// 重试噪声，store 恢复后重开同目录文件需刷新会话才再探测）。

import type { TreeStore } from '@bhxch/vviewer-core';

export interface GitProbeHit {
  /** 仓库根的 store 相对路径（'' = store 根；GitFsAdapter 的 repoPrefix 原样消费） */
  repoDir: string;
}

/** 命中缓存：目录 → 仓库根。null 值 = 负缓存（同会话不重试）。 */
const probeCache = new Map<string, GitProbeHit | null>();

/** 探测上限（Global Constraints：向上 ≤5 级，含文件自身目录）。 */
const MAX_LEVELS = 5;

/** 测试与会话释放面（store 关闭后缓存随 storeRelease 生命周期失效的场景）。 */
export function clearGitProbeCache(): void {
  probeCache.clear();
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i <= 0 ? '' : filePath.slice(0, i);
}

function parentOf(dir: string): string | null {
  if (dir === '') return null; // 根已到顶
  const i = dir.lastIndexOf('/');
  return i <= 0 ? '' : dir.slice(0, i);
}

function gitHeadPath(dir: string): string {
  return dir === '' ? '.git/HEAD' : `${dir}/.git/HEAD`;
}

/** 目录读 HEAD；`.git` 为文件时解析 gitdir: 指向并验证 store 内可达，否则判可用。 */
async function probeDir(store: TreeStore, dir: string): Promise<GitProbeHit | null> {
  let head: Uint8Array;
  try {
    head = await store.read(gitHeadPath(dir));
  } catch {
    return null; // 404/throw → 上一级（brief 口径：一切读取失败 = 此处无可用 .git）
  }
  const text = new TextDecoder().decode(head);
  if (!text.startsWith('gitdir:')) return { repoDir: dir };
  const target = resolveGitdirTarget(dir, text.slice('gitdir:'.length).trim());
  if (target === null) return null;
  try {
    await store.read(target === '' ? 'HEAD' : `${target}/HEAD`);
  } catch {
    return null; // gitdir: 指向 store 内不可达 → 本级不可用（v1）
  }
  return { repoDir: dir };
}

/**
 * gitdir: 目标 → store 相对路径：相对目标以 `.git` 文件所在目录为基；绝对目标（宿主
 * 绝对路径在 store 内无意义）以 store 根为基。逐段消 '.'/'..'（与 gitFs 的
 * resolveRelPath 同构），逃出基链 → null（不可达）。
 */
function resolveGitdirTarget(dir: string, target: string): string | null {
  const trimmed = target.replace(/\/+$/, '');
  if (trimmed === '') return null;
  // 先入基段再逐段消解：相对目标的 '..' 消的是 .git 所在目录的祖先链
  const segs: string[] = target.startsWith('/') || dir === '' ? [] : dir.split('/');
  for (const raw of trimmed.split('/')) {
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

/**
 * 探测 store 内某文件所在目录向上 ≤5 级是否有可用 git 仓库。结果按目录缓存（键含
 * store.id——同名目录跨 store 不误命中；brief 口径「缓存键=目录路径」的实例隔离补强），
 * 未命中负缓存同会话不重试（同目录重复探测零 store 请求）。
 */
export async function probeGitAvailability(store: TreeStore, filePath: string): Promise<GitProbeHit | null> {
  const dir = dirOf(filePath);
  const key = `${store.id}\u0000${dir}`;
  if (probeCache.has(key)) return probeCache.get(key) ?? null;
  let cur: string | null = dir;
  let hit: GitProbeHit | null = null;
  for (let level = 0; level < MAX_LEVELS && cur !== null; level++) {
    hit = await probeDir(store, cur);
    if (hit) break;
    cur = parentOf(cur);
  }
  const result = hit;
  probeCache.set(key, result);
  return result;
}
