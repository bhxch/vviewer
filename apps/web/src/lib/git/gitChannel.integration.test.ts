// gitChannel.integration.test.ts — fs 反向通道端到端集成测试（评审 C1 防回归锚点）：
// 真 isomorphic-git（经 gitIso 懒加载边界）+ 内存 fake store + 假双端 worker 通道
//（serveGitWorker 绑 globalThis.self.stub + GitClient 鸭子 Worker），全消息协议跑通
// last-commit/status。锚定「code 透传后 isogit 的 isNotFoundError 消费链通」：loose
// blob miss → 回帧 code:'ENOENT' → isogit 判「对象不在此处」回落 pack → pack 亦无 →
// NotFoundError → worker isIsoNotFound 分流 status:'untracked'。通道任一端剥码则该
// 路径以裸 fs 错误中断，本用例失败。
// 夹具：手工字节序列构造最小 loose 仓库（sha1+zlib，无 pack 解析——评审允许简化）。
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TreeNode, TreeStore } from '@bhxch/vviewer-core';
import { GitClient, type GitWorkerIn, type GitWorkerOut } from './gitClient';
import { serveGitWorker } from './gitWorker';

const enc = new TextEncoder();

// ---------- 最小 loose 仓库字节夹具 ----------

const sha1Hex = (d: Uint8Array): string => createHash('sha1').update(d).digest('hex');
const looseKey = (oid: string): string => `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;

function looseObject(type: 'blob' | 'tree' | 'commit', body: Uint8Array): { oid: string; bytes: Uint8Array<ArrayBuffer> } {
  const header = enc.encode(`${type} ${body.length}\u0000`);
  const raw = new Uint8Array(header.length + body.length);
  raw.set(header);
  raw.set(body, header.length);
  // deflateSync 产物独占自有 ArrayBuffer（收窄标注，TreeStore.read 约束同款）
  return { oid: sha1Hex(raw), bytes: deflateSync(raw) as Uint8Array<ArrayBuffer> };
}

const blobA = looseObject('blob', enc.encode('hello git\n'));
const blobB = looseObject('blob', enc.encode('brave new\n'));

const treeEntry = (mode: string, name: string, oid: string): Uint8Array => {
  const head = enc.encode(`${mode} ${name}\u0000`);
  const bin = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bin[i] = parseInt(oid.slice(i * 2, i * 2 + 2), 16);
  const out = new Uint8Array(head.length + 20);
  out.set(head);
  out.set(bin, head.length);
  return out;
};
const treeBody = new Uint8Array(treeEntry('100644', 'a.txt', blobA.oid).length + treeEntry('100644', 'b.txt', blobB.oid).length);
treeBody.set(treeEntry('100644', 'a.txt', blobA.oid));
treeBody.set(treeEntry('100644', 'b.txt', blobB.oid), treeEntry('100644', 'a.txt', blobA.oid).length);
const tree = looseObject('tree', treeBody);

const commitMessage = 'initial commit\n';
const commitBody = `tree ${tree.oid}\nauthor T <t@t> 1700000000 +0000\ncommitter T <t@t> 1700000000 +0000\n\n${commitMessage}`;
const commit = looseObject('commit', enc.encode(commitBody));

function makeFiles(): Map<string, Uint8Array<ArrayBuffer>> {
  const map = new Map<string, Uint8Array<ArrayBuffer>>();
  const put = (k: string, v: string | Uint8Array<ArrayBuffer>): void => {
    map.set(k, typeof v === 'string' ? enc.encode(v) : v);
  };
  put('.git/HEAD', 'ref: refs/heads/main\n');
  put('.git/config', '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n');
  put('.git/refs/heads/main', `${commit.oid}\n`);
  put(looseKey(blobA.oid), blobA.bytes);
  put(looseKey(blobB.oid), blobB.bytes);
  put(looseKey(tree.oid), tree.bytes);
  put(looseKey(commit.oid), commit.bytes);
  return map;
}

/** 内存 store：read 直查 Map；listChildren 由文件路径派生（真实 store 的目录语义）。 */
function makeStore(files: Map<string, Uint8Array<ArrayBuffer>>): TreeStore {
  return {
    id: 'fixture',
    displayName: () => 'fixture',
    async listChildren(path: string): Promise<TreeNode[]> {
      const prefix = path === '' ? '' : `${path}/`;
      const seen = new Map<string, 'file' | 'dir'>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0]!;
        seen.set(name, rest.includes('/') ? 'dir' : 'file');
      }
      return [...seen].map(([name, kind]) => ({ name, path: prefix + name, kind }));
    },
    async read(path: string) {
      const hit = files.get(path);
      if (!hit) throw new Error(`文件不存在: ${path}`);
      return hit;
    }
  };
}

// ---------- 假双端通道（microtask 异步，形状同真实 postMessage 往返） ----------

let client: GitClient;
let files: Map<string, Uint8Array<ArrayBuffer>>;

/** worker 侧 ctx 桩：serveGitWorker 绑其 onmessage；postMessage 投给 client 侧。 */
let selfStub: {
  onmessage: ((ev: { data: GitWorkerIn }) => void) | null;
  postMessage: (m: GitWorkerOut) => void;
};

const originalSelf = (globalThis as { self?: unknown }).self;

afterAll(() => {
  client.dispose();
  // jsdom 下 self 即 window.self：必须还原，不污染同文件其他用例环境
  (globalThis as { self?: unknown }).self = originalSelf;
});

beforeAll(() => {
  files = makeFiles();
  const clientSide = {
    onmessage: null as ((ev: { data: GitWorkerOut }) => void) | null,
    postMessage: (m: GitWorkerIn): void => {
      queueMicrotask(() => selfStub.onmessage?.({ data: m })); // → worker 处理器
    },
    terminate: (): void => {}
  };
  selfStub = {
    onmessage: null,
    postMessage: (m: GitWorkerOut): void => {
      queueMicrotask(() => clientSide.onmessage?.({ data: m })); // → client 处理器
    }
  };
  (globalThis as { self?: unknown }).self = selfStub;
  serveGitWorker(); // 绑 selfStub.onmessage（jsdom 无 WorkerGlobalScope 不自启动）
  client = new GitClient(clientSide as unknown as Worker);
  client.bindFs('', makeStore(files));
});

describe('fs 反向通道端到端（真 isogit + loose 仓库夹具）', () => {
  it('last-commit：HEAD→ref→commit→tree 全 loose 读链通', async () => {
    const { commit: info } = await client.lastCommit('', 'a.txt');
    expect(info).not.toBeNull();
    expect(info!.oid).toBe(commit.oid);
    expect(info!.message).toBe(commitMessage);
    expect(info!.author).toBe('T');
  });

  it('status：工作区字节 == HEAD blob → clean', async () => {
    await expect(client.statusOf('', 'a.txt', enc.encode('hello git\n'))).resolves.toEqual({ status: 'clean' });
  });

  it('last-commit 无历史路径 → commit:null（isogit 返空即 null 口径）', async () => {
    await expect(client.lastCommit('', 'missing.txt')).resolves.toEqual({ commit: null });
  });

  it('C1 锚定：loose blob miss → ENOENT 透传 → isogit 回落分流 → untracked', async () => {
    // b.txt 的 blob 未被前序用例触碰（worker 侧 objectBytes 未缓存），删除后走
    // 「loose miss（ENOENT）→ pack 亦无 → NotFoundError → untracked」回落链
    files.delete(looseKey(blobB.oid));
    await expect(client.statusOf('', 'b.txt', enc.encode('brave new\n'))).resolves.toEqual({ status: 'untracked' });
  });
});
