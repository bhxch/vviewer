import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Route } from '@playwright/test';
import { hash8 } from '@bhxch/vviewer-core';
import { openFile, waitAppMounted } from './helpers';

/**
 * b-pdf-range-2 —— PDFX 域（pdf Range transport 补强）e2e 锚。
 *
 * 与既有 b-pdf-range.spec.ts（PDF-RANGE-00~07）分工：既有锚依赖库外 binary 夹具
 * （corpus 目录下的 progressive.pdf，binary 不入库、.gitignore 排除），其中 6 个用例
 * 仍受夹具门禁（PDF-RANGE-01/02/03/05/06/07，缺夹具环境静默 skip）；本域以「代码内
 * 合成夹具 + 读形态计量 + 装置自持守卫」提供**不依赖库外夹具**的等价与增量锚：
 *
 * - PDFX-LOCAL-01/02：本地来源 1MB 阈值两侧的读形态对照（>1MB 走 transport 窗段读；
 *   ≤1MB 走 data 路径整读）——既有 PDF-RANGE-04 只钉渲染面与零远端请求，不钉读形态；
 * - PDFX-MEMO-01：size 未知的远端 PDF「首次装载失败 → 重试 → 成功」链 + 全量补拉
 *   零重复下载（memo 命中，pdf.ts:48-67；毒化防护为双层，端到端面以行为面为准）——与被夹具门禁的
 *   PDF-RANGE-02 请求形态等价但夹具自持（见域文档 §2 分工表）；
 * - PDFX-MEMO-02：size 未知的全量补拉读失败 → 读取失败卡片（不挂起、零动作钮）+ 失败
 *   尝试零污染后续打开；
 * - PDFX-MEMO-03/04/05：pdfjs worker 三条失败分支（资产不可达 / 资产 404 装配失败 /
 *   握手 data 非 Uint8Array）——回落链不挂起 + 错误身份可辨；
 * - PDFX-CARD-01/02：远端 transport 路径零进度卡（缺席面）与远端 ≤1MB 泵路径出卡
 *   （正向对照面）——两者成对，缺席断言方有对照；
 * - PDFX-M1-01/02：M1 mid-load 读失败收口后的 worker 零泄漏 + 请求流停止（文档未开），
 *   与文档已开后的静默分支（docOpened 门控，pdf.ts:239-247）；
 * - PDFX-FIX-01：本域夹具自持守卫（禁夹具条件 skip + 禁库外夹具依赖 + 合成夹具结构
 *   与确定性锚）。
 *
 * 装置全部自建在本文件内（假 vviewer 服务器 / 合成 PDF / Blob 读切片计量 / 进度卡
 * 观察器 / pdfjs worker 协议桩），不抽公共 helper 文件；仅只读复用 ./helpers 的
 * waitAppMounted / openFile（注入通道自建：需给 File 打标记以计量读形态）。
 */

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** 域正主既有锚（PDF-RANGE-00~07）：FIX-01 的域级夹具门禁扫描对象 */
const LEGACY_SPEC_PATH = `${REPO_ROOT}/apps/web/e2e/b-pdf-range.spec.ts`;

/** 大件夹具目标字节数（> dispatcher FULL_LIMIT=1MB，pdf.ts:189 的 transport 门槛） */
const BIG_PDF_BYTES = 1_300_796;
/** 小件夹具目标字节数（贴近 1MB 阈值下侧：1MB-1 字节——阈值向下漂移时必打红） */
const SMALL_PDF_BYTES = 1_048_575;
/** memo 夹具目标字节数（> 探测块 8KB：探测块不得吞掉全量，否则补拉计量失真） */
const MEMO_PDF_BYTES = 20_000;
/** pdfjs range 窗段大小（pdf.mjs:15409 rangeChunkSize=2**16） */
const PDFJS_CHUNK = 65536;
/** dispatcher 探测块大小（dispatcher.ts:63 HEAD_SIZE） */
const HEAD_SIZE = 8192;
/** pdfjs 立即渲染页数（pdf.ts:26 IMMEDIATE_PAGES） */
const IMMEDIATE_PAGES = 3;

const SMALL_PDF_PAGES = ['PDFX Page 1', 'PDFX Page 2'];
/** 大件 5 页：> IMMEDIATE_PAGES，第 4+ 页走 IO 懒渲染路径 */
const BIG_PDF_PAGES = ['PDFX Page 1', 'PDFX Page 2', 'PDFX Page 3', 'PDFX Page 4', 'PDFX Page 5'];
const MEMO_PDF_PAGES = ['PDFX Page 1', 'PDFX Page 2', 'PDFX Page 3'];

/**
 * 目标 File 的标记 symbol（`Symbol.for('vv.pdfx.target-blob')`）：Blob 计量装置据此
 * 筛出目标文件的读/切片。initScript 与注入 evaluate 均以 `Symbol.for` 字面量取同一
 * symbol（两处代码互不闭包引用，无法共享外层常量）。
 */

// ---------- 合成 PDF（代码内生成，零外部文件依赖） ----------

/**
 * 合成多页 PDF：页数由 pages 决定；targetTotal 给定时以注释行填充到**精确**目标
 * 字节数（xref 内 startxref 位数变化会带偏 ±数字节，故迭代收敛到 diff=0）。
 *
 * layout 决定填充位：
 * - `front`：填充在头部（对象全在尾块）——文档打开读「首块 + 尾块」，页面内容在尾块内，
 *   渲染不产生新窗段读；
 * - `mid`：填充在 pages 树之后、page 对象之前——文档打开只读「首块 + 尾块」，页面
 *   对象/内容流落在中段块，渲染期才按需窗段读（M1 文档已开分支的构造前提）。
 */
function makePdf(
  pages: string[],
  targetTotal?: number,
  layout: 'front' | 'mid' = 'front'
): Uint8Array {
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
  const total = (arr: Uint8Array[]): number => arr.reduce((n, c) => n + c.length, 0);
  const build = (pad: Uint8Array | null): Uint8Array[] => {
    const chunks: Uint8Array[] = [enc('%PDF-1.4\n')];
    const offsets: number[] = [0];
    // 填充位：`front` 置于首个对象之前（对象全在尾块）；`mid` 置于 pages 树之后、
    // 首个 page 对象之前（页面对象/内容流落中段块，渲染期才按需窗段读）
    const padBefore = layout === 'mid' ? 4 : 1;
    for (let i = 1; i < objs.length; i++) {
      if (i === padBefore && pad !== null) chunks.push(pad);
      offsets[i] = total(chunks);
      chunks.push(enc(`${i} 0 obj\n${objs[i]}\nendobj\n`));
    }
    const xrefAt = total(chunks);
    let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    chunks.push(enc(xref));
    return chunks;
  };
  const concat = (chunks: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(total(chunks));
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  };
  const base = build(null);
  if (targetTotal === undefined) return concat(base);
  let padLen = targetTotal - total(base) - 2; // '%' + 'x'×n + '\n'
  let chunks = base;
  for (let i = 0; i < 64; i++) {
    chunks = build(enc('%' + 'x'.repeat(Math.max(padLen, 0)) + '\n'));
    const diff = targetTotal - total(chunks);
    if (diff === 0) break;
    padLen += diff;
  }
  const out = concat(chunks);
  if (out.length !== targetTotal) {
    throw new Error(`makePdf 未收敛到目标字节数：期望 ${targetTotal}，实得 ${out.length}`);
  }
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------- Blob 读/切片计量装置（本地来源读形态） ----------

interface ReadEntry {
  /** 实读字节数（Blob.arrayBuffer 拦截取 this.size） */
  size: number;
}

interface SliceEntry {
  /** 被切片的父 Blob 大小（= 目标文件总长） */
  parentSize: number;
  /** 切片长度 */
  len: number;
}

/**
 * 打补丁：Blob.prototype.slice / arrayBuffer 采集目标 File 的读形态。
 * 目标 File 由注入通道打标记，切片派生物继承标记——计量面因此只覆盖目标文件，
 * 不被页面其他 Blob 读污染。
 */
async function installBlobMeter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mark = Symbol.for('vv.pdfx.target-blob');
    const w = window as unknown as {
      __vvReadLog: Array<{ size: number }>;
      __vvSliceLog: Array<{ parentSize: number; len: number }>;
    };
    w.__vvReadLog = [];
    w.__vvSliceLog = [];
    const origSlice = Blob.prototype.slice;
    Blob.prototype.slice = function (
      this: Blob,
      start?: number,
      end?: number,
      contentType?: string
    ): Blob {
      const out = origSlice.call(this, start, end, contentType);
      if ((this as unknown as Record<symbol, boolean>)[mark] === true) {
        w.__vvSliceLog.push({ parentSize: this.size, len: out.size });
        (out as unknown as Record<symbol, boolean>)[mark] = true;
      }
      return out;
    };
    const origArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      if ((this as unknown as Record<symbol, boolean>)[mark] === true) {
        w.__vvReadLog.push({ size: this.size });
      }
      return origArrayBuffer.call(this);
    };
  });
}

/** 本地目录注入（__vvOpenDirImpl 通道）：字节走 base64 桥（1MB+ 夹具免去百万级数组序列化） */
async function openLocalPdf(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  const b64 = Buffer.from(bytes).toString('base64');
  await page.evaluate(
    ({ n, b }) => {
      const raw = atob(b);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      const f = new File([arr], n, { type: 'application/pdf' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `pdfx/${n}` });
      (f as unknown as Record<symbol, boolean>)[Symbol.for('vv.pdfx.target-blob')] = true;
      return (window as unknown as { __vvOpenDirImpl: (fs: File[]) => void }).__vvOpenDirImpl([f]);
    },
    { n: name, b: b64 }
  );
}

async function readLog(page: Page): Promise<ReadEntry[]> {
  return page.evaluate(() => (window as unknown as { __vvReadLog: ReadEntry[] }).__vvReadLog);
}

async function sliceLog(page: Page): Promise<SliceEntry[]> {
  return page.evaluate(() => (window as unknown as { __vvSliceLog: SliceEntry[] }).__vvSliceLog);
}

/**
 * 读流结算：连续 3 次采样（间隔 250ms，共 ≥750ms 静默窗）计数不变方认定读流已停。
 * 3 次连同样本避免「两次窗段读之间出现 >250ms 间隙」被误判为静止；20s 内未静止则
 * 抛错（失败信号，不静默放行）。
 */
async function settledReads(page: Page): Promise<ReadEntry[]> {
  let prev = await readLog(page);
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(250);
    const cur = await readLog(page);
    if (cur.length === prev.length) {
      stable++;
      if (stable >= 3) return cur;
    } else {
      stable = 0;
      prev = cur;
    }
  }
  throw new Error(`读流未静止（末值 ${prev.length} 条读记录）`);
}

/**
 * 请求计数恒定断言：观察窗内每次采样都必须等于期望值（用于「零重复下载」——
 * 晚到的第 3 条请求也会被抓到，而非固定等待后放行）。
 */
async function expectCountStays(
  page: Page,
  fn: () => number,
  expected: number,
  opts: { rounds: number; intervalMs: number }
): Promise<void> {
  for (let i = 0; i < opts.rounds; i++) {
    expect(fn(), `请求计数在观察窗内发生变化（期望恒为 ${expected}）`).toBe(expected);
    if (i < opts.rounds - 1) await page.waitForTimeout(opts.intervalMs);
  }
}

/**
 * 等计数静止（连续 rounds 次采样不变）并返回静止值；超时未静止即抛错。
 * 用于「请求流停止」：先等流自然收尾（尾随请求在结算窗内清偿），再以此为基线
 * 观察后续不再增长——避免用固定窗口在慢机上误判。
 */
async function waitStableCount(
  page: Page,
  fn: () => number,
  opts: { rounds: number; intervalMs: number; timeoutMs: number }
): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  let prev = fn();
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(opts.intervalMs);
    const cur = fn();
    if (cur === prev) {
      stable++;
      if (stable >= opts.rounds) return cur;
    } else {
      stable = 0;
      prev = cur;
    }
  }
  throw new Error(`请求计数未在 ${opts.timeoutMs}ms 内静止（末值 ${prev}）`);
}

// ---------- 迷你假 vviewer 服务器（远端通道；形态照 b-pdf-range.spec.ts 同款端点集） ----------

interface FileRequestLog {
  path: string;
  range: string | null;
  start: number | null;
  end: number | null;
  served: boolean;
  servedLen: number;
}

interface FakeVVServer {
  base: string;
  fileRequests: FileRequestLog[];
  close(): Promise<void>;
}

/**
 * 假 vviewer 服务器：
 * - /api/health、/api/ticket、/api/events（SSE 挂起）——远端来源接通面；
 * - /api/tree：单条目（omitTreeSize 时省略 size → FileSource.size 未知形态）；
 * - /api/file：Range 206 精确切片（end 含语义），非目标 path 一律 404（git 探测隔离）；
 *   failFirstFullRange 时首个「全量补拉」请求（Range end ≥ MAX_SAFE_INTEGER）返 HTTP 500。
 */
async function startFakeVVServer(
  fileName: string,
  bytes: Uint8Array,
  opts: { omitTreeSize?: boolean; failFirstFullRange?: boolean } = {}
): Promise<FakeVVServer> {
  const fileRequests: FileRequestLog[] = [];
  let fullRangeFailed = false;
  const server = http.createServer((req, res) => {
    res.on('error', () => {}); // 客户端 abort 后写已毁 socket：吞 ECONNRESET 防进程崩
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
      if (opts.omitTreeSize !== true) entry.size = bytes.length;
      res.end(JSON.stringify({ entries: [entry] }));
      return;
    }
    if (url.pathname === '/api/file') {
      const reqPath = url.searchParams.get('path') ?? '';
      const range = req.headers.range ?? null;
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      if (reqPath !== fileName) {
        fileRequests.push({ path: reqPath, range, start: null, end: null, served: false, servedLen: 0 });
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const start = m !== null ? Math.min(Number(m[1]), Math.max(bytes.length - 1, 0)) : null;
      const endSrv =
        m !== null && m[2] !== undefined && m[2] !== ''
          ? Math.min(Number(m[2]), bytes.length - 1)
          : bytes.length - 1;
      const isFullRange =
        m !== null && m[2] !== undefined && m[2] !== '' && Number(m[2]) >= Number.MAX_SAFE_INTEGER;
      if (opts.failFirstFullRange === true && isFullRange && !fullRangeFailed) {
        fullRangeFailed = true;
        fileRequests.push({ path: reqPath, range, start, end: endSrv, served: false, servedLen: 0 });
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'pdfx forced full-read failure' }));
        return;
      }
      const chunk = start !== null ? bytes.subarray(start, endSrv + 1) : bytes.subarray(0, bytes.length);
      fileRequests.push({ path: reqPath, range, start, end: endSrv, served: true, servedLen: chunk.length });
      res.writeHead(start !== null ? 206 : 200, {
        ...cors,
        'Content-Type': 'application/octet-stream',
        ...(start !== null ? { 'Content-Range': `bytes ${start}-${endSrv}/${bytes.length}` } : {}),
        'Content-Length': String(chunk.length)
      });
      res.end(chunk);
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
    close: async () => {
      server.close();
      server.closeAllConnections();
    }
  };
}

// ---------- 会话预置（旧键 'tabs' 快照恢复，形态照 b-pdf-range.spec.ts 同款） ----------

interface SeedTab {
  path: string;
  name: string;
  size?: number;
  active?: boolean;
}

async function seedRemoteTabs(
  page: Page,
  opts: { base: string; tabs: SeedTab[] }
): Promise<void> {
  const storeId = `remote:${hash8(`${opts.base}:e2e-fake`)}`;
  await page.addInitScript(
    (seed) => {
      sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: seed.base, token: null }));
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
          storeBase: seed.base,
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
    { base: opts.base, storeId, tabs: opts.tabs }
  );
}

// ---------- pdfjs worker 协议桩与失败注入 ----------

/**
 * 最小 pdfjs worker 桩（仅在 worker 全局作用域内生效；页侧动态 import 回落时本模块
 * 被再次求值——此时必须无副作用，否则会覆写页面的 window.onmessage）。
 *
 * 协议面（pdfjs-dist 6.4.299）：
 * - 主线程 MessageHandler（pdf.mjs:8700）按 sourceName/targetName 配对；ready 动作的
 *   data 须为 Uint8Array（pdf.mjs:16305 的 ready 门：`!(data instanceof Uint8Array)`
 *   即判失败 → terminateEarly → fake worker 回落）；
 * - 回调通道 callback=2（CallbackKind.ERROR，pdf.mjs:8664）配 callbackId 回包。
 *
 * 为何用桩而非「拦掉 worker 脚本」：worker 脚本失败后 pdfjs 回落 fake worker
 * （同 URL 动态 import，pdf.mjs:16319-16338），而 `PDFWorker.#isWorkerDisabled` 是
 * 粘滞静态位（pdf.mjs:16208 声明 / :16270 读 / :16322 置位）——回落路径一旦触发，
 * 后续 PDFWorker 实例恒走 fake worker 且页侧模块表缓存失败模块，重试无法回到真 worker。
 * 桩以「握手成功 + 文档开启失败」模拟环境性故障：worker 侧模块表每次 new Worker 皆
 * 新建，重试可恢复。
 */
const STUB_WORKER_SRC = `
const isWorkerScope = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (isWorkerScope) {
  self.onmessage = (e) => {
    const d = e.data;
    if (d && d.action === 'GetDocRequest' && d.callbackId) {
      self.postMessage({
        sourceName: 'worker',
        targetName: 'main',
        callback: 2,
        callbackId: d.callbackId,
        reason: { name: 'Error', message: 'PDFX worker stub: forced doc-open failure' }
      });
    }
  };
  self.postMessage({ sourceName: 'worker', targetName: 'main', action: 'ready', data: new Uint8Array(0) });
}
`;

/**
 * 握手失败桩：ready 的 data 非 Uint8Array（字符串）→ 主线程 ready 门判失败
 * （pdf.mjs:16305）→ terminateEarly → fake worker 回落（页侧动态 import 本模块，
 * 其导出的 WorkerMessageHandler 为 undefined → 回落链再失败 → 'Setting up fake
 * worker failed'）。
 */
const STUB_WORKER_BAD_READY_SRC = `
const isWorkerScope = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (isWorkerScope) {
  self.onmessage = (e) => {
    const d = e.data;
    if (d && d.action === 'GetDocRequest' && d.callbackId) {
      self.postMessage({
        sourceName: 'worker',
        targetName: 'main',
        callback: 2,
        callbackId: d.callbackId,
        reason: { name: 'Error', message: 'PDFX worker stub: forced doc-open failure' }
      });
    }
  };
  self.postMessage({ sourceName: 'worker', targetName: 'main', action: 'ready', data: 'pdfx-bad-ready' });
}
`;

// ---------- 进度卡缺席/出现观察器（transport 渐进装载期 / 泵路径对照面） ----------

interface ProgressFlags {
  done: boolean;
  loading: boolean;
  mut: number;
  doneText: string;
}

/**
 * 进度卡观察器：每次 mutation 分别判「完成态卡」与「下载中卡」是否出现过，并留存
 * 完成态卡首次出现时的文本（完成态 TTL=4s，ViewerPane.svelte:181——DOM 复核会与
 * TTL 竞态，观察器记录不受影响）。
 * 双旗必须分判——完成态卡自身带 .vv-dl-progress 类（DownloadProgressCard.svelte:38），
 * 合并计数会把完成态误判为下载中卡。观察器活性由 mut 计数自证（没看见 ≠ 没装上）。
 */
async function installProgressObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __vvDlSeenDone: boolean;
      __vvDlSeenLoading: boolean;
      __vvMutCount: number;
      __vvDlDoneText: string;
    };
    w.__vvDlSeenDone = false;
    w.__vvDlSeenLoading = false;
    w.__vvMutCount = 0;
    w.__vvDlDoneText = '';
    const DONE_SEL = '.vv-dl-progress-done';
    const LOADING_SEL = '.vv-dl-progress:not(.vv-dl-progress-done)';
    const pick = (root: unknown, sel: string): Element | null => {
      if (!(root instanceof Element)) return null;
      if (root.matches(sel)) return root;
      return root.querySelector(sel);
    };
    const check = (root: unknown): void => {
      const done = pick(root, DONE_SEL);
      if (done !== null) {
        w.__vvDlSeenDone = true;
        if (w.__vvDlDoneText === '') w.__vvDlDoneText = done.textContent ?? '';
      }
      if (pick(root, LOADING_SEL) !== null) w.__vvDlSeenLoading = true;
    };
    const obs = new MutationObserver((records) => {
      w.__vvMutCount++;
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) check(n);
      }
      check(document.documentElement);
    });
    obs.observe(document, { childList: true, subtree: true });
  });
}

async function progressFlags(page: Page): Promise<ProgressFlags> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __vvDlSeenDone: boolean;
      __vvDlSeenLoading: boolean;
      __vvMutCount: number;
      __vvDlDoneText: string;
    };
    return {
      done: w.__vvDlSeenDone,
      loading: w.__vvDlSeenLoading,
      mut: w.__vvMutCount,
      doneText: w.__vvDlDoneText
    };
  });
}

// ---------- FIX-01 守卫用源码工具 ----------

/** 去注释（保留字符串字面量）：守卫只扫代码面，注释里的路径提及不算依赖 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    // 字符串态：转义跳过；结束引号回 code
    if (c === '\\') {
      out += c + (n ?? '');
      i += 2;
      continue;
    }
    if (
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`')
    ) {
      state = 'code';
    }
    out += c;
    i++;
  }
  return out;
}

// ---------- 用例 ----------

test.describe('b-pdf-range-2 PDFX 域锚（pdf Range transport 补强）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('PDFX-LOCAL-01 本地 >1MB 走 transport：按 ≤64KB 窗段切片读、零整文件物化，且懒渲染页同样走窗段', async ({ page }) => {
    test.setTimeout(150_000);
    const bytes = makePdf(BIG_PDF_PAGES, BIG_PDF_BYTES);
    expect(bytes.length).toBe(BIG_PDF_BYTES);
    await installBlobMeter(page);
    await waitAppMounted(page);
    await openLocalPdf(page, 'pdfx-big.pdf', bytes);
    await openFile(page, 'pdfx-big.pdf');

    // 渲染面（transport 分支的可达性）
    await expect(page.locator('.vv-pdf')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-pdf-page')).toHaveCount(BIG_PDF_PAGES.length);
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText(`第 1 / ${BIG_PDF_PAGES.length} 页`);

    // 立即渲染面：仅 IMMEDIATE_PAGES 页出画布（其余待 IO 懒渲染）
    await expect(page.locator('.vv-pdf canvas')).toHaveCount(IMMEDIATE_PAGES);

    // 懒渲染面：滚到底触发 IO → 第 4+ 页出画布（IO 懒渲染路径可达）。
    // 滚动容器是 PDF 自身的 .vv-pdf-pages（pdf.ts:301-303 建；app.css:191 .vv-pdf
    // 定高 + :198 .vv-pdf-pages{flex:1;overflow:auto}；IO 的 root 亦为 pagesHost，
    // pdf.ts:417）——外层 .vv-viewer-scroll 在 PDF 视图下 scrollHeight===clientHeight
    // （零溢出，滚动是空操作），写法同既有锚 MEDIA-07（b-media-office-viewer.spec.ts:374）。
    await page.locator('.vv-pdf-pages').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => page.locator('.vv-pdf canvas').count(), {
        timeout: 30_000,
        message: 'IO 懒渲染未触发——第 4+ 页无画布'
      })
      .toBeGreaterThan(IMMEDIATE_PAGES);

    // 读形态计量：探测块 8KB + pdfjs 64KB 窗段读，零整文件物化
    const reads = await settledReads(page);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads[0]!.size).toBe(HEAD_SIZE); // dispatcher 探测块（dispatcher.ts:63/406）
    const sizes = reads.map((r) => r.size);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PDFJS_CHUNK);
    expect(sizes).toContain(PDFJS_CHUNK); // 存在整窗读（pdfjs rangeChunkSize=2**16）
    expect(sizes).not.toContain(bytes.length); // 零整文件一次性物化

    // 切片计量：store 走 File.slice 窗段（parentSize = 夹具总长）
    const slices = await sliceLog(page);
    const fileSlices = slices.filter((s) => s.parentSize === bytes.length);
    expect(fileSlices.length).toBeGreaterThanOrEqual(1);
    expect(fileSlices.every((s) => s.len <= PDFJS_CHUNK)).toBe(true);

    // 缺席面：本地来源非远端来源（storeId 前缀 localfiles:）→ isRemoteDownload 恒 false
    // → 无 tracker（ViewerPane.svelte:826-831）→ 不产进度卡/完成态卡。
    // 该断言的因果是「无 tracker」而非「transport 零 update」——后者归 PDFX-CARD-01
    // （远端 tracker 在场但零 update），正向对照面归 PDFX-CARD-02（远端泵路径出卡）。
    await expect(page.locator('.vv-dl-progress-done')).toHaveCount(0);
    await expect(page.locator('.vv-dl-progress:not(.vv-dl-progress-done)')).toHaveCount(0);
  });

  test('PDFX-LOCAL-02 本地 ≤1MB 走 data 路径：单次整读、零窗段切片（1MB 阈值另一侧）', async ({ page }) => {
    test.setTimeout(150_000);
    // 贴近阈值下侧（1MB-1 字节）：FULL_LIMIT 向下漂移时本锚必红（读形态从整读变窗段）
    const bytes = makePdf(SMALL_PDF_PAGES, SMALL_PDF_BYTES);
    expect(bytes.length).toBe(SMALL_PDF_BYTES);
    expect(bytes.length).toBeLessThanOrEqual(1 << 20);
    await installBlobMeter(page);
    await waitAppMounted(page);
    await openLocalPdf(page, 'pdfx-small.pdf', bytes);
    await openFile(page, 'pdfx-small.pdf');

    // 渲染面
    await expect(page.locator('.vv-pdf')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-pdf-page')).toHaveCount(SMALL_PDF_PAGES.length);
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText(`第 1 / ${SMALL_PDF_PAGES.length} 页`);

    // 读形态计量：≤1MB 直读全量（dispatcher.ts:401-404），恰一次整读
    const reads = await settledReads(page);
    expect(reads.length).toBe(1);
    expect(reads[0]!.size).toBe(bytes.length);

    // 切片计量：未按窗段读（pdf.ts:189 的 buffer.byteLength < ctx.size 不成立 → 不进 transport）
    const slices = await sliceLog(page);
    expect(slices.filter((s) => s.parentSize === bytes.length)).toHaveLength(0);
  });

  // SW 阻断面：page.route 拦不到经 Service Worker 的请求（b-cdn-diagram-engines 先例）。
  // pdf worker 资产为 .mjs（build/_app/immutable/assets/pdf.worker.min.<hash>.mjs），
  // precache globPatterns 只覆盖 js/css/woff2/json（vite.config.ts:593）故不入 precache；
  // 阻断 SW 只为让该请求必经页面网络栈，拦截面确定。
  test.describe('PDFX-MEMO-01/03/04/05（SW 阻断面）', () => {
    test.use({ serviceWorkers: 'block' });

    test('PDFX-MEMO-01 size 未知远端 PDF 装载失败 → 重试 → 渲染成功且全量补拉零重复下载', async ({ page }) => {
      test.setTimeout(180_000);
      const bytes = makePdf(MEMO_PDF_PAGES, MEMO_PDF_BYTES);
      const srv = await startFakeVVServer('memo.pdf', bytes, { omitTreeSize: true });
      // 树条目与快照双缺 size → FileSource.size null → ctx.size === null → 渲染器走
      // memoizedFullRead（pdf.ts:192）全量补拉
      await seedRemoteTabs(page, {
        base: srv.base,
        tabs: [
          { path: '', name: 'e2e-fake', active: false },
          { path: 'memo.pdf', name: 'memo.pdf', active: true }
        ]
      });
      // worker 脚本桩：首轮握手成功但文档开启失败（环境性故障面）
      let stubPhase = true;
      const stubHits: string[] = [];
      await page.route(/pdf[._-]worker/i, (route: Route) => {
        if (stubPhase) {
          stubHits.push(route.request().url());
          return void route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
            body: STUB_WORKER_SRC
          });
        }
        return void route.continue();
      });
      await page.goto('/');

      // 拦截自检：桩确实被下发（失败前提不成立时显式红，防静默假绿）
      await expect
        .poll(() => stubHits.length, {
          timeout: 30_000,
          message: 'pdf worker 桩未命中——失败前提不成立（worker 资产名是否变化？）'
        })
        .toBeGreaterThanOrEqual(1);

      // 首次失败面：渲染失败卡片 + 重试动作（错误身份锁在桩的文案上）
      const card = page.locator('.vv-error-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const detail = await card.locator('.vv-error-detail').textContent();
      expect(detail).toContain('PDFX worker stub: forced doc-open failure');
      await expect(card.locator('.vv-error-action').first()).toHaveText('重试');

      // 请求面：探测块 + 全量补拉恰两条（size 未知 → 探测块 → memoizedFullRead 单发全量）
      const targetReqs = (): FileRequestLog[] => srv.fileRequests.filter((r) => r.path === 'memo.pdf');
      await expect
        .poll(() => targetReqs().length, { timeout: 30_000, message: '目标文件请求数未达 2' })
        .toBe(2);
      expect(targetReqs()[0]!.range).toBe(`bytes=0-${HEAD_SIZE - 1}`);
      expect(targetReqs()[0]!.servedLen).toBe(HEAD_SIZE);
      expect(targetReqs()[1]!.range).toBe(`bytes=0-${Number.MAX_SAFE_INTEGER}`);
      expect(targetReqs()[1]!.servedLen).toBe(bytes.length);

      // 重试：放行真 worker（worker 侧模块表每次 new Worker 皆新建，可恢复）
      stubPhase = false;
      await card.locator('.vv-error-action').first().click();

      // 重试成功面
      await expect(page.locator('.vv-error-card')).toHaveCount(0, { timeout: 60_000 });
      await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('.vv-pdf-page-indicator')).toHaveText(`第 1 / ${MEMO_PDF_PAGES.length} 页`);

      // 零重复下载：memo 命中（pdf.ts:56-67）→ 重试零新增请求。观察窗多次采样，晚到的
      // 第 3 条请求亦被抓（memo 若失效/不记忆 → 重试重新下载 → 计数变 3 → 红）。
      // transfer 毒化防护在产品侧为双层：memo 存字节本体、每次消费返回副本
      // （pdf.ts:56-67），且 data 分支另交副本给 getDocument
      // （`getDocument({ data: buffer.slice() })`）——两层皆为拷贝时端到端面无法区分
      // 是哪一层在挡，故本锚以行为面（重试成功 + 零重复下载）为准，拷贝契约由
      // packages/vviewer-render-doc/test/pdf-render.test.ts 单测锁。
      await expectCountStays(page, () => targetReqs().length, 2, { rounds: 5, intervalMs: 400 });
      await srv.close();
    });

    test('PDFX-MEMO-02 size 未知远端 PDF 全量补拉读失败落读取失败卡片（零动作钮），且失败尝试零污染后续打开', async ({ page }) => {
      test.setTimeout(180_000);
      const bytes = makePdf(MEMO_PDF_PAGES, MEMO_PDF_BYTES);
      const srv = await startFakeVVServer('memo.pdf', bytes, {
        omitTreeSize: true,
        failFirstFullRange: true
      });
      await seedRemoteTabs(page, {
        base: srv.base,
        tabs: [
          { path: '', name: 'e2e-fake', active: false },
          { path: 'memo.pdf', name: 'memo.pdf', active: true }
        ]
      });
      await page.goto('/');

      // 不挂起：读取失败卡片（dispatcher.ts:539 读错误上抛 → ViewerPane 读取失败面）
      const card = page.locator('.vv-error-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const detail = await card.locator('.vv-error-detail').textContent();
      expect(detail).toContain('HTTP 500');
      // 读失败面与渲染失败面的分界：读失败卡不带任何动作钮（渲染失败卡有 3 个：
      // 重试 / 以 hex 打开 / 以纯文本打开）——若该请求被误分类为渲染失败即红
      await expect(card.locator('.vv-error-action')).toHaveCount(0);

      // 请求计量：探测块恰 1 条 + 全量补拉恰 1 条（服务端 500，served=false）
      const targetReqs = (): FileRequestLog[] => srv.fileRequests.filter((r) => r.path === 'memo.pdf');
      await expect
        .poll(() => targetReqs().length, { timeout: 30_000, message: '目标文件请求数未达 2' })
        .toBe(2);
      expect(targetReqs()[0]!.range).toBe(`bytes=0-${HEAD_SIZE - 1}`);
      expect(targetReqs()[1]!.range).toBe(`bytes=0-${Number.MAX_SAFE_INTEGER}`);
      expect(targetReqs()[1]!.served).toBe(false);

      // 零污染：再次点击树行同文件（新 tab，AppShell.svelte:1044-1045）→ 渲染成功
      await page.locator('.vv-tree-row', { hasText: 'memo.pdf' }).click();
      await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('.vv-pdf-page-indicator')).toHaveText(`第 1 / ${MEMO_PDF_PAGES.length} 页`);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);

      // 计量收口：失败尝试未留缓存/闩锁 → 后续打开重新取数并成功
      await expect
        .poll(() => targetReqs().length, { timeout: 30_000, message: '二次打开未重新取数' })
        .toBe(4);
      expect(targetReqs()[2]!.range).toBe(`bytes=0-${HEAD_SIZE - 1}`);
      expect(targetReqs()[3]!.range).toBe(`bytes=0-${Number.MAX_SAFE_INTEGER}`);
      expect(targetReqs()[3]!.served).toBe(true);
      expect(targetReqs()[3]!.servedLen).toBe(bytes.length);
      await srv.close();
    });

    test('PDFX-MEMO-03 pdfjs worker 资产不可达：回落链不挂起，落渲染失败卡片（错误身份可辨）', async ({ page }) => {
      test.setTimeout(150_000);
      const bytes = makePdf(MEMO_PDF_PAGES, MEMO_PDF_BYTES);
      const srv = await startFakeVVServer('memo.pdf', bytes, { omitTreeSize: true });
      await seedRemoteTabs(page, {
        base: srv.base,
        tabs: [
          { path: '', name: 'e2e-fake', active: false },
          { path: 'memo.pdf', name: 'memo.pdf', active: true }
        ]
      });
      // worker 脚本请求 abort（资产不可达）→ worker 失败 → fake worker 回落（同 URL
      // 动态 import 亦失败）→ 文档开启 reject → 渲染失败卡片
      const workerHits: string[] = [];
      await page.route(/pdf[._-]worker/i, (route: Route) => {
        workerHits.push(route.request().url());
        return void route.abort();
      });
      await page.goto('/');

      // 拦截自检：worker 脚本 + fake worker 动态 import 两次命中（回落链确已触发）
      await expect
        .poll(() => workerHits.length, {
          timeout: 30_000,
          message: 'pdf worker 请求未被拦截（资产名是否变化？）或回落链未触发'
        })
        .toBeGreaterThanOrEqual(2);

      // 不挂起：渲染失败卡片 + 错误身份（回落链失败的原文，非泛化文案）
      const card = page.locator('.vv-error-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const detail = await card.locator('.vv-error-detail').textContent();
      expect(detail).toContain('Setting up fake worker failed');
      expect(detail).toContain('Failed to fetch dynamically imported module');
      await expect(card.locator('.vv-error-action').first()).toHaveText('重试');
      // 渲染失败面的动作钮数（读失败面为 0——见 PDFX-MEMO-02）
      await expect(card.locator('.vv-error-action')).toHaveCount(3);

      // 读面已完成且未被 worker 失败污染：探测块 + 全量补拉恰两条
      const targetReqs = (): FileRequestLog[] => srv.fileRequests.filter((r) => r.path === 'memo.pdf');
      await expect
        .poll(() => targetReqs().length, { timeout: 30_000, message: '目标文件请求数未达 2' })
        .toBe(2);
      expect(targetReqs()[0]!.range).toBe(`bytes=0-${HEAD_SIZE - 1}`);
      expect(targetReqs()[1]!.range).toBe(`bytes=0-${Number.MAX_SAFE_INTEGER}`);
      expect(targetReqs()[1]!.servedLen).toBe(bytes.length);
      await srv.close();
    });

    test('PDFX-MEMO-04 pdfjs worker 资产 404（装配失败）：回落链不挂起，落渲染失败卡片', async ({ page }) => {
      test.setTimeout(150_000);
      const bytes = makePdf(MEMO_PDF_PAGES, MEMO_PDF_BYTES);
      const srv = await startFakeVVServer('memo.pdf', bytes, { omitTreeSize: true });
      await seedRemoteTabs(page, {
        base: srv.base,
        tabs: [
          { path: '', name: 'e2e-fake', active: false },
          { path: 'memo.pdf', name: 'memo.pdf', active: true }
        ]
      });
      // worker 资产 404：模块装载失败（与 abort 的差别仅在失败原因文案）
      const workerHits: string[] = [];
      await page.route(/pdf[._-]worker/i, (route: Route) => {
        workerHits.push(route.request().url());
        return void route.fulfill({
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: 'pdfx worker asset not found'
        });
      });
      await page.goto('/');

      // 拦截自检：worker 脚本 + fake worker 动态 import 两次命中
      await expect
        .poll(() => workerHits.length, {
          timeout: 30_000,
          message: 'pdf worker 请求未被拦截（资产名是否变化？）或回落链未触发'
        })
        .toBeGreaterThanOrEqual(2);

      // 不挂起 + 错误身份：回落链失败原文
      const card = page.locator('.vv-error-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const detail = await card.locator('.vv-error-detail').textContent();
      expect(detail).toContain('Setting up fake worker failed');
      await expect(card.locator('.vv-error-action').first()).toHaveText('重试');

      // 读面未被污染：探测块 + 全量补拉恰两条
      const targetReqs = (): FileRequestLog[] => srv.fileRequests.filter((r) => r.path === 'memo.pdf');
      await expect
        .poll(() => targetReqs().length, { timeout: 30_000, message: '目标文件请求数未达 2' })
        .toBe(2);
      expect(targetReqs()[0]!.range).toBe(`bytes=0-${HEAD_SIZE - 1}`);
      expect(targetReqs()[1]!.servedLen).toBe(bytes.length);
      await srv.close();
    });

    test('PDFX-MEMO-05 pdfjs worker 握手失败（ready data 非 Uint8Array）：回落链不挂起，落渲染失败卡片', async ({ page }) => {
      test.setTimeout(150_000);
      const bytes = makePdf(MEMO_PDF_PAGES, MEMO_PDF_BYTES);
      const srv = await startFakeVVServer('memo.pdf', bytes, { omitTreeSize: true });
      await seedRemoteTabs(page, {
        base: srv.base,
        tabs: [
          { path: '', name: 'e2e-fake', active: false },
          { path: 'memo.pdf', name: 'memo.pdf', active: true }
        ]
      });
      // 桩握手失败：ready 的 data 为字符串 → 主线程 ready 门（pdf.mjs:16305）判失败
      // → terminateEarly → fake worker 回落（页侧动态 import 本模块，导出无
      // WorkerMessageHandler → 回落链再失败）
      const workerHits: string[] = [];
      await page.route(/pdf[._-]worker/i, (route: Route) => {
        workerHits.push(route.request().url());
        return void route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
          body: STUB_WORKER_BAD_READY_SRC
        });
      });
      await page.goto('/');

      // 拦截自检：worker 脚本 + fake worker 动态 import 两次命中
      await expect
        .poll(() => workerHits.length, {
          timeout: 30_000,
          message: 'pdf worker 请求未被拦截（资产名是否变化？）或回落链未触发'
        })
        .toBeGreaterThanOrEqual(2);

      // 不挂起 + 错误身份：回落链失败原文
      const card = page.locator('.vv-error-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const detail = await card.locator('.vv-error-detail').textContent();
      expect(detail).toContain('Setting up fake worker failed');
      await expect(card.locator('.vv-error-action').first()).toHaveText('重试');

      // 读面未被污染：探测块 + 全量补拉恰两条
      const targetReqs = (): FileRequestLog[] => srv.fileRequests.filter((r) => r.path === 'memo.pdf');
      await expect
        .poll(() => targetReqs().length, { timeout: 30_000, message: '目标文件请求数未达 2' })
        .toBe(2);
      expect(targetReqs()[0]!.range).toBe(`bytes=0-${HEAD_SIZE - 1}`);
      expect(targetReqs()[1]!.servedLen).toBe(bytes.length);
      await srv.close();
    });
  });

  test('PDFX-CARD-01 远端 >1MB 走 transport 渐进装载：全程零进度卡/零完成态卡', async ({ page }) => {
    test.setTimeout(180_000);
    const bytes = makePdf(BIG_PDF_PAGES, BIG_PDF_BYTES);
    const srv = await startFakeVVServer('card.pdf', bytes); // 树条目带 size → ctx.size 已知
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'card.pdf', name: 'card.pdf', size: bytes.length, active: true }
      ]
    });
    await installProgressObserver(page);
    await page.goto('/');

    // transport 路径成立（前提）：探测块 + ≥1 条 start ≥ 8192 的窗段请求
    const targetReqs = (): FileRequestLog[] => srv.fileRequests.filter((r) => r.path === 'card.pdf');
    await expect
      .poll(() => targetReqs().filter((r) => r.start !== null && r.start >= HEAD_SIZE).length, {
        timeout: 60_000,
        message: 'transport 窗段请求未出现——渐进装载前提不成立'
      })
      .toBeGreaterThanOrEqual(1);
    expect(targetReqs()[0]!.range).toBe(`bytes=0-${HEAD_SIZE - 1}`);

    // 渲染成功
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText(`第 1 / ${BIG_PDF_PAGES.length} 页`);

    // 缺席断言（双旗分列）：远端 tracker 在场（remote: 来源）但 transport 路径零 update
    // → tracker.pumped 恒 false → 完成态卡门与进度卡门同时不成立。
    // 正向对照面见 PDFX-CARD-02（远端 ≤1MB 泵路径出卡）——两者成对，缺席方才有对照。
    const flags = await progressFlags(page);
    expect(flags.done).toBe(false);
    expect(flags.loading).toBe(false);
    expect(flags.mut).toBeGreaterThan(0); // 观察器活性自检（没看见 ≠ 没装上）

    // DOM 复核
    await expect(page.locator('.vv-dl-progress-done')).toHaveCount(0);
    await expect(page.locator('.vv-dl-progress:not(.vv-dl-progress-done)')).toHaveCount(0);
    await srv.close();
  });

  test('PDFX-CARD-02 远端 ≤1MB 走 dispatcher 泵：进度卡与完成态卡出现（缺席面的正向对照）', async ({ page }) => {
    test.setTimeout(180_000);
    const bytes = makePdf(MEMO_PDF_PAGES, MEMO_PDF_BYTES); // 20,000B ≤ 1MB
    const srv = await startFakeVVServer('card2.pdf', bytes); // 树条目带 size → ≤1MB 直读泵
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'card2.pdf', name: 'card2.pdf', size: bytes.length, active: true }
      ]
    });
    await installProgressObserver(page);
    await page.goto('/');

    // 泵路径成立（前提）：≤1MB 分支直读全量（dispatcher.ts:401-404）——单条全量窗请求，
    // 无探测块（与 transport 路径的「探测块 + 窗段流」形态可区分）
    const targetReqs = (): FileRequestLog[] => srv.fileRequests.filter((r) => r.path === 'card2.pdf');
    await expect
      .poll(() => targetReqs().length, {
        timeout: 60_000,
        message: '≤1MB 泵路径的单条全量请求未出现'
      })
      .toBe(1);
    expect(targetReqs()[0]!.range).toBe(`bytes=0-${bytes.length - 1}`);
    expect(targetReqs()[0]!.servedLen).toBe(bytes.length);

    // 渲染成功
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText(`第 1 / ${MEMO_PDF_PAGES.length} 页`);

    // 正向对照：泵路径产出进度卡（下载中）与完成态卡——缺席面（PDFX-CARD-01）的对照证据。
    // 完成态卡 TTL=4s（ViewerPane.svelte:181），DOM 复核会与 TTL 竞态，故以观察器
    // 记录为准（记录不受卸载影响）。
    const flags = await progressFlags(page);
    expect(flags.loading).toBe(true);
    expect(flags.done).toBe(true);
    expect(flags.doneText).toContain('card2.pdf');
    expect(flags.mut).toBeGreaterThan(0);
    await srv.close();
  });

  test('PDFX-M1-01 M1 mid-load 读失败收口后 pdfjs worker 零泄漏且读请求流停止', async ({ page }) => {
    test.setTimeout(180_000);
    const bytes = makePdf(BIG_PDF_PAGES, BIG_PDF_BYTES);
    const srv = await startFakeVVServer('m1.pdf', bytes); // 树条目带 size → transport 分支
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'm1.pdf', name: 'm1.pdf', size: bytes.length, active: true }
      ]
    });
    // 放行探测块与无 Range 的 git 探测，abort 其余带 Range 的窗段请求（非 abort 读失败）
    const hits: Array<{ url: string; range: string | null }> = [];
    await page.route(/\/api\/file/, (route: Route) => {
      const req = route.request();
      const range = req.headers()['range'] ?? null;
      hits.push({ url: req.url(), range });
      if (range === null || range === `bytes=0-${HEAD_SIZE - 1}`) return void route.continue();
      return void route.abort();
    });
    // worker 观测：Playwright 的 worker 面（不依赖 pdfjs 私有字段名）
    const workerEvents: string[] = [];
    page.on('worker', (w) => {
      workerEvents.push(`created:${w.url()}`);
      w.on('close', () => workerEvents.push(`closed:${w.url()}`));
    });
    await page.goto('/');

    // 前提：pdf worker 已创建 + 窗段请求被 abort（transport 窗段流已成立）
    const pdfWorkers = (): number =>
      workerEvents.filter((e) => e.startsWith('created:') && e.includes('pdf.worker')).length;
    await expect
      .poll(pdfWorkers, { timeout: 60_000, message: 'pdf worker 未被创建——transport 前提不成立' })
      .toBeGreaterThanOrEqual(1);
    const abortedWindows = (): number =>
      hits.filter((h) => h.url.includes('path=m1.pdf') && h.range !== null && h.range !== `bytes=0-${HEAD_SIZE - 1}`)
        .length;
    await expect
      .poll(abortedWindows, { timeout: 60_000, message: '窗段请求未被 abort——读失败前提不成立' })
      .toBeGreaterThanOrEqual(1);

    // 收口：错误卡片出现而非悬挂（读失败身份：fetch 层 TypeError）
    const card = page.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const detail = await card.locator('.vv-error-detail').textContent();
    expect(detail).toContain('Failed to fetch');

    // 零泄漏：loadingTask.destroy() 在 setup 段 await 永挂（pdf.mjs:15557-15575），
    // pdf.ts:279 的 _worker?.destroy() 是唯一可达的终止路径
    await expect
      .poll(() => page.workers().filter((w) => w.url().includes('pdf.worker')).length, {
        timeout: 30_000,
        message: 'pdf worker 未被终止——泄漏面回归'
      })
      .toBe(0);
    expect(
      workerEvents.some((e) => e.startsWith('closed:') && e.includes('pdf.worker'))
    ).toBe(true);

    // 请求流停止：先等计数自然静止（尾随请求在结算窗内清偿），再以此为基线观察
    // 1.5s 窗口内不再增长——避免用固定窗口在慢机上把尾随请求误判为「未停止」
    const baseline = await waitStableCount(page, abortedWindows, {
      rounds: 3,
      intervalMs: 400,
      timeoutMs: 20_000
    });
    await expectCountStays(page, abortedWindows, baseline, { rounds: 4, intervalMs: 400 });
    await srv.close();
  });

  test('PDFX-M1-02 文档已开后的懒页 chunk 读失败：静默（零错误卡、该页无画布）', async ({ page }) => {
    test.setTimeout(180_000);
    // mid 布局：填充在 pages 树之后、page 对象之前——文档打开只读「首块 + 尾块」，
    // 页面对象/内容流落在中段块，渲染期才按需窗段读（M1 docOpened 门控的构造前提）
    const bytes = makePdf(BIG_PDF_PAGES, BIG_PDF_BYTES, 'mid');
    const srv = await startFakeVVServer('m12.pdf', bytes);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'm12.pdf', name: 'm12.pdf', size: bytes.length, active: true }
      ]
    });
    // 放行文档打开所需的两块（首块 start=0 与尾块 start≥文件尾 - 一块），abort 中段块
    // （中段块只在渲染期被取——probe 实测：文档打开读「首块 + 尾块」，页面内容读中段）
    const aborted: string[] = [];
    await page.route(/\/api\/file/, (route: Route) => {
      const req = route.request();
      const range = req.headers()['range'] ?? null;
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      const start = m !== null ? Number(m[1]) : null;
      const isDocOpenChunk =
        start !== null && (start === 0 || start >= bytes.length - PDFJS_CHUNK);
      if (range === null || isDocOpenChunk) return void route.continue();
      aborted.push(range);
      return void route.abort();
    });
    await page.goto('/');

    // 文档已开（页容器就位、页码指示更新）→ 渲染期窗段读被 abort
    await expect(page.locator('.vv-pdf-page')).toHaveCount(BIG_PDF_PAGES.length, { timeout: 60_000 });
    await expect(page.locator('.vv-pdf-page-indicator')).toHaveText(`第 1 / ${BIG_PDF_PAGES.length} 页`);
    await expect
      .poll(() => aborted.length, { timeout: 60_000, message: '渲染期窗段请求未被 abort' })
      .toBeGreaterThanOrEqual(1);

    // 静默分支（docOpened 门控，pdf.ts:239-247）：读失败不落错误卡；该页画布不出
    // （渲染 promise 因缺块永久 pending → 画布不挂载）
    await page.waitForTimeout(1500);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await expect(page.locator('.vv-pdf canvas')).toHaveCount(0);
    await srv.close();
  });

  test('PDFX-FIX-01 夹具自持守卫：禁夹具条件 skip + 禁库外夹具依赖 + 合成夹具结构与确定性锚', async () => {
    const src = readFileSync(SELF_PATH, 'utf8');
    const code = stripComments(src);
    const lines = src.split('\n');

    // 守卫 1a：本文件的 skip/fixme 调用必须是项目作用域（desktop 专属），
    // 不得有夹具条件 skip（否则 CI 在缺夹具环境静默空心化）
    const skipNeedles = [
      'test' + '.skip(',
      'test' + '.describe.skip(',
      'test' + '.fixme(',
      'test' + '.describe.fixme(',
      'testInfo' + '.skip(',
      'testInfo' + '.fixme('
    ];
    const badSkips = lines.filter(
      (l) => skipNeedles.some((n) => l.includes(n)) && !l.includes('project.name')
    );
    expect(badSkips, '存在非项目作用域的 skip/fixme（夹具条件 skip 会让 CI 静默空心化）').toEqual([]);

    // 守卫 1b：域正主既有锚的夹具条件 skip 必须带可再生命令（禁静默空心化）
    const legacySrc = readFileSync(LEGACY_SPEC_PATH, 'utf8');
    const legacySkipLines = legacySrc.split('\n').filter((l) => /test\.skip\(/.test(l));
    for (const line of legacySkipLines) {
      const inline = /test\.skip\([^,]+,\s*'([^']*)'\s*\)/.exec(line)?.[1];
      const id = /test\.skip\([^,]+,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(line)?.[1];
      const viaId =
        id !== undefined
          ? new RegExp(`const\\s+${id}\\s*=\\s*'([^']*)'`).exec(legacySrc)?.[1]
          : undefined;
      const reason = inline ?? viaId ?? '';
      expect(reason, `夹具条件 skip 缺可再生命令：${line.trim()}`).toMatch(
        /uv run|python|node .*gen|gen-e2e/i
      );
    }

    // 守卫 2：本文件只允许读仓内 .ts 源文件（自身源码 + 域正主既有锚源码），
    // 禁止任何语料/夹具目录路径字面量（库外 binary 夹具依赖面）。
    // 针脚用字符串拼接写法规避自匹配。
    const fsRe = /\b(readFileSync|existsSync|readFile|writeFileSync)\s*\(\s*([A-Za-z_$][\w$]*)/g;
    const fsTargets = [...code.matchAll(fsRe)].map((m) => m[2]!);
    expect(fsTargets.length, 'fs 扫描未命中任何调用——守卫失效自检').toBeGreaterThan(0);
    for (const target of fsTargets) {
      expect(
        ['SELF_PATH', 'LEGACY_SPEC_PATH'],
        `本文件只允许读仓内 .ts 源文件，不得读语料/夹具：${target}`
      ).toContain(target);
    }
    for (const needle of ['fixt' + 'ures', 'cor' + 'pus', 'sam' + 'ples']) {
      expect(code.includes(needle), `本文件不得出现语料/夹具目录字面量：${needle}`).toBe(false);
    }

    // 守卫 3：合成夹具结构与体量（三档字节数与域文档 §4.2 一致）
    const big = makePdf(BIG_PDF_PAGES, BIG_PDF_BYTES);
    const small = makePdf(SMALL_PDF_PAGES, SMALL_PDF_BYTES);
    const memo = makePdf(MEMO_PDF_PAGES, MEMO_PDF_BYTES);
    expect(big.length).toBe(BIG_PDF_BYTES);
    expect(small.length).toBe(SMALL_PDF_BYTES);
    expect(memo.length).toBe(MEMO_PDF_BYTES);
    expect(big.length).toBeGreaterThan(1 << 20);
    expect(big.length).toBeLessThan(2 << 20);
    expect(small.length).toBeLessThanOrEqual(1 << 20);
    expect(small.length).toBeGreaterThan((1 << 20) - 4096); // 贴近阈值下侧（漂移可被发现）
    expect(memo.length).toBeGreaterThan(HEAD_SIZE); // 探测块不得吞掉全量
    expect(new TextDecoder().decode(big.subarray(0, 8))).toBe('%PDF-1.4');
    expect(new TextDecoder().decode(big.subarray(big.length - 6))).toBe('%%EOF\n');
    expect(new TextDecoder().decode(big)).toContain(`/Count ${BIG_PDF_PAGES.length}`);
    expect(new TextDecoder().decode(small)).toContain(`/Count ${SMALL_PDF_PAGES.length}`);

    // 守卫 4：确定性——同参两次合成字节级相同
    expect(sha256(makePdf(BIG_PDF_PAGES, BIG_PDF_BYTES))).toBe(sha256(big));
    expect(sha256(makePdf(SMALL_PDF_PAGES, SMALL_PDF_BYTES))).toBe(sha256(small));
  });
});
