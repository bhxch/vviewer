// gitProbe.test.ts — probeGitAvailability 结构测试（git 信息面板 Task 1 Step 1）：
// 向上 ≤5 级命中、根到顶未命中负缓存、.git 为文件的 gitdir: 解析（相对/绝对目标、
// 可达→可用/不可达→不可用）、负缓存同会话不重试（fake store 调用计数）。
// probeCache 为模块级：每用例独立 store.id + clearGitProbeCache 双保险。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TreeStore } from '@bhxch/vviewer-core';
import { clearGitProbeCache, probeGitAvailability } from './gitProbe';

const enc = new TextEncoder();

interface ProbeStore extends TreeStore {
  reads: string[];
}

function makeProbeStore(seq: number, files: Record<string, string>): ProbeStore {
  const reads: string[] = [];
  const map = new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)] as const));
  return {
    id: `fake-${seq}`,
    displayName: () => `fake-${seq}`,
    reads,
    async listChildren() {
      throw new Error('probe 不应触发 listChildren');
    },
    async read(path: string) {
      reads.push(path);
      const hit = map.get(path);
      if (!hit) throw new Error(`文件不存在: ${path}`);
      return hit;
    }
  };
}

const HEAD = 'ref: refs/heads/main\n';

describe('probeGitAvailability 向上探测', () => {
  beforeEach(() => clearGitProbeCache());
  afterEach(() => clearGitProbeCache());

  it('自身目录命中：repoDir 为根（store 根仓库）', async () => {
    const store = makeProbeStore(1, { '.git/HEAD': HEAD });
    const hit = await probeGitAvailability(store, 'README.md');
    expect(hit).toEqual({ repoDir: '' });
    expect(store.reads).toEqual(['.git/HEAD']);
  });

  it('向上 4 级命中：repoDir 为仓库根目录', async () => {
    const store = makeProbeStore(2, { 'a/.git/HEAD': HEAD });
    const hit = await probeGitAvailability(store, 'a/b/c/d/f.md');
    expect(hit).toEqual({ repoDir: 'a' });
    expect(store.reads).toEqual(['a/b/c/d/.git/HEAD', 'a/b/c/.git/HEAD', 'a/b/.git/HEAD', 'a/.git/HEAD']);
  });

  it('≤5 级上限：仓库在文件目录第 5 级之外探测不到', async () => {
    const store = makeProbeStore(3, { 'p/.git/HEAD': HEAD });
    // 目录链 p/q/r/s/t/u（6 层）：5 级读取止于 p/q——'p' 层 .git 不可达
    const hit = await probeGitAvailability(store, 'p/q/r/s/t/u/v.md');
    expect(hit).toBeNull();
    expect(store.reads).toEqual([
      'p/q/r/s/t/u/.git/HEAD',
      'p/q/r/s/t/.git/HEAD',
      'p/q/r/s/.git/HEAD',
      'p/q/r/.git/HEAD',
      'p/q/.git/HEAD'
    ]);
  });

  it('根到顶未命中：负缓存后同目录重探零 store 请求', async () => {
    const store = makeProbeStore(4, {});
    expect(await probeGitAvailability(store, 'x/y.md')).toBeNull();
    expect(store.reads).toEqual(['x/.git/HEAD', '.git/HEAD']);
    expect(await probeGitAvailability(store, 'x/z.md')).toBeNull();
    expect(store.reads).toEqual(['x/.git/HEAD', '.git/HEAD']);
  });

  it('命中缓存：同目录不同文件复用（零新增请求）', async () => {
    const store = makeProbeStore(5, { '.git/HEAD': HEAD });
    await probeGitAvailability(store, 'a.md');
    await probeGitAvailability(store, 'b.md');
    expect(store.reads).toEqual(['.git/HEAD']);
  });
});

describe('probeGitAvailability .git 为文件（worktree gitdir: 形态）', () => {
  beforeEach(() => clearGitProbeCache());
  afterEach(() => clearGitProbeCache());

  it('gitdir: 相对目标 store 内可达 → 可用（repoDir 为 .git 文件所在目录）', async () => {
    const store = makeProbeStore(11, {
      'wt/.git/HEAD': 'gitdir: ../main/.git/worktrees/wt\n',
      'main/.git/worktrees/wt/HEAD': HEAD
    });
    const hit = await probeGitAvailability(store, 'wt/code.ts');
    expect(hit).toEqual({ repoDir: 'wt' });
    expect(store.reads).toEqual(['wt/.git/HEAD', 'main/.git/worktrees/wt/HEAD']);
  });

  it('gitdir: 绝对目标按 store 根相对解释，可达 → 可用', async () => {
    const store = makeProbeStore(12, {
      'wt/.git/HEAD': 'gitdir: /main/.git/worktrees/wt\n',
      'main/.git/worktrees/wt/HEAD': HEAD
    });
    expect(await probeGitAvailability(store, 'wt/code.ts')).toEqual({ repoDir: 'wt' });
  });

  it('gitdir: 不可达 → 本级不可用，继续向上直至未命中', async () => {
    const store = makeProbeStore(13, { 'wt/.git/HEAD': 'gitdir: ../nowhere\n' });
    expect(await probeGitAvailability(store, 'wt/code.ts')).toBeNull();
    expect(store.reads).toEqual(['wt/.git/HEAD', 'nowhere/HEAD', '.git/HEAD']);
  });

  it('gitdir: 路径逃逸（.. 出根）→ 不可达', async () => {
    const store = makeProbeStore(14, { 'wt/.git/HEAD': 'gitdir: ../../outside\n' });
    expect(await probeGitAvailability(store, 'wt/code.ts')).toBeNull();
    // 逃逸路径不产生第二次读取（resolve 阶段即判不可达）
    expect(store.reads).toEqual(['wt/.git/HEAD', '.git/HEAD']);
  });
});
