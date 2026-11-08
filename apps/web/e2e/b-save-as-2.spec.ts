import http from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { hash8 } from '@bhxch/vviewer-core';
import { openDirBytes, openFile, waitAppMounted } from './helpers';

/**
 * b-save-as-2 —— 另存为管线与下载确认门 e2e 补强（SAV 域；b-save-as 的续编文件，
 * 不改动既有 spec）。
 *
 * 与既有 b-save-as.spec.ts 的分工：既有文件覆盖 SA-01/02/03、DL-PROG-01/02、
 * DL-CONF-01a/01b/02/03、DL-SAVE-01（10 锚，菜单路 picker-first + 进度卡字段 +
 * 确认门触发侧 + tee 直写）；本文件只补**既有锚未覆盖的行为面**（勘察缺口清单）：
 * - 完成态卡（下载完成后浮层）的两个按钮点击链路（另存为 / 关闭）零锚；
 * - 进度卡「取消」的两种取消语义（渲染 effect 路的 effectAbort vs 完成态重下路的
 *   自持 pumpAbort）未区分；
 * - 无 FS Access 环境的 blob URL + `<a download>` 兜底零锚；远端取数与选目标的
 *   先后顺序（picker-first vs 先取数后选目标）零锚；picker 取消的静默分类零锚；
 * - 确认门的**非触发侧**（size 恰等阈值、size 未知、本地来源永不拦）无对照锚；
 *   确认作用域键（同键不再问 / 取消后重问）零锚；菜单路 window.confirm 的
 *   拒绝/接受零锚；菜单路状态条反馈面零锚；
 * - saveAsDisabledOf 三条判定中「目录 tab」「错误卡片 tab」两条零锚；
 * - tee 直写降级面（createWritable 失败 → 状态条降级提示；写失败 → abort 半成品）零锚；
 * - 在手/归档面（本地文件）的 saveAsBlob 入口在无 FS Access 环境无锚。
 *
 * 装置（自建在本文件内；仅复用既有共享 helper ./helpers 的 openDirBytes/openFile/
 * waitAppMounted——只读引用，未改动共享文件）：
 * - mini 假 vviewer 服务器（/api/health + /api/tree + /api/file Range 206 切片 +
 *   逐块延时 + 500 失败形态 + /api/count 计数面）。**不抽公共 helper 文件**：
 *   ① 本域与既有 b-save-as.spec.ts 的装置无法互相 import（spec 文件顶层即注册
 *   用例，导入会重复注册）；② 仓内既有共享件 fake-file-server.ts 不具备本域所需
 *   能力（无 Range 206 切片 → 泵的请求窗会取到同一段前缀；无请求计数面/到达
 *   顺序面/500 形态/逐块延时），故保留本文件内的服务器；③ PNG 构造已收敛到
 *   node:zlib 的 crc32（png-fixture.ts:1/20 同款），不再手写 CRC 表与 crc32
 *   实现（原手写段与 b-save-as.spec.ts:44-67 重复，已删除）。
 * - 旧键 'tabs' 会话快照预置（remote:<hash8(base:label)> 来源 + 目录/文件 tab）。
 * - showSaveFilePicker 桩（addInitScript）：记录 suggestedName/调用时刻/写入块/
 *   close/abort 计数/「选定目标时服务器侧取数计数」；三档故障桩（createWritable
 *   抛错 / write 抛错 / picker 抛 NotAllowedError=用户取消）。
 * - 无 FS Access 形态：init script 以 defineProperty 把 window.showSaveFilePicker
 *   遮蔽为 undefined（Chromium 原生面在 localhost 安全上下文下存在，必须显式遮蔽
 *   才能到达降级路径）。
 * - `<a download>` 兜底点击记录（改写 HTMLAnchorElement.prototype.click）。
 * - 确认阈值改小：settings 落 localStorage 键 'vviewer:settings'（设置面持久化
 *   单源，loadSettings 每轮现算 → 门评估即时生效）。
 *
 * 顺序断言口径（本域不使用跨进程时刻比对）：浏览器 Date.now() 与 node 侧请求到达
 * 时刻跨进程同刻比较在系统时钟被 NTP 调整时会破（无容差即脆）——顺序结论一律
 * 改用「服务器侧请求计数/到达序」单源表达（picker 桩在返回句柄前先读一次计数，
 * 断言「选定目标时取数计数 == 另存为前计数」= 目标先选、传输后启；blob 兜底面
 * 则以「blob 体携带已读全的源字节（字节数+校验和等值）」表达取数先于落盘）。
 *
 * 桌面专属（仅 chromium project；b-save-as/b-diagram-file 同款 beforeEach 写法）：
 * 右键菜单/进度卡/确认卡均为桌面交互面，mobile 375px 复跑无增量覆盖。
 */

// ---------- 载体构造：精确体量 PNG（CRC 走 node:zlib，与 png-fixture.ts 同款） ----------

/** PNG 块（len/type/data/crc；CRC 用 node:zlib 的 crc32——png-fixture.ts:1/20 同款，
 *  不再手写 CRC 表与 crc32 实现，避免与既有 spec 各自漂移） */
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** 精确体量 PNG：vvEX 私有 ancillary 块填充到 total 字节（解码器跳过未知块）。
 *  精确体量的意义：确认门阈值比较（size > 阈值，字节级）与「等界不触发」场景
 *  需要 size 与阈值逐字节相等，填充量必须可算。 */
function makePngOfExactSize(total: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const raw = Buffer.from([0, 0x33, 0x44, 0x55, 0xff]); // filter 0 + RGBA 像素
  const idat = pngChunk('IDAT', deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  const overhead = 12; // vvEX 块自身开销：len(4) + type(4) + crc(4)
  const padLen = total - sig.length - ihdr.length - idat.length - iend.length - overhead;
  if (padLen < 0) throw new Error(`目标体量 ${total} 字节小于 PNG 最小体量`);
  const pad = pngChunk('vvEX', Buffer.alloc(padLen, 0x5a));
  return Buffer.concat([sig, ihdr, pad, idat, iend]);
}

/** 落盘字节校验和（页/节点两端同算法）：逐块内下标参与，块边界重置下标——
 *  与 saveAs.ts 泵的 4MiB 请求窗分块形态一致（tee 直写逐块写盘时块边界即窗边界）。
 *  单块文件（≤4MiB）时与扁平 byteHash 同值。 */
function byteHashChunked(bytes: Uint8Array, chunkSize: number): number {
  let h = 0;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, bytes.length);
    for (let i = 0; i < end - start; i++) h = (h + bytes[start + i]! * ((i % 97) + 1)) >>> 0;
  }
  return h >>> 0;
}

/** 泵请求窗宽度（core pumpFull 的 FULL_CHUNK=4MiB，saveAs.ts 泵同款） */
const PUMP_CHUNK = 4 * 1024 * 1024;

/** 「零取数」类缺席结论的沉降窗（ms）：口径对齐既有 DL-CONF-01b
 *  （b-save-as.spec.ts:480 的 500ms 显式窗口）——点击往返实测约 37ms、请求下发
 *   约 3ms，500ms 留两个数量级余量。 */
const SETTLE_MS = 500;

// ---------- mini 假 vviewer 服务器（端点集同 b-save-as；加计数面 + 500 形态） ----------

interface FileReqRec {
  /** Range 请求头原文（null = 无 Range 的整对象读） */
  range: string | null;
  /** 请求到达时刻（仅供调试；顺序结论不用它——跨进程时刻比对不复用） */
  t: number;
}

interface FakeVVOpts {
  /** /api/tree 条目声明体量（与实际字节脱钩 → 免真传大体积的确认门形态） */
  treeSize?: number;
  /** /api/tree 条目省略 size（FileSource.size null = 不定态形态） */
  omitTreeSize?: boolean;
  /** 每块响应延时（ms）：慢泵形态，进度卡/取消观察窗 */
  chunkDelayMs?: number;
  /** /api/file 强制状态码（500 = 读失败 → 错误卡片） */
  fileStatus?: number;
}

interface FakeVV {
  base: string;
  fileRequests: FileReqRec[];
  close(): Promise<void>;
}

async function startFakeVV(fileName: string, bytes: Uint8Array, opts: FakeVVOpts = {}): Promise<FakeVV> {
  const fileRequests: FileReqRec[] = [];
  const server = http.createServer((req, res) => {
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
      if (opts.omitTreeSize !== true) {
        entry.size = opts.treeSize !== undefined ? opts.treeSize : bytes.length;
      }
      res.end(JSON.stringify({ entries: [entry] }));
      return;
    }
    if (url.pathname === '/api/count') {
      // 取数计数面（顺序断言用）：页内 picker 桩在返回句柄前读一次 → 「选定目标时
      // 取数计数」= 目标先选、传输后启的单源判据（不依赖跨进程时刻比对）
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ n: fileRequests.length }));
      return;
    }
    if (url.pathname === '/api/file') {
      fileRequests.push({ range: req.headers.range ?? null, t: Date.now() });
      if (opts.fileStatus !== undefined && opts.fileStatus >= 400) {
        res.writeHead(opts.fileStatus, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'e2e 强制失败' }));
        return;
      }
      const range = req.headers.range ?? null;
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      const start = m !== null ? Math.min(Number(m[1]), Math.max(bytes.length - 1, 0)) : 0;
      const end = m !== null && m[2] !== undefined && m[2] !== '' ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
      const chunk = bytes.subarray(start, end + 1);
      const write = (): void => {
        res.writeHead(m !== null ? 206 : 200, {
          ...cors,
          'Content-Type': 'application/octet-stream',
          ...(m !== null ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
          'Content-Length': String(chunk.length)
        });
        res.end(chunk);
      };
      if (opts.chunkDelayMs !== undefined && opts.chunkDelayMs > 0) {
        setTimeout(write, opts.chunkDelayMs);
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
    close: async () => {
      server.close();
      server.closeAllConnections();
    }
  };
}

// ---------- 会话预置（旧键 'tabs' 快照恢复；来源 storeId = remote:hash8(base:label)） ----------

interface SeedTab {
  path: string;
  name: string;
  size?: number;
  active?: boolean;
}

async function seedRemoteTabs(page: Page, opts: { base: string; tabs: SeedTab[] }): Promise<void> {
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

/** 确认阈值改小（settings 落 localStorage 'vviewer:settings'；loadSettings 每轮现算，
 *  门评估即时生效——settings.ts normalizeSettings 对缺省节补默认，局部覆盖合法） */
async function seedConfirmThresholdMb(page: Page, mb: number): Promise<void> {
  await page.addInitScript((v) => {
    const key = 'vviewer:settings';
    let cur: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) cur = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      cur = {};
    }
    cur.storage = { ...(cur.storage as Record<string, unknown> | undefined), remoteDownloadConfirmMb: v };
    localStorage.setItem(key, JSON.stringify(cur));
  }, mb);
}

/** 运行期下调确认阈值（页内直写 localStorage；随后的渲染 effect 重跑即按新值评估门） */
async function setConfirmThresholdMb(page: Page, mb: number): Promise<void> {
  await page.evaluate((v) => {
    const key = 'vviewer:settings';
    let cur: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) cur = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      cur = {};
    }
    cur.storage = { ...(cur.storage as Record<string, unknown> | undefined), remoteDownloadConfirmMb: v };
    localStorage.setItem(key, JSON.stringify(cur));
  }, mb);
}

// ---------- picker 桩 / 无 FS Access 形态 / `<a download>` 兜底记录 ----------

type PickerMode = 'ok' | 'createWritableFails' | 'writeFails' | 'notAllowed';

interface SaveStub {
  calls: { name: string | null }[];
  chunks: number;
  bytes: number;
  closed: number;
  aborted: number;
  createWritableCalls: number;
  writeAttempts: number;
  /** 选定目标（picker resolve）时服务器侧的取数计数（null = 未采；顺序判据用） */
  requestsAtPicker: number | null;
}

/** showSaveFilePicker 桩：记录 suggestedName + 写入块/字节/close/abort 计数。
 *  写入块哈希在页内按「块内下标」累计（与 node 端 byteHashChunked 同算法）。
 *  countUrl 给定时：桩在返回句柄前先读一次服务器侧取数计数 → 顺序判据（目标先选、
 *  传输后启）以计数单源表达，不依赖跨进程时刻比对。 */
async function installPickerStub(
  page: Page,
  mode: PickerMode = 'ok',
  countUrl?: string
): Promise<void> {
  await page.addInitScript(
    (m) => {
      const w = window as unknown as Record<string, unknown> & {
        __vvSave: SaveStub & { hash: number };
      };
      const stub: SaveStub & { hash: number } = {
        calls: [],
        chunks: 0,
        bytes: 0,
        closed: 0,
        aborted: 0,
        createWritableCalls: 0,
        writeAttempts: 0,
        requestsAtPicker: null,
        hash: 0
      };
      w.__vvSave = stub;
      w.showSaveFilePicker = async (o?: { suggestedName?: string }) => {
        stub.calls.push({ name: o?.suggestedName ?? null });
        if (m.countUrl !== undefined) {
          try {
            const res = await fetch(m.countUrl);
            const body = (await res.json()) as { n: number };
            stub.requestsAtPicker = body.n;
          } catch {
            stub.requestsAtPicker = -1; // 计数面不可达：断言会以可见差异红（非假绿）
          }
        }
        if (m.mode === 'notAllowed') {
          // picker 取消/授权拒绝：DOMException 名 NotAllowedError（saveAs.ts:46-55
          // 的 isPickerCancel 分类面）——正确分类即静默 'cancelled'
          throw new DOMException('e2e: 用户取消保存', 'NotAllowedError');
        }
        return {
          createWritable: async () => {
            stub.createWritableCalls += 1;
            if (m.mode === 'createWritableFails') throw new Error('e2e: createWritable 失败');
            return {
              write: async (c: Blob | Uint8Array) => {
                stub.writeAttempts += 1;
                if (m.mode === 'writeFails') throw new Error('e2e: write 失败');
                const buf = c instanceof Blob ? new Uint8Array(await c.arrayBuffer()) : new Uint8Array(c);
                stub.chunks += 1;
                stub.bytes += buf.length;
                for (let i = 0; i < buf.length; i++) stub.hash = (stub.hash + buf[i]! * ((i % 97) + 1)) >>> 0;
              },
              close: async () => {
                stub.closed += 1;
              },
              abort: async () => {
                stub.aborted += 1;
              }
            };
          }
        };
      };
    },
    { mode, countUrl }
  );
}

/** 无 FS Access 形态：遮蔽 window.showSaveFilePicker（Chromium 原生面在安全上下文
 *  下存在，必须显式遮蔽才能到达 saveAsBlob 的 blob URL 兜底路径） */
async function removeFsAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    try {
      delete w.showSaveFilePicker;
    } catch {
      /* 不可删则由 defineProperty 遮蔽 */
    }
    try {
      Object.defineProperty(w, 'showSaveFilePicker', { value: undefined, configurable: true, writable: true });
    } catch {
      /* 遮蔽失败 → 场景断言会红（非假绿） */
    }
  });
}

/** `<a download>` 兜底点击记录（blob URL 形态的落地证据面） */
async function installAnchorRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __vvAnchor: { href: string; download: string }[] };
    w.__vvAnchor = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement): void {
      w.__vvAnchor.push({ href: this.href, download: this.download });
      return orig.call(this);
    };
  });
}

async function saveStubState(page: Page): Promise<SaveStub & { hash: number }> {
  return page.evaluate(() => {
    const s = (window as unknown as { __vvSave: SaveStub & { hash: number } }).__vvSave;
    return { ...s, calls: [...s.calls] };
  });
}

// ---------- 交互小工具 ----------

/** 右键 tab 打开自绘菜单并点「另存为」（第七动作，菜单项 role=menuitem） */
async function clickTabSaveAs(page: Page, tabName: string): Promise<void> {
  await page.locator('.vv-tab', { hasText: tabName }).first().click({ button: 'right' });
  await expect(page.locator('.vv-tabctx')).toBeVisible();
  await page.getByRole('menuitem', { name: '另存为' }).click();
}

/** 点标签页切换（确认作用域键场景用：切走再切回触发渲染 effect 重跑） */
async function clickTab(page: Page, tabName: string): Promise<void> {
  await page.locator('.vv-tab', { hasText: tabName }).first().click();
  await expect(page.locator('.vv-tab.active', { hasText: tabName })).toBeVisible();
}

// ---------- 直连 S3 挂载装置（!rangeCapable 降级形态用；抄 b-mounts-deep MM-13 同款） ----------

/** 跨源 mock 端点的 CORS 响应头（页面 origin :4173 → mock 端口为跨域 fetch） */
const S3_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,depth,x-amz-content-sha256,x-amz-date,range',
  'access-control-allow-methods': 'GET,POST,DELETE,PROPFIND,OPTIONS',
  'access-control-expose-headers': 'content-range,content-length,etag'
};

/** IndexedDB 直写 mounts store 记录（应用首导航建库后调用；免版本 open + 五 store 幂等补建） */
async function seedMountRecord(page: Page, rec: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (r) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer');
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['kv', 'themes', 'fonts', 'mounts', 'iconThemes']) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('mounts', 'readwrite');
      tx.objectStore('mounts').put(r, (r as { id: string }).id);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, rec);
}

/** IndexedDB 直写 kv 'workspaces' 快照（恢复装置：seed 后 reload 走恢复链） */
async function seedWorkspaceSnapshot(page: Page, snap: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (s) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer');
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const st of ['kv', 'themes', 'fonts', 'mounts', 'iconThemes']) {
          if (!d.objectStoreNames.contains(st)) d.createObjectStore(st);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(s, 'workspaces');
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, snap);
}

test.describe('b-save-as-2 另存为管线补强（SAV 域）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('SAV-PROBE-02: 完成态卡「另存为」点击 → 远端重下泵直写盘（字节等值）+ 进度卡复用 + 确认门恒真放行', async ({ page }) => {
    test.setTimeout(180_000);
    const size = 24 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('big.png', png, { chunkDelayMs: 700 });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'big.png', name: 'big.png', size, active: true }
      ]
    });
    // 阈值改 1MB：24MiB > 1MB → 完成态「另存为」必过确认门（hooks.confirm 恒真面）
    await seedConfirmThresholdMb(page, 1);
    await installPickerStub(page);
    // 原生对话框计数：完成态另存为走 hooks.confirm 恒真，不得弹 window.confirm
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto('/');

    // 首开：确认门拦截（24MiB > 1MB）→ 开始下载 → 泵 → 完成态卡
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.locator('.vv-dl-confirm-start').click();
    const done = page.locator('.vv-dl-progress-done');
    await expect(done).toBeVisible({ timeout: 60_000 });
    // 完成态卡 TTL 仅 4s（ViewerPane.svelte:181）→ 卡出现到点击之间只留一次往返：
    // 文案一次性取回（Node 侧断言），随即点击
    const doneText = await done.innerText();
    expect(doneText).toContain('big.png'); // 完成态卡显示源文件名
    expect(doneText).toContain('24.0 MB'); // 完成态卡显示总大小（size 已知证据）

    const readsBefore = srv.fileRequests.length;
    // 完成态「另存为」：saveAsCompleted → saveAsTab 远端路（picker-first → 确认门
    // 恒真 → 重下泵逐块直写盘）
    await done.locator('.vv-dl-progress-saveas').click();
    // 完成态卡与进度卡互斥挂载：完成态先卸载，重下期间进度卡复用出现
    await expect(done).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.vv-dl-progress:not(.vv-dl-progress-done)')).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(async () => (await saveStubState(page)).closed, { timeout: 60_000 })
      .toBe(1);
    const stub = await saveStubState(page);
    expect(stub.calls[0]?.name).toBe('big.png'); // suggestedName = 源文件名
    expect(stub.bytes).toBe(size); // 全量字节落盘
    expect(stub.hash).toBe(byteHashChunked(png, PUMP_CHUNK)); // 逐块校验和等值
    expect(stub.aborted).toBe(0); // 未走 abort 半成品面
    expect(dialogs).toHaveLength(0); // 确认门恒真钩子：不弹原生确认
    expect(srv.fileRequests.length).toBeGreaterThan(readsBefore); // 远端重下确实发生
    await srv.close();
  });

  test('SAV-DONE-CLOSE-01: 完成态卡「关闭」→ 卡片卸载且零新增取数、picker 未调用、已渲染内容未被销毁', async ({ page }) => {
    test.setTimeout(180_000);
    const size = 24 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('big.png', png, { chunkDelayMs: 500 });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'big.png', name: 'big.png', size, active: true }
      ]
    });
    await installPickerStub(page);
    await page.goto('/');

    const done = page.locator('.vv-dl-progress-done');
    await expect(done).toBeVisible({ timeout: 60_000 });
    const readsBefore = srv.fileRequests.length;
    // 已渲染内容的同一性基准（关闭前取；关闭后须保持同一渲染产物，非"仍可见"式恒真）
    const imgSrc = await page.locator('.vv-viewer-host img').getAttribute('src');
    expect(imgSrc).not.toBeNull();
    await done.locator('.vv-dl-progress-close').click();

    await expect(done).toHaveCount(0, { timeout: 10_000 });
    // 零新增取数：显式沉降窗（SETTLE_MS，对齐既有 DL-CONF-01b 口径）后再比对计数
    await page.waitForTimeout(SETTLE_MS);
    expect(srv.fileRequests.length).toBe(readsBefore); // 关闭不触发重下
    const stub = await saveStubState(page);
    expect(stub.calls).toHaveLength(0); // 关闭不触发另存为（picker 未弹）
    // 内容未被销毁重建：同一渲染产物（img src 保持不变）
    await expect(page.locator('.vv-viewer-host img')).toHaveAttribute('src', imgSrc!);
    await srv.close();
  });

  test('SAV-CANCEL-PUMP-01: 完成态重下中点「取消」→ 只断本次重下泵（半成品 abort、取数停增、渲染实例存活）', async ({ page }) => {
    test.setTimeout(180_000);
    const size = 24 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('big.png', png, { chunkDelayMs: 700 });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'big.png', name: 'big.png', size, active: true }
      ]
    });
    await installPickerStub(page);
    // 原生对话框计数：泵取消落 abort 身份 → 静默收场，不得弹任何原生对话框
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto('/');

    const done = page.locator('.vv-dl-progress-done');
    await expect(done).toBeVisible({ timeout: 60_000 });
    await done.locator('.vv-dl-progress-saveas').click();
    // 重下期间进度卡出现（自持 pumpAbort 路径：卡上「取消」只断本次重下泵）
    await expect(page.locator('.vv-dl-progress:not(.vv-dl-progress-done)')).toBeVisible({ timeout: 20_000 });
    const readsAtCancel = srv.fileRequests.length;
    await page.locator('.vv-dl-progress:not(.vv-dl-progress-done) .vv-dl-progress-cancel').click();

    await expect(page.locator('.vv-dl-progress')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await saveStubState(page)).aborted, { timeout: 30_000 }).toBe(1);
    const stub = await saveStubState(page);
    expect(stub.closed).toBe(0); // 半成品不落盘（abort 面）
    // 判别证据：取数停增——重下泵确实被断（若取消句柄错挂到 effectAbort，泵会继续
    // 跑到结束并 close 落盘，本断言即红）
    await page.waitForTimeout(SETTLE_MS);
    expect(srv.fileRequests.length).toBe(readsAtCancel);
    // 取消只断重下泵，不动渲染 effect 的取消句柄 → 已渲染内容存活（护栏项：
    // 取消前渲染早已收束，本条不单独判别两种句柄，判别证据是上面的 abort/close
    // 计数与取数停增）
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    // 泵取消落 abort 身份 → 静默收场，不落「另存为失败」状态条
    expect(dialogs).toHaveLength(0);
    await expect(page.getByText('另存为失败')).toHaveCount(0);
    await srv.close();
  });

  test('SAV-CANCEL-RENDER-01: 渲染 effect 路进度卡「取消」→ 泵中止（取数停增）、无错误卡、无渲染产出', async ({ page }) => {
    test.setTimeout(180_000);
    const size = 24 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('big.png', png, { chunkDelayMs: 700 });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'big.png', name: 'big.png', size, active: true }
      ]
    });
    await page.goto('/');

    const card = page.locator('.vv-dl-progress:not(.vv-dl-progress-done)');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.locator('.vv-dl-progress-cancel').click();
    await expect(page.locator('.vv-dl-progress')).toHaveCount(0, { timeout: 15_000 });

    // 取数停增：取消后再等沉降窗（> 单块延时 700ms，泵若仍在跑必有新请求到达）
    const afterCancel = srv.fileRequests.length;
    await page.waitForTimeout(SETTLE_MS * 5);
    expect(srv.fileRequests.length).toBe(afterCancel);
    // 取消不是读失败：静默面（无错误卡），且被丢弃的渲染不产出内容
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await expect(page.locator('.vv-viewer-host img')).toHaveCount(0, { timeout: 10_000 });
    // 取消后不出现完成态卡（下载确未完成）
    await expect(page.locator('.vv-dl-progress')).toHaveCount(0);
    await srv.close();
  });

  test('SAV-PICKER-CANCEL-01: picker 抛 NotAllowedError（用户取消）→ 静默 cancelled：零写入、零取数、状态条无失败提示', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'mid.png', name: 'mid.png', size, active: true }
      ]
    });
    await installPickerStub(page, 'notAllowed');
    await page.goto('/');
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });

    const readsBefore = srv.fileRequests.length;
    await clickTabSaveAs(page, 'mid.png');
    // picker 被调 1 次（用户取消点在选目标处）
    await expect.poll(async () => (await saveStubState(page)).calls.length, { timeout: 20_000 }).toBe(1);
    const stub = await saveStubState(page);
    // 零写入：取消发生在选目标处 → 未开启 writable、未写、未 close/abort
    expect(stub.createWritableCalls).toBe(0);
    expect(stub.chunks).toBe(0);
    expect(stub.bytes).toBe(0);
    expect(stub.closed).toBe(0);
    expect(stub.aborted).toBe(0);
    // 零取数：确认门/泵均未启动（沉降窗口径同 DL-CONF-01b）
    await page.waitForTimeout(SETTLE_MS);
    expect(srv.fileRequests.length).toBe(readsBefore);
    // 静默：isPickerCancel 分类命中 → saveAsTab 返回 'cancelled'，TabBar 的 .catch
    // 不落「另存为失败」状态条（分类被破坏即红）
    await expect(page.getByText('另存为失败')).toHaveCount(0);
    await srv.close();
  });

  test('SAV-NOFSA-CONF-01: 无 FS Access 环境确认卡 → 「下载并另存为」按钮缺席（降级为普通下载路径）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'mid.png', name: 'mid.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await removeFsAccess(page);
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'mid.png');
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    // 降级契约：确认卡在场但双形态二按钮不渲染（canFsSave 探测装配门）
    await expect(confirm.locator('.vv-dl-confirm-start')).toBeVisible();
    await expect(confirm.locator('.vv-dl-confirm-cancel')).toBeVisible();
    await expect(confirm.locator('.vv-dl-confirm-saveas')).toHaveCount(0);
    // 降级后的普通下载路径照常可用（开始下载 → 进度卡 → 内容渲染）
    await confirm.locator('.vv-dl-confirm-start').click();
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });
    await srv.close();
  });

  test('SAV-NOFSA-01: 无 FS Access 环境远端另存为 → blob URL + `<a download>` 兜底（取数先于落盘）', async ({ page }) => {
    test.setTimeout(120_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'mid.png', name: 'mid.png', size, active: true }
      ]
    });
    await removeFsAccess(page);
    await installAnchorRecorder(page);
    await page.goto('/');
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });

    const readsBefore = srv.fileRequests.length;
    await clickTabSaveAs(page, 'mid.png');
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __vvAnchor: unknown[] }).__vvAnchor.length)), { timeout: 30_000 }).toBe(1);
    const anchors = await page.evaluate(() => (window as unknown as { __vvAnchor: { href: string; download: string }[] }).__vvAnchor);
    const rec = anchors[0]!;
    expect(rec.href.startsWith('blob:')).toBe(true); // 兜底面 = blob URL
    expect(rec.download).toBe('mid.png'); // 下载文件名 = 源文件名
    // 取数先于落盘（降级面形态）：blob 体携带的是**已读全的源字节**——字节数与
    // 校验和等值即证明取数在兜底落地前已完成（不依赖跨进程时刻比对）
    const blob = await page.evaluate(async (href) => {
      const res = await fetch(href);
      const buf = new Uint8Array(await res.arrayBuffer());
      let h = 0;
      for (let i = 0; i < buf.length; i++) h = (h + buf[i]! * ((i % 97) + 1)) >>> 0;
      return { len: buf.length, hash: h >>> 0 };
    }, rec.href);
    expect(blob.len).toBe(size);
    expect(blob.hash).toBe(byteHashChunked(png, PUMP_CHUNK));
    // 取数确实发出（远端面走了读通道）
    expect(srv.fileRequests.length).toBeGreaterThan(readsBefore);
    // 无 FS Access 面不得出现 picker 调用（装置自证：确在无 FS Access 形态）
    expect(await page.evaluate(() => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker)).toBe('undefined');
    await srv.close();
  });

  test('SAV-PICKER-FIRST-01: 远端 + FS Access 另存为 → 目标先选、传输后启（服务器侧取数计数单源判据）', async ({ page }) => {
    test.setTimeout(120_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'mid.png', name: 'mid.png', size, active: true }
      ]
    });
    // 计数面：picker 桩返回句柄前先读一次服务器侧取数计数
    await installPickerStub(page, 'ok', `${srv.base}/api/count`);
    await page.goto('/');
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });

    const countBefore = srv.fileRequests.length;
    await clickTabSaveAs(page, 'mid.png');
    await expect.poll(async () => (await saveStubState(page)).closed, { timeout: 30_000 }).toBe(1);

    const stub = await saveStubState(page);
    // 判别证据：选定目标时服务器侧取数计数 == 另存为前计数 → 传输在目标选定之后
    // 才启动（残余 A2 picker-first 形态；旧形态「先取数后选目标」会 > 该计数）
    expect(stub.requestsAtPicker).toBe(countBefore);
    expect(stub.calls[0]?.name).toBe('mid.png'); // suggestedName = 源文件名
    expect(stub.closed).toBe(1); // 另存为完成（字节等值面见既有 SA-01，本域不重复）
    expect(stub.bytes).toBe(size); // 全量字节确实落盘
    await srv.close();
  });

  test('SAV-CONF-EQ-01: 确认门等界不触发（size 恰等阈值 → 无确认卡、下载照常、size 已知有据）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 1024 * 1024; // 恰等 1MB 阈值（严格 > 才确认，严比较）
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('eq.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'eq.png', name: 'eq.png', size, active: true }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await page.goto('/');

    // 等渲染完成这一稳定在场信号，再判确认卡缺席（避免把「慢」误判成「无门」）
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-dl-confirm')).toHaveCount(0);
    expect(srv.fileRequests.length).toBeGreaterThan(0); // 门未拦截：下载照常发生
    // size 已知的有据形态：完成态卡回显总大小（1048576 字节 = 1.0 MB）——缺席断言
    // 不可分辨「恰等阈值」与「size 未知」，此行把 size 钉在已知面上
    await expect(page.locator('.vv-dl-progress-done .vv-dl-progress-loaded')).toContainText('共 1.0 MB', { timeout: 20_000 });
    await srv.close();
  });

  test('SAV-CONF-EQ-CTRL-01: 等界不触发的差分对照（同一已知 size 载体：阈值 2MB 无卡 → 降为 1MB 即出卡）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024; // 恰等 2MB 阈值
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('eq.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'eq.png', name: 'eq.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 2);
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'eq.png');
    // 阈值 2MB == size 2MiB → 门不触发，下载照常
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-dl-confirm')).toHaveCount(0);
    // size 已知有据：完成态卡回显总大小
    await expect(page.locator('.vv-dl-progress-done .vv-dl-progress-loaded')).toContainText('共 2.0 MB', { timeout: 20_000 });

    // 差分对照：同一已知 size 载体，把阈值下调到 1MB 并重跑渲染 effect → 门如期触发
    await setConfirmThresholdMb(page, 1);
    await clickTab(page, 'e2e-fake');
    await clickTab(page, 'eq.png');
    await expect(page.locator('.vv-dl-confirm')).toBeVisible({ timeout: 20_000 });
    await srv.close();
  });

  test('SAV-CONF-UNKNOWN-01: 确认门 size 未知不触发（无前置数字 → 无确认卡、不定态下载照常）', async ({ page }) => {
    test.setTimeout(150_000);
    const png = makePngOfExactSize(2 * 1024 * 1024);
    const srv = await startFakeVV('mystery.png', png, { omitTreeSize: true });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'mystery.png', name: 'mystery.png', active: true } // 快照不带 size → FileSource.size null
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await page.goto('/');

    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-dl-confirm')).toHaveCount(0);
    expect(srv.fileRequests.length).toBeGreaterThan(0);
    await srv.close();
  });

  test('SAV-CONF-LOCAL-01: 确认门不拦本地来源（本地 2MiB 文件 > 1MB 阈值 → 无确认卡、直接渲染）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024; // 本地 File 体量已知且 > 阈值（1MB）
    const png = makePngOfExactSize(size);
    await seedConfirmThresholdMb(page, 1);
    await waitAppMounted(page);
    await openDirBytes(page, 'localgrp', 'local.png', new Uint8Array(png));
    await openFile(page, 'local.png');
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    // 本地来源（L1/L2/L3）不进确认门：体量已知且超阈值仍无确认卡
    await expect(page.locator('.vv-dl-confirm')).toHaveCount(0);
  });

  test('SAV-CONF-KEY-01: 确认作用域键「同键不再问」（确认后切走再切回 → 不再出现确认卡）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'mid.png', name: 'mid.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'mid.png');
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.locator('.vv-dl-confirm-start').click();
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });
    const readsAfterConfirm = srv.fileRequests.length;

    // 切走再切回：同 storeId/path/size → 同确认作用域键 → 不再打扰
    await clickTab(page, 'e2e-fake');
    await clickTab(page, 'mid.png');
    await expect.poll(() => srv.fileRequests.length, { timeout: 30_000 }).toBeGreaterThan(readsAfterConfirm);
    await expect(confirm).toHaveCount(0); // 同键不再问
    await srv.close();
  });

  test('SAV-CONF-KEY-02: 确认作用域键「取消后重问」（取消 → 切走再切回 → 确认卡重现）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'mid.png', name: 'mid.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'mid.png');
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.locator('.vv-dl-confirm-cancel').click();
    await expect(confirm).toHaveCount(0);
    // 零取数（沉降窗口径同 DL-CONF-01b：点击往返时延不足以证伪，故给显式窗口）
    await page.waitForTimeout(SETTLE_MS);
    expect(srv.fileRequests).toHaveLength(0); // 取消静默中止：泵未启动

    // 取消不登记确认键 → 同文件下次渲染重问
    await clickTab(page, 'e2e-fake');
    await clickTab(page, 'mid.png');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(SETTLE_MS);
    expect(srv.fileRequests).toHaveLength(0); // 重问期间泵仍未启动
    await srv.close();
  });

  test('SAV-MENU-CONF-01: 菜单路远端超阈值 → window.confirm 拒绝 = 零取数、目标文件零触碰', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'mid.png', name: 'mid.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await installPickerStub(page);
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'mid.png');
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.locator('.vv-dl-confirm-start').click();
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });
    const readsBefore = srv.fileRequests.length;

    // 菜单路另存为：超阈值 → window.confirm 钩子（拒绝）
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss(); // 拒绝
    });
    await clickTabSaveAs(page, 'mid.png');
    await expect.poll(() => dialogs.length, { timeout: 30_000 }).toBe(1);
    expect(dialogs[0]).toContain('mid.png');
    expect(dialogs[0]).toContain('超过远端下载确认阈值');

    await expect.poll(async () => (await saveStubState(page)).calls.length, { timeout: 20_000 }).toBe(1);
    const stub = await saveStubState(page);
    expect(stub.createWritableCalls).toBe(0); // 拒绝后不写盘（目标文件零触碰）
    expect(stub.chunks).toBe(0);
    expect(stub.closed).toBe(0);
    expect(stub.aborted).toBe(0);
    // 零取数：确认门拒绝即 cancelled（read 未启动）；显式沉降窗（DL-CONF-01b 口径）
    await page.waitForTimeout(SETTLE_MS);
    expect(srv.fileRequests.length).toBe(readsBefore);
    await srv.close();
  });

  test('SAV-MENU-CONF-02: 菜单路远端超阈值 → window.confirm 接受 → 落盘字节等值', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'mid.png', name: 'mid.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await installPickerStub(page);
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'mid.png');
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.locator('.vv-dl-confirm-start').click();
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });

    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept(); // 接受
    });
    await clickTabSaveAs(page, 'mid.png');
    await expect.poll(() => dialogs.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await saveStubState(page)).closed, { timeout: 60_000 }).toBe(1);

    const stub = await saveStubState(page);
    expect(stub.calls[0]?.name).toBe('mid.png');
    expect(stub.bytes).toBe(size);
    expect(stub.hash).toBe(byteHashChunked(png, PUMP_CHUNK));
    expect(stub.aborted).toBe(0);
    await srv.close();
  });

  test('SAV-MENU-STATUS-01: 菜单路状态条反馈面（远端另存为：开始提示 → 完成提示）', async ({ page }) => {
    test.setTimeout(180_000);
    const size = 12 * 1024 * 1024; // 3 块泵窗（逐块延时 500ms → 另存为耗时 ~1.5s，
    // 保证「开始拉取」提示在完成提示出现前可被观测）
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('big.png', png, { chunkDelayMs: 500 });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: false },
        { path: 'big.png', name: 'big.png', size, active: true }
      ]
    });
    await installPickerStub(page);
    await page.goto('/');
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });

    // 菜单路：远端另存为 → 状态条先落「正在拉取全量以另存为…」，完成后落「已另存为 …」
    await clickTabSaveAs(page, 'big.png');
    await expect(page.locator('.vv-statusbar')).toContainText('正在拉取全量以另存为…', { timeout: 20_000 });
    await expect(page.locator('.vv-statusbar')).toContainText('已另存为 big.png', { timeout: 60_000 });
    await srv.close();
  });

  test('SAV-DISABLED-DIR-01: 「另存为」置灰面——目录 tab（path 为空）菜单项 aria-disabled 且点击零动作', async ({ page }) => {
    test.setTimeout(120_000);
    const png = makePngOfExactSize(1024);
    const srv = await startFakeVV('x.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'x.png', name: 'x.png', size: png.length, active: false }
      ]
    });
    await installPickerStub(page);
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await page.locator('.vv-tab.active', { hasText: 'e2e-fake' }).click({ button: 'right' });
    const menu = page.locator('.vv-tabctx');
    await expect(menu).toBeVisible();
    const item = page.getByRole('menuitem', { name: '另存为' });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await item.click({ force: true }); // 置灰守卫：不动作、菜单留守
    await expect(menu).toBeVisible();
    expect((await saveStubState(page)).calls).toHaveLength(0);
    await srv.close();
  });

  test('SAV-DISABLED-ERR-01: 「另存为」置灰面——错误卡片 tab（渲染失败）菜单项 aria-disabled 且点击零动作', async ({ page }) => {
    test.setTimeout(120_000);
    const png = makePngOfExactSize(1024);
    const srv = await startFakeVV('broken.png', png, { fileStatus: 500 });
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [{ path: 'broken.png', name: 'broken.png', size: png.length, active: true }]
    });
    await installPickerStub(page);
    await page.goto('/');

    // 读失败 → 错误卡片（lastRendererId='error' 标记写入）
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vv-tab.active', { hasText: 'broken.png' }).click({ button: 'right' });
    const menu = page.locator('.vv-tabctx');
    await expect(menu).toBeVisible();
    const item = page.getByRole('menuitem', { name: '另存为' });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await item.click({ force: true });
    await expect(menu).toBeVisible();
    expect((await saveStubState(page)).calls).toHaveLength(0);
    await srv.close();
  });

  test('SAV-DEGRADE-WRITABLE-01: tee 直写开启失败 → 状态条降级提示 + 内容照常渲染（字节不丢）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'mid.png', name: 'mid.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await installPickerStub(page, 'createWritableFails');
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'mid.png');
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.locator('.vv-dl-confirm-saveas').click();

    // 状态条降级告知（一次性提示，TTL 4s → 轮询捕获）
    await expect(page.locator('.vv-statusbar')).toContainText('已降级为普通下载', { timeout: 20_000 });
    // 内容照常渲染（普通下载路径未受影响）
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });
    const stub = await saveStubState(page);
    expect(stub.createWritableCalls).toBe(1); // 开启确实尝试过（失败在开启面）
    expect(stub.closed).toBe(0);
    expect(stub.aborted).toBe(0); // 无 writable → 无半成品面
    await srv.close();
  });

  test('SAV-DEGRADE-WRITE-01: tee 直写写失败 → abort 半成品（不落盘）+ 字节流照常交付（内容渲染）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    const srv = await startFakeVV('mid.png', png);
    await seedRemoteTabs(page, {
      base: srv.base,
      tabs: [
        { path: '', name: 'e2e-fake', active: true },
        { path: 'mid.png', name: 'mid.png', size, active: false }
      ]
    });
    await seedConfirmThresholdMb(page, 1);
    await installPickerStub(page, 'writeFails');
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    await clickTab(page, 'mid.png');
    const confirm = page.locator('.vv-dl-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.locator('.vv-dl-confirm-saveas').click();

    await expect.poll(async () => (await saveStubState(page)).aborted, { timeout: 60_000 }).toBe(1);
    const stub = await saveStubState(page);
    expect(stub.writeAttempts).toBeGreaterThan(0); // 写失败确实发生在写面
    expect(stub.closed).toBe(0); // 写失败 → 半成品 abort，不 close 落盘
    // 写失败不回灌取数主路：字节流照常交付 → 内容渲染出现
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 60_000 });
    await srv.close();
  });

  test('SAV-LOCAL-NOFSA-01: 在手/归档面（本地文件）另存为在无 FS Access 环境 → blob URL 兜底（字节等值）', async ({ page }) => {
    test.setTimeout(120_000);
    const size = 2 * 1024 * 1024;
    const png = makePngOfExactSize(size);
    await removeFsAccess(page); // 必须在首次导航前遮蔽原生 FS Access 面
    await installAnchorRecorder(page);
    await waitAppMounted(page);
    await openDirBytes(page, 'localgrp', 'local.png', new Uint8Array(png));
    await openFile(page, 'local.png');
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });

    // 本地分支（saveAs.ts:308-312：store.read 单次全量 → saveAsBlob）→ 无 picker →
    // blob URL + `<a download>` 兜底
    await clickTabSaveAs(page, 'local.png');
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __vvAnchor: unknown[] }).__vvAnchor.length)), { timeout: 30_000 }).toBe(1);
    const anchors = await page.evaluate(() => (window as unknown as { __vvAnchor: { href: string; download: string }[] }).__vvAnchor);
    const rec = anchors[0]!;
    expect(rec.href.startsWith('blob:')).toBe(true);
    expect(rec.download).toBe('local.png');
    const blob = await page.evaluate(async (href) => {
      const res = await fetch(href);
      const buf = new Uint8Array(await res.arrayBuffer());
      let h = 0;
      for (let i = 0; i < buf.length; i++) h = (h + buf[i]! * ((i % 97) + 1)) >>> 0;
      return { len: buf.length, hash: h >>> 0 };
    }, rec.href);
    expect(blob.len).toBe(size);
    expect(blob.hash).toBe(byteHashChunked(png, PUMP_CHUNK));
    // 本地来源不触发进度卡/确认门（本地面无远端泵）
    await expect(page.locator('.vv-dl-confirm')).toHaveCount(0);
    await expect(page.locator('.vv-dl-progress')).toHaveCount(0);
  });

  test('SAV-NORANGE-01: 远端 !rangeCapable 降级形态（直连 S3 无视 Range）→ 另存为走单次全量读（不带 Range 头）', async ({ page }) => {
    test.setTimeout(150_000);
    const size = 1024 * 1024; // ≤ dispatcher FULL_LIMIT（1MiB）→ 单次全量读形态
    const png = makePngOfExactSize(size);
    const endpoint = 'http://127.0.0.1:9077';
    const bucket = 'e2ebkt';
    const recId = `s3direct:${hash8(['s3', endpoint, bucket, '', 'path'].join('\u{1f}'))}`;
    // 直连端点 mock：Range 请求一律回 200 + 全量 body（S3 的 Range 防线降级形态）
    // → store.rangeCapable 由 true 转 false → saveAs 走单次全量读分支
    const objectReads: { range: string | null }[] = [];
    await page.route('**127.0.0.1:9077/**', (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        return void route.fulfill({ status: 200, headers: S3_CORS, body: '' });
      }
      const url = new URL(req.url());
      if (url.searchParams.has('list-type')) {
        return void route.fulfill({
          status: 200,
          headers: { ...S3_CORS, 'content-type': 'application/xml' },
          body:
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            `<Contents><Key>a.png</Key><Size>${size}</Size></Contents></ListBucketResult>`
        });
      }
      if (url.pathname.endsWith('/a.png')) {
        objectReads.push({ range: req.headers().range ?? null });
        return void route.fulfill({
          status: 200,
          headers: { ...S3_CORS, 'content-type': 'application/octet-stream' },
          body: png
        });
      }
      return void route.fulfill({ status: 404, headers: S3_CORS, body: 'not found' });
    });
    await installPickerStub(page);
    await page.goto('/');
    await seedMountRecord(page, {
      id: recId,
      kind: 'direct',
      backend: 's3',
      label: 'e2e-s3',
      endpoint,
      bucket,
      prefix: '',
      username: 'AK',
      secret: 'SK',
      createdAt: 1700000000000
    });
    await seedWorkspaceSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: 'e2e-s3' }],
          tabs: [
            {
              id: 't1',
              storeId: recId,
              storeLabel: 'e2e-s3',
              path: 'a.png',
              name: 'a.png',
              kind: 'rename-only',
              scrollTop: 0,
              size,
              active: true
            }
          ],
          activeTabId: 't1'
        }
      ]
    });
    await page.reload();

    // 首开渲染：head/全量读发出 Range 头 → 端点回 200 → Range 防线降级（rangeCapable=false）
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    expect(objectReads.length).toBeGreaterThan(0);
    expect(objectReads[0]!.range).not.toBeNull(); // 首读是带窗读

    const readsBefore = objectReads.length;
    await clickTabSaveAs(page, 'a.png');
    await expect.poll(async () => (await saveStubState(page)).closed, { timeout: 30_000 }).toBe(1);

    // 降级分支：单次全量读（不带 Range 头）——泵的 N 窗循环会把传输放大 N 倍，故
    // 非 range 来源回落单次 read
    const saveReads = objectReads.slice(readsBefore);
    expect(saveReads).toHaveLength(1);
    expect(saveReads[0]!.range).toBeNull();
    const stub = await saveStubState(page);
    expect(stub.bytes).toBe(size);
    expect(stub.hash).toBe(byteHashChunked(png, PUMP_CHUNK));
    expect(stub.aborted).toBe(0);
  });
});
