import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { tabNamed, waitAppMounted } from './helpers';

/**
 * STR 域（size 回填）：SSE changed / 手动刷新后的 FileSource.size 回填与回落 e2e。
 *
 * 被测面（apps/web/src/lib/tabsModel.svelte.ts）：
 * - refreshPaths（:429）：SSE changed 与手动刷新同通道（serverConnect.svelte.ts:88 /
 *   TabBarMenu.svelte:212 两处调用点）；开头 storeRevisions 自增（:434）驱动左栏
 *   树重建（AppShell.svelte:715 treeKey → :1271 {#key treeKey} 重挂 FileTree，
 *   重挂后 TreeNodeRow 展开态复位 → 树只重新列举根目录）。
 * - ≤1MB 面（:454-463）：size 已知且 ≤FULL_LIMIT（1_048_576）→ rev++ 且
 *   source.size 置 undefined（失效域）→ 重渲染时 dispatcher 侧 size 视为未知
 *   （dispatcher.ts:399-406 跳过 ≤1MB 全量物化分支，只做 8KB head 探测）→
 *   hex 渲染器走 size 未知的全量回退读（hex.ts:795-800 ctx.read 全区间），
 *   增长字节自然上屏；该面不进回填通道（无父目录 tree 请求、无增长提示）。
 * - >1MB 面（:454-457 → :466 → backfillStreamingSizes :566-603）：按父目录分组
 *   listChildren（同目录多 tab 单次请求）→ 条目 size 为有限数且与快照不同 →
 *   copy-on-write 回填 source.size（检出增长再经注入钩子提示「文件已变更」，
 *   tabsModel.svelte.ts:596-598）→ 随后 rev++ 触发恰一轮重渲染（回填先于 rev++，
 *   :597 → :600）。
 * - 回落（:568-571 store 缺失/无 listChildren；:582-587 listChildren 抛错）：放弃
 *   回填、即时 rev++，重渲染仍按陈旧 size 收口，无增长提示。
 * - size 未知（树面条目缺 size）：:589-595 的 typeof fresh.size==='number' 判否 →
 *   不回填、仅 rev++（同样按陈旧 size 收口）。
 *
 * 域内自建装置（不抽公共 helper、不 import 他域文件）：假 vviewer 服务器
 * （/api/health、/api/ticket、/api/events SSE 挂连登记 + notifyChanged 注入
 * changed 帧、/api/tree 条目带 size（可省略）/按父目录精确路径 500 失败门、
 * /api/file 206 精确切片且钳 end=min(req.end, len-1)）+ 请求日志自记 pathname/
 * query/Range 头/HTTP 状态/响应体字节/响应体文本（响应体字节按实测切片长度记，
 * 业务读计数据此做「读体过大 / 未按新 size 收口」类断言）。
 *
 * 断言纪律：每个断言都能被一处产品行为变更打红（详见 docs/e2e/sse-size-backfill.md）。
 */

/** 树面条目汇报的 size：数值 = 正常汇报；'omit' = 条目不带 size 字段（size 未知形态） */
type TreeSize = number | 'omit';

interface StrFakeFile {
  bytes: Uint8Array;
  treeSize: TreeSize;
}

/** 请求日志条目（服务器侧自记，不依赖页面网络栈——SW 拦截面不受影响） */
interface StrLogEntry {
  method: string;
  pathname: string;
  /** ?path= 查询参数（/api/tree 的目录、/api/file 的文件路径；根目录为 ''） */
  path: string;
  /** Range 请求头（null = 未带 Range） */
  range: string | null;
  status: number;
  /** 响应体字节数 */
  respBytes: number;
  /** 响应体文本（仅 JSON 类响应记录；二进制体只记字节数） */
  respText: string | null;
}

interface StrFakeServer {
  base: string;
  host: string;
  /** 覆盖某路径的实体字节与树面 size 汇报 */
  setFile(path: string, file: { bytes?: Uint8Array; treeSize?: TreeSize }): void;
  /** 布防：/api/tree?path=<dir> 精确路径返回 <status>（其余路径照常 200） */
  armTreeFailure(dir: string, status: number): void;
  /** 向全部挂连 SSE 客户端注入 changed 帧 */
  notifyChanged(paths: string[]): void;
  /** 当前挂连的 SSE 客户端数（判 SSE 通道已就绪） */
  sseClientCount(): number;
  /** 当前日志长度（变更前后分界标记） */
  mark(): number;
  logsSince(mark: number): StrLogEntry[];
  close(): Promise<void>;
}

const MB = 1024 * 1024;

/**
 * 探针读 Range：dispatcher 每轮渲染必发一次 head 探测读
 * （HEAD_SIZE=8192 → bytes=0-8191，dispatcher.ts:63/:403；size 已知且 ≤1MB 时
 * 该轮走 pumpFull 单窗读、不发探针读——故「探针读条数」= 「渲染轮数」）。
 * 窗口块读（bytes=0-65535 等 64KB 块）与探针读可区分（块读终点为块尾）。
 */
const PROBE_RANGE = 'bytes=0-8191';

/** ≤1MB 且 size 已知时的 pumpFull 单窗读 Range（dispatcher.ts:93-94，FULL_CHUNK=4MB > 文件长） */
const PUMP_FULL_RANGE = 'bytes=0-65535';

/**
 * 合成文件字节：前 split 字节 0x41、后段 0x42（增长区布点）。
 * 末行偏移 = 总长-16，落在增长区内 → 末行文本含 42（0x42 的十六进制列）。
 */
function makeFile(total: number, split: number): Uint8Array {
  const bytes = new Uint8Array(total);
  bytes.fill(0x41, 0, Math.min(split, total));
  bytes.fill(0x42, Math.min(split, total), total);
  return bytes;
}

/** git 探测通道请求判定（probeGitAvailability 逐级向上读 .git/HEAD）：非业务读 */
function isGitProbePath(path: string): boolean {
  return path === '.git' || path.startsWith('.git/') || path.includes('/.git/');
}

/** 业务 /api/file 读（剥离 git 探测通道） */
function businessReads(logs: StrLogEntry[]): StrLogEntry[] {
  return logs.filter((l) => l.pathname === '/api/file' && !isGitProbePath(l.path));
}

/** Range 终点（未带 Range = 全量读，视作无界） */
function rangeEnd(entry: StrLogEntry): number {
  const m = entry.range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(entry.range);
  return m === null ? Number.MAX_SAFE_INTEGER : Number(m[2]);
}

/** 某路径的探针读（每渲染轮恰一条） */
function probeReads(logs: StrLogEntry[], path: string): StrLogEntry[] {
  return businessReads(logs).filter((r) => r.path === path && r.range === PROBE_RANGE);
}

/** 假 vviewer 文件服务器（域内自建） */
async function startStrFakeServer(): Promise<StrFakeServer> {
  const files = new Map<string, StrFakeFile>();
  const treeFailures = new Map<string, number>();
  const logs: StrLogEntry[] = [];
  const sseClients = new Set<http.ServerResponse>();

  const treeEntries = (dir: string): Array<{ name: string; kind: 'dir' | 'file'; size?: number }> => {
    const out = new Map<string, { name: string; kind: 'dir' | 'file'; size?: number }>();
    for (const [filePath, file] of files) {
      if (dir !== '' && !filePath.startsWith(`${dir}/`)) continue;
      const rel = dir === '' ? filePath : filePath.slice(dir.length + 1);
      const head = rel.split('/')[0]!;
      if (rel.includes('/')) {
        out.set(head, { name: head, kind: 'dir' });
      } else {
        const entry: { name: string; kind: 'dir' | 'file'; size?: number } = { name: head, kind: 'file' };
        if (file.treeSize !== 'omit') entry.size = file.treeSize;
        out.set(head, entry);
      }
    }
    return [...out.values()];
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const pathParam = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
    const rangeHeader = req.headers.range ?? null;
    const record = (status: number, respBytes: number, respText: string | null): void => {
      logs.push({
        method: req.method ?? 'GET',
        pathname: url.pathname,
        path: pathParam,
        range: rangeHeader,
        status,
        respBytes,
        respText
      });
    };

    if (url.pathname === '/api/health') {
      const body = JSON.stringify({ capabilities: ['file-server'] });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(body);
      record(200, Buffer.byteLength(body), body);
      return;
    }
    if (url.pathname === '/api/ticket') {
      const body = JSON.stringify({ ticket: 'str-e2e' });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(body);
      record(200, Buffer.byteLength(body), body);
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      // 首帧注释：冲刷响应头（writeHead 本身不落 socket），浏览器 EventSource 立即
      // 进入已连接态；注释行不进 onmessage（EventSource 解析器忽略注释）
      res.write(': ping\n\n');
      return; // 保持打开：帧经 notifyChanged 注入
    }
    if (url.pathname === '/api/tree') {
      const failure = treeFailures.get(pathParam);
      if (failure !== undefined) {
        const body = JSON.stringify({ error: `tree ${pathParam} failed` });
        res.writeHead(failure, { ...cors, 'Content-Type': 'application/json' });
        res.end(body);
        record(failure, Buffer.byteLength(body), body);
        return;
      }
      const body = JSON.stringify({ entries: treeEntries(pathParam) });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(body);
      record(200, Buffer.byteLength(body), body);
      return;
    }
    if (url.pathname === '/api/file') {
      const file = files.get(pathParam);
      if (file === undefined) {
        const body = 'no such file';
        res.writeHead(404, cors);
        res.end(body);
        record(404, Buffer.byteLength(body), null);
        return;
      }
      const bytes = file.bytes;
      const m = rangeHeader === null ? null : /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
      if (m === null) {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          'Accept-Ranges': 'bytes'
        });
        res.end(bytes);
        record(200, bytes.length, null);
        return;
      }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.length - 1);
      const slice = bytes.subarray(start, end + 1);
      res.writeHead(206, {
        ...cors,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(slice.length),
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`
      });
      res.end(slice);
      record(206, slice.length, null);
      return;
    }
    res.writeHead(404, cors);
    res.end();
    record(404, 0, null);
  });

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    setFile(path, file) {
      const prev = files.get(path);
      files.set(path, {
        bytes: file.bytes ?? prev?.bytes ?? new Uint8Array(0),
        treeSize: file.treeSize ?? prev?.treeSize ?? 'omit'
      });
    },
    armTreeFailure(dir, status) {
      treeFailures.set(dir, status);
    },
    notifyChanged(paths) {
      const frame = `data: ${JSON.stringify({ type: 'changed', paths })}\n\n`;
      for (const client of [...sseClients]) {
        try {
          client.write(frame);
        } catch {
          sseClients.delete(client); // 断连出册，帧由活连承载
        }
      }
    },
    sseClientCount() {
      return sseClients.size;
    },
    mark() {
      return logs.length;
    },
    logsSince(mark) {
      return logs.slice(mark);
    },
    close: async () => {
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

/**
 * 状态条文本录制器：MutationObserver 记录 .vv-statusbar 的全部历史文本。
 * 用途——「文件已变更」提示只存活 4s（showStatusNotice 默认 duration），点检式
 * 断言会漏检瞬时提示；录制器覆盖整个变更窗口，缺席断言因此不失真。
 */
async function installStatusRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __vvStatusTexts: string[] };
    w.__vvStatusTexts = [];
    const collect = (): void => {
      const el = document.querySelector('.vv-statusbar');
      if (el === null) return;
      const text = (el.textContent ?? '').trim();
      if (text === '') return;
      const arr = w.__vvStatusTexts;
      if (arr[arr.length - 1] !== text) arr.push(text);
    };
    new MutationObserver(collect).observe(document, {
      subtree: true,
      childList: true,
      characterData: true
    });
  });
}

/** 读状态条历史文本（录制器） */
function statusTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __vvStatusTexts: string[] }).__vvStatusTexts);
}

/** 状态条历史里是否出现过匹配文本 */
async function statusEverSeen(page: Page, pattern: RegExp): Promise<boolean> {
  return (await statusTexts(page)).some((t) => pattern.test(t));
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 文件树行（按 .vv-tree-name 精确名定位，避免目录名/文件名互相命中） */
function treeRow(page: Page, name: string) {
  const exact = new RegExp(`^${escapeRe(name)}$`);
  return page.locator('.vv-tree-row').filter({ has: page.locator('.vv-tree-name', { hasText: exact }) });
}

/** 连接假服务器（TabBarMenu 融合菜单 → 连接服务器 → 表单） */
async function connectFakeServer(page: Page, fake: StrFakeServer): Promise<void> {
  await page.locator('.vv-tabbar-menu [aria-label="切换工作区"]').click();
  await expect(page.locator('.vv-tbmenu-pop')).toBeVisible();
  await page.locator('.vv-tbmenu-pop').getByRole('button', { name: '连接服务器', exact: true }).click();
  const form = page.locator('.vv-tbmenu-pop .vv-server-form');
  await expect(form).toBeVisible();
  await form.getByLabel('服务器地址').fill(fake.base);
  await form.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 20_000 });
}

/**
 * 展开目录并打开其中的文件（抽屉断点适配内置）。
 * 目录行点击是 toggle —— 同目录多文件只展开一次（expanded 集合），二次点击会
 * 把目录收起。
 */
async function openTreeFiles(
  page: Page,
  entries: Array<{ dir: string; file: string }>
): Promise<void> {
  const expanded = new Set<string>();
  for (const { dir, file } of entries) {
    const drawer = await openDrawerIfNarrow(page);
    if (!expanded.has(dir)) {
      await treeRow(page, dir).click();
      expanded.add(dir);
    }
    await expect(treeRow(page, file)).toBeVisible({ timeout: 20_000 });
    await treeRow(page, file).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(tabNamed(page, file)).toBeVisible({ timeout: 20_000 });
  }
}

/**
 * 等 SSE 通道挂连**且帧确被浏览器消费**。
 * 两段门：① 服务端挂连计数 > 0（EventSource 已建连）；② 注入一条不命中任何
 * tab 的 changed 帧，待其引发的树重建（storeRevisions++ → 根列举 path=''）出现
 * ——该请求只可能由浏览器侧消费帧后触发，故是「帧已送达并被处理」的浏览器侧
 * 证据（只靠①会把帧注入在浏览器 EventSource 就绪前 → 帧静默丢失）。
 */
async function waitSseReady(page: Page, fake: StrFakeServer): Promise<void> {
  await expect
    .poll(() => fake.sseClientCount(), { timeout: 20_000, message: 'SSE 通道未挂连' })
    .toBeGreaterThan(0);
  const rootsBefore = fake.logsSince(0).filter((l) => l.pathname === '/api/tree' && l.path === '').length;
  fake.notifyChanged(['__heartbeat__/none.bin']); // 不命中任何已开 tab → 只触发树重建
  await expect
    .poll(
      () => fake.logsSince(0).filter((l) => l.pathname === '/api/tree' && l.path === '').length,
      { timeout: 20_000, message: 'SSE 帧未被浏览器消费（心跳帧未引发树重建）' }
    )
    .toBeGreaterThan(rootsBefore);
  await expect(page.locator('.vv-tabbar')).toBeVisible();
}

/** hex 状态行（.vv-hex-status，承载 size 文案 + 结构解析结果） */
function hexStatus(page: Page) {
  return page.locator('.vv-hex-status');
}

/**
 * 等 hex 首屏渲染收口：状态行带上结构解析结果（'· 未知二进制'）——结构解析在
 * hexSource 尾窗 ensure 之后才落，故此信号同时意味着首屏的尾窗读已完成（变更
 * 前后分界标记取在此时，避免把首屏尾窗读误计到变更后）。
 * 耦合面：文案 '· 未知二进制' 出自 hex.ts:750（结构解析失败时为 '· 结构解析失败'）
 * ——文案变更需同步本门（域文档 §6.4 已登记该耦合）。
 */
async function waitHexSettled(page: Page): Promise<void> {
  await expect(hexStatus(page)).toContainText('· 未知二进制', { timeout: 30_000 });
}

// ---------------------------------------------------------------- STR-NEST-01

test('STR-NEST-01: ≤1MB 面 SSE changed 后 size 失效走全量回退读，增长字节上屏且不进回填通道', async ({
  page
}) => {
  test.setTimeout(150_000);
  const fake = await startStrFakeServer();
  try {
    fake.setFile('sub/small.bin', { bytes: makeFile(64 * 1024, 64 * 1024), treeSize: 64 * 1024 });
    await installStatusRecorder(page);
    await waitAppMounted(page);
    await connectFakeServer(page, fake);
    await openTreeFiles(page, [{ dir: 'sub', file: 'small.bin' }]);
    // 变更前：树面 size=64KB → ≤1MB 面（tabsModel.svelte.ts:462 失效域命中）
    await expect(hexStatus(page)).toContainText('64.0 KB');
    await waitHexSettled(page);
    await waitSseReady(page, fake);

    // 前提判据「变更前 size 快照已知且 ≤1MB」：该形态下 dispatcher 走 pumpFull
    // 单窗读（dispatcher.ts:401-404 → :93-94；远端源传 onReadProgress 故泵路生效，
    // ViewerPane.svelte:911），恰一条 bytes=0-65535 的读（不复发探针读——探针读
    // 只在 size 未知/超限时发）。
    // 若树面 size 未透传到 source.size（FileTree.svelte:19 onopen → AppShell.svelte
    // :1045 addTab），打开即走 size 未知全量回退读（探针读 + 全区间读），本判据
    // 即红 → 「≤1MB 失效域」前提被真正证明，而非因错误原因通过。
    const preReads = businessReads(fake.logsSince(0)).filter((r) => r.path === 'sub/small.bin');
    expect(preReads).toHaveLength(1);
    expect(preReads[0]?.range).toBe(PUMP_FULL_RANGE);
    expect(preReads[0]?.respBytes).toBe(64 * 1024);

    const mark = fake.mark();
    fake.setFile('sub/small.bin', { bytes: makeFile(96 * 1024, 64 * 1024), treeSize: 96 * 1024 });
    fake.notifyChanged(['sub/small.bin']);

    // ① 失效生效：重渲染按实长物化 → 状态行 96.0 KB（未按陈旧 64KB 收口）
    await expect(hexStatus(page)).toContainText('96.0 KB', { timeout: 30_000 });
    await expect(hexStatus(page)).not.toContainText('64.0 KB');
    // ② 恰一条整文件读（body == 96KB 实长），无读体超过实长（未按旧 size 窗口化）
    await expect
      .poll(
        () =>
          businessReads(fake.logsSince(mark)).filter((r) => r.path === 'sub/small.bin' && r.respBytes === 96 * 1024)
            .length,
        { timeout: 30_000, message: '未观测到整文件全量回退读' }
      )
      .toBeGreaterThanOrEqual(1);
    const reads = businessReads(fake.logsSince(mark)).filter((r) => r.path === 'sub/small.bin');
    expect(Math.max(...reads.map((r) => r.respBytes))).toBeLessThanOrEqual(96 * 1024);
    expect(reads.filter((r) => r.respBytes === 96 * 1024)).toHaveLength(1);
    // ③ 不进回填通道：变更后无父目录 tree 请求（>1MB 面才有 listChildren('sub')）；
    //    树重建只列举根目录（path=''）——缺席断言先证根列举在场，避免恒真
    await expect
      .poll(() => fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === '').length, {
        timeout: 20_000,
        message: '树重建根列举未发生'
      })
      .toBeGreaterThanOrEqual(1);
    expect(fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub')).toHaveLength(0);
    // ④ 增长字节上屏：末行（0x17ff0 = 96KB-16）落在增长区 → 文本含 42
    const dump = page.locator('.vv-hex-dump').first();
    await dump.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.vv-hex-row').filter({ hasText: /^00017ff0/ })).toHaveText(/^00017ff0 {2}42/, {
      timeout: 20_000
    });
    // ⑤ 无增长提示（≤1MB 面不经回填通道 → 无提示钩子调用）；先证状态条在场，
    //    否则「不含」断言会因状态条缺席而恒真
    expect(await statusEverSeen(page, /二进制/)).toBe(true);
    expect(await statusEverSeen(page, /文件已变更/)).toBe(false);
    // ⑥ 无错误卡片
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // ⑦ 恰一轮重渲染（收尾复核）：探针读每渲染轮恰一条（dispatcher.ts:403），
    //    失效域若退化为「rev++ → 再 rev++」双轮则此计数为 2
    expect(probeReads(fake.logsSince(mark), 'sub/small.bin')).toHaveLength(1);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- STR-BACKFILL-01

test('STR-BACKFILL-01: >1MB 面回填失败（父目录 tree 500）时放弃回填即时重渲染，按陈旧 size 收口且不发增长提示', async ({
  page
}) => {
  test.setTimeout(150_000);
  const fake = await startStrFakeServer();
  try {
    fake.setFile('sub/big.bin', { bytes: makeFile(2 * MB, 2 * MB), treeSize: 2 * MB });
    await installStatusRecorder(page);
    await waitAppMounted(page);
    await connectFakeServer(page, fake);
    await openTreeFiles(page, [{ dir: 'sub', file: 'big.bin' }]);
    await expect(hexStatus(page)).toContainText('2.0 MB');
    await waitHexSettled(page);
    await waitSseReady(page, fake);

    const mark = fake.mark();
    fake.setFile('sub/big.bin', { bytes: makeFile(3 * MB, 2 * MB), treeSize: 3 * MB });
    fake.armTreeFailure('sub', 500);
    fake.notifyChanged(['sub/big.bin']);

    // ① 回填通道确实发起并失败（tabsModel.svelte.ts:582-587 catch 分支）
    await expect
      .poll(
        () =>
          fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub' && l.status === 500).length,
        { timeout: 30_000, message: '未观测到父目录 tree 500' }
      )
      .toBeGreaterThanOrEqual(1);
    // ② 回落即时 rev++ → 重渲染发生：探针读恰一条（每渲染轮一条，dispatcher.ts:403）
    //    ——既证「重渲染已发生」，又证「恰一轮」（双轮则计数为 2）
    await expect
      .poll(() => probeReads(fake.logsSince(mark), 'sub/big.bin').length, {
        timeout: 30_000,
        message: '回落未触发重渲染'
      })
      .toBe(1);
    // ③ 未回填 → 仍按陈旧 size 收口（2.0 MB），不含新 size。
    //    状态行文案本身变更前后同形（陈旧 size 就是 2MB），鉴别力由「配对的
    //    不含 3.0 MB」与「④ 读窗不越陈旧边界」承担（若实现误用新鲜 size，
    //    尾窗读终点会落到 3MB-1 → ④ 即红）
    await expect(hexStatus(page)).toHaveText(/^2\.0 MB ·/);
    await expect(hexStatus(page)).not.toContainText('3.0 MB');
    // ④ 读窗不越陈旧边界（增长区 2MB~3MB 从未被读取）
    const reads = businessReads(fake.logsSince(mark)).filter((r) => r.path === 'sub/big.bin');
    for (const r of reads) {
      expect(rangeEnd(r)).toBeLessThan(2 * MB);
    }
    // ⑤ 回填通道恰一次（byDir 分组：'sub' 一个父目录 → 一次 listChildren）。
    //    计数前提（已知耦合）：树重建重挂 FileTree 后 TreeNodeRow 展开态复位
    //    （TreeNodeRow.svelte:21 局部 $state + AppShell.svelte:715/1271 的
    //    {#key treeKey}）→ 树只重列根目录，不会再列 'sub'；若日后改为展开态
    //    持久化，本计数基线须同步重估
    expect(fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub')).toHaveLength(1);
    // ⑥ 无增长提示（回填失败 → 无提示钩子调用）；先证状态条在场，避免恒真
    expect(await statusEverSeen(page, /二进制/)).toBe(true);
    expect(await statusEverSeen(page, /文件已变更/)).toBe(false);
    // ⑦ 树重建根列举仍 200 → 无「加载失败」提示（失败门只按父目录精确路径布置）
    expect(await statusEverSeen(page, /加载失败/)).toBe(false);
    // ⑧ 失败回落不得落错误卡片
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // ⑨ 恰一轮重渲染（收尾复核，避免快照式计数早于第二轮到达）
    expect(probeReads(fake.logsSince(mark), 'sub/big.bin')).toHaveLength(1);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- STR-BACKFILL-02

test('STR-BACKFILL-02: >1MB 面回填拿到「新鲜条目缺 size」时不回填、只重渲染，仍按陈旧 size 收口且不发增长提示', async ({
  page
}) => {
  test.setTimeout(150_000);
  const fake = await startStrFakeServer();
  try {
    fake.setFile('sub/big.bin', { bytes: makeFile(2 * MB, 2 * MB), treeSize: 2 * MB });
    await installStatusRecorder(page);
    await waitAppMounted(page);
    await connectFakeServer(page, fake);
    await openTreeFiles(page, [{ dir: 'sub', file: 'big.bin' }]);
    await expect(hexStatus(page)).toContainText('2.0 MB');
    await waitHexSettled(page);
    await waitSseReady(page, fake);

    const mark = fake.mark();
    // 实体换 3MB，但树面条目改为省略 size → 回填拿到的新鲜条目 size 未知
    fake.setFile('sub/big.bin', { bytes: makeFile(3 * MB, 2 * MB), treeSize: 'omit' });
    fake.notifyChanged(['sub/big.bin']);

    // ① 回填通道确实取到列表（200），但条目本身缺 size
    await expect
      .poll(
        () => fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub' && l.status === 200).length,
        { timeout: 30_000, message: '未观测到父目录 tree 200' }
      )
      .toBeGreaterThanOrEqual(1);
    const treeHits = fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub');
    const treeBody = JSON.parse(treeHits[treeHits.length - 1]?.respText ?? '{}') as {
      entries: Array<{ name: string; kind: string; size?: number }>;
    };
    const bigEntry = treeBody.entries.find((e) => e.name === 'big.bin');
    expect(bigEntry).toBeDefined();
    expect(bigEntry).not.toHaveProperty('size');
    // ② 只 rev++ → 重渲染按陈旧 size 收口（2.0 MB），不含新 size。状态行文案本身
    //    变更前后同形，鉴别力由配对的不含 3.0 MB 与 ③ 读窗边界承担
    await expect
      .poll(() => probeReads(fake.logsSince(mark), 'sub/big.bin').length, {
        timeout: 30_000,
        message: '未观测到重渲染（探针读）'
      })
      .toBe(1);
    await expect(hexStatus(page)).toHaveText(/^2\.0 MB ·/);
    await expect(hexStatus(page)).not.toContainText('3.0 MB');
    // ③ 读窗不越陈旧边界（实测末字节 2097151）
    const reads = businessReads(fake.logsSince(mark)).filter((r) => r.path === 'sub/big.bin');
    for (const r of reads) {
      expect(rangeEnd(r)).toBeLessThan(2 * MB);
    }
    // ④ 回填通道恰一次（byDir 分组：'sub' 一个父目录 → 一次 listChildren；计数
    //    前提同 BACKFILL-01⑤：树重建后展开态复位、只重列根目录）
    expect(fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub')).toHaveLength(1);
    // ⑤ 无增长提示（size 未知 → 不回填 → 无提示钩子调用）；先证状态条在场，避免恒真
    expect(await statusEverSeen(page, /二进制/)).toBe(true);
    expect(await statusEverSeen(page, /文件已变更/)).toBe(false);
    // ⑥ 无错误卡片
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // ⑦ 恰一轮重渲染（收尾复核）
    expect(probeReads(fake.logsSince(mark), 'sub/big.bin')).toHaveLength(1);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- STR-BACKFILL-03

test('STR-BACKFILL-03: >1MB 面回填按父目录分组，同目录多 tab 合并为一次 listChildren 且三个 tab 各自完成 size 回填', async ({
  page
}) => {
  test.setTimeout(180_000);
  const fake = await startStrFakeServer();
  try {
    fake.setFile('sub/a.bin', { bytes: makeFile(2 * MB, 2 * MB), treeSize: 2 * MB });
    fake.setFile('sub/b.bin', { bytes: makeFile(2 * MB, 2 * MB), treeSize: 2 * MB });
    fake.setFile('other/c.bin', { bytes: makeFile(2 * MB, 2 * MB), treeSize: 2 * MB });
    await installStatusRecorder(page);
    await waitAppMounted(page);
    await connectFakeServer(page, fake);
    await openTreeFiles(page, [
      { dir: 'sub', file: 'a.bin' },
      { dir: 'sub', file: 'b.bin' },
      { dir: 'other', file: 'c.bin' }
    ]);
    await expect(hexStatus(page)).toContainText('2.0 MB');
    await waitHexSettled(page);
    await waitSseReady(page, fake);

    const mark = fake.mark();
    for (const p of ['sub/a.bin', 'sub/b.bin', 'other/c.bin']) {
      fake.setFile(p, { bytes: makeFile(3 * MB, 2 * MB), treeSize: 3 * MB });
    }
    fake.notifyChanged(['sub/a.bin', 'sub/b.bin', 'other/c.bin']);

    // ① 同父目录两个 tab 合并为一次 listChildren（tabsModel.svelte.ts:572-583 byDir 分组），
    //    不同父目录各自一次
    await expect
      .poll(
        () =>
          fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub').length +
          fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'other').length,
        { timeout: 30_000, message: '未观测到回填通道的父目录列举' }
      )
      .toBeGreaterThanOrEqual(2);
    // ② 活动 tab（c.bin）的变更轮恰一轮重渲染：探针读恰一条（dispatcher.ts:403）
    await expect
      .poll(() => probeReads(fake.logsSince(mark), 'other/c.bin').length, {
        timeout: 30_000,
        message: '活动 tab 未发生重渲染'
      })
      .toBe(1);
    // ③ 三个 tab 全部完成 copy-on-write 回填（tabsModel.svelte.ts:594-597）→ 各自按新 size 收口
    //    「激活某 tab 恰渲染一轮」以探针读增量判定（dispatcher.ts:403 每轮一条）：
    //    增量口径不依赖此前已渲染几轮（c.bin 已有变更轮），只钉本次激活的轮数
    for (const [name, path] of [
      ['a.bin', 'sub/a.bin'],
      ['b.bin', 'sub/b.bin'],
      ['c.bin', 'other/c.bin']
    ] as const) {
      const probeBefore = probeReads(fake.logsSince(mark), path).length;
      await tabNamed(page, name).click();
      await expect(tabNamed(page, name)).toHaveAttribute('aria-selected', 'true');
      await expect(hexStatus(page)).toContainText('3.0 MB', { timeout: 30_000 });
      await expect(hexStatus(page)).not.toContainText('2.0 MB');
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      await expect
        .poll(() => probeReads(fake.logsSince(mark), path).length - probeBefore, {
          timeout: 30_000,
          message: `${name} 激活未渲染或渲染多轮`
        })
        .toBe(1);
    }
    // ④ 回填通道的父目录列举各恰一次（分组契约，不写死请求到达次序；计数前提
    //    同 BACKFILL-01⑤：树重建后展开态复位、只重列根目录）
    expect(fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub')).toHaveLength(1);
    expect(fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'other')).toHaveLength(1);
    // ⑤ 回填检出增长 → 提示（顺序随 tab 列表序，不写死具体文件名）
    await expect
      .poll(() => statusEverSeen(page, /文件已变更：(a|b|c)\.bin/), { timeout: 15_000, message: '未见增长提示' })
      .toBe(true);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- STR-SHRINK-01

test('STR-SHRINK-01: >1MB 面文件变小时回填照常生效（按新 size 收口），但增长谓词不成立故不发「文件已变更」提示', async ({
  page
}) => {
  test.setTimeout(150_000);
  const fake = await startStrFakeServer();
  try {
    fake.setFile('sub/big.bin', { bytes: makeFile(3 * MB, 3 * MB), treeSize: 3 * MB });
    await installStatusRecorder(page);
    await waitAppMounted(page);
    await connectFakeServer(page, fake);
    await openTreeFiles(page, [{ dir: 'sub', file: 'big.bin' }]);
    await expect(hexStatus(page)).toContainText('3.0 MB');
    await waitHexSettled(page);
    await waitSseReady(page, fake);

    const mark = fake.mark();
    // 实体与树面 size 同步缩为 2MB（两端都 > 1MB，不跨分支边界——跨边界后果见
    // 域文档 §5 的「跨 1MB 分支边界」条目）
    fake.setFile('sub/big.bin', { bytes: makeFile(2 * MB, 2 * MB), treeSize: 2 * MB });
    fake.notifyChanged(['sub/big.bin']);

    // ① 回填通道确实执行过（tree 200）——证明「无提示」不是因为回填没跑
    await expect
      .poll(
        () => fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub' && l.status === 200).length,
        { timeout: 30_000, message: '未观测到父目录 tree 200' }
      )
      .toBeGreaterThanOrEqual(1);
    // ② 回填生效 → 重渲染按新 size 收口（3.0 MB → 2.0 MB）。状态行文案本身
    //    变更前后不同（3.0 → 2.0），此处即有鉴别力
    await expect(hexStatus(page)).toContainText('2.0 MB', { timeout: 30_000 });
    await expect(hexStatus(page)).not.toContainText('3.0 MB');
    // ③ 尾窗按新 size 收口：变更后读窗终点恰为 2MB-1（新边界），且不越旧边界
    //    （≤2MB-1 与 ==2MB-1 组合：既禁「越过新边界」，也禁「未按新边界收口」）
    await waitHexSettled(page); // 新实例结构解析收口 → 尾窗读已完成
    const reads = businessReads(fake.logsSince(mark)).filter((r) => r.path === 'sub/big.bin');
    const maxEnd = Math.max(...reads.map(rangeEnd));
    expect(maxEnd).toBeLessThanOrEqual(2 * MB - 1);
    expect(maxEnd).toBe(2 * MB - 1);
    // ④ 回填通道恰一次（byDir 分组：'sub' 一个父目录 → 一次 listChildren；计数
    //    前提同 BACKFILL-01⑤：树重建后展开态复位、只重列根目录）
    expect(fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub')).toHaveLength(1);
    // ⑤ grew 谓词不成立 → 无增长提示；先证状态条在场，避免恒真
    expect(await statusEverSeen(page, /二进制/)).toBe(true);
    expect(await statusEverSeen(page, /文件已变更/)).toBe(false);
    // ⑥ 无错误卡片
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // ⑦ 恰一轮重渲染（收尾复核）
    expect(probeReads(fake.logsSince(mark), 'sub/big.bin')).toHaveLength(1);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- STR-CHANNEL-01

test('STR-CHANNEL-01: 手动刷新通道（TabBarMenu「刷新当前文件」）与 SSE changed 同走 refreshPaths，同样发起父目录 tree 拉取并完成 size 回填', async ({
  page
}) => {
  test.setTimeout(150_000);
  const fake = await startStrFakeServer();
  try {
    fake.setFile('sub/big.bin', { bytes: makeFile(2 * MB, 2 * MB), treeSize: 2 * MB });
    await installStatusRecorder(page);
    await waitAppMounted(page);
    await connectFakeServer(page, fake);
    await openTreeFiles(page, [{ dir: 'sub', file: 'big.bin' }]);
    await expect(hexStatus(page)).toContainText('2.0 MB');
    await waitHexSettled(page);
    await waitSseReady(page, fake);

    const mark = fake.mark();
    fake.setFile('sub/big.bin', { bytes: makeFile(3 * MB, 2 * MB), treeSize: 3 * MB });
    // 全程不调 notifyChanged（假服务器不推任何帧）——变更只由手动刷新动作触发
    await page.locator('.vv-tabbar-menu [aria-label="切换工作区"]').click();
    await expect(page.locator('.vv-tbmenu-pop')).toBeVisible();
    await page.locator('.vv-tbmenu-pop').getByRole('button', { name: '刷新当前文件' }).click();

    // ① 手动通道同样发起父目录 tree 拉取（TabBarMenu.svelte:212 → tabsModel.svelte.ts:429/:466）
    await expect
      .poll(
        () => fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub' && l.status === 200).length,
        { timeout: 30_000, message: '手动刷新未发起父目录 tree 拉取' }
      )
      .toBeGreaterThanOrEqual(1);
    // ② 回填 + 重渲染按新鲜 size 收口（2.0 MB → 3.0 MB）。状态行文案变更前后
    //    不同（2.0 → 3.0），此处即有鉴别力
    await expect(hexStatus(page)).toContainText('3.0 MB', { timeout: 30_000 });
    await expect(hexStatus(page)).not.toContainText('2.0 MB');
    // ③ 重渲染确实按新鲜 size 取到尾部（Range 终点 == 3MB-1）
    await expect
      .poll(
        () =>
          businessReads(fake.logsSince(mark)).filter((r) => r.path === 'sub/big.bin' && rangeEnd(r) === 3 * MB - 1)
            .length,
        { timeout: 30_000, message: '未按新 size 取到尾部' }
      )
      .toBeGreaterThan(0);
    // ④ 恰一轮重渲染：探针读恰一条（dispatcher.ts:403，每渲染轮一条）——实现若
    //    退化为「先 rev++ → 回填 → 再 rev++」双轮渲染，此计数为 2 即红
    await expect
      .poll(() => probeReads(fake.logsSince(mark), 'sub/big.bin').length, {
        timeout: 30_000,
        message: '未观测到重渲染（探针读）'
      })
      .toBe(1);
    // ⑤ 回填通道恰一次（手动刷新与 SSE 同为一次 refreshPaths → 一次父目录列举；
    //    计数前提同 BACKFILL-01⑤：树重建后展开态复位、只重列根目录）
    expect(fake.logsSince(mark).filter((l) => l.pathname === '/api/tree' && l.path === 'sub')).toHaveLength(1);
    // ⑥ 回填检出增长 → 提示
    await expect
      .poll(() => statusEverSeen(page, /文件已变更：big\.bin/), { timeout: 15_000, message: '未见增长提示' })
      .toBe(true);
    // ⑦ 无错误卡片
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // ⑧ 恰一轮重渲染（收尾复核）
    expect(probeReads(fake.logsSince(mark), 'sub/big.bin')).toHaveLength(1);
  } finally {
    await fake.close();
  }
});
