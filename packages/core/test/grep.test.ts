import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeStore, TreeNode } from '../src/types';
import {
  GREP_MAX_FILES,
  grepRemote,
  grepStoreLocal,
  type GrepMatch
} from '../src/compute/search';

/**
 * 内存 TreeStore 桩：files 映射 path → 文本内容；目录从文件路径的中间段推导。
 * read 未登记路径即抛错（模拟竞态删除）。
 */
function memStore(files: Record<string, string>): TreeStore & { reads: string[] } {
  const all = Object.keys(files);
  const reads: string[] = [];
  function children(path: string): TreeNode[] {
    const prefix = path ? `${path}/` : '';
    const seen = new Map<string, TreeNode>();
    for (const p of all) {
      if (!p.startsWith(prefix)) continue;
      const segs = p.slice(prefix.length).split('/');
      const head = segs[0]!;
      if (segs.length === 1) {
        seen.set(head, { name: head, path: p, kind: 'file' });
      } else if (!seen.has(head)) {
        seen.set(head, { name: head, path: `${prefix}${head}`, kind: 'dir' });
      }
    }
    return [...seen.values()];
  }
  return {
    id: 'mem:test',
    displayName: () => 'mem',
    listChildren: async (p) => children(p),
    read: async (p: string) => {
      reads.push(p);
      const content = files[p];
      if (content === undefined) throw new Error(`not found: ${p}`);
      return new TextEncoder().encode(content);
    },
    reads
  };
}

function paths(matches: GrepMatch[]): string[] {
  return [...new Set(matches.map((m) => m.path))];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('grepStoreLocal', () => {
  it('递归扫描子目录并给出 1 起行列与行预览', async () => {
    const store = memStore({
      'a.ts': 'const x = 1;\nfindMe here;\n',
      'sub/b.ts': 'deep findMe line\n',
      'sub/deep/c.ts': 'x\nfindMe again\n'
    });
    const { matches, truncated } = await grepStoreLocal(store, 'findMe');
    expect(truncated).toBe(false);
    expect(paths(matches)).toEqual(['a.ts', 'sub/b.ts', 'sub/deep/c.ts']);
    const a = matches.find((m) => m.path === 'a.ts')!;
    expect(a.line).toBe(2);
    expect(a.col).toBe(1);
    expect(a.preview).toBe('findMe here;');
    expect(a.storeId).toBe('mem:test');
  });

  it('按扩展名白名单过滤：文本扩展扫，非文本跳过', async () => {
    const store = memStore({
      'code.ts': 'findMe in ts\n',
      'photo.png': 'findMe in png',
      'noext': 'findMe no ext',
      'data.csv': 'findMe in csv\n'
    });
    const { matches } = await grepStoreLocal(store, 'findMe');
    expect(paths(matches)).toEqual(['code.ts', 'data.csv']);
  });

  it('默认大小写不敏感；caseSensitive 关闭归一', async () => {
    const store = memStore({ 'a.ts': 'Needle HERE\nsmall needle\nNEEDLE up\n' });
    const insensitive = await grepStoreLocal(store, 'needle');
    expect(insensitive.matches.map((m) => m.line)).toEqual([1, 2, 3]);
    const sensitive = await grepStoreLocal(store, 'needle', { caseSensitive: true });
    expect(sensitive.matches.map((m) => m.line)).toEqual([2]);
    const upper = await grepStoreLocal(store, 'NEEDLE', { caseSensitive: true });
    expect(upper.matches.map((m) => m.line)).toEqual([3]);
  });

  it('regex 模式按正则匹配；非法正则抛错', async () => {
    const store = memStore({ 'a.ts': 'foo123bar\nfoobar\n' });
    const { matches } = await grepStoreLocal(store, 'foo\\d+bar', { regex: true });
    expect(matches.map((m) => m.line)).toEqual([1]);
    await expect(grepStoreLocal(store, 'foo[', { regex: true })).rejects.toThrow();
  });

  it('maxFiles 上限：达到后停止并置 truncated', async () => {
    const store = memStore({
      'a.ts': 'findMe\n',
      'b.ts': 'findMe\n',
      'c.ts': 'findMe\n'
    });
    const { matches, truncated } = await grepStoreLocal(store, 'findMe', { maxFiles: 2 });
    expect(paths(matches)).toEqual(['a.ts', 'b.ts']);
    expect(truncated).toBe(true);
  });

  it('maxBytes 上限：累计字节超限停止并置 truncated', async () => {
    const store = memStore({
      'a.ts': 'x'.repeat(100) + '\nfindMe\n',
      'b.ts': 'y'.repeat(100) + '\nfindMe\n',
      'c.ts': 'z'.repeat(100) + '\nfindMe\n'
    });
    const { matches, truncated } = await grepStoreLocal(store, 'findMe', { maxBytes: 150 });
    expect(matches.length).toBeGreaterThan(0);
    expect(truncated).toBe(true);
  });

  it('单文件超 maxFileBytes 跳过（声明 size 与实际读取双保险）', async () => {
    const store = memStore({
      'big.ts': `x\nfindMe in big\n${'y'.repeat(50)}`,
      'small.ts': 'findMe in small\n'
    });
    const { matches } = await grepStoreLocal(store, 'findMe', { maxFileBytes: 20 });
    expect(paths(matches)).toEqual(['small.ts']);
  });

  it('限深 maxDepth：超深目录不再下探', async () => {
    const deep: Record<string, string> = {};
    for (let d = 1; d <= 7; d++) {
      deep[`${'lv/'.repeat(d)}f${d}.ts`] = 'findMe deep\n';
    }
    const store = memStore(deep);
    const { matches } = await grepStoreLocal(store, 'findMe', { maxDepth: 5 });
    // 根=0 层；lv(1..5) 可下探 → f1..f5 命中，f6/f7 不达
    expect(paths(matches).length).toBe(5);
  });

  it('命中数达上限即停并置 truncated；onProgress 汇报已扫文件数', async () => {
    const store = memStore({
      'a.ts': 'findMe 1\nfindMe 2\nfindMe 3\n',
      'b.ts': 'findMe 4\n'
    });
    const progress: number[] = [];
    const { matches, truncated } = await grepStoreLocal(
      store,
      'findMe',
      { maxMatches: 2 },
      (done) => progress.push(done)
    );
    expect(matches.length).toBe(2);
    expect(truncated).toBe(true);
    expect(progress[progress.length - 1]).toBeGreaterThanOrEqual(1);
  });

  it('canceled 回调为真时立即中止（返回已累计结果）', async () => {
    const store = memStore({ 'a.ts': 'findMe\n', 'b.ts': 'findMe\n' });
    const { matches, truncated } = await grepStoreLocal(store, 'findMe', {
      canceled: () => true
    });
    expect(matches).toEqual([]);
    expect(truncated).toBe(false);
    expect(store.reads).toEqual([]);
  });

  it('read 抛错的文件跳过不中断整体扫描', async () => {
    const store = memStore({ 'gone.ts': 'x', 'ok.ts': 'findMe here\n' });
    // 让 gone.ts 可列出但读取抛错
    (store as { read: (p: string) => Promise<Uint8Array> }).read = async (p) => {
      if (p === 'gone.ts') throw new Error(' vanished');
      return new TextEncoder().encode('findMe here\n');
    };
    const { matches } = await grepStoreLocal(store, 'findMe');
    expect(paths(matches)).toEqual(['ok.ts']);
  });

  it('默认上限为契约值（2000 文件 / 200MB / 1000 命中）', () => {
    // 常量导出供面板文案与测试引用，锁定契约
    expect(GREP_MAX_FILES).toBe(2000);
  });
});

// ---------- grepRemote（NDJSON 流解析） ----------

/** fetch 响应桩：把帧列表按块喂给 body.getReader()（含跨块断行场景）。 */
function ndjsonResponse(chunks: string[], status = 200): unknown {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: encoder.encode(chunks[i++]) }
              : { done: true, value: undefined }
        };
      }
    }
  };
}

describe('grepRemote', () => {
  const endpoint = { url: 'http://srv:8321/api/search', headers: { authorization: 'Bearer t' } };

  it('解析 match 帧并透传 truncated（含跨块断行缓冲）', async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([
        '{"file":"a.ts","line":2,"col":5,"text":"findMe here"}\n{"file":"b.ts","line":9,"col":1,',
        '"text":"findMe too"}\n{"done":true,"truncated":true}\n'
      ])
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await grepRemote(endpoint, { pattern: 'findMe' }, { storeId: 'remote:x' });
    expect(fetchMock).toHaveBeenCalledWith('http://srv:8321/api/search', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'findMe' }),
      signal: undefined
    });
    expect(res.truncated).toBe(true);
    expect(res.matches).toEqual([
      { storeId: 'remote:x', path: 'a.ts', line: 2, col: 5, preview: 'findMe here' },
      { storeId: 'remote:x', path: 'b.ts', line: 9, col: 1, preview: 'findMe too' }
    ]);
  });

  it('非 2xx 抛错（router auto 据此回退本地）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([], 501)));
    await expect(grepRemote(endpoint, { pattern: 'x' }, { storeId: 'r' })).rejects.toThrow(
      'HTTP 501'
    );
  });

  it('done 帧带 error 时抛错（如 rg 非法正则）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse(['{"done":true,"truncated":false,"error":"regex parse error"}\n'])
      )
    );
    await expect(grepRemote(endpoint, { pattern: '[' }, { storeId: 'r' })).rejects.toThrow(
      'regex parse error'
    );
  });

  it('透传 AbortSignal 与可选请求字段', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ndjsonResponse(['{"done":true,"truncated":false}\n'])
    );
    vi.stubGlobal('fetch', fetchMock);
    const ac = new AbortController();
    await grepRemote(
      endpoint,
      { pattern: 'x', glob: '*.ts', caseSensitive: true, regex: true, path: 'sub' },
      { storeId: 'r', signal: ac.signal }
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      signal: ac.signal,
      body: JSON.stringify({
        pattern: 'x',
        glob: '*.ts',
        caseSensitive: true,
        regex: true,
        path: 'sub'
      })
    });
  });
});
