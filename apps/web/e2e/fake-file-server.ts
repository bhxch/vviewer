import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 单根文件服务假件（审计 R1 M-2 下沉）：b-filetree-src-remove（原 startFtFakeServer）
 * 与 b-quickopen-multisource（原 startQoFakeServer）约 60 行逐字复制的共享 fixture
 * （png-fixture.ts 先例同款）。单根、无 token 分支：health/ticket/events（SSE 挂起
 * 保持打开）/tree/file + 全端点 CORS；文件表按路径前缀合成目录树。两 spec 改导入后
 * 沿用各自测试体，行为零变化。
 */
interface FakeOptions {
  rootPath: string;
  files: Record<string, string>;
}

export async function startFakeFileServer(
  opts: FakeOptions
): Promise<{ base: string; host: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      return; // 保持打开、无数据帧：SSE 挂起即可（测试结束统一断连）
    }
    if (url.pathname === '/api/tree' || url.pathname === '/api/file') {
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const table = opts.files;
      if (url.pathname === '/api/tree') {
        const entries = new Map<string, 'dir' | 'file'>();
        const prefix = p === '' ? '' : `${p}/`;
        for (const key of Object.keys(table)) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const head = rest.split('/')[0]!;
          entries.set(head, rest.includes('/') ? 'dir' : 'file');
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            entries: [...entries].map(([name, kind]) => ({
              name,
              kind,
              ...(kind === 'file' ? { size: (table[`${prefix}${name}`] ?? '').length } : {})
            }))
          })
        );
        return;
      }
      const content = table[p];
      if (content === undefined) {
        res.writeHead(404, cors);
        res.end('no such file');
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}
