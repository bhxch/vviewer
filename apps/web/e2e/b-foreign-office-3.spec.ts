import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Download, type Page, type Route } from '@playwright/test';
import JSZip from 'jszip';
import { hash8 } from '@bhxch/vviewer-core';
import { injectDir, openTreeFile, PIXEL_PNG_B64 } from './b-markdown-html-docs-helpers';
import { tabNamed } from './helpers';
import { openSettings, gotoGroup, applySettings, closeSettings } from './settings-center';

/**
 * b-foreign-office-3 —— file-viewer 桥接渲染器的「跨边界」e2e 锚（FOM 域）。
 *
 * 被测面：apps/web/src/lib/foreignRenderers.ts 装配的 20 组桥接渲染器
 * （id foreign-<group>）与 packages/vviewer-render-foreign/src/bridge.ts 的
 * 嵌套契约、apps/web/src/lib/viewer.ts:93-118 的 foreignNestedDispatch 分派链。
 *
 * 场景（编号全局唯一，登记于 docs/e2e/file-viewer-foreign-bridge.md）：
 * - FOM-NEST-01  eml 内嵌 pdf 附件经 renderNestedBuffer 交回 vviewer 派发器，
 *                 落 vviewer 自有 pdf 面（不是 foreign 引擎面，也不是 hex/code 面）；
 * - FOM-NEST-02  派发器无 byExtension 命中的嵌套附件落 blob 下载兜底（不落错误卡），
 *                 落盘字节与注入负载逐字节等值，且落盘名恢复为附件原名（FOM-EX-08）；
 * - FOM-NEST-03  嵌套深度限 3 生效——第 4 层附件不再入派发器，落下载兜底；
 * - FOM-NEST-04  嵌套附件「有渲染器但渲染失败」：坏 PDF → 错误卡落在 nested target
 *                 内（宿主顶层不落错误卡）、零下载兜底；
 * - FOM-NEST-05  嵌套附件走其它 vviewer 自有扩展名：png → 自有 image 面、
 *                 docx → 自有 docx 面（spec §6.4「pdf/image/docx 等 vviewer 本地强项」）；
 * - FOM-REMOTE-01 foreign 扩展名走远端（R1）时按非流式全量物化：>1MB 形态 =
 *                 8KB head 探测 + 全量窗两请求（单窗/全量由 streaming 声明决定），
 *                 完成后由桥接引擎接管宿主且拿到全量字节；
 * - FOM-CONFIRM-01 foreign 扩展名的远端大文件进确认门，确认后泵全量物化
 *                 （head 探测 + 全量窗两请求）并由桥接引擎接管宿主；
 * - FOM-ZIP-01   压缩包条目点击开新 tab，条目字节按扩展名派发到 foreign 桥接管；
 * - FOM-CDN-01   CDN 资产不可达时跨域 worker 引导失败被收口成错误卡（不悬挂），
 *                 且失败归因可由被拦截的资产 URL 指纹判定。
 * - FOM-SHP-01   裸单文件 .shp（single: 来源）落降级错误卡：提示补齐 .shx/.dbf/
 *                 .prj 边车（spec §6.4「裸单文件维持降级错误卡」），geo 引擎壳缺席、
 *                 错误卡三动作在；对照面：同通道注入 .geojson（单文件自足格式）
 *                 照常渲染 .geo-viewer——拦截是扩展名特异而非通道特异。
 *
 * 内容级断言纪律（本域首轮返工要点，务必守住）：
 * `.email-viewer` 容器可见**不证明邮件渲染成功**——上游先建 root 再解析
 * （renderer-email dist email.js:252 `target.replaceChildren(style, root)`），
 * 解析不出内容的邮件同样是「`.email-viewer` 可见 + 零 code/hex + 零错误卡」。
 * 故每个 foreign 出图锚都另钉**内容级**信号：`.email-header h2` 的 Subject 文本、
 * `.email-meta` 的 From 文本、`.email-error` 计数 0、附件项存在且体积标签正确。
 *
 * 装置全部自建在本文件内（不抽公共 helper 文件，避免与其他域并行写文件冲突）：
 * - MIME 合成器：RFC822/multipart 邮件（正文段 + base64 附件段，76 列折行）——
 *   零语料依赖，attachments 的 filename/content 经 postal-mime 实跑核过；
 * - mini 假 vviewer 服务器（127.0.0.1，/api/health|tree|file|ticket/events，
 *   file 端点按 Range 回 206 + Content-Range 切片）+ IndexedDB 'tabs' 快照预置；
 * - 下载捕获器：page 'download' 事件（blob 兜底通道 <a download> 点击）；
 * - 单文件注入通道（FOM-SHP-01）：合成 DataTransfer drop → openFiles 单文件
 *   通道（single: 来源）——与 injectDir 的目录注入通道（localfiles 来源）互斥，
 *   「裸单文件」形态只有这条通道造得出来。
 *
 * 桌面专属（仅 chromium project，b-save-as/b-diagram-file beforeEach 跳过同款）。
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** PDF 负载（仓内样本，620B 真 PDF——嵌套附件渲染面用真 PDF 而非伪字节：
 * 伪字节会在 pdfjs 打开阶段失败，测不出「嵌套附件真渲染」这条语义） */
const PDF_BYTES = readFileSync(join(REPO_ROOT, 'samples/m4/sample.pdf'));

/** DOCX 负载（仓内样本，1787B 最小 OOXML 包——内含文本 'vviewer docx 样例'，
 * 供「嵌套附件落自有 docx 面」的内容级断言） */
const DOCX_BYTES = readFileSync(join(REPO_ROOT, 'samples/m4/sample.docx'));

/** 无 byExtension 命中的附件负载（35B 定长串——落盘字节等值锚的对照基准） */
const MYSTERY_PAYLOAD = Buffer.from('attachment-payload-bytes-0123456789', 'utf8');

/** 坏 PDF 负载（有 pdf 渲染器但内容不可解析——「有渲染器但渲染失败」分支用） */
const BROKEN_PDF_PAYLOAD = Buffer.from('this is definitely not a PDF document, no header here', 'utf8');

/** 真 .shp 文件头 100 字节（file code 999 大端 / version 1000 小端 / shape type 1 点
 * + 64B 空 bbox）。负载内容与断言无关——FOM-SHP-01 拦截发生在任何解析之前，取真
 * 头部只为失败时归因不失真。 */
const SHP_HEADER_B64 = Buffer.from(
  '0000270a' + '00'.repeat(20) + '00000050' + 'e8030000' + '01000000' + '00'.repeat(64),
  'hex'
).toString('base64');

/** 对照面 geojson（单点 FeatureCollection——geo 组单文件自足格式，同 single: 通道
 * 注入应照常渲染，钉死拦截是扩展名特异而非通道特异） */
const GEOJSON_B64 = Buffer.from(
  JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'e2e point' },
        geometry: { type: 'Point', coordinates: [139.6917, 35.6895] }
      }
    ]
  }),
  'utf8'
).toString('base64');

const CRLF = '\r\n';

// ---------- MIME 合成器 ----------

/** base64 76 列折行（MIME 传输编码规范形态——不折行时部分解析器会截断负载） */
function foldBase64(b64: string, width = 76): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += width) out.push(b64.slice(i, i + width));
  return out.join(CRLF);
}

interface EmlPart {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * 合成 RFC822 / multipart-mixed 邮件：From/To/Subject/Date + MIME-Version +
 * Content-Type(boundary) + text/plain 正文段 + 若干 base64 附件段。
 * boundary 必须逐封唯一（嵌套多层时各层各用一枚，避免跨封误匹配）。
 */
function buildEml(opts: { subject: string; boundary: string; parts: EmlPart[] }): Buffer {
  const lines: string[] = [
    'From: FOM Probe <probe@example.invalid>',
    'To: FOM Receiver <receiver@example.invalid>',
    `Subject: ${opts.subject}`,
    'Date: Mon, 02 Jan 2006 15:04:05 -0700',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${opts.boundary}"`,
    '',
    `--${opts.boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'FOM probe body.',
    ''
  ];
  for (const part of opts.parts) {
    lines.push(
      `--${opts.boundary}`,
      `Content-Type: ${part.mimeType}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${part.filename}"`,
      '',
      foldBase64(part.bytes.toString('base64')),
      ''
    );
  }
  lines.push(`--${opts.boundary}--`, '');
  return Buffer.from(lines.join(CRLF), 'utf8');
}

/** 注入合成邮件（b64 直通，type message/rfc822）并打开 */
async function injectAndOpenEml(page: Page, name: string, bytes: Buffer): Promise<void> {
  await injectDir(page, [{ name, content: '', type: 'message/rfc822', b64: bytes.toString('base64') }]);
  await openTreeFile(page, name);
}

// ---------- 单文件注入通道（FOM-SHP-01 装置） ----------

/**
 * 等 openFlow 装配完成（__vvOpenDirImpl 钩子与 openFiles 同模块顶层装配，钩子在即
 * 通道在——injectDir 的等待同款，仅作就绪信号，本装置不走目录通道）。
 */
async function waitDropChannelReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl !== undefined
  );
}

/**
 * 单文件注入（不重载页面，可追加）：页面内构造 File 经合成 DataTransfer 的 drop
 * 事件派发到 window（+page.svelte 的 svelte:window ondrop）→ openFiles 单文件通道
 * → createSingleFileStore（storeId `single:<name>:<size>:<lastModified>`）。
 *
 * 为什么不用既有 injectDir：那是 __vvOpenDirImpl → openDirectoryViaInput 通道，
 * storeId 为 localfiles 形态——「裸单文件」（single: 来源）只有拖拽/文件 picker
 * 单选才造得出来，目录通道原理上到不了。程序化构造的 DataTransfer 条目
 * webkitGetAsEntry() 为 null（entry 仅真实 OS 拖拽存在）→ collectDirectoryFiles
 * 兜 null → 落 e.dataTransfer.files 单文件分支；即便个别内核为合成条目造出 file
 * entry，非目录条目同样兜 null，两分支殊途同归（openFiles）。多个文件一次 drop
 * 时各自成独立 single: tab（后注入者激活）。
 */
async function dropSingleFiles(page: Page, specs: Array<{ name: string; type?: string; b64: string }>): Promise<void> {
  await page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const s of list) {
      const bytes = Uint8Array.from(atob(s.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], s.name, { type: s.type ?? 'application/octet-stream' }));
    }
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, specs);
}

/** 首页加载后注入单文件（首个 single: tab，goto 与就绪等待一次到位） */
async function injectSingleFile(page: Page, spec: { name: string; type?: string; b64: string }): Promise<void> {
  await page.goto('/');
  await waitDropChannelReady(page);
  await dropSingleFiles(page, [spec]);
}

// ---------- 邮件面内容级断言 ----------

/**
 * 邮件面内容级守门：Subject 文本（上游 `.email-header h2` = parsed.subject）、
 * From 文本（`.email-meta`）、内部错误元素 `.email-error` 计数 0。
 * 这三条合起来证明「邮件被真正解析并渲染」，而非仅有一个 `.email-viewer` 空壳。
 */
async function expectMailContent(
  page: Page,
  scope: ReturnType<Page['locator']>,
  opts: { subject: string }
): Promise<void> {
  await expect(scope.locator('.email-header h2')).toHaveText(opts.subject);
  await expect(scope.locator('.email-meta')).toContainText('probe@example.invalid');
  await expect(scope.locator('.email-error')).toHaveCount(0);
}

/** 附件项（按 <strong> 内的文件名锚定；多层嵌套下各层附件名互异不重） */
function attachmentItem(page: Page, filename: string) {
  return page.locator('.attachment-item').filter({ has: page.locator('strong', { hasText: filename }) });
}

/**
 * 附件项体积标签（上游 `<em>` = formatBytes(附件字节数)）——字节级正确性的
 * 内容级信号：附件负载被完整送达（长度即字节数）。
 */
function attachmentSizeLabel(page: Page, filename: string) {
  return attachmentItem(page, filename).locator('em');
}

/**
 * 点击附件项：视口内用常规 click（真手势路径）；深层嵌套项在视口外（邮箱侧栏是
 * 独立滚动容器，且 level4 附件项完全在视口外——真实 click 会被
 * `.attachment-preview-head` 的「Download attachment」按钮与 `.vv-statusbar`
 * 命中测试拦截），改用 dispatchEvent 仅作驱动——驱动后一律用 expect.poll /
 * locator 自动等待等 DOM 更新（「dispatchEvent 不自动等待」陷阱）。
 */
async function clickAttachment(page: Page, filename: string, opts: { dispatch?: boolean } = {}): Promise<void> {
  const item = attachmentItem(page, filename);
  await expect(item).toHaveCount(1);
  if (opts.dispatch === true) await item.dispatchEvent('click');
  else await item.click();
}

/**
 * 等邮件解析完成：上游在解析/渲染期间挂 `.email-state` 加载遮罩（position:absolute
 * 覆盖整个邮件面），常规 click 会被遮罩拦截（hit-target 校验失败）——常规 click 前
 * 必须先确认遮罩撤除。
 */
async function waitEmailIdle(page: Page): Promise<void> {
  await expect(page.locator('.email-state')).toHaveCount(0, { timeout: 60_000 });
}

// ---------- 下载捕获（blob 兜底通道） ----------

interface DownloadCapture {
  list: Download[];
}

/** 捕获 page 'download' 事件（须在触发动作之前挂） */
function captureDownloads(page: Page): DownloadCapture {
  const list: Download[] = [];
  page.on('download', (d) => list.push(d));
  return { list };
}

/** 等首个下载事件落定并回读落盘字节（download.path() 为 null 即未落盘） */
async function firstDownloadBytes(cap: DownloadCapture): Promise<{ filename: string; bytes: Buffer }> {
  await expect
    .poll(() => cap.list.length, { timeout: 30_000, message: '未捕获到下载事件（嵌套附件兜底未触发？）' })
    .toBeGreaterThan(0);
  const dl = cap.list[0];
  expect(dl, '下载事件已发生但取不到实例').toBeDefined();
  const path = await dl!.path();
  expect(path, '下载未落盘（download.path() 为 null）').not.toBeNull();
  return { filename: dl!.suggestedFilename(), bytes: readFileSync(path!) };
}

// ---------- mini 假 vviewer 服务器（R1 远端面） ----------

interface FakeVVServer {
  base: string;
  /** '/api/file' 请求记录：`${path} :: ${rangeHeader ?? '(no-range)'}`（含 git 面板等旁路请求，按 path 过滤） */
  fileRequests: string[];
  close(): Promise<void>;
}

async function startFakeVVServer(files: Record<string, Buffer>): Promise<FakeVVServer> {
  const fileRequests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/tree') {
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const prefix = p === '' ? '' : `${p}/`;
      const entries = Object.keys(files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ name: f.slice(prefix.length), kind: 'file', size: files[f]!.length }));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
      return;
    }
    if (url.pathname === '/api/file') {
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const range = req.headers.range ?? null;
      fileRequests.push(`${p} :: ${range ?? '(no-range)'}`);
      const bytes = files[p];
      if (bytes === undefined) {
        res.writeHead(404, cors);
        res.end('no such file');
        return;
      }
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      const start = m !== null ? Math.min(Number(m[1]), Math.max(bytes.length - 1, 0)) : 0;
      const end =
        m !== null && m[2] !== undefined && m[2] !== '' ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
      const chunk = bytes.subarray(start, end + 1);
      res.writeHead(m !== null ? 206 : 200, {
        ...cors,
        'Content-Type': 'application/octet-stream',
        ...(m !== null ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
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
      return; // SSE 挂起、无数据帧（测试结束统一断连）
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

// ---------- 远端 tab 快照预置 ----------

interface SeedTab {
  path: string;
  name: string;
  size?: number;
  active?: boolean;
}

/**
 * 预置远端来源的 tab 快照（旧键 'tabs'，IndexedDB 'vviewer'/'kv'）——
 * 形态沿 b-save-as.spec.ts:187-223。来源 storeId = remote:<hash8(base:e2e-fake)>
 * （与 createRemoteStore 的 id 派生同口径：hash8(`${base}:${dirLabel}`)，
 * 根 0 且无 basePath 时不带 :r 段）。path==='' 的目录项是必需的——快照的
 * remote 来源只从目录项派生（migrateLegacyTabs 只看 path==='' 的条目）。
 *
 * 竞态说明：写库是异步的，而应用启动时的 restore 会读同一个键。init script 的
 * `indexedDB.open` 请求先于应用脚本发起（init script 在页面任何脚本之前跑），
 * 其写事务先于应用的读事务入队，故 'tabs' 必被 restore 读到——这是 b-save-as
 * 长期沿用的仓内惯例。为便于失败诊断，写库完成后置 `window.__vvSeedReady`，
 * 测试侧等该标志再断言 tab 出现（标志只说明「写库完成」，restore 是否读到位
 * 由 tab 断言判定）。
 */
async function seedRemoteTabs(page: Page, opts: { base: string; tabs: SeedTab[] }): Promise<void> {
  const storeId = `remote:${hash8(`${opts.base}:e2e-fake`)}`;
  await page.addInitScript(
    (seed) => {
      const w = window as unknown as Record<string, unknown>;
      w.__vvSeedReady = false;
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
        tx.oncomplete = () => {
          db.close();
          w.__vvSeedReady = true;
        };
        tx.onerror = () => {
          db.close();
          w.__vvSeedReady = true;
        };
      };
    },
    { base: opts.base, storeId, tabs: opts.tabs }
  );
}

/** 等快照写库完成（诊断用：读不到 tab 时先看这个标志） */
async function waitSeedReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __vvSeedReady?: boolean }).__vvSeedReady === true, undefined, {
    timeout: 30_000
  });
}

// ---------- 设置面板（远端下载确认阈值） ----------

/**
 * 设置中心把「远端下载确认阈值」改为指定 MB（数值输入 onchange 提交——
 * fill 只发 input 事件，须补 Enter 触发 change 使草稿变脏，b-save-as 同款）。
 *
 * 持久化等待：applySettings 只等「应用」钮复位（草稿脏态清除），设置真正落盘
 * （localStorage 'vviewer:settings'）在其后——门若读到旧阈值则确认卡不出现，
 * 故改写后轮询 localStorage 直到阈值生效（阈值读 settings 现值，每轮现算）。
 */
async function setConfirmThreshold(page: Page, mb: string): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, '存储与数据');
  const input = page.getByLabel('远端下载确认阈值（MB）');
  await input.fill(mb);
  await input.press('Enter');
  await applySettings(page);
  await closeSettings(page);
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('vviewer:settings');
          if (raw === null) return null;
          try {
            const v = JSON.parse(raw) as { storage?: { remoteDownloadConfirmMb?: number } };
            return v.storage?.remoteDownloadConfirmMb ?? null;
          } catch {
            return null;
          }
        }),
      { timeout: 15_000, message: '远端下载确认阈值未落盘（门会读到旧阈值）' }
    )
    .toBe(Number(mb));
}

/**
 * 与 apps/web/src/lib/storageHealth.ts:260 formatBytes 同口径的字节格式化
 * （确认卡体积与附件项体积标签的期望值由此算出——不写死 '1.4 MB' 之类字面量，
 * 避免夹具体量一变即假红）。
 */
function formatBytesLike(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** 静默窗（请求序列类断言的护栏）：等一段窗口让「迟到的下一条请求」落定，
 *  再复断言条数——否则第 N+1 条请求晚于断言到达时，序列断言假绿
 *  （DL-CONF-01b 的 500ms 静默窗同款思路，本域取 1s） */
async function settleWindow(page: Page, ms = 1000): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * 完成态下载卡断言（可打红形态，单次原子快照）：
 * - `.vv-dl-progress-title` 文本 = 「下载完成」（下载中形态为「正在下载」）；
 * - `.vv-dl-progress-cancel` 计数 0（下载中卡才有「取消」钮）；
 * - `.vv-dl-progress-saveas` 计数 1（完成态卡才有「另存为」钮）；
 * - `.vv-dl-progress-address` 文本 = 文件名。
 * 四条随「卡形态」变化而变红，替代此前结构性恒真的「进度卡计数」写法。
 *
 * TTL 处置：完成态卡 TTL 仅 4s（ViewerPane.svelte:181），逐条 locator 断言在
 * TTL 边界会抖红——故用一次 evaluate 取全量快照 + expect.poll 等待其出现。
 */
async function expectDoneCard(page: Page, fileName: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const card = document.querySelector('.vv-dl-progress-done');
          if (card === null) return null;
          return {
            title: card.querySelector('.vv-dl-progress-title')?.textContent ?? '',
            address: card.querySelector('.vv-dl-progress-address')?.textContent ?? '',
            cancel: card.querySelectorAll('.vv-dl-progress-cancel').length,
            saveas: card.querySelectorAll('.vv-dl-progress-saveas').length
          };
        }),
      { timeout: 60_000, message: '远端下载完成态卡未出现' }
    )
    .toMatchObject({ title: '下载完成', address: fileName, cancel: 0, saveas: 1 });
}

test.describe('b-foreign-office-3 foreign 桥接渲染器的跨边界行为（FOM 域）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('FOM-NEST-01: eml 内嵌 pdf 附件经桥接交回 vviewer 派发器，落自有 pdf 面而非 foreign/hex/code 面', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const host = page.locator('.vv-viewer-host');
    const eml = buildEml({
      subject: 'FOM NEST-01',
      boundary: 'FOMBOUND01',
      parts: [{ filename: 'leaf.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }]
    });
    await injectAndOpenEml(page, 'probe.eml', eml);

    // 内容级守门：邮件被真正解析（Subject/From 文本 + 零内部错误）。
    // 仅 `.email-viewer` 可见不足——上游先建 root 再解析（email.js:252）。
    const mail = host.locator('.email-viewer');
    await expect(mail).toBeVisible({ timeout: 60_000 });
    await expectMailContent(page, mail, { subject: 'FOM NEST-01' });
    // 附件段被解析出来且字节长度正确（体积标签 = formatBytes(附件字节数)）
    await expect(attachmentItem(page, 'leaf.pdf')).toHaveCount(1);
    await expect(attachmentSizeLabel(page, 'leaf.pdf')).toHaveText(formatBytesLike(PDF_BYTES.length));

    // 点击附件 → 上游 renderNestedBuffer → 桥接层 renderNested → 装配层
    // foreignNestedDispatch → registry.byExtension('pdf') → vviewer 自有 pdf 面
    await waitEmailIdle(page);
    await clickAttachment(page, 'leaf.pdf');

    const attach = host.locator('.email-attachment-render');
    await expect(attach.locator('.vv-pdf')).toBeVisible({ timeout: 60_000 });
    const pages = attach.locator('.vv-pdf-page');
    await expect
      .poll(async () => pages.count(), { timeout: 60_000, message: '嵌套 pdf 未出页面容器' })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => pages.locator('canvas').count(), { timeout: 60_000, message: '嵌套 pdf 页面 canvas 未渲染' })
      .toBeGreaterThan(0);
    // canvas 非零尺寸（页面真渲染，非空壳容器）
    const canvasSize = await pages
      .locator('canvas')
      .first()
      .evaluate((el) => ({ w: (el as HTMLCanvasElement).width, h: (el as HTMLCanvasElement).height }));
    expect(canvasSize.w).toBeGreaterThan(0);
    expect(canvasSize.h).toBeGreaterThan(0);
    // 附件未被派回 foreign 引擎面，也未退到 code/hex 面
    await expect(attach.locator('.email-viewer')).toHaveCount(0);
    await expect(attach.locator('.vv-code-pre')).toHaveCount(0);
    await expect(attach.locator('.vv-hex')).toHaveCount(0);
  });

  test('FOM-NEST-02: 无 byExtension 命中的嵌套附件落 blob 下载兜底、字节等值、原名落盘且不落错误卡', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const host = page.locator('.vv-viewer-host');
    const eml = buildEml({
      subject: 'FOM NEST-02',
      boundary: 'FOMBOUND02',
      parts: [{ filename: 'mystery.zzz', mimeType: 'application/octet-stream', bytes: MYSTERY_PAYLOAD }]
    });
    const downloads = captureDownloads(page);
    await injectAndOpenEml(page, 'probe2.eml', eml);
    const mail = host.locator('.email-viewer');
    await expect(mail).toBeVisible({ timeout: 60_000 });
    await expectMailContent(page, mail, { subject: 'FOM NEST-02' });
    await expect(attachmentItem(page, 'mystery.zzz')).toHaveCount(1);

    // 常规 click 需真手势路径（遮罩撤除后再点；blob 兜底本身不依赖用户激活）
    await waitEmailIdle(page);
    await clickAttachment(page, 'mystery.zzz');

    const got = await firstDownloadBytes(downloads);
    expect(downloads.list).toHaveLength(1);
    // 落盘名 = 附件原名（FOM-EX-08 验收判据：原文件名在第 4 参 context.filename，
    // 桥接层只取三参 → 现落盘名为扩展名派生名 attachment.zzz。本断言即该缺陷的
    // 验收锚：修复前红、修复后转绿。）
    expect(got.filename).toBe('mystery.zzz');
    expect(got.bytes.equals(MYSTERY_PAYLOAD)).toBe(true);
    // 回落下载、不落错误卡片（spec §6.4）
    await expect(host.locator('.vv-error-card')).toHaveCount(0);
    // 上游先建空容器，兜底不落渲染内容
    const attach = host.locator('.email-attachment-render');
    await expect(attach).toHaveCount(1);
    expect(await attach.evaluate((el) => el.childElementCount)).toBe(0);
  });

  test('FOM-NEST-03: 嵌套深度限 3 生效，第 4 层附件落下载兜底而非渲染', async ({ page }) => {
    test.setTimeout(240_000);
    const host = page.locator('.vv-viewer-host');
    // 四层邮件：注入件 level1=深度 0，逐层 level2=1 / level3=2 / level4=3；
    // leaf.pdf 挂在深度 3 的 level4 上 → 第 4 层附件应落下载
    const level4 = buildEml({
      subject: 'FOM level4',
      boundary: 'FOMBOUND4',
      parts: [{ filename: 'leaf.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }]
    });
    const level3 = buildEml({
      subject: 'FOM level3',
      boundary: 'FOMBOUND3',
      parts: [{ filename: 'level4.eml', mimeType: 'message/rfc822', bytes: level4 }]
    });
    const level2 = buildEml({
      subject: 'FOM level2',
      boundary: 'FOMBOUND2',
      parts: [{ filename: 'level3.eml', mimeType: 'message/rfc822', bytes: level3 }]
    });
    const level1 = buildEml({
      subject: 'FOM level1',
      boundary: 'FOMBOUND1',
      parts: [{ filename: 'level2.eml', mimeType: 'message/rfc822', bytes: level2 }]
    });

    const downloads = captureDownloads(page);
    await injectAndOpenEml(page, 'level1.eml', level1);
    await expect(host.locator('.email-viewer')).toHaveCount(1);
    await expectMailContent(page, host.locator('.email-viewer').first(), { subject: 'FOM level1' });

    // 逐层下钻（第 1 层附件在视口内 → 常规 click；第 2 层起在视口外 → 事件驱动）
    await waitEmailIdle(page);
    await clickAttachment(page, 'level2.eml');
    await expect(host.locator('.email-viewer')).toHaveCount(2);
    await expectMailContent(page, host.locator('.email-viewer').nth(1), { subject: 'FOM level2' });
    await clickAttachment(page, 'level3.eml', { dispatch: true });
    await expect(host.locator('.email-viewer')).toHaveCount(3);
    await expectMailContent(page, host.locator('.email-viewer').nth(2), { subject: 'FOM level3' });
    await clickAttachment(page, 'level4.eml', { dispatch: true });
    await expect(host.locator('.email-viewer')).toHaveCount(4);
    await expectMailContent(page, host.locator('.email-viewer').nth(3), { subject: 'FOM level4' });

    // 深度 3 的 level4 内的 leaf.pdf：第 4 层附件不再入派发器
    await clickAttachment(page, 'leaf.pdf', { dispatch: true });
    const got = await firstDownloadBytes(downloads);
    expect(downloads.list).toHaveLength(1);
    // 深度闸兜底落盘名 = 附件原名（FOM-EX-08 验收判据同 FOM-NEST-02）
    expect(got.filename).toBe('leaf.pdf');
    expect(got.bytes.equals(PDF_BYTES)).toBe(true);
    await expect(host.locator('.email-attachment-render .vv-pdf')).toHaveCount(0);
    // 限深是「落下载」而非整链失败：四层邮件面仍在
    await expect(host.locator('.email-viewer')).toHaveCount(4);
    await expect(host.locator('.vv-error-card')).toHaveCount(0);
  });

  test('FOM-NEST-04: 嵌套附件有渲染器但渲染失败——错误卡落在 nested target 内、零下载兜底', async ({ page }) => {
    test.setTimeout(180_000);
    const host = page.locator('.vv-viewer-host');
    const eml = buildEml({
      subject: 'FOM NEST-04',
      boundary: 'FOMBOUND04',
      parts: [{ filename: 'broken.pdf', mimeType: 'application/pdf', bytes: BROKEN_PDF_PAYLOAD }]
    });
    const downloads = captureDownloads(page);
    await injectAndOpenEml(page, 'probe4.eml', eml);
    const mail = host.locator('.email-viewer');
    await expect(mail).toBeVisible({ timeout: 60_000 });
    await expectMailContent(page, mail, { subject: 'FOM NEST-04' });
    await expect(attachmentItem(page, 'broken.pdf')).toHaveCount(1);

    await waitEmailIdle(page);
    await clickAttachment(page, 'broken.pdf');

    // 有渲染器命中（pdf）→ 进派发器 → pdfjs 打开失败 → 错误卡落在 nested target 内
    const attach = host.locator('.email-attachment-render');
    await expect(attach.locator('.vv-error-card')).toBeVisible({ timeout: 60_000 });
    await expect(attach.locator('.vv-error-title')).toHaveText('无法预览此文件');
    await expect(attach.locator('.vv-pdf')).toHaveCount(0);
    // 宿主顶层不落错误卡（错误卡在嵌套容器内，不冒泡到宿主——用直接子级计数判定）
    const topLevelCards = await host.evaluate((el) => el.querySelectorAll(':scope > .vv-error-card').length);
    expect(topLevelCards).toBe(0);
    // 渲染失败不转下载兜底（有渲染器命中 → 不走 downloadNestedAttachment）
    await settleWindow(page, 1000);
    expect(downloads.list).toHaveLength(0);
  });

  test('FOM-NEST-05: 嵌套附件走其它 vviewer 自有扩展名——png 落自有 image 面、docx 落自有 docx 面', async ({
    page
  }) => {
    test.setTimeout(180_000);
    // docx 内置默认已改为 file-viewer 版式还原（foreign-word）；本用例锚「嵌套附件经
    // vviewer 派发器落自有 docx 面」→ 经默认渲染器偏好选用 mammoth（偏好与顶层打开
    // 同经 registry.byExtension，嵌套分派一致生效；injectDir 内 goto 前注册）
    await page.addInitScript(() => {
      localStorage.setItem('vviewer:settings', JSON.stringify({ rendererDefaults: { docx: 'docx' } }));
    });
    const host = page.locator('.vv-viewer-host');
    const png = Buffer.from(PIXEL_PNG_B64, 'base64');
    const eml = buildEml({
      subject: 'FOM NEST-05',
      boundary: 'FOMBOUND05',
      parts: [
        { filename: 'pic.png', mimeType: 'image/png', bytes: png },
        { filename: 'word.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: DOCX_BYTES }
      ]
    });
    await injectAndOpenEml(page, 'probe5.eml', eml);
    const mail = host.locator('.email-viewer');
    await expect(mail).toBeVisible({ timeout: 60_000 });
    await expectMailContent(page, mail, { subject: 'FOM NEST-05' });
    await expect(attachmentItem(page, 'pic.png')).toHaveCount(1);
    await expect(attachmentItem(page, 'word.docx')).toHaveCount(1);

    const attach = host.locator('.email-attachment-render');

    // png → vviewer 自有 image 面（.vv-image + img，vviewer-render-media/src/image.ts:104）
    await waitEmailIdle(page);
    await clickAttachment(page, 'pic.png');
    await expect(attach.locator('.vv-image')).toBeVisible({ timeout: 60_000 });
    await expect(attach.locator('.vv-image img')).toBeVisible();
    const natural = await attach
      .locator('.vv-image img')
      .evaluate((el) => ({ w: (el as HTMLImageElement).naturalWidth, h: (el as HTMLImageElement).naturalHeight }));
    expect(natural.w).toBeGreaterThan(0);
    expect(natural.h).toBeGreaterThan(0);

    // docx → vviewer 自有 docx 面（.vv-docx + 内容，vviewer-render-doc/src/docx.ts:40）
    await waitEmailIdle(page);
    await clickAttachment(page, 'word.docx');
    await expect(attach.locator('.vv-docx')).toBeVisible({ timeout: 60_000 });
    await expect(attach.locator('.vv-docx-content')).toContainText('vviewer docx 样例');
    // 切换后前一个附件渲染被清空（单激活槽）
    await expect(attach.locator('.vv-image')).toHaveCount(0);
  });

  test('FOM-REMOTE-01: foreign 扩展名走远端按非流式全量物化（head+全量两请求）后桥接引擎接管宿主', async ({
    page
  }) => {
    test.setTimeout(240_000);
    const host = page.locator('.vv-viewer-host');
    // >1MB 夹具：非流式（streaming:false）路径 = 8KB head 探测 + 全量窗两请求；
    // 若 foreign 改声明 streaming:true，则 dispatcher 只发 1 条 head 请求、
    // 引擎只拿到 8KB（附件解析不出）→ 本锚的两请求序列与内容级断言同时打红。
    const pad = Buffer.alloc(1_100_000, 0x5a);
    const eml = buildEml({
      subject: 'FOM REMOTE-01',
      boundary: 'FOMBOUNDR1',
      parts: [{ filename: 'pad.bin', mimeType: 'application/octet-stream', bytes: pad }]
    });
    const srv = await startFakeVVServer({ 'remote.eml': eml });
    const reqs = (): string[] => srv.fileRequests.filter((r) => r.startsWith('remote.eml ::'));
    try {
      // 快照条目与树条目均带 size——size 缺失会改走 head 探测路径，请求形态随之改变
      await seedRemoteTabs(page, {
        base: srv.base,
        tabs: [
          { path: '', name: 'e2e-fake', active: false },
          { path: 'remote.eml', name: 'remote.eml', size: eml.length, active: true }
        ]
      });
      await page.goto('/');
      await waitSeedReady(page);
      await expect(tabNamed(page, 'remote.eml')).toBeVisible({ timeout: 30_000 });

      // foreign 引擎接管宿主 + 内容级守门（Subject/From + 附件项与体积标签）
      const mail = host.locator('.email-viewer');
      await expect(mail).toBeVisible({ timeout: 120_000 });
      // 完成态卡先取快照（TTL 4s——早取早得，避免后续内容断言吃掉 TTL 窗口）
      await expectDoneCard(page, 'remote.eml');
      await expectMailContent(page, mail, { subject: 'FOM REMOTE-01' });
      await expect(attachmentItem(page, 'pad.bin')).toHaveCount(1);
      await expect(attachmentSizeLabel(page, 'pad.bin')).toHaveText(formatBytesLike(pad.length));
      // 远端下载不经过确认门（默认阈值 512MB，本文件 ~1.5MB）
      await expect(page.locator('.vv-dl-confirm')).toHaveCount(0);

      // 请求形态：非流式全量物化 = 8KB head 探测 + 全量窗（两条，顺序固定）
      await expect.poll(() => reqs().length, { timeout: 90_000, message: '远端泵未发出预期请求' }).toBe(2);
      await settleWindow(page);
      expect(reqs()).toEqual(['remote.eml :: bytes=0-8191', `remote.eml :: bytes=0-${eml.length - 1}`]);
    } finally {
      await srv.close();
    }
  });

  test('FOM-CONFIRM-01: 远端大文件过确认门后泵全量物化，桥接引擎接管宿主', async ({ page }) => {
    test.setTimeout(240_000);
    const host = page.locator('.vv-viewer-host');
    // >1MB 的合成 eml（正文 + 1.1MB application/octet-stream 附件 pad.bin）；
    // 声明体积 = 真实字节数（不脱钩——脱钩时泵会按 4MiB 窗反复请求、被服务端钳成
    // 1 字节逐窗推进而挂起不可完成，测不出「确认后 foreign 接管」这条语义）
    const pad = Buffer.alloc(1_100_000, 0x5a);
    const eml = buildEml({
      subject: 'FOM CONFIRM-01',
      boundary: 'FOMBOUNDC1',
      parts: [{ filename: 'pad.bin', mimeType: 'application/octet-stream', bytes: pad }]
    });
    const srv = await startFakeVVServer({ 'gate.eml': eml });
    const reqs = (): string[] => srv.fileRequests.filter((r) => r.startsWith('gate.eml ::'));
    try {
      await seedRemoteTabs(page, {
        base: srv.base,
        tabs: [
          { path: '', name: 'e2e-fake', active: true },
          { path: 'gate.eml', name: 'gate.eml', size: eml.length, active: false }
        ]
      });
      await page.goto('/');
      await waitSeedReady(page);
      await expect(tabNamed(page, 'gate.eml')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible();
      // 阈值 1MB（门公式：远端来源 × size > 阈值 × 未确认键）
      await setConfirmThreshold(page, '1');

      await tabNamed(page, 'gate.eml').click();
      const card = page.locator('.vv-dl-confirm');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.locator('.vv-dl-confirm-name')).toHaveText('gate.eml');
      await expect(card.locator('.vv-dl-confirm-size')).toHaveText(`大小 ${formatBytesLike(eml.length)}`);
      // 门拦截期泵未启动：静默窗内零 /api/file 请求（泵若与确认卡竞态启动，
      // 请求会落在窗内——无静默窗的直接计数断言会假绿）
      await settleWindow(page, 1000);
      expect(reqs()).toEqual([]);

      await card.locator('.vv-dl-confirm-start').click();
      await expect(card).toHaveCount(0);
      // 泵请求序列：>1MB 先 8KB head 探测，再一窗读全量（dispatcher.ts:399-406/485-490）
      await expect.poll(() => reqs().length, { timeout: 90_000, message: '确认后泵未发出预期请求' }).toBe(2);
      await settleWindow(page);
      expect(reqs()).toEqual(['gate.eml :: bytes=0-8191', `gate.eml :: bytes=0-${eml.length - 1}`]);

      // 确认后 foreign 引擎接管宿主 + 内容级守门
      const mail = host.locator('.email-viewer');
      await expect(mail).toBeVisible({ timeout: 120_000 });
      // 完成态卡先取快照（TTL 4s——早取早得）
      await expectDoneCard(page, 'gate.eml');
      await expectMailContent(page, mail, { subject: 'FOM CONFIRM-01' });
      await expect(attachmentItem(page, 'pad.bin')).toHaveCount(1);
      await expect(attachmentSizeLabel(page, 'pad.bin')).toHaveText(formatBytesLike(pad.length));
    } finally {
      await srv.close();
    }
  });

  test('FOM-ZIP-01: 压缩包条目开新 tab，条目字节按扩展名派发到 foreign 桥接管', async ({ page }) => {
    test.setTimeout(180_000);
    const host = page.locator('.vv-viewer-host');
    const eml = buildEml({
      subject: 'FOM ZIP-01',
      boundary: 'FOMBOUNDZ1',
      parts: [{ filename: 'leaf.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }]
    });
    const z = new JSZip();
    z.file('inner.eml', eml);
    const zip = await z.generateAsync({ type: 'nodebuffer' });
    await injectDir(page, [{ name: 'bundle.zip', content: '', type: 'application/zip', b64: zip.toString('base64') }]);
    await openTreeFile(page, 'bundle.zip');

    // 归档面 → 条目行（标签含大小后缀 `${name}（${size} B）`——大小即条目字节数）
    const archive = host.locator('.vv-archive');
    await expect(archive).toBeVisible({ timeout: 30_000 });
    const row = archive.locator('.vv-tree-row', { hasText: 'inner.eml' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(`inner.eml（${eml.length} B）`);

    await row.click();
    await expect(page.locator('.vv-tab.active', { hasText: 'inner.eml' })).toBeVisible({ timeout: 30_000 });

    // foreign 增量：条目字节按扩展名派发到 foreign-email 桥接管 + 内容级守门
    const mail = host.locator('.email-viewer');
    await expect(mail).toBeVisible({ timeout: 60_000 });
    await expectMailContent(page, mail, { subject: 'FOM ZIP-01' });
    await expect(attachmentItem(page, 'leaf.pdf')).toHaveCount(1);
    await expect(attachmentSizeLabel(page, 'leaf.pdf')).toHaveText(formatBytesLike(PDF_BYTES.length));
    // 渲染发生在新 tab 而非归档树面内：归档面已被接管，归档面内无 foreign 引擎壳
    await expect(host.locator('.vv-archive')).toHaveCount(0);
  });

  test.describe('FOM-CDN-01 拦截面（SW block：page.route 拦不到经 SW 的请求）', () => {
    test.use({ serviceWorkers: 'block' });

    test('FOM-CDN-01: CDN 资产不可达时跨域 worker 引导失败收口成错误卡且归因可核验', async ({ page }) => {
      test.setTimeout(180_000);
      const host = page.locator('.vv-viewer-host');
      // 本地 abort 兜底（不依赖真网可达）+ 记录被拦截的 URL 作失败归因指纹。
      // 路由按「worker 资产文件名」匹配（**/…/wordperfect.worker.js），跟随应用
      // 实际资产基座——不写死 CDN 域名与版本字面量：构建期注入 VV_FOREIGN_ASSETS
      // 镜像基座或上游 assets 版本升级时，写死 URL 的断言会假红。
      const intercepted: string[] = [];
      const abortAsset = (route: Route): Promise<void> => {
        intercepted.push(route.request().url());
        return route.abort('failed');
      };
      await page.route('**/*wordperfect.worker.js*', abortAsset);
      await page.route('**/cdn.jsdelivr.net/**', abortAsset);
      await injectDir(page, [
        { name: 'broken.wpd', content: 'this is definitely not a WordPerfect document', type: 'application/octet-stream' }
      ]);
      await openTreeFile(page, 'broken.wpd');

      const card = host.locator('.vv-error-card');
      await expect(card).toBeVisible({ timeout: 90_000 });
      await expect(card.locator('.vv-error-title')).toHaveText('无法预览此文件');
      await expect(card.locator('.vv-error-meta')).toHaveText('broken.wpd');
      // 收口标记：跨域 worker 引导失败被桥接层转成 error 事件 → 渲染器 reject → 错误卡
      await expect(card.locator('.vv-error-detail')).toContainText('foreign worker bootstrap failed');
      // 归因指纹：被拦截的请求即应用实际请求的 wordperfect worker 资产（决定性证据，
      // 不依赖浏览器错误文案措辞，也不依赖 CDN 域名/版本字面量）
      expect(intercepted.some((u) => /wordperfect\.worker\.js(\?|$)/.test(u))).toBe(true);
      // 错误卡三动作（按集合断言不按序——顺序随 looksTextual 探测而变）
      const labels = await card.locator('.vv-error-action').allInnerTexts();
      expect([...labels].sort()).toEqual(['以 hex 打开', '以纯文本打开', '重试'].sort());
      // 引擎壳未挂载（失败发生在 worker 引导阶段，引擎 DOM 尚未产出）
      await expect(host.locator('.wpd-viewer')).toHaveCount(0);
      await expect(host.locator('.vv-code-pre')).toHaveCount(0);
    });
  });

  test('FOM-SHP-01: 裸单文件 .shp（single: 来源）落降级错误卡提示补齐边车；对照面同通道 .geojson 照常渲染', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const host = page.locator('.vv-viewer-host');

    // ---- 主面：single: 来源 .shp → 装配层前置拦截 → dispatcher 错误卡 ----
    await injectSingleFile(page, { name: 'points.shp', b64: SHP_HEADER_B64 });
    await expect(page.locator('.vv-tab.active', { hasText: 'points.shp' })).toBeVisible({ timeout: 30_000 });

    const card = host.locator('.vv-error-card');
    // 先等在场信号（错误卡），再做缺席断言（缺席断言不得单飞）
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card.locator('.vv-error-title')).toHaveText('无法预览此文件');
    await expect(card.locator('.vv-error-meta')).toHaveText('points.shp');
    await expect(card.locator('.vv-error-detail')).toContainText('Shapefile 需同目录');
    // 错误卡三动作（与 FOM-CDN-01 同款集合断言——registry 里 code/hex 均装配，集合确定）
    const labels = await card.locator('.vv-error-action').allInnerTexts();
    expect(labels.length).toBeGreaterThanOrEqual(1);
    expect(labels).toContain('重试');
    expect([...labels].sort()).toEqual(['以 hex 打开', '以纯文本打开', '重试'].sort());
    // geo 引擎壳缺席（拦截发生在桥接 mount 之前，引擎 DOM 从未产出）
    await expect(host.locator('.geo-viewer')).toHaveCount(0);

    // ---- 对照面：同一单文件通道注入 .geojson（同样 single: 来源）→ 正常渲染 ----
    // 钉死拦截是扩展名特异而非通道特异：geojson 单文件自足，不受边车限制。
    await dropSingleFiles(page, [{ name: 'map.geojson', type: 'application/geo+json', b64: GEOJSON_B64 }]);
    await expect(page.locator('.vv-tab.active', { hasText: 'map.geojson' })).toBeVisible({ timeout: 30_000 });
    await expect(host.locator('.geo-viewer')).toBeVisible({ timeout: 90_000 });
    // 旧错误卡随 tab 切换销毁（共享单 host：内容随活动 tab 替换）
    await expect(host.locator('.vv-error-card')).toHaveCount(0);
  });
});
