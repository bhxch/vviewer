// gitChannel.integration.test.ts — fs 反向通道端到端集成测试（评审 C1 防回归锚点）：
// 真 isomorphic-git（经 gitIso 懒加载边界）+ 内存 fake store + 假双端 worker 通道
//（serveGitWorker 绑 globalThis.self.stub + GitClient 鸭子 Worker），全消息协议跑通
// last-commit/status + T3 file-log/blob-at/blame。锚定「code 透传后 isogit 的
// isNotFoundError 消费链通」：loose blob miss → 回帧 code:'ENOENT' → isogit 判「对象
// 不在此处」回落 pack → pack 亦无 → NotFoundError → worker isIsoNotFound 分流
// status:'untracked'。通道任一端剥码则该路径以裸 fs 错误中断，本用例失败。
// 夹具：手工字节序列构造最小 loose 仓库（sha1+zlib，无 pack 解析——评审允许简化），
// Task 3 扩四提交链：c1 建档 → c2 改写（parent 指回 c1）→ c3 删除 a.txt → c4 同路径
// 重建（评审 Minor① force 语义向量）供 log/blame/HEAD^/删除轮全覆盖。
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
// Task 3：a.txt 的第二版（commit2 改写）与 CRLF 工作区向量（归一后与 blobC 同行域）
const blobC = looseObject('blob', enc.encode('hello git v2\n'));
// 评审 Minor①：a.txt 的重建版（c3 删除 → c4 同路径重建）——log force 语义向量
const blobD = looseObject('blob', enc.encode('reborn content\n'));

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

// Task 3 两提交链：tree2 只改写 a.txt → blobC（b.txt 保持 blobB，log filepath 过滤向量）
const tree2Body = new Uint8Array(treeEntry('100644', 'a.txt', blobC.oid).length + treeEntry('100644', 'b.txt', blobB.oid).length);
tree2Body.set(treeEntry('100644', 'a.txt', blobC.oid));
tree2Body.set(treeEntry('100644', 'b.txt', blobB.oid), treeEntry('100644', 'a.txt', blobC.oid).length);
const tree2 = looseObject('tree', tree2Body);

const commit2Message = 'second commit\n';
const commit2Body = `tree ${tree2.oid}\nparent ${commit.oid}\nauthor U <u@t> 1700001000 +0000\ncommitter V <v@t> 1700002000 +0000\n\n${commit2Message}`;
const commit2 = looseObject('commit', enc.encode(commit2Body));

// 评审 Minor① 删除重建链：c3 只删 a.txt（b.txt 保持——C1 锚定的回落链不受影响），
// c4 同路径重建 a.txt → blobD。无 force 时 log(filepath='a.txt') 走到 c3 读 blob
// NotFound 即 throw；force 使删除轮照常入列。
const tree3Body = treeEntry('100644', 'b.txt', blobB.oid);
const tree3 = looseObject('tree', tree3Body);

const commit3Message = 'delete a.txt\n';
const commit3Body = `tree ${tree3.oid}\nparent ${commit2.oid}\nauthor T <t@t> 1700003000 +0000\ncommitter T <t@t> 1700003000 +0000\n\n${commit3Message}`;
const commit3 = looseObject('commit', enc.encode(commit3Body));

const tree4Body = new Uint8Array(treeEntry('100644', 'a.txt', blobD.oid).length + treeEntry('100644', 'b.txt', blobB.oid).length);
tree4Body.set(treeEntry('100644', 'a.txt', blobD.oid));
tree4Body.set(treeEntry('100644', 'b.txt', blobB.oid), treeEntry('100644', 'a.txt', blobD.oid).length);
const tree4 = looseObject('tree', tree4Body);

const commit4Message = 'rebuild a.txt\n';
const commit4Body = `tree ${tree4.oid}\nparent ${commit3.oid}\nauthor T <t@t> 1700004000 +0000\ncommitter T <t@t> 1700004000 +0000\n\n${commit4Message}`;
const commit4 = looseObject('commit', enc.encode(commit4Body));

function makeFiles(): Map<string, Uint8Array<ArrayBuffer>> {
  const map = new Map<string, Uint8Array<ArrayBuffer>>();
  const put = (k: string, v: string | Uint8Array<ArrayBuffer>): void => {
    map.set(k, typeof v === 'string' ? enc.encode(v) : v);
  };
  put('.git/HEAD', 'ref: refs/heads/main\n');
  put('.git/config', '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n');
  put('.git/refs/heads/main', `${commit4.oid}\n`);
  put(looseKey(blobA.oid), blobA.bytes);
  put(looseKey(blobB.oid), blobB.bytes);
  put(looseKey(blobC.oid), blobC.bytes);
  put(looseKey(blobD.oid), blobD.bytes);
  put(looseKey(tree.oid), tree.bytes);
  put(looseKey(tree2.oid), tree2.bytes);
  put(looseKey(tree3.oid), tree3.bytes);
  put(looseKey(tree4.oid), tree4.bytes);
  put(looseKey(commit.oid), commit.bytes);
  put(looseKey(commit2.oid), commit2.bytes);
  put(looseKey(commit3.oid), commit3.bytes);
  put(looseKey(commit4.oid), commit4.bytes);
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
  it('last-commit：HEAD→ref→commit→tree 全 loose 读链通（filepath 过滤各自末次）', async () => {
    // a.txt 末次 = commit4（重建轮），b.txt 末次 = c1（后续提交未触）——filepath
    // 过滤在四提交链上正确落点
    const a = await client.lastCommit('', 'a.txt');
    expect(a.commit).not.toBeNull();
    expect(a.commit!.oid).toBe(commit4.oid);
    expect(a.commit!.message).toBe(commit4Message);
    expect(a.commit!.author).toBe('T');
    const b = await client.lastCommit('', 'b.txt');
    expect(b.commit!.oid).toBe(commit.oid);
    expect(b.commit!.author).toBe('T');
  });

  it('status：工作区字节 == HEAD blob → clean', async () => {
    await expect(client.statusOf('', 'a.txt', enc.encode('reborn content\n'))).resolves.toEqual({ status: 'clean' });
  });

  it('last-commit 无历史路径 → commit:null（isogit 返空即 null 口径）', async () => {
    await expect(client.lastCommit('', 'missing.txt')).resolves.toEqual({ commit: null });
  });

  it('C1 锚定：loose blob miss → ENOENT 透传 → isogit 回落分流 → untracked', async () => {
    // b.txt 的 blob 未被前序用例触碰（worker 侧 objectBytes 未缓存），删除后走
    // 「loose miss（ENOENT）→ pack 亦无 → NotFoundError → untracked」回落链；
    // 断言后还原——后续用例（HEAD^ 链的 b.txt 直取）仍需该 loose 对象在库
    files.delete(looseKey(blobB.oid));
    await expect(client.statusOf('', 'b.txt', enc.encode('brave new\n'))).resolves.toEqual({ status: 'untracked' });
    files.set(looseKey(blobB.oid), blobB.bytes);
  });
});

describe('T3 操作：file-log / blob-at / blame（真 isogit + 四提交删除重建链）', () => {
  it('file-log：filepath 过滤 + 新旧序 + committer 增补 + 截断探针', async () => {
    const full = await client.fileLog('', 'a.txt', 50);
    expect(full.truncated).toBe(false);
    expect(full.entries.map((e) => e.oid)).toEqual([commit4.oid, commit3.oid, commit2.oid, commit.oid]);
    // log 详情消费面（spec §3.4）：committer 与 author 可异（夹具 c2 = author U/committer V）
    expect(full.entries[2]!.author).toBe('U');
    expect(full.entries[2]!.committer).toBe('V');
    expect(full.entries[2]!.committerTimestamp).toBe(1700002000);
    // b.txt 只在 c1 变过：单条
    const bLog = await client.fileLog('', 'b.txt', 50);
    expect(bLog.entries.map((e) => e.oid)).toEqual([commit.oid]);
    // depth 1 命中截断（链上有 4 条）
    const cut = await client.fileLog('', 'a.txt', 1);
    expect(cut.entries.map((e) => e.oid)).toEqual([commit4.oid]);
    expect(cut.truncated).toBe(true);
    // untracked：空列表非错误
    await expect(client.fileLog('', 'missing.txt', 50)).resolves.toEqual({ entries: [], truncated: false });
  });

  it('评审 Minor① 锚定：删除后同路径重建，force 使历史含删除轮、blame 非空归重建轮', async () => {
    // 无 force 时 isogit log 走到 c3（删除提交）读 blob NotFound 即 throw——被
    // worker 分流吞成「空历史/空归属」；force: true + blame 删除轮空 blob 容错使
    // 四轮齐列、归属落 c4（重建提交）
    const log = await client.fileLog('', 'a.txt', 50);
    expect(log.entries.map((e) => e.oid)).toContain(commit3.oid); // 删除轮在列
    expect(log.entries).toHaveLength(4);
    const r = await client.blame('', 'a.txt');
    expect(r.lines).not.toHaveLength(0);
    expect(r.lines).toEqual([
      { sha: commit4.oid, line: 0, numLines: 1, author: 'T', timestamp: 1700004000, message: commit4Message }
    ]);
  });

  it('blob-at：HEAD / 完整 oid / ^ 首父 / 删除态与无路径 null', async () => {
    const head = await client.blobAt('', 'HEAD', 'a.txt');
    expect(head).not.toBeNull();
    expect(head!.oid).toBe(blobD.oid);
    expect(new TextDecoder().decode(head!.bytes)).toBe('reborn content\n');
    // 40 位 oid 直取（log 展开的逐提交 diff 通道）
    const atC1 = await client.blobAt('', commit.oid, 'a.txt');
    expect(atC1!.oid).toBe(blobA.oid);
    // HEAD^ 首父 = c3（删除提交）：该时点树内无 a.txt → null（「文件由后提交新增/
    // 重建」分流；首父解析正确性由「恰为 null 而非 c2 版本」佐证）
    await expect(client.blobAt('', 'HEAD^', 'a.txt')).resolves.toBeNull();
    // 首父链 b.txt 未被动：blob 直取成功（HEAD^ 解析面非全路径失效）
    const parentB = await client.blobAt('', 'HEAD^', 'b.txt');
    expect(parentB!.oid).toBe(blobB.oid);
    // 该时点树内无此路径 → null
    await expect(client.blobAt('', 'HEAD', 'missing.txt')).resolves.toBeNull();
  });

  it('blame：HEAD 域归属 + 未提交哨兵 + CRLF 归一行域对齐', async () => {
    // 无工作区字节：重建单行全归 commit4（c3 删除轮把此前归属清空）
    const r = await client.blame('', 'a.txt');
    expect(r.truncated).toBe(false);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ sha: commit4.oid, line: 0, numLines: 1, author: 'T' });
    // 工作区改写（归一后不等）：未提交哨兵
    const dirty = await client.blame('', 'a.txt', enc.encode('reborn content more\n'));
    expect(dirty.lines[0]!.sha).toBe('');
    expect(dirty.lines[0]!.author).toBe('（未提交）');
    // CRLF 工作区字节归一后与 HEAD blob 同域：归属保持 HEAD 提交（行号域与渲染
    // data-line 对齐的集成锚）
    const crlf = await client.blame('', 'a.txt', enc.encode('reborn content\r\n'));
    expect(crlf.lines[0]!.sha).toBe(commit4.oid);
  });
});
