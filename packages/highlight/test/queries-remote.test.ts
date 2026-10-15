import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TreeSitterEngine, type EngineInitProgress, type GrammarTable } from '../src/core-parse';
import { initWorker } from '../src/worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.join(here, '../../../apps/web/static');
// queries 走入库资产（packages/highlight/assets/queries）保证 hermetic——
// apps/web/static/queries 是 vite 构建期拷贝产物（gitignore），fresh clone 不存在
const queriesAssetDir = path.join(here, '../assets/queries');
// grammar 资产（manifest + 运行时 wasm）由 `pnpm gen:grammars` 生成（不入库），fresh clone 跳过
const grammarAssetsReady =
  existsSync(path.join(staticDir, 'grammars', 'manifest.json')) &&
  existsSync(path.join(staticDir, 'tree-sitter.wasm'));

/**
 * queriesBase fetch 链路集成测试（浏览器 Worker 端的同款查询加载代码）：
 * node:http 本地静态服务将 /queries/* 映射到入库的 assets/queries，
 * 引擎以 queriesBase 创建（不经 fs 读查询目录），查询文件经真实 HTTP fetch +
 * expandQueryAsync 继承展开；grammar wasm 仍走本地路径
 * （Node 端 web-tree-sitter 的 Language.load 只支持文件路径，URL 加载属浏览器行为，由 T7 E2E 覆盖）。
 */
describe.skipIf(!grammarAssetsReady)('TreeSitterEngine（queriesBase fetch 版查询来源）', () => {
  let server: http.Server;
  let engine: TreeSitterEngine;

  beforeAll(async () => {
    const manifest = JSON.parse(readFileSync(path.join(staticDir, 'grammars', 'manifest.json'), 'utf8')) as {
      grammars: GrammarTable;
    };
    const mime: Record<string, string> = {
      '.scm': 'text/plain',
      '.wasm': 'application/wasm',
      '.json': 'application/json',
    };
    server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!;
      // /queries/{lang}/{file} → assets/queries；其余（grammars、runtime）→ 入库的 static
      const m = /^\/queries\/(.+)$/.exec(url);
      const file = m ? path.join(queriesAssetDir, m[1]!) : path.join(staticDir, url);
      try {
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': mime[path.extname(url)] ?? 'text/plain' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    engine = await TreeSitterEngine.create({
      queriesBase: `${base}/queries/`,
      grammars: manifest.grammars,
      grammarsDir: path.join(staticDir, 'grammars'),
      runtimeDir: staticDir,
    });
  }, 60_000);

  afterAll(async () => {
    engine.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetch 查询完成真实高亮（sh 别名 → bash，与 fs 模式行为一致）', async () => {
    const src = 'echo "hello"';
    const r = await engine.highlight(src, 'sh');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intervals.length).toBeGreaterThan(0);
    const stringHit = r.intervals.find((i) => i.capture === 'string');
    expect(stringHit).toBeDefined();
    expect(src.slice(stringHit!.start, stringHit!.end)).toBe('"hello"');
  }, 30_000);

  it('查询 404（null）→ 无可用查询，highlight 失败', async () => {
    const r = await engine.highlight('anything', '__no_such_lang__');
    expect(r.ok).toBe(false);
  }, 30_000);
});

/**
 * SUSP-06（doPrepare 顺序微优化）：同源 manifest 剥离条目时，highlight 该语言应在
 * resolveGrammarEntry 短路——零 /queries/** 请求（修前 expandQueryAsync 先行，
 * /queries/java/{highlights,injections}.scm 空打 ≥1），结果仍 ok:false（「语言 java
 * 无可用 grammar 或查询」）→ 调用方 hljs 兜底不变。剥离手法沿用 e2e GRF-01/SUSP-06
 * 同款：读真实清单后删条目，防硬编码漂移。
 */
describe.skipIf(!grammarAssetsReady)('TreeSitterEngine（SUSP-06：manifest 剥离条目 → 条目判定前置零 query 请求）', () => {
  it('grammar 条目缺失时不发 query 资产请求（resolveGrammarEntry 前置）', async () => {
    const manifest = JSON.parse(readFileSync(path.join(staticDir, 'grammars', 'manifest.json'), 'utf8')) as {
      grammars: GrammarTable;
    };
    delete manifest.grammars.java;
    // 计数先行：所有请求无论命中与否都记录（断言面是「发没发」，不是「有没有」）
    const queryHits: string[] = [];
    const server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!;
      queryHits.push(url);
      const m = /^\/queries\/(.+)$/.exec(url);
      const file = m ? path.join(queriesAssetDir, m[1]!) : path.join(staticDir, url);
      try {
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // 引擎创建移入 try（deferred 清偿 Task 1 ⑧）：TreeSitterEngine.create 抛错
    //（wasm 加载失败/资产缺失等）时 server 也必须关闭，否则本地 http 句柄泄漏、
    // 测试进程无法退出。engine 以 let 声明 + 可选调用：create 失败时无实例可 dispose
    let engine: TreeSitterEngine | undefined;
    try {
      engine = await TreeSitterEngine.create({
        queriesBase: `http://127.0.0.1:${port}/queries/`,
        grammars: manifest.grammars,
        grammarsDir: path.join(staticDir, 'grammars'),
        runtimeDir: staticDir,
      });
      const r = await engine.highlight('x', 'java');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain('语言 java 无可用 grammar 或查询');
      const javaHits = queryHits.filter((u) => u.includes('/queries/java/'));
      expect(
        javaHits,
        `条目缺失不得发起 /queries/java/** 请求（修前 expandQueryAsync 先行空打 ≥1），实得 ${JSON.stringify(javaHits)}`,
      ).toEqual([]);
    } finally {
      engine?.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

/**
 * init 探针细口径（deferred 清偿 Task 4，spec §8）：debug 链路的 query 逐文件帧与
 * wasm resource timing。query-loaded 用既有 http 服务形态驱动真实帧序列（fetch →
 * remoteQueryLoader → onQueryLoaded → initWorker 折算，全真实代码，别名规范化后按
 * bash 计）；wasm resource timing 在 jsdom（performance 无 getEntriesByType，真实
 * resource 条目仅浏览器产生）以「注入 mock getEntriesByType」驱动命中分支、以
 * 「无条目/无 API」驱动省略分支——真实浏览器形态由 e2e ?vvWorkerDebug=1 观察。
 */
describe.skipIf(!grammarAssetsReady)('init 探针细口径（debug：query 逐文件帧 + wasm resource timing）', () => {
  it('debug 回调下：init 四阶段后逐文件 query-loaded（真实 http fetch，detail 为目录布局相对名）', async () => {
    const manifest = JSON.parse(readFileSync(path.join(staticDir, 'grammars', 'manifest.json'), 'utf8')) as {
      grammars: GrammarTable;
    };
    const server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!;
      const m = /^\/queries\/(.+)$/.exec(url);
      const file = m ? path.join(queriesAssetDir, m[1]!) : path.join(staticDir, url);
      try {
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': url.endsWith('.scm') ? 'text/plain' : 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // initWorker 真实链路：debug 回调注入时派生 onQueryLoaded → query-loaded 事件
    const events: EngineInitProgress[] = [];
    const handler = await initWorker(
      {
        queriesBase: `http://127.0.0.1:${port}/queries/`,
        grammars: manifest.grammars,
        grammarsDir: path.join(staticDir, 'grammars'),
        runtimeDir: staticDir,
      },
      (p) => events.push(p),
    );
    try {
      // init 四阶段依序（探针通道本身不因细口径改变）
      expect(events.slice(0, 4).map((e) => e.stage)).toEqual(['wasm-fetch', 'parser-init', 'assets', 'ready']);
      // 首次高亮触发 query 资产远程加载：每份文件 fetch 完成一帧（sh 别名规范化为 bash；
      // bash 无 inherits，恰好两文件）。并发完成顺序不保证，按集合比较
      const r = await handler({ id: 1, text: 'echo "hello"', lang: 'sh' });
      expect(r.ok).toBe(true);
      expect(events.filter((e) => e.stage === 'query-loaded').map((e) => e.detail).sort()).toEqual([
        'bash/highlights.scm',
        'bash/injections.scm',
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('resource 条目命中（mock 注入）：parser-init/ready 帧附 name/duration/transferSize', async () => {
    const entry = { name: 'https://assets.example.com/vv/tree-sitter.wasm', duration: 12.25, transferSize: 5678 };
    const getEntriesByType = vi.fn(() => [entry]);
    // jsdom 的 performance 无 getEntriesByType：原型链保留既有能力，仅注入该方法的替身
    vi.stubGlobal(
      'performance',
      Object.assign(Object.create(Object.getPrototypeOf(performance)), performance, { getEntriesByType }),
    );
    try {
      const events: EngineInitProgress[] = [];
      const engine = await TreeSitterEngine.create({
        queriesDir: queriesAssetDir,
        grammarsDir: path.join(staticDir, 'grammars'),
        runtimeDir: staticDir,
        onInitProgress: (p) => events.push(p),
      });
      engine.dispose();
      // 既有帧形态不变（wasm-fetch 的 runtimeDir detail）
      expect(events[0]).toStrictEqual({ stage: 'wasm-fetch', detail: `runtimeDir=${staticDir}` });
      const parserInit = events.find((e) => e.stage === 'parser-init');
      const ready = events.find((e) => e.stage === 'ready');
      // 三字段齐备（Task 4 细口径：wasm 加载 resource timing）
      expect(parserInit?.detail).toContain('tree-sitter.wasm');
      expect(parserInit?.detail).toContain('duration=12.25ms');
      expect(parserInit?.detail).toContain('transfer=5678B');
      // ready 帧同补：独立再读一次 buffer，取到同一条目
      expect(ready?.detail).toBe(parserInit?.detail);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('resource 条目缺失（buffer 清空/jsdom 无此 API）：detail 省略但 parser-init/ready 帧仍发', async () => {
    // 本环境即 jsdom：performance.getEntriesByType 缺位（或 Node perf 下无匹配条目），
    // 读取分支静默容错——帧不缺席、零 detail 键（deferred 卫生：非 detail: undefined）
    const events: EngineInitProgress[] = [];
    const engine = await TreeSitterEngine.create({
      queriesDir: queriesAssetDir,
      grammarsDir: path.join(staticDir, 'grammars'),
      runtimeDir: staticDir,
      onInitProgress: (p) => events.push(p),
    });
    engine.dispose();
    expect(events.map((e) => e.stage)).toEqual(['wasm-fetch', 'parser-init', 'assets', 'ready']);
    expect(events[1]).toStrictEqual({ stage: 'parser-init' });
    expect(events[3]).toStrictEqual({ stage: 'ready' });
  }, 30_000);
});

/**
 * SPA-fallback 防御（终审 C1，双层修之前端层回归锚）：
 * 静态服务器对缺失查询文件以 200 index.html 兜底（content-type text/html）时，
 * 不得把 HTML 误载为查询文本——否则该语言 Query 编译抛错，整语言降级 hljs。
 * 正确语义：200 text/html 视同缺失（undefined），highlights 照常生效。
 */
describe.skipIf(!grammarAssetsReady)('remoteQueryLoader（200 text/html 兜底防误载）', () => {
  it('injections.scm 回 200 text/html → 视为缺失，highlights 单独生效（语言不整体降级）', async () => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!;
      // SPA fallback 模拟：injections.scm「未命中」回 200 index.html；highlights.scm 正常
      if (url.endsWith('/injections.scm')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body>spa-shell</body></html>');
        return;
      }
      const m = /^\/queries\/(.+)$/.exec(url);
      try {
        const body = readFileSync(path.join(queriesAssetDir, m?.[1] ?? ''));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const engine = await TreeSitterEngine.create({
      queriesBase: `http://127.0.0.1:${port}/queries/`,
      grammars: JSON.parse(
        readFileSync(path.join(staticDir, 'grammars', 'manifest.json'), 'utf8'),
      ).grammars as GrammarTable,
      grammarsDir: path.join(staticDir, 'grammars'),
      runtimeDir: staticDir,
    });
    try {
      // 修前：HTML 被当作 injections 查询编译 → 整语言失败（ok:false）降级 hljs；
      // 修后：HTML 视为缺失，bash 的 highlights 照常产出区间
      const r = await engine.highlight('echo "hello"', 'sh');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const stringHit = r.intervals.find((i) => i.capture === 'string');
      expect(stringHit).toBeDefined();
      expect('echo "hello"'.slice(stringHit!.start, stringHit!.end)).toBe('"hello"');
    } finally {
      engine.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
