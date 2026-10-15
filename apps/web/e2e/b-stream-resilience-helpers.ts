import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * IO 流式域共享装置（SCAN / JVL / DEG 三域共用；io-degrade-matrix.md §4.1）：
 * 自包含实现，不 import 既有 spec 内未导出的装置（b-io-streaming.spec.ts 同类物
 * 的复制适配 + 本轮扩展）。
 *
 * - IoStats：/api/file 响应计量（Range 请求头 + 响应体字节数；b-io-streaming 同口径）。
 * - UrlStats：URL 打开通道（url store 直连 fetch，不经 /api/file）的请求计量，
 *   以调用方给的 URL 谓词过滤（TopBar「粘贴文件 URL」→ createUrlStore 场景）。
 * - startStreamFakeServer：内存字节表假 vviewer 服务器（t-workspace 先例扩展版）：
 *   /api/tree 带 size（条目可省略 size = size 未知形态）、/api/file 支持 Range
 *   （206 精确切片），可组合：
 *   · rangeless 两档（DEG 域新增能力）：'all' = 全部请求忽略 Range 回 200 全量；
 *     'after-probe' = 仅 bytes=0-8191 探针回 206，其余 Range 请求一律 200 全量；
 *   · stall 门：指定文件 start ≥ minStart 的应答挂起直至 releaseStall（IO-10 先例）；
 *   · fail 门：指定文件 start ≥ minStart 的应答 500 直至 releaseFail；
 *   · notifyChanged：向挂连 SSE 客户端注入 changed 帧（SSE rev++ 重渲染触发）。
 * - 页面流装置：waitAppMounted / connectForm / openTreeFile / openRemoteFile /
 *   openUrlFile / settleStats（drawer.ts 窄视口适配内置于 openTreeFile）。
 */

export const MB = 1024 * 1024;

// ---------------- code 窗口夹具（SCAN 域引入，JVL/DEG 可复用） ----------------

/** code 窗口块大小（render-text code.ts CODE_WINDOW_BLOCK_BYTES 同源）：256KB */
export const CODE_BLOCK_BYTES = 256 * 1024;
/** 行字节（含 \n）：纯 ASCII 定长行，行 i 起始偏移 = i×64，字符数 === 字节数 */
export const CODE_ROW_BYTES = 64;
/** 搜索命中布点词（文本特征唯一，makeCodeFile 布点行 pad 段替换为它） */
export const CODE_NEEDLE = 'zzneedleqz';
/** 无命中触发词：文件内输入它驱动后台全文扫描至 EOF 且零命中 */
export const CODE_TRIGGER = 'qqnothingqz';

/**
 * 定长 js 行构造：`const v{i} = 'pad';` + '\n' 恰 64 字节——行 i 起始偏移可预算
 * （块号 = floor(i×64/256KB)），末行行号/命中行号断言直接对得上构造值。
 * needleRows 布点行把 pad 换成布点词（CODE_NEEDLE，搜索命中）。
 */
export function makeCodeFile(rows: number, needleRows: readonly number[] = []): Uint8Array {
  const needles = new Set(needleRows);
  const parts = new Array<string>(rows);
  for (let i = 0; i < rows; i++) {
    const head = `const v${i} = '`;
    const core = needles.has(i) ? CODE_NEEDLE : '';
    const pad = CODE_ROW_BYTES - 1 - head.length - 2 - core.length;
    parts[i] = `${head}${core}${'x'.repeat(pad)}';\n`;
  }
  return new TextEncoder().encode(parts.join(''));
}

/** 行 row 的构造原文（去尾 \n；全局搜索 NDJSON 命中帧 text 字段与深行内容断言用） */
export function codeLineText(bytes: Uint8Array, row: number): string {
  return new TextDecoder()
    .decode(bytes.subarray(row * CODE_ROW_BYTES, (row + 1) * CODE_ROW_BYTES))
    .replace(/\n$/, '');
}

/** 块 b 的精确 Range 区间字符串（BlockStream 步进形状：256KB 端点，末块由服务器钳） */
export function codeBlockRange(b: number): string {
  return `bytes=${b * CODE_BLOCK_BYTES}-${(b + 1) * CODE_BLOCK_BYTES - 1}`;
}

/**
 * 假服务器文件条目：裸 Uint8Array（tree size = 实体字节数）或
 * `{ bytes, treeSize? }`——treeSize 显式数值 = tree 汇报与实体解耦（「size 已知
 * 超限」的零读停机构造，IO-11 同款）；省略 treeSize = /api/tree 条目不带 size
 * 字段（FileSource.size null → size 未知流式形态，DEG-04）。
 */
export type StreamFakeFile = Uint8Array | { bytes: Uint8Array; treeSize?: number };

function fileBytesOf(entry: StreamFakeFile): Uint8Array {
  return entry instanceof Uint8Array ? entry : entry.bytes;
}

function treeSizeOf(entry: StreamFakeFile): number | undefined {
  return entry instanceof Uint8Array ? entry.length : entry.treeSize;
}

/** /api/file 单条响应计量记录：Range 请求头（null = 请求未带 Range）、HTTP 状态
 * （500 门可辨析）与响应体字节数 */
export interface IoRecord {
  range: string | null;
  status: number;
  bytes: number | null;
}

/** /api/file 响应计量（page.on('response') 过滤）：body 异步补齐，settled() 等齐后读数。
 * attach 必须先于 goto（不漏请求）。 */
export class IoStats {
  readonly records: IoRecord[] = [];
  private pending: Promise<void>[] = [];

  attach(page: Page): void {
    page.on('response', (res) => {
      if (new URL(res.url()).pathname !== '/api/file') return;
      const rec: IoRecord = {
        range: res.request().headers()['range'] ?? null,
        status: res.status(),
        bytes: null
      };
      this.records.push(rec);
      this.pending.push(
        res
          .body()
          .then(
            (body) => {
              rec.bytes = body.length;
            },
            () => {
              rec.bytes = -1; // 体取回失败（理论不达）：计量失真，下游断言必红
            }
          )
          .then(() => {})
      );
    });
  }

  /** 等所有已登记响应的 body 计量落定（新响应需再次调用） */
  async settled(): Promise<void> {
    const tail = this.pending;
    this.pending = [];
    await Promise.all(tail);
  }

  count(): number {
    return this.records.length;
  }

  /** 已登记的 Range 请求头列表（null 元素 = 请求未带 Range 的全量 200 形态） */
  ranges(): Array<string | null> {
    return this.records.map((r) => r.range);
  }

  total(): number {
    return this.records.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  }
}

/**
 * URL 打开通道计量（url store 直连 fetch 外部地址，不经 /api/file）：以 match 谓词
 * 过滤响应 URL（host/path 精确匹配由调用方给），记录 Range 头与体字节数。
 */
export class UrlStats {
  readonly records: IoRecord[] = [];
  private pending: Promise<void>[] = [];

  constructor(private readonly match: (url: URL) => boolean) {}

  attach(page: Page): void {
    page.on('response', (res) => {
      let parsed: URL;
      try {
        parsed = new URL(res.url());
      } catch {
        return;
      }
      if (!this.match(parsed)) return;
      const rec: IoRecord = {
        range: res.request().headers()['range'] ?? null,
        status: res.status(),
        bytes: null
      };
      this.records.push(rec);
      this.pending.push(
        res
          .body()
          .then(
            (body) => {
              rec.bytes = body.length;
            },
            () => {
              rec.bytes = -1;
            }
          )
          .then(() => {})
      );
    });
  }

  async settled(): Promise<void> {
    const tail = this.pending;
    this.pending = [];
    await Promise.all(tail);
  }

  count(): number {
    return this.records.length;
  }

  total(): number {
    return this.records.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  }
}

export interface StreamFakeServer {
  base: string;
  host: string;
  /** 向全部挂连的 SSE 客户端推送 changed 帧（模拟服务端 watcher 检出文件变更） */
  notifyChanged(paths: string[]): void;
  /** 原地替换文件字节（后续 /api/file 即新内容；配合 notifyChanged 构造 SSE 变更面） */
  updateFile(path: string, bytes: Uint8Array): void;
  /** 释放 stall 门（opts.stall 布置；未布置时 no-op）：挂起应答全部落地，后续直答 */
  releaseStall(): void;
  /** 释放 fail 门（opts.fail 布置；未布置时 no-op）：500 转正常应答 */
  releaseFail(): void;
  close(): Promise<void>;
}

export interface StreamFakeServerOptions {
  /**
   * Range-less 模拟（DEG 域）：
   * - 'off'（缺省）：标准 206 精确切片；
   * - 'all'：全部 /api/file 忽略 Range 回 200 全量（探针即全量，head 已含全量）；
   * - 'after-probe'：仅 bytes=0-8191 探针回 206，其余 Range 请求一律 200 全量
   *   （块读超长 → 客户端 BlockStream 200-回退全量切换，BUG-103 面）。
   */
  rangeless?: 'off' | 'all' | 'after-probe';
  /** 冻结指定文件 start ≥ minStart 的 Range 应答（挂起不回，直至 releaseStall） */
  stall?: { path: string; minStart: number };
  /** 指定文件 start ≥ minStart 的 Range 应答 500，直至 releaseFail 后恢复直答 */
  fail?: { path: string; minStart: number };
  /** 精确 Range 头匹配的自愈 500 门（SCAN 域回看重拉「首拒一次」面）：命中请求第
   * 1..skip 次放行（打开期首拉）、第 skip+1..skip+fails 次应 500，其后自愈直答
   * （无 release 依赖；seen 为服务器内侧计数）。exact 用精确 Range 头
   * （如 codeBlockRange(0)），探测头 bytes=0-8191 不误伤 */
  failOnce?: { path: string; exact: string; skip?: number; fails?: number; seen?: number };
  /** /api/file 206 直答统一延迟毫秒（确定性放慢扫描/续读推进——进度条采样与
   * 「挂起阶段渐进命中」类断言不再依赖真实时序；stall/fail 门应答不受影响） */
  slowMs?: number;
  /** POST /api/search 固定 NDJSON 应答：一条命中帧 + done 终帧（远端 ripgrep 同接口
   * 形状）。全局搜索的「命中点击打开大文件」只能走远端通道——本地全局搜索单文件
   * >2MB 被过滤（core compute/search.ts GREP_MAX_FILE_BYTES） */
  searchHit?: { file: string; line: number; col: number; text: string };
}

/**
 * 假 vviewer 文件服务器（b-io-streaming startIoFakeServer 的域共享扩展版）：内存
 * bytes 表，/api/tree 带 size（条目可省略）、/api/file 支持 Range + rangeless 两档 +
 * stall/fail 门、/api/events 挂连登记（notifyChanged 注入 changed 帧）。页面源
 * 4173 跨源：全响应带 ACAO:*（EventSource 亦要求）。
 */
export async function startStreamFakeServer(
  files: Record<string, StreamFakeFile>,
  opts?: StreamFakeServerOptions
): Promise<StreamFakeServer> {
  const sseClients = new Set<http.ServerResponse>();
  let stallRelease: (() => void) | null = null;
  const stallGate = new Promise<void>((ok) => {
    stallRelease = ok;
  });
  // fail 门放行旗标（stall 是「挂起到放行」，fail 是「500 直到放行」——布尔即可，
  // 无挂起面；failRelease promise 仅保留对称命名面，避免 lint 未用告警则一并去掉）
  let failArmed = true;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'OPTIONS') {
      // CORS 预检（POST /api/search 携 JSON content-type/Authorization 均非简单请求；
      // 真实服务器放行预检，假服务器须同形应答，否则远端搜索降级本地）
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, authorization',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'stream-e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res)); // 断连/关闭自动出册
      return; // 保持打开：帧经 notifyChanged 注入
    }
    if (url.pathname === '/api/search' && req.method === 'POST') {
      // 远端 ripgrep 同接口形状：NDJSON（0..n 条命中帧 + done 终帧），固定应答
      const hit = opts?.searchHit;
      const frames = [
        ...(hit ? [JSON.stringify(hit)] : []),
        JSON.stringify({ done: true, truncated: false })
      ];
      res.writeHead(200, { ...cors, 'Content-Type': 'application/x-ndjson' });
      res.end(frames.join('\n') + '\n');
      return;
    }
    if (url.pathname === '/api/tree') {
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const prefix = p === '' ? '' : `${p}/`;
      const entries = new Map<string, { name: string; kind: 'dir' | 'file'; size?: number }>();
      for (const [key, entry] of Object.entries(files)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const head = rest.split('/')[0]!;
        if (rest.includes('/')) {
          entries.set(head, { name: head, kind: 'dir' });
        } else {
          const size = treeSizeOf(entry); // undefined = 条目省略 size（size 未知形态）
          entries.set(head, size !== undefined ? { name: head, kind: 'file', size } : { name: head, kind: 'file' });
        }
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [...entries.values()] }));
      return;
    }
    if (url.pathname === '/api/file') {
      const path = url.searchParams.get('path') ?? '';
      const entry = files[path];
      if (entry === undefined) {
        res.writeHead(404, cors);
        res.end('no such file');
        return;
      }
      const bytes = fileBytesOf(entry);
      // 门裁决（stall/fail 二选一生效，均按 Range 起始对齐；应答形态在放行/失败后
      // 与无门时完全一致——门只挪时序不改内容）
      const gateOf = (start: number): 'pass' | 'stall' | 'fail' => {
        if (opts?.stall !== undefined && path === opts.stall.path && start >= opts.stall.minStart) return 'stall';
        if (failArmed && opts?.fail !== undefined && path === opts.fail.path && start >= opts.fail.minStart) return 'fail';
        return 'pass';
      };
      const serveSlice = (start: number, end: number, gate: 'pass' | 'stall' | 'fail'): void => {
        const slice = bytes.subarray(start, end + 1);
        const serve = (): void => {
          try {
            if (gate === 'fail') {
              res.writeHead(500, cors);
              res.end('fail gate');
              return;
            }
            res.writeHead(206, {
              ...cors,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice.length),
              'Accept-Ranges': 'bytes',
              'Content-Range': `bytes ${start}-${end}/${bytes.length}`
            });
            res.end(slice);
          } catch {
            // 客户端已 abort（destroy 取消常态化后）：纯静默——连接已断无行为可做（对比 notifyChanged catch 的出册=有行为），吞断管写错即完
          }
        };
        if (gate === 'stall') {
          void stallGate.then(serve);
          return;
        }
        if (gate === 'pass' && opts?.slowMs !== undefined && opts.slowMs > 0) {
          setTimeout(serve, opts.slowMs); // 确定性放慢直答（门应答不受影响）
          return;
        }
        serve();
      };
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      const rangeless = opts?.rangeless ?? 'off';
      if (!m || rangeless === 'all') {
        // 无 Range 或 rangeless='all'：200 全量（门按 start=0 对齐）
        const gate = gateOf(0);
        const serve = (): void => {
          try {
            if (gate === 'fail') {
              res.writeHead(500, cors);
              res.end('fail gate');
              return;
            }
            res.writeHead(200, {
              ...cors,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.length),
              'Accept-Ranges': 'bytes'
            });
            res.end(bytes);
          } catch {
            // 客户端已 abort（destroy 取消常态化后）：纯静默——连接已断无行为可做（对比 notifyChanged catch 的出册=有行为），吞断管写错即完
          }
        };
        if (gate === 'stall') {
          void stallGate.then(serve);
          return;
        }
        serve();
        return;
      }
      const start = Number(m[1]);
      const rawEnd = Number(m[2]);
      if (rangeless === 'after-probe' && !(start === 0 && rawEnd === 8191)) {
        // 探针之外一律 200 全量（忽略 Range）：块读超长 → 客户端 200-回退全量切换
        const gate = gateOf(start);
        const serve = (): void => {
          try {
            if (gate === 'fail') {
              res.writeHead(500, cors);
              res.end('fail gate');
              return;
            }
            res.writeHead(200, {
              ...cors,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.length),
              'Accept-Ranges': 'bytes'
            });
            res.end(bytes);
          } catch {
            // 客户端已 abort（destroy 取消常态化后）：纯静默——连接已断无行为可做（对比 notifyChanged catch 的出册=有行为），吞断管写错即完
          }
        };
        if (gate === 'stall') {
          void stallGate.then(serve);
          return;
        }
        serve();
        return;
      }
      // failOnce 自愈门（精确 Range 头匹配）：前 skip 次放行、其后 fails 次 500、
      // 再自愈直答——回看重拉「首拒后停机、用户动作重试成功」面的确定性构造
      const fo = opts?.failOnce;
      if (fo !== undefined && path === fo.path && req.headers.range === fo.exact) {
        fo.seen = (fo.seen ?? 0) + 1;
        const skip = fo.skip ?? 0;
        if (fo.seen > skip && fo.seen <= skip + (fo.fails ?? 1)) {
          res.writeHead(500, cors);
          res.end('failOnce gate');
          return;
        }
      }
      const end = Math.min(rawEnd, bytes.length - 1);
      serveSlice(start, end, gateOf(start));
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
    notifyChanged(paths) {
      const frame = `data: ${JSON.stringify({ type: 'changed', paths })}\n\n`;
      for (const client of [...sseClients]) {
        try {
          client.write(frame);
        } catch {
          // 出册=有行为可做（对比 /api/file serve catch 的纯静默：连接已断无行为可做）——已断连挂连出册，帧由活连承载
          sseClients.delete(client);
        }
      }
    },
    updateFile(path, bytes) {
      files[path] = bytes; // 服务器每请求读表：后续响应即新内容
    },
    releaseStall() {
      stallRelease?.(); // 已 resolve 的门重复调用为 no-op（幂等）
    },
    releaseFail() {
      failArmed = false; // 之后的命中请求恢复直答（一次性放开不复闭）
    },
    close: async () => {
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

// ---------------- 页面流装置（b-io-streaming 同名物的复制适配） ----------------

/** 等应用挂载（__vvOpenDirImpl 注入钩子 + 顶栏可见） */
export async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 连接表单提交（token 留空） */
export async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/** 窄视口（mobile project）抽屉适配的树行打开：桌面直点，≤900px 开抽屉点击后还原 */
export async function openTreeFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 远端文件打开全套（attach 先于 goto 不漏计量）：连接 → 树行打开 → 活动 tab 可见。
 * 渲染器就绪信号（状态条/首行等）由调用方按载体断言。 */
export async function openRemoteFile(
  page: Page,
  fake: StreamFakeServer,
  stats: IoStats,
  name: string
): Promise<void> {
  stats.attach(page);
  await waitAppMounted(page);
  await connectForm(page, fake.base);
  await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });
  await openTreeFile(page, name);
}

/** TopBar「粘贴文件 URL」打开（url store）：表单填入回车 → 活动 tab 可见 */
export async function openUrlFile(page: Page, url: string, tabName: string): Promise<void> {
  await waitAppMounted(page);
  await page.getByLabel('文件 URL').fill(url);
  await page.getByLabel('文件 URL').press('Enter');
  await expect(page.locator('.vv-tab.active', { hasText: tabName })).toBeVisible();
}

/** 计量收敛保险（b-io-streaming 同口径）：settled → 300ms 静置 → settled，
 * 防偶发迟滞请求漏计；理论无后续 IO 的时段读数前必经 */
export async function settleStats(page: Page, stats: IoStats | UrlStats): Promise<void> {
  await stats.settled();
  await page.waitForTimeout(300);
  await stats.settled();
}
