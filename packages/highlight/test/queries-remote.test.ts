import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TreeSitterEngine, type GrammarTable } from '../src/core-parse';

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
    const engine = await TreeSitterEngine.create({
      queriesBase: `http://127.0.0.1:${port}/queries/`,
      grammars: manifest.grammars,
      grammarsDir: path.join(staticDir, 'grammars'),
      runtimeDir: staticDir,
    });
    try {
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
      engine.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
