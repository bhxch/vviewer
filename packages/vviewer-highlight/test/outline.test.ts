import { describe, it, expect, vi, afterEach } from 'vitest';
import { expandQuery, expandQueryAsync, type QueryAssets } from '../src/queries';
import { pairsToOutline, type OutlineCapture, type OutlineMatch } from '../src/outline';
import { createHandler, serveWorker } from '../src/worker';
import { HighlightClient } from '../src/client';
import type { TreeSitterEngine } from '../src/core-parse';
import type { OutlineEntry, OutlineResponse } from '../src/types';

// —— serveWorker 装置（worker.test.ts 同款：stub self/WorkerGlobalScope + engine 桩）——
const engineCreate = vi.hoisted(() => ({
  impl: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('engine create 桩未安装')),
}));

vi.mock('../src/core-parse', () => ({
  TreeSitterEngine: {
    create: (...args: unknown[]) => engineCreate.impl(...args),
  },
}));

interface FakeCtx {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (msg: unknown) => void;
}

function installServeWorker(): { ctx: FakeCtx; posted: unknown[] } {
  const posted: unknown[] = [];
  const ctx: FakeCtx = { onmessage: null, postMessage: (msg) => posted.push(msg) };
  vi.stubGlobal('self', ctx);
  vi.stubGlobal('WorkerGlobalScope', class {});
  serveWorker();
  return { ctx, posted };
}

/** synthetic capture 构造器：name + node 形态与 web-tree-sitter QueryCapture 解耦同形。 */
const cap = (name: string, start: number, end: number, text: string): OutlineCapture => ({
  name,
  node: { startIndex: start, endIndex: end, text },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('expandQuery tags 字段（继承展开）', () => {
  it('父 tags 与子 tags 父前子后拼接（沿 highlights 的继承链）', () => {
    const assets: QueryAssets = new Map([
      ['parent', { tags: 'PARENT_TAGS' }],
      ['child', { highlights: '; inherits: parent\nH', tags: 'CHILD_TAGS' }],
    ]);
    const out = expandQuery(assets, 'child');
    expect(out?.highlights).toBe('H');
    expect(out?.tags).toBe('PARENT_TAGS\nCHILD_TAGS');
  });

  it('子无 tags 正文但 highlights 声明继承：tags 沿链拼接父 tags', () => {
    const assets: QueryAssets = new Map([
      ['js', { tags: 'JS_TAGS' }],
      ['ts', { highlights: '; inherits: js\nH' }], // 无 tags 文件
    ]);
    expect(expandQuery(assets, 'ts')?.tags).toBe('JS_TAGS');
  });

  it('tags 头部自有 inherits 声明优先于 highlights 链', () => {
    const assets: QueryAssets = new Map([
      ['hl-parent', { tags: 'WRONG' }],
      ['tags-parent', { tags: 'TAGS_PARENT' }],
      ['child', { highlights: '; inherits: hl-parent\nH', tags: '; inherits: tags-parent\nCHILD' }],
    ]);
    const out = expandQuery(assets, 'child');
    expect(out?.highlights).toBe('H');
    expect(out?.tags).toBe('TAGS_PARENT\nCHILD');
  });

  it('全链无 tags：expanded.tags 为空串（toQuery 侧转 null）', () => {
    const assets: QueryAssets = new Map([
      ['p', { highlights: 'PH' }],
      ['c', { highlights: '; inherits: p\nCH' }],
    ]);
    expect(expandQuery(assets, 'c')).toEqual({ highlights: 'PH\nCH', injections: '', tags: '' });
  });

  it('expandQueryAsync tags 语义与同步版一致', async () => {
    const assets: QueryAssets = new Map([
      ['js', { tags: 'JS_TAGS' }],
      ['ts', { highlights: '; inherits: js\nH', tags: '; inherits: js\nTS_TAGS' }],
    ]);
    const source = async (lang: string) => assets.get(lang) ?? null;
    const out = await expandQueryAsync(source, 'ts');
    expect(out?.tags).toBe('JS_TAGS\nTS_TAGS');
  });
});

describe('pairsToOutline（capture 配对纯函数，synthetic 构造）', () => {
  it('@name 与 @definition 配对：name 取 @name 文本，byte 取 definition 节点，kind 保留 capture 全名', () => {
    const match: OutlineMatch = [
      cap('doc', 0, 20, '/** doc */'),
      cap('name', 30, 33, 'foo'),
      cap('definition.function', 25, 60, 'function foo() {}'),
    ];
    expect(pairsToOutline([match])).toEqual([
      { name: 'foo', kind: 'definition.function', line: 0, byteStart: 25, byteEnd: 60, depth: 0 },
    ]);
  });

  it('@reference 配对同语义（kind 保留 reference 全名）', () => {
    const match: OutlineMatch = [
      cap('name', 5, 8, 'bar'),
      cap('reference.call', 0, 12, 'bar(1, 2)'),
    ];
    expect(pairsToOutline([match])).toEqual([
      { name: 'bar', kind: 'reference.call', line: 0, byteStart: 0, byteEnd: 12, depth: 0 },
    ]);
  });

  it('无配对 @name：用节点自身文本与范围，kind 为 name', () => {
    const match: OutlineMatch = [cap('name', 10, 14, 'Baz')];
    expect(pairsToOutline([match])).toEqual([
      { name: 'Baz', kind: 'name', line: 0, byteStart: 10, byteEnd: 14, depth: 0 },
    ]);
  });

  it('@doc 忽略：纯 doc match 不产条目；配对 match 中 doc 不干扰', () => {
    const docOnly: OutlineMatch = [cap('doc', 0, 10, '// note')];
    const paired: OutlineMatch = [
      cap('doc', 0, 10, '// note'),
      cap('name', 12, 15, 'fn'),
      cap('definition.function', 11, 30, 'fn fn() {}'),
    ];
    expect(pairsToOutline([docOnly])).toEqual([]);
    expect(pairsToOutline([docOnly, paired])).toHaveLength(1);
  });

  it('double capture（同节点 @name + @reference.type，go 形态）：按 reference 产一条', () => {
    const node = cap('name', 0, 3, 'Foo');
    const match: OutlineMatch = [node, { name: 'reference.type', node: node.node }];
    expect(pairsToOutline([match])).toEqual([
      { name: 'Foo', kind: 'reference.type', line: 0, byteStart: 0, byteEnd: 3, depth: 0 },
    ]);
  });

  it('无 @name 的 anchor（definition 节点自名）：name 用 anchor 节点文本', () => {
    const match: OutlineMatch = [cap('definition.class', 0, 30, 'class Foo {}')];
    expect(pairsToOutline([match])).toEqual([
      { name: 'class Foo {}', kind: 'definition.class', line: 0, byteStart: 0, byteEnd: 30, depth: 0 },
    ]);
  });

  it('depth 栈式嵌套：class 0 / 内层 1 / 更内层 2，兄弟回退同级', () => {
    // class [0,100] 内含 method [10,90]，method 内含 inner [20,80]；之后兄弟 fn [110,130] 回 0
    const matches: OutlineMatch[] = [
      [cap('name', 6, 11, 'Klass'), cap('definition.class', 0, 100, 'class ...')],
      [cap('name', 16, 22, 'method'), cap('definition.method', 10, 90, 'def method ...')],
      [cap('name', 26, 31, 'inner'), cap('definition.function', 20, 80, 'fn inner ...')],
      [cap('name', 116, 118, 'fn'), cap('definition.function', 110, 130, 'fn fn() {}')],
    ];
    const out = pairsToOutline(matches);
    expect(out.map((e) => [e.name, e.depth])).toEqual([
      ['Klass', 0],
      ['method', 1],
      ['inner', 2],
      ['fn', 0],
    ]);
  });

  it('输出按 byteStart 升序（输入乱序不透传原序）', () => {
    const matches: OutlineMatch[] = [
      [cap('name', 50, 52, 'b'), cap('definition.function', 40, 60, 'fn b')],
      [cap('name', 5, 6, 'a'), cap('definition.function', 0, 10, 'fn a')],
    ];
    expect(pairsToOutline(matches).map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('line（0 起）：text 给定时按 byteStart 线性扫行', () => {
    const text = 'line0\nline1\nline2';
    const matches: OutlineMatch[] = [
      [cap('name', 0, 5, 'l0'), cap('definition.function', 0, 5, 'line0')],
      [cap('name', 6, 11, 'l1'), cap('definition.function', 6, 11, 'line1')],
      [cap('name', 12, 17, 'l2'), cap('definition.function', 12, 17, 'line2')],
    ];
    expect(pairsToOutline(matches, text).map((e) => e.line)).toEqual([0, 1, 2]);
  });

  it('text 缺省时 line 恒 0（synthetic 用例不涉全文）', () => {
    expect(pairsToOutline([[cap('name', 100, 105, 'x')]])[0]?.line).toBe(0);
  });

  it('空输入返回空数组', () => {
    expect(pairsToOutline([])).toEqual([]);
  });

  it('千级条目时限：2000 条（1000 层嵌套链 + 1000 兄弟）< 500ms（防 O(n²) 退化）', () => {
    const matches: OutlineMatch[] = [];
    // 1000 层全嵌套链：start 递增、end 递减
    for (let i = 0; i < 1000; i++) {
      matches.push([
        cap('name', i, i + 1, `n${i}`),
        cap('definition.function', i, 20_000 - i, `fn n${i} {...}`),
      ]);
    }
    // 1000 个兄弟（与嵌套链不重叠）
    for (let i = 0; i < 1000; i++) {
      const s = 30_000 + i * 10;
      matches.push([cap('name', s + 3, s + 5, `b${i}`), cap('definition.class', s, s + 8, `class b${i}`)]);
    }
    const t0 = performance.now();
    const out = pairsToOutline(matches);
    const elapsed = performance.now() - t0;
    expect(out).toHaveLength(2000);
    expect(elapsed).toBeLessThan(500);
    // 栈式 depth 抽查：嵌套链第 i 条 depth=i；兄弟段 depth=0
    expect(out[500]?.depth).toBe(500);
    expect(out[1000]?.depth).toBe(0);
  });
});

describe('OutlineRequest/Response 协议形状', () => {
  it('OutlineRequest wire 形状：{ kind, id, text, lang }（序列化后 kind 保留）', async () => {
    const sent: unknown[] = [];
    const fakeWorker: {
      onmessage: ((ev: { data: OutlineResponse }) => void) | null;
      onerror: ((ev: ErrorEvent) => void) | null;
      onmessageerror: (() => void) | null;
      postMessage(msg: unknown): void;
      terminate(): void;
    } = {
      onmessage: null,
      postMessage(msg: unknown): void {
        sent.push(msg);
      },
      terminate(): void {},
      onerror: null,
      onmessageerror: null,
    };
    const client = new HighlightClient(fakeWorker as unknown as Worker);
    try {
      const p = client.outline('def fn(): pass', 'python');
      const wire = JSON.parse(JSON.stringify(sent.at(-1))) as Record<string, unknown>;
      expect(wire).toEqual({ kind: 'outline', id: 1, text: 'def fn(): pass', lang: 'python' });
      // 回包成功形状：{ id, ok, entries }
      fakeWorker.onmessage?.({
        data: { id: 1, ok: true, entries: [{ name: 'fn', kind: 'definition.function', line: 0, byteStart: 0, byteEnd: 14, depth: 0 }] },
      });
      await expect(p).resolves.toEqual([
        { name: 'fn', kind: 'definition.function', line: 0, byteStart: 0, byteEnd: 14, depth: 0 },
      ]);
    } finally {
      client.dispose();
    }
  });
});

describe('createHandler outline 分派（engine 桩）', () => {
  it('kind=outline 请求分流 engine.outline，成功回 { id, ok, entries }（无 engine 键）', async () => {
    const entries: OutlineEntry[] = [
      { name: 'foo', kind: 'definition.function', line: 0, byteStart: 0, byteEnd: 10, depth: 0 },
    ];
    const outline = vi.fn(async () => ({ ok: true as const, entries }));
    const handler = await createHandler({ outline } as unknown as TreeSitterEngine);
    const res = await handler({ kind: 'outline', id: 3, text: 'x', lang: 'python' });
    expect(outline).toHaveBeenCalledWith('x', 'python');
    expect(res).toStrictEqual({ id: 3, ok: true, entries });
  });

  it('engine.outline 失败 → { id, ok:false, error }', async () => {
    const outline = vi.fn(async () => ({ ok: false as const, error: 'boom' }));
    const handler = await createHandler({ outline } as unknown as TreeSitterEngine);
    expect(await handler({ kind: 'outline', id: 4, text: 'x', lang: 'nope' })).toStrictEqual({
      id: 4,
      ok: false,
      error: 'boom',
    });
  });

  it('未知 kind 不崩：回 ok:false 错误响应（不透传 engine）', async () => {
    const engine = {
      highlight: vi.fn(),
      outline: vi.fn(),
    };
    const handler = await createHandler(engine as unknown as TreeSitterEngine);
    const res = (await handler({ kind: 'bogus', id: 5 } as never)) as OutlineResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未知');
    expect(engine.highlight).not.toHaveBeenCalled();
    expect(engine.outline).not.toHaveBeenCalled();
  });
});

describe('serveWorker outline 分派（engine 桩）', () => {
  it('kind=outline 请求（init 前排队）init 成功后经 handler 分流回 entries', async () => {
    engineCreate.impl = async () => {
      const outline = async (text: string, lang: string) => ({
        ok: true as const,
        entries: [{ name: `fn-${lang}`, kind: 'definition.function', line: 0, byteStart: 0, byteEnd: text.length, depth: 0 }],
      });
      return { outline };
    };
    const { ctx, posted } = installServeWorker();
    ctx.onmessage?.({ data: { kind: 'outline', id: 9, text: 'abc', lang: 'python' } }); // 先于 init 排队
    ctx.onmessage?.({ data: { kind: 'init' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toContainEqual({
      id: 9,
      ok: true,
      entries: [{ name: 'fn-python', kind: 'definition.function', line: 0, byteStart: 0, byteEnd: 3, depth: 0 }],
    });
  });

  it('未知 kind 消息不崩 worker：回 ok:false 帧，后续 outline 请求照常服务', async () => {
    engineCreate.impl = async () => ({ outline: async () => ({ ok: true as const, entries: [] }) });
    const { ctx, posted } = installServeWorker();
    ctx.onmessage?.({ data: { kind: 'init' } });
    await new Promise((r) => setTimeout(r, 20));
    ctx.onmessage?.({ data: { kind: 'bogus', id: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toContainEqual(expect.objectContaining({ id: 1, ok: false }));
    ctx.onmessage?.({ data: { kind: 'outline', id: 2, text: 'x', lang: 'python' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toContainEqual({ id: 2, ok: true, entries: [] });
  });
});

describe('HighlightClient.outline（独立 pending 面）', () => {
  /** 可脚本化回包的假 Worker（client.test.ts 同款，响应面放宽为 OutlineResponse）。 */
  class FakeWorker {
    onmessage: ((ev: { data: OutlineResponse }) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    requests: Array<Record<string, unknown>> = [];
    responder: (req: Record<string, unknown>, reply: (res: Omit<OutlineResponse, 'id'>) => void) => void = (_req, reply) =>
      reply({ ok: true, entries: [] });

    postMessage(msg: unknown): void {
      const req = msg as Record<string, unknown>;
      if (req.kind === 'init') return;
      this.requests.push(req);
      queueMicrotask(() => {
        if (this.terminated) return;
        this.responder(req, (res) => this.onmessage?.({ data: { ...res, id: req.id as number } }));
      });
    }
    terminate(): void {
      this.terminated = true;
    }
  }

  const fake = (): { worker: FakeWorker; client: HighlightClient } => {
    const worker = new FakeWorker();
    return { worker, client: new HighlightClient(worker as unknown as Worker) };
  };

  it('outline 成功 resolve entries（与 highlight 互不串扰：id 共享单调空间各自分流）', async () => {
    const { worker, client } = fake();
    worker.responder = (req, reply) => {
      if (req.kind === 'outline') reply({ ok: true, entries: [{ name: 'x', kind: 'name', line: 0, byteStart: 0, byteEnd: 1, depth: 0 }] });
      else reply({ ok: true });
    };
    const intervals = client.highlight('a=1', 'bash');
    const entries = client.outline('a=1', 'bash');
    await expect(intervals).resolves.toEqual([]);
    await expect(entries).resolves.toEqual([{ name: 'x', kind: 'name', line: 0, byteStart: 0, byteEnd: 1, depth: 0 }]);
    client.dispose();
  });

  it('同 lang 连续 outline：前一个取消（reject），后一个成功（独立于 highlight 的去重表）', async () => {
    const { worker, client } = fake();
    worker.responder = (req, reply) => {
      if (req.id === 1) return; // 挂起
      reply({ ok: true, entries: [{ name: 'second', kind: 'name', line: 0, byteStart: 0, byteEnd: 1, depth: 0 }] });
    };
    const first = client.outline('a=1', 'bash');
    await vi.waitFor(() => expect(worker.requests.length).toBe(1));
    const second = client.outline('b=2', 'bash');
    await expect(first).rejects.toThrow();
    await expect(second).resolves.toEqual([{ name: 'second', kind: 'name', line: 0, byteStart: 0, byteEnd: 1, depth: 0 }]);
    client.dispose();
  });

  it('highlight 与 outline 的同 lang 去重互不取消（独立 pendingByLang）', async () => {
    const { worker, client } = fake();
    worker.responder = () => {}; // 全挂起
    const h = client.highlight('a=1', 'bash');
    const o = client.outline('a=1', 'bash');
    await vi.waitFor(() => expect(worker.requests.length).toBe(2));
    client.cancelAll();
    await expect(h).rejects.toThrow();
    await expect(o).rejects.toThrow();
  });

  it('ok:false 响应 reject 携带 error 文案；缺 error 兜底通用文案', async () => {
    const { worker, client } = fake();
    worker.responder = (_req, reply) => reply({ ok: false, error: '查询超时' });
    await expect(client.outline('x', 'python')).rejects.toThrow('查询超时');
    worker.responder = (_req, reply) => reply({ ok: false });
    await expect(client.outline('x', 'python')).rejects.toThrow('outline 失败');
    client.dispose();
  });
});
