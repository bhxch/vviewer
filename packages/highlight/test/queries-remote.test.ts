import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TreeSitterEngine, type GrammarTable } from '../src/core-parse';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.join(here, '../../../apps/web/static');
// queries 走入库资产（packages/highlight/assets/queries）保证 hermetic——
// apps/web/static/queries 是 vite 构建期拷贝产物（gitignore），fresh clone 不存在
const queriesAssetDir = path.join(here, '../assets/queries');

/**
 * queriesBase fetch 链路集成测试（浏览器 Worker 端的同款查询加载代码）：
 * node:http 本地静态服务将 /queries/* 映射到入库的 assets/queries，
 * 引擎以 queriesBase 创建（不经 fs 读查询目录），查询文件经真实 HTTP fetch +
 * expandQueryAsync 继承展开；grammar wasm 仍走本地路径
 * （Node 端 web-tree-sitter 的 Language.load 只支持文件路径，URL 加载属浏览器行为，由 T7 E2E 覆盖）。
 */
describe('TreeSitterEngine（queriesBase fetch 版查询来源）', () => {
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
