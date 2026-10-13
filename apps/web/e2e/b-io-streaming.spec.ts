import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * IO 流式字节计量 e2e（b- 前缀；io-streaming 计划 1 Task 7，spec §6 验收口径）：
 * 远端来源（rangeCapable store）下 hex 流式窗口的字节级行为锚点——用 page.on('response')
 * 过滤 /api/file 累计响应字节数 + 记录 Range 头存在性：
 * - IO-01：10MB 文件首屏总拉取 ≤ 1MB（实测 ~139KB：探针 8KB + 结构尾窗 2×64KB），
 *   且每请求必带 Range（一个 200 全量即流式选路回归）
 * - IO-02：滚动触发按需续读——中部可视块不在缓存（head=块 0、结构尾窗=块 158/159），
 *   新 Range 请求按块拉取；拉满到底渲染末偏移行 0x9ffff0
 * - IO-03：SSE changed 重渲染免全量重读——增量 < 2MB（窗口级：新探针 + 新尾窗）
 *   而非 10MB 全量
 * - IO-04：窗口模式搜索 need/chunk 端到端——worker 以 1MB 步进发 search-need、
 *   client 经 ctx.read 逐块回灌（命中 0x600000 需 chunk 0..6），命中跳转正确
 *   （t-hex-enhance HEX-SEARCH 模式）
 * - IO-05：远端 5MB jsonl 窗口模式计量（计划 2 Task 5）——首屏探针+前 2 块
 *   （256KB 块）总拉取 <1MB；滚动到底一次一块续读至 EOF 状态条「共 N 行」；
 *   EOF 后滚动零 IO（消费契约停机）；末行坏行徽标「N 行解析失败」渐进文案
 *   与全量模式同款（t-open-with OPEN-05 语义）
 *
 * code 窗口流式（io-streaming 计划 3 Task 6，spec §4.3 验收口径）：
 * - IO-06：远端 10MB js code 首屏总拉取 ≤1MB（探针 8KB + 首块 256KB，逐请求 Range）；
 *   引擎「hljs 兜底」= 窗口 lazy 路径证据（假服务器无 compute 能力 → 路由 null →
 *   行级 hljs；误选全量 tree-sitter 时 10MB 整文件解析必超时，标签使失败模式可读）
 * - IO-07：code 滚动续读至 EOF——贴底循环一次一块（jsonl IO-05 同构），新请求全部
 *   为恰 256KB 的块区间（BlockStream 步进形状），末行（0 基 163839）真实渲染
 * - IO-08：≤2MB code 全量路径——head 探测后守卫经 ctx.read 补拉全量（Range
 *   bytes=0-<MAX> 原样透传形状断言 + body 恰全尺寸），tree-sitter 整文件引擎，
 *   滚动零 IO（整件在手）
 * - IO-09：code 后台全文扫描搜索端到端——扫描逐块拉到 EOF（40 块）、命中渐进、
 *   gotoMatch ensure 补块后行号与三布点构造吻合（T5 评审待验面「命中跳转正确」）
 * - IO-10：扫描取消不悬挂 + 扫描中滚动交错（T5 评审待验面）——假服务器 stall 门
 *   冻结块 2+ 的 Range 应答：扫描停在门上时越界滚动零额外请求不崩溃，Esc 取消
 *   （令牌失效）放行后以部分结果收场，新搜索照常完成且扫到 EOF 末行可渲染
 * - IO-11：>512MB 构造即知超限——tree size 600MB（size 是客户端唯一事实来源，
 *   超限路径零读块字节，与真实 513MB 文件在客户端观测面等价；513MB 实体无法在
 *   测试内存构造）：仅探针 1 请求 + 流式上限提示条 + 引擎终值 plain
 *
 * 通道：t-workspace 假服务器先例（health/ticket/events SSE + CORS，跨源 4173 页面），
 * 本版扩展：/api/tree 携带 size（FileSource.size 事实来源，窗口模式判定依赖）、
 * /api/file 支持 Range（bytes=start-end → 206 精确切片，无 Range → 200 全量）、
 * /api/events 挂连后可注入 changed 帧（SSE 重渲染触发）。
 * 字节计量放 spec 侧（page.on('response')）而非响应头：计量是测试关注点，不污染产品面。
 */

const MB = 1024 * 1024;
/** 10MB：窗口模式必经路径（> FULL_LIMIT 1MB → head 探测而非全量直读） */
const BIG_BYTES = 10 * MB;
/** 探针 + 结构尾窗（2×64KB 块）的理论首屏字节，实证锚的下界参考 */
const FIRST_SCREEN_EXPECTED = 8 * 1024 + 2 * 64 * 1024;

/**
 * 已知布点的 10MB 样例：主体 0x41（'A'，无 magic/EOCD 签名 → 结构解析「未知二进制」，
 * 状态行稳定可断言）；0x300000 / 0x600000 布点 'de ad'（搜索命中，分属搜索 chunk 3/6，
 * 跨 1MB 边界验证 need/chunk 步进）。
 */
function makeBigFile(): Uint8Array {
  const bytes = new Uint8Array(BIG_BYTES);
  bytes.fill(0x41);
  for (const off of [3 * MB, 6 * MB]) {
    bytes[off] = 0xde;
    bytes[off + 1] = 0xad;
  }
  return bytes;
}

/** 单条 /api/file 响应计量记录：Range 请求头（null = 全量 200）与响应体字节数 */
interface IoRecord {
  range: string | null;
  bytes: number | null;
}

/** /api/file 响应计量（page.on('response') 过滤）：body 异步补齐，settled() 等齐后读数 */
class IoStats {
  readonly records: IoRecord[] = [];
  private pending: Promise<void>[] = [];

  attach(page: Page): void {
    page.on('response', (res) => {
      if (new URL(res.url()).pathname !== '/api/file') return;
      const rec: IoRecord = { range: res.request().headers()['range'] ?? null, bytes: null };
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

  total(): number {
    return this.records.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  }
}

/**
 * 假 vviewer 文件服务器（t-workspace startFakeServer 的流式扩展版）：内存 bytes 表，
 * /api/tree 带 size、/api/file 支持 Range（206 + Content-Range 精确切片）、
 * /api/events 挂连登记（notifyChanged 注入 changed 帧）。页面源 4173 跨源：
 * 全响应带 ACAO:*（EventSource 亦要求）。
 *
 * 条目两种形态：裸 Uint8Array（size=实体字节数）或 { bytes, treeSize }（tree 汇报
 * 与实体解耦——IO-11 用它构造「size 已知超 512MB」的零读停机面：size 是客户端唯一
 * 事实来源，超限路径不读任何块字节，实体可远小于汇报值）。
 */
type IoFakeFile = Uint8Array | { bytes: Uint8Array; treeSize: number };

function fileBytesOf(entry: IoFakeFile): Uint8Array {
  return entry instanceof Uint8Array ? entry : entry.bytes;
}

function treeSizeOf(entry: IoFakeFile): number {
  return entry instanceof Uint8Array ? entry.length : entry.treeSize;
}

interface IoFakeServer {
  base: string;
  host: string;
  /** 向全部挂连的 SSE 客户端推送 changed 帧（模拟服务端 watcher 检出文件变更） */
  notifyChanged(paths: string[]): void;
  /** 释放 stall 门（startIoFakeServer opts.stall 布置；未布置时 no-op）：
   * 已挂起的 Range 应答全部落地，后续请求正常直答（门一次性放开不复闭） */
  releaseStall(): void;
  close(): Promise<void>;
}

interface IoFakeServerOptions {
  /** 冻结指定文件 start ≥ minStart 的 Range 应答（挂起不回，直至 releaseStall）：
   * 「扫描中取消/交错」类时序面的确定性构造（IO-10），杜绝真实时序竞态 */
  stall?: { path: string; minStart: number };
}

async function startIoFakeServer(
  files: Record<string, IoFakeFile>,
  opts?: IoFakeServerOptions
): Promise<IoFakeServer> {
  const sseClients = new Set<http.ServerResponse>();
  let stallRelease: (() => void) | null = null;
  const stallGate = new Promise<void>((ok) => {
    stallRelease = ok;
  });
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
      res.end(JSON.stringify({ ticket: 'io-e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res)); // 断连/关闭自动出册
      return; // 保持打开：帧经 notifyChanged 注入
    }
    if (url.pathname === '/api/tree') {
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const prefix = p === '' ? '' : `${p}/`;
      const entries = new Map<string, { name: string; kind: 'dir' | 'file'; size?: number }>();
      for (const [key, entry] of Object.entries(files)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const head = rest.split('/')[0]!;
        entries.set(
          head,
          rest.includes('/')
            ? { name: head, kind: 'dir' }
            : { name: head, kind: 'file', size: treeSizeOf(entry) }
        );
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [...entries.values()] }));
      return;
    }
    if (url.pathname === '/api/file') {
      const entry = files[url.searchParams.get('path') ?? ''];
      if (entry === undefined) {
        res.writeHead(404, cors);
        res.end('no such file');
        return;
      }
      const bytes = fileBytesOf(entry);
      // Range 透传契约（remote.ts read）：bytes=start-end（end 含）→ 206 精确切片；
      // 服务器忽略 Range 回 200 全量是允许形态（客户端自校验），但流式锚点测试中
      // 出现 200 即全量拉取回归（IO-01 逐请求 Range 断言承接）
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), bytes.length - 1);
        const slice = bytes.subarray(start, end + 1);
        const serve = (): void => {
          res.writeHead(206, {
            ...cors,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice.length),
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${bytes.length}`
          });
          res.end(slice);
        };
        // stall 门（IO-10）：匹配区间的应答挂起直至 releaseStall（确定性时序构造）
        const stall = opts?.stall;
        if (stall !== undefined && url.searchParams.get('path') === stall.path && start >= stall.minStart) {
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
    notifyChanged(paths) {
      const frame = `data: ${JSON.stringify({ type: 'changed', paths })}\n\n`;
      for (const client of [...sseClients]) {
        try {
          client.write(frame);
        } catch {
          sseClients.delete(client); // 已断连的挂连：出册，帧由活连承载
        }
      }
    },
    releaseStall() {
      stallRelease?.(); // 已 resolve 的门重复调用为 no-op（幂等）
    },
    close: async () => {
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

/** 等应用挂载（t-workspace waitAppMounted 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 连接表单提交（t-workspace connectForm 同款；token 留空） */
async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/**
 * 打开远端 big.bin 的 hex tab 并等首屏 IO 收敛：
 * 计量 attach 先于 goto（不漏请求）→ 连接 → 树行打开 → 状态行「10.0 MB · 未知二进制」
 * （结构尾窗拉取 + 解析完成的确定性信号）→ settled 等齐 body 计量。
 */
async function openRemoteBigHex(page: Page, fake: IoFakeServer, stats: IoStats): Promise<void> {
  stats.attach(page);
  await waitAppMounted(page);
  await connectForm(page, fake.base);
  await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'big.bin' }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: 'big.bin' })).toBeVisible();
  await expect(page.locator('.vv-hex-status')).toContainText('10.0 MB · 未知二进制', {
    timeout: 20_000
  });
  await stats.settled();
  await page.waitForTimeout(300); // 收敛保险：理论无后续 IO，防偶发迟滞请求漏计
  await stats.settled();
}

/** 含当前命中（active 档）的 hex 行（t-hex-enhance 同款：has 须为文档级 page.locator） */
function activeHitRow(page: Page) {
  return page.locator('.vv-hex-row', { has: page.locator('.vv-hex-hit-active') });
}

// ---------------------------------------------------------------- IO-01

test('IO-01：远端 10MB 文件 hex 首屏总拉取 ≤ 1MB（逐请求 Range，无全量 200）', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'big.bin': makeBigFile() });
  try {
    const stats = new IoStats();
    await openRemoteBigHex(page, fake, stats);
    // 状态行（formatSize）：窗口模式 totalSize = ctx.size = 10MB
    await expect(page.locator('.vv-hex-status')).toContainText('10.0 MB');
    // 首屏至少探针 + 结构尾窗两块（3 请求），且全部带 Range——任一 200 全量即流式回归
    expect(stats.count()).toBeGreaterThanOrEqual(3);
    for (const r of stats.records) {
      expect(r.range, '首屏 /api/file 请求必须带 Range（200 全量拉取 = streaming 选路回归）').not.toBeNull();
      expect(r.bytes, 'body 计量必须落定').not.toBeNull();
      expect(r.bytes as number).toBeGreaterThanOrEqual(0);
    }
    // 总量上限（spec §6 口径 ≤1MB + 10% 余量）；下界锁「窗口路径真实发生」
    //（探针 8KB + 尾窗 128KB ≈ 139KB，全量回归时为 10MB 级必超上限）
    expect(stats.total()).toBeGreaterThanOrEqual(FIRST_SCREEN_EXPECTED);
    expect(stats.total()).toBeLessThanOrEqual(1_100_000);
    console.log(
      `[iostream] 首屏计量: ${stats.count()} 请求 / ${stats.total()} B（预算 1_100_000，理论 ${FIRST_SCREEN_EXPECTED}）`
    );
    // 首屏行真实渲染（head 块 0 供数，非占位行）
    await expect(page.locator('.vv-hex-dump .vv-hex-row').first()).toHaveText(/^00000000 {2}41/);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-02

test('IO-02：滚动触发按需续读——中部可视块新 Range 拉取 + 拉满到底渲染末偏移行', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'big.bin': makeBigFile() });
  try {
    const stats = new IoStats();
    await openRemoteBigHex(page, fake, stats);
    const dump = page.locator('.vv-hex-dump');
    const baseline = stats.count();

    // ① 滚到纵向中点（scrollHeight/2 → 首可视行恰为 0x500000）：所在块 80 不在缓存
    //    （head=块 0、结构尾窗=块 158/159、首屏无中部读）→ 必须新发按需 Range 拉块
    await dump.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    const midRow = dump.locator('.vv-hex-row', { hasText: /^00500000/ });
    await expect(midRow).toBeVisible({ timeout: 10_000 }); // 占位行不含偏移文本，出现即真实行
    await expect(midRow).toHaveText(/^00500000 {2}41/);
    await expect
      .poll(() => stats.count(), { timeout: 10_000 })
      .toBeGreaterThan(baseline);
    const midRanges = stats.records.slice(baseline).map((r) => r.range);
    // 块 80 = [0x500000, 0x510000)：块端点精确区间（64KB 步进的续读证据）
    expect(
      midRanges.some((r) => r === 'bytes=5242880-5308415'),
      `续读应按块 80 精确区间拉取，实得 ${JSON.stringify(midRanges)}`
    ).toBe(true);

    // ② 拉满到底：末行 0x9ffff0（10MB = 655360 行整，末行起偏 0x9ffff0）——
    //    结构尾窗块已缓存时零读直渲、被逐出时按需重拉，两路径都必须出真实行
    await dump.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const lastRow = dump.locator('.vv-hex-row', { hasText: /^009ffff0/ });
    await expect(lastRow).toBeVisible({ timeout: 10_000 });
    await expect(lastRow).toHaveText(/^009ffff0 {2}41/);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-03

test('IO-03：SSE changed 重渲染免全量重读——增量 < 2MB（窗口级）而非 10MB 全量', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'big.bin': makeBigFile() });
  try {
    const stats = new IoStats();
    await openRemoteBigHex(page, fake, stats);
    const bytesBefore = stats.total();
    const countBefore = stats.count();

    // 外部变更：假服务器向挂连 SSE 推 changed 帧 → refreshPaths → rev++ 重渲染
    fake.notifyChanged(['big.bin']);
    // 重渲染 = 新探针 + 新结构尾窗（≥3 个 Range 请求；新 hexSource 块缓存不继承旧态）
    await expect
      .poll(() => stats.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(countBefore + 3);
    await stats.settled();
    await page.waitForTimeout(300); // 收敛保险（同 openRemoteBigHex 口径）
    await stats.settled();

    const growth = stats.total() - bytesBefore;
    expect(growth).toBeGreaterThan(0);
    // 上限 2MB = 窗口级增量（实测 ~139KB）；10MB 级增幅即「重渲染整件重读」回归
    expect(growth, `SSE 重渲染增量 ${growth}B 应为窗口级（<2MB），全量重读回归即 ~10MB`).toBeLessThan(
      2_000_000
    );
    console.log(`[iostream] SSE 重渲染增量: ${growth} B（预算 2_000_000）`);
    for (const r of stats.records.slice(countBefore)) {
      expect(r.range, '重渲染请求同样必须带 Range').not.toBeNull();
    }
    // 重渲染后内容完好（非占位/错误卡）
    await expect(page.locator('.vv-hex-status')).toContainText('10.0 MB · 未知二进制');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-04

test('IO-04：窗口模式搜索 need/chunk 端到端——1MB 步进拉块扫描 + 命中跳转正确', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'big.bin': makeBigFile() });
  try {
    const stats = new IoStats();
    await openRemoteBigHex(page, fake, stats);
    const baseline = stats.count();
    const search = page.locator('.vv-hex-search');
    const status = page.locator('.vv-hex-search-status');

    // ① hex 搜索 'de ad'（0x300000/0x600000 两布点）：worker 1MB 步进 need、client
    //    ctx.read 回灌（0x600000 需 chunk 0..6 共 7 块，全扫为 10 块）——窗口模式
    //    无 data 请求，超大文件不整件预读
    await search.fill('de ad');
    await search.press('Enter');
    await expect(status).toHaveText('1/2 处命中', { timeout: 30_000 }); // done 自动定位首处
    await expect(activeHitRow(page)).toHaveText(/^00300000/);

    // ② 导航第二处：跨 3MB 定位 0x600000，命中行块按需 ensure 后高亮重绘
    await page.locator('.vv-hex-search-next').click();
    await expect(status).toHaveText('2/2 处命中');
    await expect(activeHitRow(page)).toHaveText(/^00600000/);

    // ③ need/chunk 证据：chunk 6 = [0x600000, 0x700000) 的 1MB Range 区间（end 含）
    //    恰为 worker need 步进形状（hexSource 命中行块拉取是 64KB 块区间，二者可辨）
    const searchRanges = stats.records.slice(baseline).map((r) => r.range);
    expect(
      searchRanges.some((r) => r === 'bytes=6291456-7340031'),
      `搜索应经 1MB 步进 chunk 拉取覆盖 0x600000，实得 ${JSON.stringify(searchRanges)}`
    ).toBe(true);
    // 覆盖 0x600001 至少需 chunk 0..6（7 块）
    expect(stats.count() - baseline).toBeGreaterThanOrEqual(7);
    for (const r of stats.records) {
      expect(r.range, '搜索全程不得出现全量 200 拉取').not.toBeNull();
    }
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-05

/** 5MB jsonl：256B/行（含 \n）× 20480 行 = 恰 5MB；窗口块 256KB → 每块恰 1024 行 */
const JSONL_BYTES = 5 * MB;
const JSONL_ROWS = JSONL_BYTES / 256;
/** 首屏理论恰值：探针 8KB + 前 2 块（2×256KB）——下界锁「窗口路径真实发生」 */
const JSONL_FIRST_SCREEN_EXPECTED = 8 * 1024 + 2 * 256 * 1024;

/**
 * 已知行数的 5MB jsonl：每行 `{"id":N,"pad":"aaa…"}` 补齐 255 字符 + '\n'（末行
 * 故意未闭合字符串 = 同长坏行）。坏行让失败徽标的渐进语义一并入锚：解析按窗口
 * 惰性，首屏（全合法行）无徽标，滚动到底坏行入窗后状态条出现「1 行解析失败」
 * （t-open-with OPEN-05 的徽标文案在窗口流式模式同款，不回归）。
 */
function makeJsonlFile(): Uint8Array {
  const ROW = 256;
  const lines: string[] = [];
  for (let i = 0; i < JSONL_ROWS; i++) {
    const head = `{"id":${i},"pad":"`;
    const broken = i === JSONL_ROWS - 1;
    lines.push(head + 'a'.repeat(ROW - 1 - head.length - (broken ? 0 : 2)) + (broken ? '' : '"}'));
  }
  return new TextEncoder().encode(lines.join('\n') + '\n'); // ASCII：字节数 === 字符数
}

test('IO-05：远端 5MB jsonl 首屏总拉取 <1MB（探针+2 块）+ 滚动到底续读至 EOF「共 N 行」', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'big.jsonl': makeJsonlFile() });
  try {
    const stats = new IoStats();
    stats.attach(page);
    await waitAppMounted(page);
    await connectForm(page, fake.base);
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'big.jsonl' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'big.jsonl' })).toBeVisible();
    const status = page.locator('.vv-jsonl-status');

    // ① 首屏窗口模式：.vv-jsonl 挂载前已 ensure 前 2 块（render 先拉后挂）——
    //    「已加载 2048 行」（2 块 × 每块 1024 行）即窗口路径的确定性信号
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    await expect(status).toHaveText('已加载 2048 行', { timeout: 20_000 });
    await stats.settled();
    await page.waitForTimeout(300); // 收敛保险（IO-01 同口径）：防偶发迟滞请求漏计
    await stats.settled();
    expect(stats.count()).toBeGreaterThanOrEqual(3); // 探针 + 块 0 + 块 1
    for (const r of stats.records) {
      expect(r.range, '首屏 /api/file 请求必须带 Range（200 全量拉取 = streaming 选路回归）').not.toBeNull();
    }
    // 上限即本用例标题口径：head+2 块+余量（<1MB）；全量回归时 5MB 级必超
    expect(stats.total()).toBeGreaterThanOrEqual(JSONL_FIRST_SCREEN_EXPECTED);
    expect(stats.total(), `jsonl 首屏总拉取 ${stats.total()}B 应 <1MB`).toBeLessThan(1_000_000);
    console.log(
      `[iostream] jsonl 首屏计量: ${stats.count()} 请求 / ${stats.total()} B（预算 1_000_000，理论 ${JSONL_FIRST_SCREEN_EXPECTED}）`
    );

    // ② 滚动到底触发续读：一次一块（滚动近尾部 → 拉块 → refresh 重评）直至 EOF，
    //    状态条落「共 20480 行」（页内循环反复贴底：每次贴底触发一块续读）
    const scroll = page.locator('.vv-jsonl-scroll');
    await scroll.evaluate(async (el) => {
      const statusEl = el.parentElement!.querySelector('.vv-jsonl-status')!;
      for (let i = 0; i < 300; i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 50));
        if (statusEl.textContent?.startsWith('共 ')) return;
      }
      throw new Error('jsonl 续读未在预算轮次内到达 EOF');
    });
    await expect(status).toContainText('共 20480 行', { timeout: 10_000 });
    await stats.settled();
    for (const r of stats.records) {
      expect(r.range, '续读全程不得出现全量 200 拉取').not.toBeNull();
    }
    expect(stats.total(), '续读到底后总拉取应 ≥ 文件本体（20 块逐块拉取的证据）').toBeGreaterThanOrEqual(
      5 * MB
    );

    // ③ EOF 后滚动零 IO（消费契约：finishJsonlIndex 后续读/拉块停机）
    const countAtEnd = stats.count();
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await stats.settled();
    expect(stats.count(), 'EOF 后滚动不得再发任何 /api/file 请求').toBe(countAtEnd);

    // ④ 失败徽标渐进语义 + 到尾证据：末行坏行入窗才计数（首屏无徽标），
    //    徽标文案与全量模式逐字同款（t-open-with OPEN-05 对照）；末行邻位真实卡片
    await expect(page.locator('.vv-jsonl-card-failed')).toHaveCount(1);
    await expect(status).toContainText('1 行解析失败');
    // 末行邻位真实行渲染（续读到尾的证据）：卡片=「1 基行号徽标 + pretty 正文」
    // （JSON.stringify 2 缩进，冒号带空格）；'"id": 20478' 唯一命中行 20478 正文
    //（裸 '20478' 会同时命中行 20477 的徽标——strict mode 二元素冲突）
    await expect(page.locator('.vv-jsonl-card', { hasText: '"id": 20478' })).toBeVisible();
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------- code 窗口流式（计划 3 Task 6）

/** code 窗口块大小（render-text code.ts CODE_WINDOW_BLOCK_BYTES 同源）：256KB */
const CODE_BLOCK_BYTES = 256 * 1024;
/** 行字节（含 \n）：行 i 起始偏移 = i×64（纯 ASCII，字符数 === 字节数，偏移可预算） */
const CODE_ROW_BYTES = 64;

/** 10MB js：163840 行 × 64B 整（= 40 个 256KB 块）；三布点分属块 0/19/39 */
const BIG_JS_ROWS = 163_840;
const BIG_JS_NEEDLES = [1_000, 80_000, 160_000] as const;

/** 3MB js（IO-10 专载）：49152 行 = 12 块；布点在块 0（stall 门之前即可见） */
const SCAN_JS_ROWS = 49_152;
const SCAN_JS_NEEDLES = [100, 200] as const;

/** 1.5MB js（IO-08 专载）：> FULL_LIMIT 1MB（走 head 探测）且 ≤ 2MB（窗口分界之下） */
const MID_JS_BYTES = 1_572_864;
const MID_JS_ROWS = MID_JS_BYTES / CODE_ROW_BYTES;

/**
 * 定长 js 行构造：`const v{i} = 'pad';` + '\n' 恰 64 字节——行 i 起始偏移可预算
 * （块号 = floor(i×64/256KB)），末行行号/命中行号断言直接对得上构造值。
 * needleRows 布点行把 pad 换成 zzneedleqz（搜索命中，文本特征唯一）。
 */
function makeCodeFile(rows: number, needleRows: readonly number[] = []): Uint8Array {
  const needles = new Set(needleRows);
  const parts = new Array<string>(rows);
  for (let i = 0; i < rows; i++) {
    const head = `const v${i} = '`;
    const core = needles.has(i) ? 'zzneedleqz' : '';
    const pad = CODE_ROW_BYTES - 1 - head.length - 2 - core.length;
    parts[i] = `${head}${core}${'x'.repeat(pad)}';\n`;
  }
  return new TextEncoder().encode(parts.join(''));
}

/** 块 b 的精确 Range 区间字符串（BlockStream 步进形状：256KB 端点，末块由服务器钳） */
function codeBlockRange(b: number): string {
  return `bytes=${b * CODE_BLOCK_BYTES}-${(b + 1) * CODE_BLOCK_BYTES - 1}`;
}

/**
 * 打开远端 code 文件 tab 并等首屏 IO 收敛（openRemoteBigHex 的 code 同构）：
 * 首行真实渲染（窗口模式首块供数 / 全量模式整件供数）为就绪信号 →
 * settled 等齐 body 计量 + 收敛保险（防偶发迟滞请求漏计）。返回内部滚动容器。
 */
async function openRemoteCodeFile(
  page: Page,
  fake: IoFakeServer,
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
  const pre = page.locator('.vv-code-pre');
  await expect(pre.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
  await stats.settled();
  await page.waitForTimeout(300);
  await stats.settled();
  return pre;
}

/** 打开文件内搜索面板并输入词（b-in-file-search 同款：'/' 打开，输入框自聚焦） */
async function panelSearch(page: Page, term: string): Promise<void> {
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText(term);
}

/** 当前命中行（code active 行级高亮；1.5s 限时语义下断言须紧随计数落定） */
function activeCodeHitLine(page: Page): Locator {
  return page.locator('.vv-code-line.vv-search-hit-line-active');
}

// ---------------------------------------------------------------- IO-06

test('IO-06：远端 10MB js code 窗口首屏总拉取 ≤1MB（探针+首块，逐请求 Range）', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'big.js': makeCodeFile(BIG_JS_ROWS, BIG_JS_NEEDLES) });
  try {
    const stats = new IoStats();
    await openRemoteCodeFile(page, fake, stats, 'big.js');
    // 首屏至少探针 + 块 0（head 8KB 部分预置被整块替换），全部带 Range
    expect(stats.count()).toBeGreaterThanOrEqual(2);
    for (const r of stats.records) {
      expect(r.range, '首屏 /api/file 请求必须带 Range（200 全量拉取 = streaming 选路回归）').not.toBeNull();
    }
    expect(stats.records[0]?.range, '首请求应为 head 探测').toBe('bytes=0-8191');
    expect(stats.records[1]?.range, '次请求应为块 0 整块（256KB）').toBe(codeBlockRange(0));
    // 上限即本用例标题口径（spec §6 同款 +10% 余量）；全量/大预取回归时 10MB 级必超
    const firstScreenExpected = 8 * 1024 + CODE_BLOCK_BYTES;
    expect(stats.total()).toBeGreaterThanOrEqual(firstScreenExpected);
    expect(stats.total(), `code 首屏总拉取 ${stats.total()}B 应 ≤1.1MB`).toBeLessThanOrEqual(1_100_000);
    console.log(
      `[iostream] code 首屏计量: ${stats.count()} 请求 / ${stats.total()} B（预算 1_100_000，理论 ${firstScreenExpected}）`
    );
    // 引擎标签 = 窗口 lazy 路径证据：远端 store 无 compute 能力 → 路由 null → 行级 hljs
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-07

test('IO-07：code 滚动续读至 EOF——256KB 块精确区间逐块拉取 + 末行真实渲染', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'big.js': makeCodeFile(BIG_JS_ROWS, BIG_JS_NEEDLES) });
  try {
    const stats = new IoStats();
    const pre = await openRemoteCodeFile(page, fake, stats, 'big.js');
    const baseline = stats.count();
    const lastLine = BIG_JS_ROWS - 1; // 0 基；行起始偏移 = 163839×64 ∈ 块 39

    // 贴底循环驱动续读（jsonl IO-05 同构：一次滚动事件至多推进一块，行数动态增长
    // 至 spacer 稳定、末行入窗即停）
    await pre.evaluate(async (el, last: number) => {
      for (let i = 0; i < 600; i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 50));
        if (el.querySelector(`[data-line="${last}"]`) !== null) return;
      }
      throw new Error('code 续读未在预算轮次内到达 EOF');
    }, lastLine);
    await expect(pre.locator(`.vv-code-line[data-line="${lastLine}"]`)).toContainText(
      `v${lastLine}`,
      { timeout: 10_000 }
    );
    await stats.settled();

    // 续读证据：全部新请求为恰 256KB 的块区间（BlockStream 步进形状；文件恰 40 块，
    // 无末块短读干扰），并覆盖中部块 20 与末块 39
    const ranges = stats.records.slice(baseline).map((r) => r.range);
    expect(ranges.length, '滚动必须触发按需续读').toBeGreaterThan(0);
    for (const range of ranges) {
      expect(range, '续读请求必须带 Range').not.toBeNull();
      const m = /^bytes=(\d+)-(\d+)$/.exec(range as string);
      expect(m, `Range 形状异常: ${range}`).not.toBeNull();
      expect(Number(m![2]) - Number(m![1]) + 1, `块请求应恰 256KB: ${range}`).toBe(CODE_BLOCK_BYTES);
    }
    expect(ranges, `实得 ${JSON.stringify(ranges)}`).toContain(codeBlockRange(20));
    expect(ranges, `实得 ${JSON.stringify(ranges)}`).toContain(codeBlockRange(39));
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-08

test('IO-08：≤2MB code 全量路径——打开即全量 read（守卫补拉）+ tree-sitter 整文件引擎', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startIoFakeServer({ 'mid.js': makeCodeFile(MID_JS_ROWS) });
  try {
    const stats = new IoStats();
    const pre = await openRemoteCodeFile(page, fake, stats, 'mid.js');
    // 全量 tree-sitter 主路径（t-hl HL-01 同款状态栏锚点；1.5MB 整文件解析给足超时）
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 45_000 });
    await stats.settled();
    await page.waitForTimeout(300);
    await stats.settled();

    // 打开即全量 read 断言：head 探测（8KB）→ 窗口分界（size ≤2MB）→ 守卫经 ctx.read
    // 补拉全量（read({start:0,end:MAX_SAFE_INTEGER}) 的 Range 原样透传，服务器钳到
    // size-1 回 206 全量切片）——此后零 IO（整件在手，虚拟滚动/高亮均不再读）
    expect(stats.count(), '全量路径应恰为 探针+全量补拉 2 个请求').toBe(2);
    expect(stats.records[0]?.range).toBe('bytes=0-8191');
    expect(stats.records[1]?.range).toBe('bytes=0-9007199254740991');
    expect(stats.records[1]?.bytes as number, '补拉应恰为全尺寸').toBe(MID_JS_BYTES);
    for (const r of stats.records) {
      expect(r.range, '全量路径同样不得出现 200 响应形态').not.toBeNull();
    }

    // 整件在手：滚到底末行真实渲染且零新 IO
    const baseline = stats.count();
    const lastLine = MID_JS_ROWS - 1;
    await pre.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(pre.locator(`.vv-code-line[data-line="${lastLine}"]`)).toContainText(
      `v${lastLine}`,
      { timeout: 10_000 }
    );
    await stats.settled();
    expect(stats.count(), '全量模式滚动不得再发 /api/file 请求').toBe(baseline);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-09

test('IO-09：code 后台全文扫描搜索——逐块拉取至 EOF + 命中跳转 ensure 定位正确', async ({ page }) => {
  test.setTimeout(180_000);
  const fake = await startIoFakeServer({ 'big.js': makeCodeFile(BIG_JS_ROWS, BIG_JS_NEEDLES) });
  try {
    const stats = new IoStats();
    await openRemoteCodeFile(page, fake, stats, 'big.js');
    const baseline = stats.count();

    // 后台全文扫描：命中渐进上屏（先到先出），Promise 完成制——计数在扫描至 EOF 后落定
    await panelSearch(page, 'zzneedleqz');
    await expect(page.locator('.vv-search-count')).toHaveText('1/3', { timeout: 90_000 });

    // ① 扫描 IO 证据：块 1..39 全部经 256KB Range 步进拉取（块 0 在 baseline 前），
    //    覆盖命中行 80000 所在块 19 与末块 39（扫到 EOF），全程无全量 200
    await stats.settled();
    const scanRanges = stats.records.slice(baseline).map((r) => r.range ?? '');
    expect(scanRanges.length, '全文扫描应逐块拉取全文件（≥39 新块）').toBeGreaterThanOrEqual(39);
    expect(scanRanges, `实得 ${JSON.stringify(scanRanges)}`).toContain(codeBlockRange(19));
    expect(scanRanges, `实得 ${JSON.stringify(scanRanges)}`).toContain(codeBlockRange(39));
    for (const r of stats.records) {
      expect(r.range, '搜索扫描全程不得出现全量 200 拉取').not.toBeNull();
    }

    // ② 首命中自动定位（runSearch → gotoMatch(0)）：行号与构造吻合 + 词级命中可见
    await expect(activeCodeHitLine(page)).toHaveAttribute(
      'data-line',
      String(BIG_JS_NEEDLES[0]),
      { timeout: 10_000 }
    );
    await expect(activeCodeHitLine(page)).toContainText('zzneedleqz');

    // ③ 导航第二/第三处：gotoMatch ensure 补块（扫描后早期块普遍被 LRU 逐出，重拉
    //    合法）后行级高亮定位，行号逐一吻合
    await page.keyboard.press('Enter');
    await expect(page.locator('.vv-search-count')).toHaveText('2/3');
    await expect(activeCodeHitLine(page)).toHaveAttribute(
      'data-line',
      String(BIG_JS_NEEDLES[1]),
      { timeout: 15_000 }
    );
    await expect(activeCodeHitLine(page)).toContainText('zzneedleqz');
    await page.keyboard.press('Enter');
    await expect(page.locator('.vv-search-count')).toHaveText('3/3');
    await expect(activeCodeHitLine(page)).toHaveAttribute(
      'data-line',
      String(BIG_JS_NEEDLES[2]),
      { timeout: 15_000 }
    );
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-10

test('IO-10：扫描取消不悬挂 + 扫描中滚动交错——stall 门冻结应答下不崩溃、放行后新搜索完成', async ({ page }) => {
  test.setTimeout(120_000);
  // 3MB = 12 块：块 0/1 正常应答，块 2+ 的 Range 应答挂起在 stall 门（全文扫描必经）
  const fake = await startIoFakeServer(
    { 'scan.js': makeCodeFile(SCAN_JS_ROWS, SCAN_JS_NEEDLES) },
    { stall: { path: 'scan.js', minStart: 2 * CODE_BLOCK_BYTES } }
  );
  try {
    const stats = new IoStats();
    const pre = await openRemoteCodeFile(page, fake, stats, 'scan.js');
    expect(stats.count(), '打开应恰为 探针+块 0').toBe(2);

    // 无命中词触发全文扫描：块 1 落地后在块 2 上挂起（T5 评审待验面的确定性构造——
    // 扫描进度不上 UI，in-flight 证据取 IO 计量而非计数文本）
    await panelSearch(page, 'qqnothingqz');
    await expect
      .poll(() => stats.records.map((r) => r.range).includes(codeBlockRange(1)), { timeout: 15_000 })
      .toBe(true);
    await stats.settled();
    expect(stats.count(), '扫描应停在 stall 门上（块 2 无应答，含探针/块 0/块 1）').toBe(3);

    // 扫描中滚动交错（评审待验面）：越界滚动（占位行）+ 回顶——无崩溃无错误卡，
    // pulling 单飞闸下零额外块请求
    await pre.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    await pre.evaluate((el) => {
      el.scrollTop = 0;
    });
    await stats.settled();
    expect(stats.count(), '扫描挂起期间交错滚动不得再发块请求').toBe(3);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);

    // 取消（Esc = search('') 令牌失效）：面板关闭，扫描在下一检查点以部分结果收场
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-search-panel')).toHaveCount(0);

    // 放行 stall 门：挂起的块 2 应答落地（取消的扫描不悬挂——挂起请求有归宿）
    fake.releaseStall();
    await expect
      .poll(() => stats.records.map((r) => r.range).includes(codeBlockRange(2)), { timeout: 15_000 })
      .toBe(true);
    await stats.settled();

    // 新搜索完成（不悬挂的核心证据）：命中块 0 内两布点，计数与自动定位照常
    await panelSearch(page, 'zzneedleqz');
    await expect(page.locator('.vv-search-count')).toHaveText('1/2', { timeout: 60_000 });
    await expect(activeCodeHitLine(page)).toHaveAttribute(
      'data-line',
      String(SCAN_JS_NEEDLES[0]),
      { timeout: 10_000 }
    );

    // 第二次扫描至 EOF：贴底末行真实渲染（取消/交错后索引完好、消费契约未破坏）
    await pre.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const lastLine = SCAN_JS_ROWS - 1;
    await expect(pre.locator(`.vv-code-line[data-line="${lastLine}"]`)).toContainText(
      `v${lastLine}`,
      { timeout: 15_000 }
    );
    await stats.settled();
    for (const r of stats.records) {
      expect(r.range, '全程不得出现全量 200 拉取').not.toBeNull();
    }
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- IO-11

test('IO-11：>512MB 构造即知超限——零读停机（仅探针）+ 流式上限提示条', async ({ page }) => {
  test.setTimeout(60_000);
  // 等价构造：size 是客户端唯一事实来源，构造期 limitReached 路径不读任何块字节——
  // 100KB 实体 + tree size 600MB 与真实 513MB 文件在客户端观测面逐字节等价
  //（513MB 实体无法在测试内存构造；size 未知随续读逐块裁决的动态分支由
  // render-text 单测覆盖，此处锚的是「size 已知构造即知」主面）
  const fake = await startIoFakeServer({
    'huge.js': { bytes: makeCodeFile(1_600), treeSize: 600 * MB }
  });
  try {
    const stats = new IoStats();
    stats.attach(page);
    await waitAppMounted(page);
    await connectForm(page, fake.base);
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'huge.js' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'huge.js' })).toBeVisible();

    // 零读停机 + 非失败态提示条（spec §4.3 防线换代：解释停机而非报错，建议 hex）
    const notice = page.locator('.vv-code-oversize-card');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toHaveText('文件超过 512MB，已达流式渲染上限（索引停止推进），建议以 hex 打开');
    await stats.settled();
    await page.waitForTimeout(300);
    await stats.settled();
    expect(stats.count(), 'size 已知构造即知超限：除探针外必须零读').toBe(1);
    expect(stats.records[0]?.range).toBe('bytes=0-8191');
    // 引擎终值 plain（不留「解析中」）——提示条复用 vv-error-card 结构类但非错误卡，
    // 断言其持续在位而非错误卡片缺席
    await expect(page.locator('.vv-statusbar')).toContainText('纯文本', { timeout: 10_000 });
    await expect(notice).toBeVisible();
  } finally {
    await fake.close();
  }
});
