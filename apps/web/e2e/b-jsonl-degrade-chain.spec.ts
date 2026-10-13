import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * jsonl 窗口降级链与回看 e2e（b- 前缀；场景文档 docs/e2e/jsonl-degrade-chain.md，
 * 场景编号 JVL-01~08 与其一一对应）。jsonl 窗口模式（块 256KB、块表 LRU 16 块、
 * 文本缓存 8 块）的失败/降级/回看面回归锚：
 * - JVL-01：跨块过大行「行过大（>1MB）」徽标 + 64K 字符预览（不解析、跨块字节域
 *   拼装无 U+FFFD）——OPEN-05 只测非法行
 * - JVL-02：STREAM_MAX_BYTES(512MB) jsonl 侧零读停机 + 状态条上限提示（io spec
 *   §4.3 防线换代；IO-11 是 code 载体）
 * - JVL-03：size 未知 + 流内嗅探降级后 metaSize/行数转投全量实例（BUG-105，9a0aa54）
 * - JVL-04：回看缓存命中零新请求（≤16 块全驻留构造，jsonl spec §5「缓存命中可观测」）
 * - JVL-05：prefetchThrough 首屏两块并行预取夹持断言（29c3405，stall 门放行前
 *   块 0/1 请求均已发出）
 * - JVL-06：「已加载 N 行→共 N 行」渐进（IO-05 只锚 EOF 终值）
 * - JVL-07：回看重拉失败停机闩（af6a705：失败零风暴、用户动作单次重试）
 * - JVL-08：视口外卡片回收的 DOM 有界代理锚（io spec §6 内存有界的可观测代理面）
 *
 * 通道：b-io-streaming.spec.ts 的 startIoFakeServer 自包含扩展版（spec 内 node:http
 * 假服务器 + 跨源 CORS，页面源 4173），差异面：
 * - /api/tree 条目可省略 size（treeSize undefined → 条目无 size 键，JVL-03 的
 *   size 未知构造）；
 * - stall 门按「请求 end ≥ minEnd」谓词挂起应答（JVL-05：探针与块 0 的 start 同为 0，
 *   start 门无法区分；探针 end 8191 < minEnd 放行）；
 * - fail 门按「Range 头第 nth 次请求回 500」（JVL-07：块 0 第 1 次是首屏合法拉取，
 *   第 2 次是滚回顶部的回看重拉）；
 * - 计量类 IoStats 增 request 级在途记录（stall 挂起应答无 response 事件，夹持
 *   断言须观测请求本身）与响应状态码。
 * 夹具全部内联生成：均匀行 `{"id":i,"pad":"a…"}` 恰 256B（含 \n）→ 每块恰 1024 行、
 * 首两块 2048 行；GBK 中文行字节为预生成序列（中=D6 D0 文=CE C4，python3 gbk codec
 * 回转验证，非法 UTF-8），Node 无内建 gbk 编码器故硬编码。
 */

const MB = 1024 * 1024;
/** jsonl 窗口块大小（render-text jsonl WINDOW_BLOCK_BYTES 同源）：256KB */
const BLOCK = 256 * 1024;
/** 均匀行字节（含 \n）：行 i 起始偏移可预算（块号 = floor(i×256/256KB)） */
const ROW = 256;
/** 过大行阈值（render-text jsonl/parse.ts JSONL_OVERSIZE_LINE_BYTES 同源）：1MB，取等号即超限 */
const OVERSIZE_LINE_BYTES = 1_048_576;
/** 过大行预览（parse.ts JSONL_OVERSIZE_PREVIEW_BYTES 同源）：64K 字符 */
const OVERSIZE_PREVIEW_CHARS = 65_536;

/** 块 b 的精确 Range 区间字符串（BlockStream 步进形状：256KB 端点） */
function blockRange(b: number): string {
  return `bytes=${b * BLOCK}-${(b + 1) * BLOCK - 1}`;
}

/** 恰 255 字符的均匀行内容（+'\n' = 256B）：`{"id":i,"pad":"aaa…"}` 合法 JSON */
function uniformContent(i: number): string {
  const prefix = `{"id":${i},"pad":"`;
  return prefix + 'a'.repeat(255 - prefix.length - 2) + '"}';
}

/** totalBytes 字节的合法均匀行 jsonl（totalBytes 须为 ROW 整数倍，末行带换行） */
function makeUniformJsonl(totalBytes: number): Uint8Array {
  const rows = totalBytes / ROW;
  if (!Number.isInteger(rows)) throw new Error(`makeUniformJsonl：totalBytes 须为 ${ROW} 整数倍`);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) lines.push(uniformContent(i));
  return new TextEncoder().encode(lines.join('\n') + '\n'); // 纯 ASCII：字节数 === 字符数
}

/**
 * 过大行夹具（JVL-01）：行 0 合法行 + 行 1 = `{"big":"x…x"}` 恰 1MB+1KB（≥阈值
 * 留 1KB 裕量，跨块边界 262144/524288/786432/1048576 共 4 处）+ 合法行补至 ≈3MB。
 * 返回行数（0 基内容行计数，空行已无——构造不含空行）供状态条「共 N 行」断言。
 */
function makeOversizeJsonl(): { bytes: Uint8Array; rows: number } {
  const bigContent = `{"big":"${'x'.repeat(OVERSIZE_LINE_BYTES + 1024 - 9)}"}`; // 恰阈值+1KB 字符
  const perRow = ROW + 1; // 内容 + '\n'
  const normalRows = Math.floor((3 * MB - perRow - (bigContent.length + 1)) / perRow);
  const lines: string[] = [uniformContent(0), bigContent];
  for (let i = 0; i < normalRows; i++) lines.push(uniformContent(i + 2));
  return { bytes: new TextEncoder().encode(lines.join('\n') + '\n'), rows: 2 + normalRows };
}

/** 「中文」的 GBK 字节（python3 gbk codec 生成并回转验证；非法 UTF-8） */
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];

/**
 * size 未知 + 流内嗅探降级夹具（JVL-03）：前 512KB 纯 ASCII 均匀行（恰块 0/1，
 * 首屏嗅探不触发）+ 自 524288 起 GBK 中文行补至 ≥900KB（脏块 = 块 2 起，须滚动
 * 续读才喂入——判脏前缀 786432 ≠ 实体精确字节数，BUG-105 的可观测差值面）。
 */
function makeGbkNoSizeJsonl(): { bytes: Uint8Array; rows: number } {
  const head = makeUniformJsonl(512 * 1024); // 2048 行，恰 2 块
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [head];
  let total = head.length;
  let i = 0;
  while (total < 900 * 1024) {
    const pre = enc.encode(`{"zh":"`);
    const post = enc.encode(`","n":${i}}\n`);
    const line = new Uint8Array(pre.length + GBK_ZHONGWEN.length + post.length);
    line.set(pre, 0);
    line.set(GBK_ZHONGWEN, pre.length);
    line.set(post, pre.length + GBK_ZHONGWEN.length);
    parts.push(line);
    total += line.length;
    i += 1;
  }
  const bytes = concatBytes(parts);
  return { bytes, rows: 2048 + i };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ------------------------------------------------------------- 假服务器与计量

/** 单条 /api/file 响应计量记录：Range 请求头（null = 全量 200）、状态码与 body 字节数 */
interface IoRecord {
  range: string | null;
  bytes: number | null;
  status: number;
}

/** /api/file 计量：response 级（Range 头/状态码/字节数）+ request 级在途记录。
 * request 级为 stall 门场景必备：挂起应答不产生 response 事件，夹持断言观测请求本身。 */
class IoStats {
  readonly records: IoRecord[] = [];
  readonly requestRanges: string[] = [];
  private pending: Promise<void>[] = [];

  attach(page: Page): void {
    page.on('request', (req) => {
      if (new URL(req.url()).pathname !== '/api/file') return;
      this.requestRanges.push(req.headers()['range'] ?? '');
    });
    page.on('response', (res) => {
      if (new URL(res.url()).pathname !== '/api/file') return;
      const rec: IoRecord = {
        range: res.request().headers()['range'] ?? null,
        bytes: null,
        status: res.status()
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
}

/**
 * 假 vviewer 文件服务器（b-io-streaming startIoFakeServer 扩展版，见文件头）：
 * 内存 bytes 表，/api/tree 带 size（可省略）、/api/file 支持 Range（206 精确切片）、
 * /api/events 挂连登记（notifyChanged 注入 changed 帧，本域暂未消费，保留通道对称）。
 * 页面源 4173 跨源：全响应带 ACAO:*。
 *
 * 条目形态：裸 Uint8Array（size=实体字节数）/ { bytes, treeSize }（tree 汇报与实体
 * 解耦，JVL-02 零读构造）/ { bytes }（省略 size 键，JVL-03 size 未知构造）。
 */
type JvlFakeFile = Uint8Array | { bytes: Uint8Array; treeSize?: number };

function fileBytesOf(entry: JvlFakeFile): Uint8Array {
  return entry instanceof Uint8Array ? entry : entry.bytes;
}

function treeSizeOf(entry: JvlFakeFile): number | undefined {
  return entry instanceof Uint8Array ? entry.length : entry.treeSize;
}

interface JvlFakeServer {
  base: string;
  host: string;
  releaseStall(): void;
  close(): Promise<void>;
}

interface JvlFakeServerOptions {
  /** 挂起指定文件 end ≥ minEnd 的 Range 应答（不回，直至 releaseStall；一次性放开）：
   * JVL-05 并行预取夹持的确定性构造（minEnd=262143 → 探针 8191 放行、块 0/1 挂起） */
  stall?: { path: string; minEnd: number };
  /** 指定文件 + 精确 Range 头的第 nth 次请求回 500（其余照常）：JVL-07 回看重拉
   * 首拒构造（nth=2：第 1 次是首屏合法拉取） */
  failRangeOnce?: { path: string; range: string; nth: number };
}

async function startJvlFakeServer(
  files: Record<string, JvlFakeFile>,
  opts?: JvlFakeServerOptions
): Promise<JvlFakeServer> {
  const sseClients = new Set<http.ServerResponse>();
  let stallRelease: (() => void) | null = null;
  const stallGate = new Promise<void>((ok) => {
    stallRelease = ok;
  });
  const failCounts = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'jvl-e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
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
        const size = treeSizeOf(entry);
        entries.set(
          head,
          rest.includes('/')
            ? { name: head, kind: 'dir' }
            : { name: head, kind: 'file', ...(size !== undefined ? { size } : {}) }
        );
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
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), bytes.length - 1);
        const serve = (): void => {
          res.writeHead(206, {
            ...cors,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${bytes.length}`
          });
          res.end(bytes.subarray(start, end + 1));
        };
        // fail 门（JVL-07）：同 path+Range 第 nth 次请求回 500
        const fail = opts?.failRangeOnce;
        if (fail !== undefined && path === fail.path && req.headers.range === fail.range) {
          const key = `${path}|${fail.range}`;
          const seen = (failCounts.get(key) ?? 0) + 1;
          failCounts.set(key, seen);
          if (seen === fail.nth) {
            res.writeHead(500, { ...cors, 'Content-Type': 'text/plain' });
            res.end('block fetch failed');
            return;
          }
        }
        // stall 门（JVL-05）：end ≥ minEnd 的应答挂起直至 releaseStall
        const stall = opts?.stall;
        if (stall !== undefined && path === stall.path && Number(m[2]) >= stall.minEnd) {
          void stallGate.then(serve);
          return;
        }
        serve();
        return;
      }
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Accept-Ranges': 'bytes'
      });
      res.end(bytes);
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
    releaseStall() {
      stallRelease?.();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

// ------------------------------------------------------------- 页面装置

/** 等应用挂载（b-io-streaming waitAppMounted 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 连接表单提交（b-io-streaming connectForm 同款；token 留空） */
async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/**
 * 打开远端 jsonl 文件 tab（计量 attach 先于 goto，不漏请求）。只等到 tab 激活，
 * 不等 .vv-jsonl——JVL-05 的挂起期不渲染、JVL-02 的零读停机各有就绪信号。
 * 返回内部滚动容器定位器。
 */
async function openRemoteJsonl(
  page: Page,
  fake: JvlFakeServer,
  stats: IoStats,
  name: string
): Promise<Locator> {
  stats.attach(page);
  await waitAppMounted(page);
  await connectForm(page, fake.base);
  await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
  return page.locator('.vv-jsonl-scroll');
}

interface PumpResult {
  /** 状态条文本采样（相邻去重；EOF 前为「已加载 N 行」序列、末位「共 N 行」） */
  texts: string[];
  /** 每步采样的 .vv-jsonl-card 数量峰值（JVL-08 有界代理） */
  maxCards: number;
}

/**
 * 贴底泵续读至 EOF（b-io-streaming IO-05 同构：一次滚动事件至多推进一块），
 * 页内循环逐步采样状态条文本与卡片数。预算轮次内未到 EOF 即抛错。
 */
async function pumpJsonlToEof(
  scroll: Locator,
  opts: { maxRounds?: number; sampleCards?: boolean } = {}
): Promise<PumpResult> {
  return scroll.evaluate(
    async (el, o) => {
      const status = el.parentElement!.querySelector('.vv-jsonl-status');
      if (!status) throw new Error('.vv-jsonl-status 不存在');
      const texts: string[] = [];
      let maxCards = 0;
      for (let i = 0; i < o.maxRounds; i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 50));
        const t = status.textContent ?? '';
        if (texts[texts.length - 1] !== t) texts.push(t);
        if (o.sampleCards) {
          maxCards = Math.max(maxCards, el.querySelectorAll('.vv-jsonl-card').length);
        }
        if (t.startsWith('共 ')) return { texts, maxCards };
      }
      throw new Error('jsonl 续读未在预算轮次内到达 EOF');
    },
    { maxRounds: opts.maxRounds ?? 600, sampleCards: opts.sampleCards ?? false }
  );
}

// ---------------------------------------------------------------- JVL-01

test('JVL-01：窗口模式跨块过大行——「行过大（>1MB）」徽标 + 64K 字符预览，不解析不撑爆', async ({ page }) => {
  test.setTimeout(120_000);
  const f = makeOversizeJsonl();
  const fake = await startJvlFakeServer({ 'oversize-line.jsonl': f.bytes });
  try {
    const stats = new IoStats();
    const scroll = await openRemoteJsonl(page, fake, stats, 'oversize-line.jsonl');
    const status = page.locator('.vv-jsonl-status');
    // ① 续读泵到 EOF：过大行终结符在块 4（偏移 ≈1.025MB），喂块后才入索引出卡
    await pumpJsonlToEof(scroll);
    await expect(status).toHaveText(`共 ${f.rows} 行`, { timeout: 10_000 });
    await stats.settled();

    // ② 回顶使第 2 行（0 基 data-line=1）卡片入视口
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    const card = page.locator('.vv-jsonl-card[data-line="1"]');
    await expect(card).toBeVisible();
    // ③ 徽标 + 64K 字符预览（字节域跨块拼装后单次解码截断）
    await expect(card.locator('.vv-jsonl-badge')).toHaveText('行过大（>1MB）');
    const preview = (await card.locator('.vv-jsonl-body').textContent()) ?? '';
    expect(preview.length, `预览应恰 ${OVERSIZE_PREVIEW_CHARS} 字符，实得 ${preview.length}`).toBe(
      OVERSIZE_PREVIEW_CHARS
    );
    expect(preview.startsWith('{"big":"'), '预览应为原始文本前缀').toBe(true);
    expect(preview.includes('\uFFFD'), '跨块拼装不得产出 U+FFFD').toBe(false);
    // ④ 不走解析/pretty 分支：无「展开全部」钮
    await expect(card.locator('.vv-jsonl-expand')).toHaveCount(0);
    // ⑤ 邻位合法行照常 pretty；无错误卡
    await expect(page.locator('.vv-jsonl-card[data-line="0"]')).toContainText('"id": 0');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- JVL-02

test('JVL-02：STREAM_MAX_BYTES 512MB jsonl 零读停机——仅探针 + 状态条上限提示（非错误卡）', async ({ page }) => {
  test.setTimeout(60_000);
  // 等价构造（IO-11 同裁决）：size 是客户端唯一事实来源，构造期 limitReached 路径
  // 不读任何块字节——100KB 实体 + tree size 600MB 与真实 >512MB 文件观测面等价
  const fake = await startJvlFakeServer({
    'huge-declared.jsonl': { bytes: makeUniformJsonl(100 * 1024), treeSize: 600 * MB }
  });
  try {
    const stats = new IoStats();
    await openRemoteJsonl(page, fake, stats, 'huge-declared.jsonl');
    const status = page.locator('.vv-jsonl-status');
    // 零读停机 + 非失败态提示条（jsonl/index.ts STREAM_LIMIT_NOTICE；不复用错误卡片）
    await expect(status).toContainText('已加载 0 行', { timeout: 20_000 });
    await expect(status).toContainText('已达流式上限，建议以 hex 打开');
    await expect(status).not.toContainText('解析失败');
    await stats.settled();
    await page.waitForTimeout(300); // 收敛保险：理论无后续 IO，防偶发迟滞请求漏计
    await stats.settled();
    expect(stats.count(), 'size 已知构造即知超限：除探针外必须零读').toBe(1);
    expect(stats.records[0]?.range).toBe('bytes=0-8191');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // meta 面照常（ctx.size 原样透传；状态栏 250ms 周期重读）
    await expect(page.locator('.vv-statusbar')).toContainText('大小: 629145600', { timeout: 10_000 });
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- JVL-03

test('JVL-03：size 未知 + 流内嗅探降级——metaSize/行数转投全量实例（BUG-105）', async ({ page }) => {
  test.setTimeout(120_000);
  const f = makeGbkNoSizeJsonl();
  const fake = await startJvlFakeServer({ 'gbk-nosize.jsonl': { bytes: f.bytes } }); // 条目省略 size
  try {
    const stats = new IoStats();
    const scroll = await openRemoteJsonl(page, fake, stats, 'gbk-nosize.jsonl');
    const status = page.locator('.vv-jsonl-status');
    // ① 降级前：干净前缀（块 0/1 = 2048 行）窗口口径可读
    await expect(status).toHaveText('已加载 2048 行', { timeout: 20_000 });
    // ② 滚到底：脏块（块 2 起全 GBK）喂入 → 流内嗅探判非 UTF-8 → 全量重渲替换 DOM
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(status).toHaveText(`共 ${f.rows} 行`, { timeout: 30_000 });
    // ③ meta 转投全量实例（9a0aa54）：编码 = 全量精判、大小 = 实体精确字节数
    //    （旧缺陷停在被逐出/判脏前缀确认字节，本构造为 786432 ≠ bytes.length）
    await expect(page.locator('.vv-statusbar')).toContainText('编码: gb18030', { timeout: 10_000 });
    await expect(page.locator('.vv-statusbar')).toContainText(`大小: ${f.bytes.length}`, {
      timeout: 10_000
    });
    // ④ 中文行解码正确无乱码（全量 gb18030 解码；滚到底使 GBK 卡片入窗）
    await page.locator('.vv-jsonl-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const zhCard = page.locator('.vv-jsonl-card', { hasText: '中文' }).first();
    await expect(zhCard).toBeVisible({ timeout: 15_000 });
    const zhText = (await zhCard.textContent()) ?? '';
    expect(zhText).toContain('中文');
    expect(zhText.includes('\uFFFD'), 'gb18030 全量解码不得产出 U+FFFD').toBe(false);
    // ⑤ 降级重渲非失败态
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- JVL-04

test('JVL-04：回看缓存命中零新请求——≤16 块全驻留文件滚回顶部零 IO', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startJvlFakeServer({ 'resident-3mb.jsonl': makeUniformJsonl(3 * MB) }); // 12288 行 12 块
  try {
    const stats = new IoStats();
    const scroll = await openRemoteJsonl(page, fake, stats, 'resident-3mb.jsonl');
    const status = page.locator('.vv-jsonl-status');
    await expect(status).toHaveText('已加载 2048 行', { timeout: 20_000 });
    // ① 滚到底至 EOF（12 块 ≤ LRU 16：全程驻留）
    await pumpJsonlToEof(scroll);
    await expect(status).toHaveText('共 12288 行', { timeout: 10_000 });
    await stats.settled();
    await page.waitForTimeout(300);
    await stats.settled();
    // ② 一步滚回顶部：块缓存命中，零新增请求
    const before = stats.count();
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(500);
    await stats.settled();
    expect(stats.count(), `回看顶部不得再发 /api/file 请求（实得 ${stats.count() - before} 条新增）`).toBe(
      before
    );
    // ③ 顶部行内容与构造一致（缓存命中渲染真实卡片，非占位）
    const first = page.locator('.vv-jsonl-card[data-line="0"]');
    await expect(first).toBeVisible();
    await expect(first).toContainText('"id": 0');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- JVL-05

test('JVL-05：首屏两块并行预取夹持——stall 门放行前块 0/1 请求均已发出（prefetchThrough）', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startJvlFakeServer(
    { 'resident-3mb.jsonl': makeUniformJsonl(3 * MB) },
    // end 谓词（探针与块 0 的 start 同为 0，start 门无法区分）：end ≥ 262143 挂起
    // → 块 0/1 应答冻结、探针（end 8191）放行
    { stall: { path: 'resident-3mb.jsonl', minEnd: BLOCK - 1 } }
  );
  try {
    const stats = new IoStats();
    stats.attach(page);
    await waitAppMounted(page);
    await connectForm(page, fake.base);
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'resident-3mb.jsonl' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'resident-3mb.jsonl' })).toBeVisible();
    // 探针落地 = dispatch 完成、render 进入 prefetchThrough(1)
    await expect.poll(() => stats.records[0]?.range, { timeout: 15_000 }).toBe('bytes=0-8191');
    // 夹持断言（29c3405 prefetchThrough：fetchBlock 首个 await 前同步调用 ctx.read，
    // 任一放行前即可观测全部请求）：块 0 与块 1 两条 Range 均已发出——串行实现的
    // 块 1 请求必须等块 0 应答（挂在门上永不到达），即红
    await expect
      .poll(() => stats.requestRanges.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    expect(stats.requestRanges, `实得 ${JSON.stringify(stats.requestRanges)}`).toContain(
      blockRange(0)
    );
    expect(stats.requestRanges, `实得 ${JSON.stringify(stats.requestRanges)}`).toContain(
      blockRange(1)
    );
    // 挂起期不渲染（首拉未收口）
    await page.waitForTimeout(200);
    await expect(page.locator('.vv-jsonl')).toHaveCount(0);
    // 放行：两块应答落地 → 首屏渲染 → 渐进口径状态条
    fake.releaseStall();
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-jsonl-status')).toHaveText('已加载 2048 行', { timeout: 20_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- JVL-06

test('JVL-06：「已加载 N 行→共 N 行」渐进——续读逐块单调增长，EOF 后翻转固定', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startJvlFakeServer({ 'progressive-5mb.jsonl': makeUniformJsonl(5 * MB) }); // 20480 行 20 块
  try {
    const stats = new IoStats();
    const scroll = await openRemoteJsonl(page, fake, stats, 'progressive-5mb.jsonl');
    const status = page.locator('.vv-jsonl-status');
    // ① 首屏：前 2 块 = 2048 行的「已加载」渐进口径（非「共」）
    await expect(status).toHaveText('已加载 2048 行', { timeout: 20_000 });
    // ② 贴底泵续读，逐步采样状态条
    const pumped = await pumpJsonlToEof(scroll);
    await expect(status).toHaveText('共 20480 行', { timeout: 10_000 });
    // ③ 渐进证据：≥3 个不同「已加载」值、单调不减、首值即首屏口径
    const loaded = pumped.texts.filter((t) => t.startsWith('已加载 '));
    expect(loaded.length, `应采样到 ≥3 个渐进值，实得 ${JSON.stringify(pumped.texts)}`).toBeGreaterThanOrEqual(3);
    const nums = loaded.map((t) => Number(/^已加载 (\d+) 行$/.exec(t)?.[1]));
    // 首个采样点可能已含第一次续读（50ms 步进 vs 本地块拉取），只锁下界——
    // 首屏恰值 2048 已由循环外 toHaveText('已加载 2048 行') 锚定
    expect(nums[0]).toBeGreaterThanOrEqual(2048);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]!);
    }
    // ④ EOF 后翻转固定：继续滚动状态条不再变化
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await expect(status).toHaveText('共 20480 行');
    for (const r of stats.records) {
      expect(r.range, '全程不得出现全量 200 拉取').not.toBeNull();
    }
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- JVL-07

test('JVL-07：回看重拉失败停机闩——首拒后零风暴，用户动作单次重试成功（af6a705）', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startJvlFakeServer(
    { 'backtrack-6mb.jsonl': makeUniformJsonl(6 * MB) }, // 24576 行 24 块 > LRU 16
    // 块 0 Range 第 2 次请求回 500：第 1 次是首屏 prefetchThrough 合法拉取，
    // 第 2 次是滚回顶部触发的回看重拉（此时块 0 已被 LRU 逐出）
    { failRangeOnce: { path: 'backtrack-6mb.jsonl', range: blockRange(0), nth: 2 } }
  );
  try {
    const stats = new IoStats();
    const scroll = await openRemoteJsonl(page, fake, stats, 'backtrack-6mb.jsonl');
    const status = page.locator('.vv-jsonl-status');
    // ① 打开滚到底：块 0 在第 17 块入表时被 LRU 逐出（驻留 = 块 8..23）
    await pumpJsonlToEof(scroll);
    await expect(status).toHaveText('共 24576 行', { timeout: 10_000 });
    await stats.settled();
    // ② 滚回顶部：回看重拉首拒（500）
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect
      .poll(() => stats.records.filter((r) => r.status === 500).length, { timeout: 15_000 })
      .toBe(1);
    const failRec = stats.records.find((r) => r.status === 500);
    expect(failRec?.range).toBe(blockRange(0));
    const countAfterFail = stats.count();
    // ③ 停机闩：失败后 2s 内零自动重试（防活锁不风暴）
    await page.waitForTimeout(2_000);
    await stats.settled();
    expect(stats.count(), '失败后 2s 内不得出现任何自动重试请求').toBe(countAfterFail);
    // 占位卡维持：卡片在、内容未回填、无错误卡（自兜底非失败态）
    await expect(page.locator('.vv-jsonl-card[data-line="0"]')).toHaveCount(1);
    expect(page.locator('.vv-jsonl-card[data-line="0"]', { hasText: '"id": 0' })).toHaveCount(0);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // ④ 用户动作解除停机（滚动）：单次重试成功，内容回填
    await scroll.evaluate((el) => {
      el.scrollTop = 4000;
    });
    await page.waitForTimeout(200);
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    const filled = page.locator('.vv-jsonl-card[data-line="0"]', { hasText: '"id": 0' });
    await expect(filled).toBeVisible({ timeout: 15_000 });
    await stats.settled();
    expect(stats.count(), '重试应恰 1 个新块请求').toBe(countAfterFail + 1);
    const retry = stats.records[countAfterFail];
    expect(retry?.range).toBe(blockRange(0));
    expect(retry?.status).toBe(206);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- JVL-08

test('JVL-08：视口外卡片回收——滚动全程 DOM 卡片峰值有界（结构性代理锚）', async ({ page }) => {
  test.setTimeout(120_000);
  const TOTAL_ROWS = 5 * MB / ROW; // 20480
  const fake = await startJvlFakeServer({ 'progressive-5mb.jsonl': makeUniformJsonl(5 * MB) });
  try {
    const stats = new IoStats();
    const scroll = await openRemoteJsonl(page, fake, stats, 'progressive-5mb.jsonl');
    await expect(page.locator('.vv-jsonl-status')).toHaveText('已加载 2048 行', { timeout: 20_000 });
    // ① 全程贴底泵：每步采样视口内卡片数取峰值（可变高度窗口：渲染后实测高度进
    //    缓存、视口外卡片 DOM 回收——峰值应为视口高度量级，与总行数无关）
    const pumped = await pumpJsonlToEof(scroll, { sampleCards: true });
    await expect(page.locator('.vv-jsonl-status')).toHaveText(`共 ${TOTAL_ROWS} 行`, { timeout: 10_000 });
    // ② 有界代理断言：峰值 < 总行数 10%（量级阈值，避免实现微调误红；实测为几十）
    expect(pumped.maxCards, `卡片峰值 ${pumped.maxCards} 应远小于总行数 ${TOTAL_ROWS}`).toBeLessThan(
      TOTAL_ROWS * 0.1
    );
    expect(pumped.maxCards, '卡片峰值应覆盖至少一屏（>5），确认窗口真实渲染').toBeGreaterThanOrEqual(5);
    // ③ EOF 终态：泵循环见「共」即返，spacer 因行数增长再变高——补一次贴底使末行
    //    入窗（EOF 停机：零新 IO），末行真实渲染（无白屏/错位的终态证据）
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await expect(page.locator(`.vv-jsonl-card[data-line="${TOTAL_ROWS - 1}"]`)).toBeVisible();
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});
