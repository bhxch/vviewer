import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Route } from '@playwright/test';
import { hash8 } from '@bhxch/vviewer-core';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { openMenu } from './tabbar-menu';

/**
 * b-pdf-range —— pdf Range transport 域 e2e 锚（spec §6.6，io-streaming plan5 Task 2；
 * 编写 only——实跑移交统一验证阶段，全局约束）。
 *
 * T1 已落地面（pdf.ts streaming:true + createPdfRangeTransport）：capable + size 已知 +
 * buffer 短于 size（>1MB 探测块形态）→ PDFDataRangeTransport（requestRange → ctx.read
 * 窗段，[begin,end) → ByteRange end 含换算）；回退矩阵（size null → memoizedFullRead 全量
 * 补拉；!rangeCapable / 本地 / ≤1MB → data 路径）；M1 收口（非 abort mid-load 读失败且
 * 文档未开 → loadingTask.destroy → render reject → 错误卡片；abort 静默）。
 *
 * 锚清单（PDF-RANGE-00~07）：
 * - 00 夹具生成器入库守卫（binary 夹具不入库的确定性再生前提）；
 * - 01 渐进锚（远端 R1 通道 + linearized 夹具 + 中段窗口悬挂）：首屏 canvas 出现先于
 *   「全量字节已传」——悬挂带内窗口被请求但永不应答（全量不可达是构造保证而非竞态），
 *   Range 请求下限 + 探测块形态 + 已传字节上界断言；
 * - 02 size 未知回退：树条目/快照双缺 size（b-save-as DL-PROG-02 同款形态）→
 *   memoizedFullRead 单次全量补拉（请求形态：探测块 + 单条 0- 起全量 Range，零窗口流）；
 * - 03 非 Range store 回退：directDav 200 无视 Range → rangeOk=false 降级（探测块带
 *   Range 被答 200 全量 + 全量补拉无 Range 头）→ data 路径渲染；
 * - 04 本地文件：localFiles buffer/全量交付（byteLength===size）→ data 路径，远端服务器
 *   零 /api/file 请求；
 * - 05 取消锚：渐进装载期关闭 tab（effectAbort → 实例 destroy → readAbort.abort +
 *   loadingTask.destroy）→ 后续 Range 窗口请求停止（增长→停止的前后对照）+ 取消静默
 *   （不落错误卡）。注：transport 渐进装载零全量物化、无泵无进度卡，取消面即 tab 关闭
 *   （进度卡取消是 pumpFull 物化泵的取消面，归 b-save-as DL-PROG 域）；
 * - 06 M1 读失败退化锚：route.abort 中段窗口（探测块放行、其后全部 abort——非 abort
 *   读失败、文档未开）→ 错误卡片出现（M1 destroy 收口路径）而非悬挂；
 * - 07 S3 直连形态锚：mockS3 遵从 Range（206 + Content-Range 精确窗段）→ directS3
 *   rangeCapable 维持 true → transport 分支可达（Range 窗口 ≥2 + 首屏渲染）。
 *   落点判定：directS3 的 e2e 形态锚走默认套件 page.route mock（b-mounts-manager MM-06
 *   先例，mock 不验签）——e2e-server 套件（真实 serve 实例）无 S3 真源可依赖，不在彼处
 *   落锚；本锚即 S3 直连的套件落点。
 *
 * 夹具（linearized PDF，binary 不入库，corpus 惯例 gitignore + 生成脚本圈定）：
 * - apps/web/e2e/fixtures/corpus/pdf-linearized/progressive.pdf——由
 *   tools/gen-e2e-pdf-linearized.py 生成（uv run --with pikepdf tools/gen-e2e-pdf-linearized.py，
 *   12 页 600×900pt / 1,576,058B / 确定性重跑等值，生成时 sha256
 *   83bd9a3714002e443e8dda6b0fde4509bc18cad6fc3a36302cd9047dc5f0ded4）。
 * - 线性化两前提（pdfjs worker 实读锚定）：① startxref 取自文件头线性化字典首个 endobj
 *   之后（不走文件尾扫描）——文档打开只需文件头首屏段（本夹具 /E=132016，即前 3 个
 *   64KB 窗段）+ 尾部主 xref（/Prev 追随，pdf.worker.mjs readXRef 的 startXRefQueue）；
 *   ② /N=12 使 numPages 免尾区读取。R-01 悬挂带 [196608,1.45MB)（窗段 3-22）落在首屏
 *   段之后、尾部主 xref 窗段（chunk 24）之前——文档打开与首屏不受悬挂影响、全量永不可达。
 * - 缺失容错：existsSync 守卫 skip（fetch-e2e-corpus 同款，统一验证阶段先跑生成脚本）。
 *
 * mock 形态沿先例：R1 远端通道 = mini 假 vviewer 服务器（b-save-as 同款端点集：health/
 * tree/file/ticket/events，Range 206 切片 + 逐窗延时/悬挂形态）+ 旧键 'tabs' 快照预置
 * 恢复；directDav/directS3 = page.route mock（b-mounts-manager MM-06/07 同款，表单→
 * PROPFIND/ListObjectsV2 探测→保存→打开→树行点击）。桌面专属（仅 chromium project，
 * b-save-as 同款跳过——mounts 表单/树行点击为桌面交互面）。
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
/** 线性化夹具（corpus 路线：binary 不入库，生成脚本见 tools/gen-e2e-pdf-linearized.py） */
const FIXTURE_PATH = `${repoRoot}/apps/web/e2e/fixtures/corpus/pdf-linearized/progressive.pdf`;
const GENERATOR_PATH = `${repoRoot}/tools/gen-e2e-pdf-linearized.py`;
/** 夹具缺失说明（统一验证阶段的再生命令，skip 原因透出） */
const FIXTURE_HINT = '线性化夹具未生成——uv run --with pikepdf tools/gen-e2e-pdf-linearized.py';

const fixtureBytes = (): Buffer => readFileSync(FIXTURE_PATH);
const hasFixture = existsSync(FIXTURE_PATH);

// ---------- R1 远端通道：mini 假 vviewer 服务器（b-save-as 同款端点集，Range 形态扩展） ----------

interface FileRequestLog {
  range: string | null;
  start: number | null;
  end: number | null;
  served: boolean;
  servedLen: number;
}

interface FakeVVServer {
  base: string;
  fileRequests: FileRequestLog[];
  servedBytes: number;
  close(): Promise<void>;
}

async function startFakeVVServer(
  fileName: string,
  bytes: Uint8Array,
  opts: {
    treeSize?: number;
    omitTreeSize?: boolean;
    /** 逐窗延时 ms（慢泵形态：R-05 取消锚的持续请求流来源） */
    windowDelayMs?: number;
    /** 悬挂带 [start, end)：带内窗口请求记日志后永不应答（R-01 渐进锚——全量不可达的构造保证） */
    hangRange?: [number, number];
  } = {}
): Promise<FakeVVServer> {
  const fileRequests: FileRequestLog[] = [];
  let servedBytes = 0;
  const server = http.createServer((req, res) => {
    res.on('error', () => {}); // 客户端 abort（取消锚）后写已毁 socket：吞 ECONNRESET 防进程崩
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/tree') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      const entry: Record<string, unknown> = { name: fileName, kind: 'file' };
      if (opts.omitTreeSize === true) {
        // 树条目省略 size：FileSource.size null（size 未知回退的干净 mock 形态）
      } else if (opts.treeSize !== undefined) {
        entry.size = opts.treeSize;
      } else {
        entry.size = bytes.length;
      }
      res.end(JSON.stringify({ entries: [entry] }));
      return;
    }
    if (url.pathname === '/api/file') {
      const range = req.headers.range ?? null;
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      const start = m !== null ? Math.min(Number(m[1]), Math.max(bytes.length - 1, 0)) : null;
      const endSrv =
        m !== null && m[2] !== undefined && m[2] !== ''
          ? Math.min(Number(m[2]), bytes.length - 1)
          : bytes.length - 1;
      if (opts.hangRange !== undefined && start !== null && start >= opts.hangRange[0] && start < opts.hangRange[1]) {
        // 悬挂带：记日志（served=false）后不 response.end——请求保持打开（浏览器侧
        // fetch pending；测试收尾 closeAllConnections 统一清偿）
        fileRequests.push({ range, start, end: endSrv, served: false, servedLen: 0 });
        return;
      }
      const chunk =
        start !== null ? bytes.subarray(start, endSrv + 1) : bytes.subarray(0, bytes.length);
      const write = (): void => {
        if (res.writableEnded || res.destroyed) return; // 客户端已 abort（取消锚）：静默丢弃
        res.writeHead(start !== null ? 206 : 200, {
          ...cors,
          'Content-Type': 'application/octet-stream',
          ...(start !== null ? { 'Content-Range': `bytes ${start}-${endSrv}/${bytes.length}` } : {}),
          'Content-Length': String(chunk.length)
        });
        res.end(chunk);
      };
      fileRequests.push({ range, start, end: endSrv, served: true, servedLen: chunk.length });
      servedBytes += chunk.length;
      if (opts.windowDelayMs !== undefined && opts.windowDelayMs > 0) {
        setTimeout(write, opts.windowDelayMs);
      } else {
        write();
      }
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      return; // 保持打开、无数据帧：SSE 挂起（测试结束统一断连）
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    fileRequests,
    get servedBytes(): number {
      return servedBytes;
    },
    close: async () => {
      server.close();
      server.closeAllConnections();
    }
  };
}

// ---------- 会话预置（旧键 'tabs' 快照恢复，b-save-as seedRemoteTabs 同款） ----------

interface SeedTab {
  path: string;
  name: string;
  size?: number;
  active?: boolean;
}

async function seedRemoteTabs(
  page: Page,
  opts: { base: string; tabs: SeedTab[]; withLastServer?: boolean }
): Promise<void> {
  const storeId = `remote:${hash8(`${opts.base}:e2e-fake`)}`;
  await page.addInitScript(
    (seed) => {
      if (seed.withLastServer) {
        sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: seed.base, token: null }));
      }
      const open = indexedDB.open('vviewer');
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('kv', 'readwrite');
        const entries = seed.tabs.map((t, i) => ({
          id: `t${i}`,
          storeId: seed.storeId,
          storeLabel: 'e2e-fake',
          ...(seed.withLastServer ? { storeBase: seed.base } : {}),
          kind: 'rename-only' as const,
          scrollTop: 0,
          active: t.active ?? false,
          path: t.path,
          name: t.name,
          ...(t.size !== undefined ? { size: t.size } : {})
        }));
        tx.objectStore('kv').put(entries, 'tabs');
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      };
    },
    { base: opts.base, storeId, tabs: opts.tabs, withLastServer: opts.withLastServer ?? true }
  );
}

// ---------- 本地注入（b-media-office-viewer 同款 __vvOpenDirImpl 通道） ----------

/** 极简多页 PDF（R-04 本地件：2 页小体量——localFiles 全量交付形态，无体量前提） */
function makeLocalPdf(pages: string[]): Uint8Array {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const pid = 4 + i * 2;
    const cid = pid + 1;
    objs[pid] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
    const stream = `BT /F1 28 Tf 40 500 Td (${text}) Tj ET`;
    objs[cid] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const chunks: Uint8Array[] = [enc('%PDF-1.4\n')];
  const total = (arr: Uint8Array[]): number => arr.reduce((n, c) => n + c.length, 0);
  const offsets: number[] = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = total(chunks);
    chunks.push(enc(`${i} 0 obj\n${objs[i]}\nendobj\n`));
  }
  const xrefAt = total(chunks);
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(enc(xref));
  const out = new Uint8Array(total(chunks));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

interface SpecFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

async function openDir(page: Page, files: SpecFile[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bmedia/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

async function openTreeFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

// ---------- 直连 mock（b-mounts-manager MM-06/07 同款形态；allow-headers 增 range） ----------

/** 跨源 mock CORS 头（Range GET 携自定义头 range/authorization → 预检须放行 range）。 */
const DIRECT_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,depth,range,x-amz-content-sha256,x-amz-date',
  'access-control-allow-methods': 'GET,PROPFIND,OPTIONS'
};

/** 目录管理面板（⋯ 菜单通道，b-mounts-manager openMountsPanel 同款） */
async function openMountsPanel(page: Page): Promise<void> {
  await openMenu(page);
  await page.locator('button[aria-label="目录管理"]').click();
  await expect(page.locator('.vv-mounts-manager')).toBeVisible();
}

interface DavMock {
  /** 对象 GET 请求日志（Range 头原样；PROPFIND 不入） */
  gets: Array<{ range: string | null }>;
}

/** WebDAV mock：PROPFIND 207（单 PDF 条目）+ 对象 GET 恒 200 全量（无视 Range——
 * directDav.read 的 Range 防线：200 → rangeOk=false 降级 + 全量切片交付）。 */
async function mockDavIgnoringRange(page: Page, origin: string, fileName: string, bytes: Uint8Array): Promise<DavMock> {
  const gets: Array<{ range: string | null }> = [];
  const MULTISTATUS = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    <D:response><D:href>/dav/${fileName}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>${bytes.length}</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  </D:multistatus>`;
  await page.route(`**${origin}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: DIRECT_CORS, body: '' });
    }
    if (req.method() === 'PROPFIND') {
      return void route.fulfill({ status: 207, headers: DIRECT_CORS, body: MULTISTATUS });
    }
    if (req.method() === 'GET') {
      gets.push({ range: req.headers()['range'] ?? null });
      // 恒 200 全量（Range 头若在场即被无视）——降级形态的 mock 前提
      return void route.fulfill({
        status: 200,
        headers: { ...DIRECT_CORS, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
        body: Buffer.from(bytes)
      });
    }
    return void route.fulfill({ status: 404, headers: DIRECT_CORS, body: 'not found' });
  });
  return { gets };
}

interface S3Mock {
  /** 对象 GET 请求日志（Range 头原样；ListObjectsV2 不入） */
  gets: Array<{ range: string | null }>;
}

/** S3 mock：ListObjectsV2（单 PDF 条目）+ 对象 GET 遵从 Range（206 + Content-Range
 * 精确窗段；无 Range 头 200 全量）——directS3 rangeCapable 维持 true 的 transport 形态。
 * mock 不验签（SigV4 头存在性归 MM-06，本域不重复）。 */
async function mockS3WithRanges(page: Page, origin: string, key: string, bytes: Uint8Array): Promise<S3Mock> {
  const gets: Array<{ range: string | null }> = [];
  const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bkt</Name><Prefix></Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>${key}</Key><Size>${bytes.length}</Size></Contents>
</ListBucketResult>`;
  await page.route(`**${origin}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: DIRECT_CORS, body: '' });
    }
    if (req.url().includes('list-type=2')) {
      return void route.fulfill({
        status: 200,
        headers: { ...DIRECT_CORS, 'content-type': 'application/xml' },
        body: LIST_XML
      });
    }
    if (req.method() === 'GET') {
      const range = req.headers()['range'] ?? null;
      gets.push({ range });
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      if (m === null) {
        return void route.fulfill({
          status: 200,
          headers: { ...DIRECT_CORS, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
          body: Buffer.from(bytes)
        });
      }
      const start = Math.min(Number(m[1]), bytes.length - 1);
      const end =
        m[2] !== undefined && m[2] !== '' ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
      const slice = Buffer.from(bytes.subarray(start, end + 1));
      return void route.fulfill({
        status: 206,
        headers: {
          ...DIRECT_CORS,
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
          'content-length': String(slice.length)
        },
        body: slice
      });
    }
    return void route.fulfill({ status: 404, headers: DIRECT_CORS, body: 'not found' });
  });
  return { gets };
}

// ---------- 桌面专属 + 夹具守卫 ----------

test.describe('b-pdf-range PDF-RANGE 域锚（spec §6.6）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('PDF-RANGE-00 夹具生成器入库守卫：linearized 夹具由库内脚本确定性再生（binary 不入库）', async () => {
    // 生成器必须入库（夹具的确定性来源）；夹具本体在 gitignore 的 corpus 目录，缺失时
    // 01/02/05/06/07 逐用例 skip（fetch-e2e-corpus 语料同款容错）——本锚防「脚本漂移出库」
    // 的静默空心化
    expect(existsSync(GENERATOR_PATH)).toBe(true);
  });

  test('PDF-RANGE-01 渐进锚：linearized 远端样例首屏渲染先于全量到达（悬挂带内窗口被请求而未应答）', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!hasFixture, FIXTURE_HINT);
    const bytes = fixtureBytes();
    // 悬挂带（64KB 窗段对齐语义：pdfjs 窗口请求 start 恒为 64KB 倍数）：夹具首屏段
    // /E=132016（文档打开 + 首页渲染的全部所需，落入窗段 0-2 < 196608）之后、尾部主
    // xref 窗段（chunk 24 起点 1_572_864，/Prev 追随的文档打开必读面）之前——带内窗口
    // 永不应答 ⇒ 全量到达在构造上不可达。悬挂卡住 pages 2-12 对象/内容流（其窗段自
    // chunk 3 起），IMMEDIATE_PAGES 的 pages 2-3 渲染永久 pending
    const HANG: [number, number] = [196_608, 1_450_000];
    const srv = await startFakeVVServer('prog.pdf', bytes, { hangRange: HANG });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'prog.pdf', name: 'prog.pdf', size: bytes.length, active: true }
      ]
    });
    await page.goto('/');

    // transport 装配（probe 8KB 探测块 → pdfjs 窗段请求）→ 首屏 canvas
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
    // 文档打开（numPages 自线性化 /N）+ 首页渲染；悬挂带卡住 pages 2-3（IMMEDIATE_PAGES）
    // 的对象窗段 ⇒ canvas 恒 1（首屏先于全量的 UI 面证据）
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 1 / 12 页');
    expect(await page.locator('.vv-pdf canvas').count()).toBe(1);

    // auto-fetch（disableAutoFetch 缺省 false：transport 下逐空块顺序补拉）终将触达
    // 悬挂带（前缀窗段逐个应答后停在带首）——「全量字节已传」不可达的请求面证据
    await expect
      .poll(() => srv.fileRequests.some((r) => !r.served && r.start !== null && r.start >= HANG[0] && r.start < HANG[1]), {
        timeout: 30_000,
        message: '悬挂带窗口未被请求——auto-fetch 未推进到中段（transport 窗段流未成立）'
      })
      .toBe(true);

    // 请求形态断言：
    // - 全部 /api/file 均带 Range 头（探测块 + 窗段——零「无 Range 全量拉取」混入）
    // - 首请求恰为 dispatcher 探测块 bytes=0-8191
    // - 存在探测块之后的窗段（start ≥ 8192，transport 窗段流证据）
    const reqs = srv.fileRequests;
    expect(reqs.length).toBeGreaterThanOrEqual(3); // 探测块 + ≥2 窗段（Range 请求数下限）
    for (const r of reqs) expect(r.range).toMatch(/^bytes=\d+-\d*$/);
    expect(reqs[0]!.range).toBe('bytes=0-8191');
    expect(reqs[0]!.servedLen).toBe(8192);
    expect(reqs.some((r) => r.start !== null && r.start >= 8192)).toBe(true);
    // 首窗字节断言：已传字节有界（< 总量，且 < 悬挂带上界）——首屏出现时全量不可达
    expect(srv.servedBytes).toBeGreaterThan(100_000); // 窗段真实交付（非单发小读）
    expect(srv.servedBytes).toBeLessThan(HANG[1]);
    expect(srv.servedBytes).toBeLessThan(bytes.length);
    await srv.close();
  });

  test('PDF-RANGE-02 size 未知回退：memoizedFullRead 单次全量补拉（探测块 + 单条 0- 起全量 Range，零窗口流）', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(!hasFixture, FIXTURE_HINT);
    const bytes = fixtureBytes();
    // 双缺 size（树条目省略 + 快照无 size）= FileSource.size null 的干净 mock 形态
    //（b-save-as DL-PROG-02 同款）；remote store 恒 rangeCapable，回退判定走 ctx.size===null
    const srv = await startFakeVVServer('mystery.pdf', bytes, { omitTreeSize: true });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [{ path: '', name: 'e2e-fake', active: false }, { path: 'mystery.pdf', name: 'mystery.pdf', active: true }]
    });
    await page.goto('/');

    // data 路径渲染（补拉全量后 getDocument({data})）
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 1 / 12 页');

    // 请求形态：恰两条——探测块 bytes=0-8191 + pdf.ts memoizedFullRead 的
    // {0, MAX_SAFE_INTEGER} 全量补拉（Range bytes=0-9007199254740991，服务端钳制回全量）；
    // 渲染完成后零新增（data 路径零按需窗——transport 未装配的请求面证据）
    await expect.poll(() => srv.fileRequests.length, { timeout: 20_000 }).toBe(2);
    const [probe, full] = [srv.fileRequests[0]!, srv.fileRequests[1]!];
    expect(probe.range).toBe('bytes=0-8191');
    expect(probe.servedLen).toBe(8192);
    expect(full.range).toMatch(/^bytes=0-\d+$/);
    expect(full.servedLen).toBe(bytes.length); // 服务端钳制：单条全量应答
    await page.waitForTimeout(800);
    expect(srv.fileRequests.length).toBe(2);
    await srv.close();
  });

  test('PDF-RANGE-03 非 Range store 回退：directDav 200 无视 Range → rangeOk=false 降级全量（探测块带 Range 被答 200 + 全量补拉无 Range 头）', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!hasFixture, FIXTURE_HINT);
    const bytes = fixtureBytes();
    const origin = 'http://127.0.0.1:9021';
    const dav = await mockDavIgnoringRange(page, origin, 'prog.pdf', bytes);

    // 挂载表单全链（MM-07 同款：表单 → PROPFIND 探测 → 保存 → 打开 → 树行点击）
    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await openMountsPanel(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await page.locator('#vv-mm-backend').selectOption('webdav');
    await page.locator('#vv-mm-label').fill('e2e dav pdf');
    await page.locator('#vv-mm-endpoint').fill(`${origin}/dav`);
    await page.locator('#vv-mm-username').fill('davuser');
    await page.locator('#vv-mm-secret').fill('davpass');
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-form').getByText(/连接成功：根目录 1 个条目，延迟 \d+ ms/)).toBeVisible();
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await page.locator('.vv-mm-item', { hasText: 'e2e dav pdf' }).getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e dav pdf' })).toBeVisible();
    await openTreeFile(page, 'prog.pdf');

    // 降级全量后 data 路径渲染（headOnly + full 补拉 → byteLength === size）
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 1 / 12 页');

    // 请求形态：恰两条对象 GET——①探测块带 Range 头、被答 200 全量（directDav Range 防线：
    // status!==206 → rangeOk=false + 全量切片交付）；②dispatcher 降级全量补拉、无 Range 头。
    // 渲染完成后零新增（!capable 全量切片 ctx 的 data 路径零按需窗）
    await expect.poll(() => dav.gets.length, { timeout: 20_000 }).toBe(2);
    expect(dav.gets[0]!.range).toBe('bytes=0-8191');
    expect(dav.gets[1]!.range).toBeNull();
    await page.waitForTimeout(800);
    expect(dav.gets.length).toBe(2);
  });

  test('PDF-RANGE-04 本地文件 data 路径：localFiles 全量交付（byteLength===size）→ 渲染成功且远端零 /api/file', async ({ page }) => {
    test.setTimeout(90_000);
    const pdf = makeLocalPdf(['Local Page 1', 'Local Page 2']);
    // 在场远端服务器（last-server 预置，健康探测可达）作为「零 Range 读」的对照面：
    // 本地渲染全程其 /api/file 计数必须为 0
    const srv = await startFakeVVServer('unused.pdf', pdf);
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: false }] });
    await page.goto('/');
    await openDir(page, [{ name: 'local2.pdf', type: 'application/pdf', bytes: pdf }]);
    await openTreeFile(page, 'local2.pdf');

    await expect(page.locator('.vv-pdf')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-pdf-page')).toHaveCount(2);
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 1 / 2 页');
    expect(srv.fileRequests).toHaveLength(0); // 零 Range 读（本地来源不触远端文件通道）
    await srv.close();
  });

  test('PDF-RANGE-05 取消锚：渐进装载期关闭 tab → 后续 Range 窗口请求停止 + 取消静默（不落错误卡）', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!hasFixture, FIXTURE_HINT);
    const bytes = fixtureBytes();
    // 逐窗 250ms 延时：~24 窗 × 250ms ≈ 6s 的 auto-fetch 请求流——关闭时刻仍有大量
    // 未拉窗段，「停止」断言非空转（延迟全拉完则计数天然走平，对照失效）
    const srv = await startFakeVVServer('prog.pdf', bytes, { windowDelayMs: 250 });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'prog.pdf', name: 'prog.pdf', size: bytes.length, active: true }
      ]
    });
    await page.goto('/');

    // 首屏出现（首窗段 ~6 个 × 250ms ≈ 1.5s + 渲染）
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
    // 关闭前先证请求流在增长（auto-fetch 逐窗推进）——「停止」的前后对照非空转前提
    const countAtCanvas = srv.fileRequests.length;
    await expect
      .poll(() => srv.fileRequests.length, { timeout: 15_000, message: '关闭前窗口请求未增长（auto-fetch 流未成立）' })
      .toBeGreaterThan(countAtCanvas);

    // 关闭 tab：effect cleanup abort（effectAbort）+ 实例 destroy（readAbort.abort +
    // loadingTask.destroy）→ 在飞读 abort 身份静默、worker 终止、窗段请求停止
    await page.locator('.vv-tab', { hasText: 'prog.pdf' }).locator('.vv-tab-close').click();
    await expect(page.locator('.vv-tab', { hasText: 'prog.pdf' })).toHaveCount(0);

    // 结算窗 300ms：worker 终止（destroy 异步消息）与销毁前沿发的最后窗段请求到达——
    // 之后才采样基线，防「销毁竞态尾请求」误计为未停止
    await page.waitForTimeout(300);

    // 请求停止：1.5s 观察窗内计数走平（对照：关闭前 250ms/窗 ≈ 每秒 4 窗增长）
    const countAtClose = srv.fileRequests.length;
    await page.waitForTimeout(1_500);
    expect(srv.fileRequests.length).toBe(countAtClose);
    // 取消静默（abort 不落错误卡——T1 abort 身份收口）：无错误卡片残留
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await srv.close();
  });

  test('PDF-RANGE-06 M1 读失败退化锚：中段窗口 route.abort（非 abort 读失败、文档未开）→ 错误卡片出现而非悬挂', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!hasFixture, FIXTURE_HINT);
    const bytes = fixtureBytes();
    const srv = await startFakeVVServer('prog.pdf', bytes);
    // 探测块（dispatcher 层）放行到真服务器，其后全部 /api/file（pdfjs 窗段）abort：
    // fetch 以 TypeError('Failed to fetch') reject（非 AbortError 身份）→ ctx.read 包装标
    // DispatchReadError → pdf.ts requestRange catch 判非 abort → onReadFailure → docOpened
    //=false 门控 → loadingTask.destroy → render reject（M1 收口）→ dispatch catch 错误卡片
    const aborted: string[] = [];
    await page.route('**/api/file', (route: Route) => {
      const range = route.request().headers()['range'] ?? null;
      if (range === 'bytes=0-8191') return void route.continue(); // 探测块放行（物化头部面）
      aborted.push(range ?? '(no-range)');
      return void route.abort();
    });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'prog.pdf', name: 'prog.pdf', size: bytes.length, active: true }
      ]
    });
    await page.goto('/');

    // M1 收口路径（错误卡片 + 重试按钮出现）而非 render 永久悬挂——卡片出现本身即
    // 「非悬挂」证据；abort 窗口在场即 transport 窗段流已装配的证据
    const card = page.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    expect(aborted.length).toBeGreaterThanOrEqual(1);
    expect(aborted.every((r) => r.startsWith('bytes='))).toBe(true);
    const detail = await card.locator('.vv-error-detail').textContent();
    expect(detail!.trim().length).toBeGreaterThan(0);
    await expect(card.locator('.vv-error-action').first()).toHaveText('重试');
    await srv.close();
  });

  test('PDF-RANGE-07 S3 直连形态锚：mockS3 遵从 Range（206 精确窗段）→ directS3 transport 渐进装载（Range 窗口 ≥2 + 首屏）', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!hasFixture, FIXTURE_HINT);
    const bytes = fixtureBytes();
    const origin = 'http://127.0.0.1:9022';
    const s3 = await mockS3WithRanges(page, origin, 'prog.pdf', bytes);

    // 挂载表单全链（MM-06 同款：S3 直连缺省类型，填 endpoint/bucket/ak/sk）
    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await openMountsPanel(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await page.locator('#vv-mm-label').fill('e2e s3 pdf');
    await page.locator('#vv-mm-endpoint').fill(origin);
    await page.locator('#vv-mm-bucket').fill('bkt');
    await page.locator('#vv-mm-username').fill('AKIDEXAMPLE');
    await page.locator('#vv-mm-secret').fill('wJalrXUtnFEMI');
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-form').getByText(/连接成功：根目录 1 个条目，延迟 \d+ ms/)).toBeVisible();
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await page.locator('.vv-mm-item', { hasText: 'e2e s3 pdf' }).getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e s3 pdf' })).toBeVisible();
    await openTreeFile(page, 'prog.pdf');

    // transport 分支可达：探测块（Range 206 精确窗段）→ pdfjs 窗段请求（恒 206 应答，
    // rangeOk 不降级）→ 首屏渲染；auto-fetch 持续补拉 → 窗口计数增长
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText('第 1 / 12 页');
    await expect
      .poll(() => s3.gets.length, { timeout: 30_000, message: 'S3 对象 GET 窗口数未增长（transport 窗段流未成立）' })
      .toBeGreaterThanOrEqual(4);
    // 形态断言：全部对象 GET 带 Range 头（探测块 + 窗段，零无 Range 全量拉取混入）；
    // 首请求恰为探测块（bytes=0-8191 → 206 + Content-Range 精确匹配，rangeCapable 维持 true 的前提）
    for (const g of s3.gets) expect(g.range).toMatch(/^bytes=\d+-\d*$/);
    expect(s3.gets[0]!.range).toBe('bytes=0-8191');
  });
});
