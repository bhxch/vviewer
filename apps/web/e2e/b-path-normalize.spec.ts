import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import JSZip from 'jszip';
import ts from 'typescript';
import { injectDir, openTreeFile, PIXEL_PNG_B64 } from './b-markdown-html-docs-helpers';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { waitAppMounted } from './helpers';

/**
 * b-path-normalize —— PAT 域（路径规范化与越权防护）e2e 锚。
 *
 * 被测面（两个层次）：
 * 1. **桥接层 sibling 解析**（packages/vviewer-render-foreign/src/bridge.ts:198-250）：
 *    本地 POSIX 路径工具 posixDirname/posixJoin/posixNormalize + createSiblingResolver
 *    的越权防御（空名 / 前导 '/' 根逃逸 / 任一 '..' 段目录穿越 → 拒读返回 null；
 *    目录型来源（path 以 '/' 结尾）→ null；read 抛错（含取消形态）→ null）。该防御
 *    此前只有单测锚（packages/vviewer-render-foreign/test/bridge.test.ts:410-480），
 *    e2e 零锚。
 * 2. **应用面路径规范化**（浏览器可及面）：markdown 相对图片解析的越界拒绝
 *    （apps/web/src/lib/markdownImages.ts:22-35 resolveInStorePath）、归档条目名的
 *    穿越段（jszip 路径 packages/vviewer-render-archive/src/zipStore.ts；libarchive
 *    路径 packages/vviewer-render-archive/src/libarchiveStore.ts:190-202）、
 *    嵌套附件兜底下载名的路径成分（apps/web/src/lib/foreignRenderers.ts:68-73
 *    nestedName 合成 'attachment.<ext>'）。
 *
 * 场景编号 PAT-01~09（全局唯一，登记于 docs/e2e/path-normalization.md）：
 * - PAT-01  穿越判定按**独立段**（'..' 独立段拒读；含 '..' 子串的合法文件名放行）——
 *            段判定退化为子串判定（过度拦截）即红；
 * - PAT-02  sibling 名以 '/' 开头（根逃逸）→ 拒读（null + store.read 零调用）；
 * - PAT-03  契约外输入（空名 / 根级来源 / 目录型来源）→ null 不抛 + 零读；
 * - PAT-04  store.read 抛错（含 AbortError 取消形态）→ null 不抛、读被尝试过一次，
 *            且失败不外泄为页面未处理拒绝；
 * - PAT-05  合法 sibling 命中：读路径 = dirname 拼接（根级来源直接取名）、字节精确
 *            （内容不串别的文件）、退化形读路径归一；
 * - PAT-06  markdown 相对图片越界引用（'../../x.png'）→ 不解析成 store 内文件
 *            （src 保持字面量、文档内 blob: 图恰 1 张），同目录相对图仍解析（对照锚）；
 * - PAT-07  归档条目名含 '..' 段（jszip 路径）→ 树内无穿越段名、内容取归档自身字节
 *            （不串宿主同名/同路径文件）；
 * - PAT-08  嵌套附件兜底下载名**产品侧**不得含路径成分（恶意附件名 'x.z/evil' 经
 *            fileNameOnly 文件名化）+ 落盘字节为被点附件自身负载（不串别的附件）；
 * - PAT-09  归档条目名含 '..' 段（tar / libarchive 路径）→ 同 PAT-07 的两条不变量。
 *
 * 装置全部自建在本文件内（不抽公共 helper 文件，避免与其他域并行写文件冲突）：
 * - **桥接模块注入装置**：读仓内产品源码 packages/vviewer-render-foreign/src/bridge.ts
 *   → ts.transpileModule（去类型，产出零运行时依赖的 ES module）→ page.addScriptTag
 *   以 type=module 注入页内 → window.__patBridge.createSiblingResolver 可用。
 *   为何不注入构建产物：vite build 的 chunk 经 tree-shake 不再导出
 *   createSiblingResolver（应用只 import wrapFileViewerRenderer/disposeForeignRendered），
 *   且构建产物可能滞后于源码；注入源码本体保证「锚的是当前工作区的产品实现」。
 *   注入前先加载**真实产品页**（vite preview + SW 开启）——PAT-04 的「失败不外泄为
 *   页面未处理拒绝」断言须在产品页语境下成立（about:blank 下该通道未被证伪）。
 * - **stub store**：页内构造一个带 read 的 TreeStore 桩，记录每次 read 的路径并按
 *   文件表返回字节（可切换抛错 / 无 read / 无 store；另有 fire-and-forget 形态用于
 *   观测「失败是否外泄为页面未处理拒绝」）。
 * - **穿越命名归档包**：zip 走 jszip 写入面直给穿越名（jszip 3.10 的 file() **不消解**
 *   条目名——lib/object.js 无 utils.resolve，消解只发生在读侧 lib/load.js:66；
 *   实测 z.file('../secret.txt') 的 forEach 名字为 ['../','../secret.txt']）；
 *   tar 走手写 ustar 头（512B 头 + 512B 对齐数据 + 两块零尾）。
 * - **下载名观测钩子**：<a download> 的 download **属性**在点击前被记录（产品侧
 *   合成名的真值）；浏览器的兜底消毒只作用于落盘文件名（suggestedFilename），
 *   在该层观测路径成分恒被消毒 → 恒真断言。
 * - **MIME 合成器**：RFC822/multipart-mixed 邮件（正文段 + base64 附件段，76 列折行）。
 *
 * 断言纪律：无恒真断言（每条都能被一处具体产品改动打红）；注册面数量不写死；
 * 轮询一律 expect.poll；不依赖真网外域（本 spec 零外呼）。
 *
 * 桌面专属（仅 chromium project，b-save-as/b-diagram-file/b-foreign-office beforeEach
 * 跳过同款）：PAT-06~09 的树/邮件/归档交互均为桌面交互面；PAT-01~05 为模块级锚
 * （视口无关），随文件级跳过统一收敛运行面。
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BRIDGE_SRC = join(REPO_ROOT, 'packages/vviewer-render-foreign/src/bridge.ts');

// ---------- 装置一：桥接模块注入（产品源码 → 真实产品页内的 ES module） ----------

/**
 * 把仓内桥接源码注入**真实产品页**：先 waitAppMounted（vite preview + SW 开启），
 * 再 ts.transpileModule（只做类型擦除——bridge.ts 的唯一 import 是 `import type`
 * → 编译后零 import，可作独立 ES module 载入）→ page.addScriptTag 注入。
 * 注入后 window.__patBridge.createSiblingResolver 为产品实现本体。
 */
async function injectBridgeModule(page: Page): Promise<void> {
  await waitAppMounted(page);
  const src = readFileSync(BRIDGE_SRC, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  expect(js, '桥接源码转译产物为空（源码读取或转译失败）').not.toBe('');
  await page.addScriptTag({
    type: 'module',
    content: `${js}\nwindow.__patBridge = { createSiblingResolver };\n`
  });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __patBridge?: { createSiblingResolver?: unknown } }).__patBridge
        ?.createSiblingResolver === 'function'
  );
}

interface SiblingProbe {
  /** resolver 返回的字节（null = 拒读/兜 null） */
  bytes: number[] | null;
  /** store.read 收到的路径序列（顺序即调用序） */
  calls: string[];
  /** resolver 自身抛出的错误信息（null = 未抛） */
  threw: string | null;
  /** 页面 unhandledrejection 通道记录到的拒绝（fireAndForget 形态才有意义） */
  unhandled: string[];
}

/**
 * 页内驱动 createSiblingResolver：source.path / sibling name / store 形态（缺失、
 * 无 read、抛错）均由入参控制；返回字节 + read 调用序列 + 是否抛出。
 *
 * fireAndForget 形态：不 await、不 catch 地调 resolver——若产品把 read 的失败当
 * 未处理拒绝抛进页面，页面的 unhandledrejection 监听会记录到（用于断言「失败不
 * 外泄到全局错误通道」；直调形态由本页 try/catch 兜住拒绝，故其外泄面不可观测）。
 */
async function probeSibling(
  page: Page,
  opts: {
    sourcePath: string;
    name: string;
    files?: Record<string, number[]>;
    readError?: 'boom' | 'abort';
    noStore?: boolean;
    noRead?: boolean;
    fireAndForget?: boolean;
  }
): Promise<SiblingProbe> {
  return page.evaluate(async (o) => {
    const calls: string[] = [];
    const unhandled: string[] = [];
    const onUnhandled = (ev: Event): void => {
      unhandled.push(String((ev as PromiseRejectionEvent).reason));
    };
    const store = {
      read: async (p: string): Promise<Uint8Array> => {
        calls.push(p);
        if (o.readError === 'boom') throw new Error('pat-read-boom');
        if (o.readError === 'abort') throw new DOMException('pat-read-abort', 'AbortError');
        const hit = o.files?.[p];
        if (!hit) throw new Error(`未知路径: ${p}`);
        return new Uint8Array(hit);
      }
    };
    const source: Record<string, unknown> = {
      storeId: 'pat-store',
      storeLabel: 'pat',
      path: o.sourcePath,
      name: o.sourcePath.split('/').pop() ?? ''
    };
    if (!o.noStore) source.store = o.noRead ? {} : store;
    const resolver = (
      window as unknown as {
        __patBridge: { createSiblingResolver: (s: unknown) => (n: string) => Promise<Uint8Array | null> };
      }
    ).__patBridge.createSiblingResolver(source);
    window.addEventListener('unhandledrejection', onUnhandled);
    try {
      if (o.fireAndForget === true) {
        resolver(o.name); // 不 await 不 catch：拒绝即页面未处理拒绝
        await new Promise((r) => setTimeout(r, 100));
        return { bytes: null, calls, threw: null, unhandled };
      }
      try {
        const bytes = await resolver(o.name);
        return { bytes: bytes ? Array.from(bytes) : null, calls, threw: null, unhandled };
      } catch (err) {
        return { bytes: null, calls, threw: String(err), unhandled };
      }
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  }, opts);
}

// ---------- 装置二：穿越命名的归档容器 ----------

/**
 * zip（jszip 路径）：写入面直接给穿越名——jszip 3.10 的 file() 不消解条目名
 * （lib/object.js 无 utils.resolve；消解只发生在读侧 lib/load.js:66），实测
 * z.file('../secret.txt') 的 forEach 名字为 ['../','../secret.txt']。
 * 应用侧读入时 jszip 把 '../secret.txt' 消解为 'secret.txt'（条目树里不出现穿越段名）。
 */
async function buildTraversalZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('ok.txt', 'ZIP-OK-BYTES');
  zip.file('../secret.txt', 'ZIP-ESCAPE-BYTES');
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  expect(
    buf.includes(Buffer.from('../secret.txt', 'utf8')),
    'zip 包体未含穿越条目名（jszip 写入面行为变化）'
  ).toBe(true);
  return buf;
}

/** ustar 头（512B）：name/mode/uid/gid/size/mtime/chksum/typeflag/magic/version… */
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644', 100, 8, 'utf8'); // mode
  h.write('0000000', 108, 8, 'utf8'); // uid
  h.write('0000000', 116, 8, 'utf8'); // gid
  h.write(`${size.toString(8).padStart(11, '0')}`, 124, 12, 'utf8'); // size
  h.write('00000000000', 136, 12, 'utf8'); // mtime
  h.write('        ', 148, 8, 'utf8'); // chksum 占位（全空格）
  h.write('0', 156, 1, 'utf8'); // typeflag：普通文件
  h.write('ustar\0', 257, 6, 'utf8'); // magic
  h.write('00', 263, 2, 'utf8'); // version
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return h;
}

/**
 * tar（libarchive 路径）：手写 ustar 包，条目名带穿越段——libarchive 的条目列举
 * API 原样返回 pathname（archive_read_next_header 不做路径消毒），产品侧的
 * libarchiveStore walk（libarchiveStore.ts:190-202）按原名聚合 → 穿越段名会进入
 * 产品条目树（与 jszip 路径不同：那里的穿越名在读侧被消解）。
 */
function buildTraversalTar(entries: Array<{ name: string; content: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content, 'utf8');
    blocks.push(tarHeader(e.name, data.length));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // 两块零尾（EOF）
  return Buffer.concat(blocks);
}

// ---------- 装置三：MIME 合成器（嵌套附件面） ----------

const CRLF = '\r\n';

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

/** 合成 RFC822 / multipart-mixed 邮件：头 + text/plain 正文段 + 若干 base64 附件段 */
function buildEml(opts: { subject: string; boundary: string; parts: EmlPart[] }): Buffer {
  const lines: string[] = [
    'From: PAT Probe <probe@example.invalid>',
    'To: PAT Receiver <receiver@example.invalid>',
    `Subject: ${opts.subject}`,
    'Date: Mon, 02 Jan 2006 15:04:05 -0700',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${opts.boundary}"`,
    '',
    `--${opts.boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'PAT probe body.',
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

// ---------- 装置四：下载名观测钩子（产品侧合成名的真值） ----------

/**
 * 记录 <a> 被点击时的 download **属性**（产品侧合成名真值）。
 * 浏览器在落盘时对路径成分做兜底消毒（'../../x' → '_x'、'a/b/x' → 'a_b_x'），
 * 故 suggestedFilename 层观测不到产品是否把路径成分写进下载名——只能看属性。
 * 锚点未挂 DOM（bridge.ts:110-117 直接 createElement + click），故用 click 钩子。
 */
async function captureDownloadNames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __patDownloadNames?: Array<string | null> };
    w.__patDownloadNames = [];
    const proto = HTMLAnchorElement.prototype as unknown as { click: () => void };
    const orig = proto.click;
    proto.click = function (this: HTMLAnchorElement): void {
      w.__patDownloadNames?.push(this.getAttribute('download'));
      return orig.call(this);
    };
  });
}

/** 取钩子记录的 download 属性序列（产品侧合成名，按点击序） */
async function downloadNames(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() => {
    const w = window as unknown as { __patDownloadNames?: Array<string | null> };
    return w.__patDownloadNames ?? [];
  });
}

// ---------- 装置五：目录注入后的嵌套文件打开（树行展开 → 点击） ----------

/** 注入目录里带子目录时：先展开目录行，再点子文件行（b-icon-themes ICON-04 同款手势） */
async function openNestedTreeFile(page: Page, dirName: string, fileName: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  const dirRow = page.locator('.vv-tree-row', { hasText: dirName });
  const fileRow = page.locator('.vv-tree-row', { hasText: fileName });
  await expect(dirRow).toBeVisible({ timeout: 20_000 });
  // 目录默认折叠（b-icon-themes ICON-04 同款）；若已展开则不再点（避免点反折叠）
  if ((await fileRow.count()) === 0) await dirRow.click();
  await expect(fileRow).toBeVisible({ timeout: 20_000 });
  await fileRow.click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: fileName })).toBeVisible({ timeout: 20_000 });
}

/**
 * 归档条目行定位：条目名文本含 fileName 的行；若条目被聚合在穿越段目录（'..'）下，
 * 先展开该目录再定位（libarchive 路径的穿越名原样进树 → 出现 '..' 目录行）。
 */
function archiveEntryRow(page: Page, archive: Locator, fileName: string): Locator {
  return archive.locator('.vv-tree-row').filter({ has: page.locator('.vv-tree-name', { hasText: fileName }) });
}

test.describe('b-path-normalize PAT 域：路径规范化与越权防护', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('PAT-01: 桥接 sibling 名的穿越判定按独立段（".." 段拒读；含 ".." 子串的合法名放行）', async ({ page }) => {
    test.setTimeout(60_000);
    await injectBridgeModule(page);
    // ① 穿越段形态：父目录逃逸、嵌套后回退、纯 '..'、以及「不出根但含 '..' 段」
    // （守卫按「任一 '..' 段即拒」实现，保守拒绝是契约的一部分）。
    for (const name of ['../escape.json', 'sub/../../escape.json', '..', 'a/../b.json']) {
      const r = await probeSibling(page, {
        sourcePath: 'a/b/data.csv',
        name,
        files: { 'a/b/ok.json': [1, 2, 3] }
      });
      expect(r.threw, `name=${name}：resolver 抛错（应兜 null 不抛）`).toBeNull();
      expect(r.bytes, `name=${name}：未拒读（应返回 null）`).toBeNull();
      expect(r.calls, `name=${name}：触发了 store.read（穿越读不应发生）`).toEqual([]);
    }
    // ② 对向：合法文件名含 '..' 但非独立段 → 必须放行（段判定退化为子串判定即红：
    //    '..foo' / 'a..b.json' 会被误拒，而误拒合法兄弟是越权防护的反面故障）。
    for (const name of ['..foo', 'a..b.json']) {
      const r = await probeSibling(page, {
        sourcePath: 'a/b/data.csv',
        name,
        files: { 'a/b/..foo': [4, 4], 'a/b/a..b.json': [5, 5] }
      });
      expect(r.threw, `name=${name}：合法名被误拒时 resolver 抛错`).toBeNull();
      expect(r.bytes, `name=${name}：合法名（含 '..' 子串）被误拒`).not.toBeNull();
      expect(r.calls, `name=${name}：读路径不是 dirname + name 的拼接结果`).toEqual([`a/b/${name}`]);
    }
  });

  test('PAT-02: 桥接 sibling 名以 "/" 开头（根逃逸）一律拒读（返回 null 且 store.read 零调用）', async ({ page }) => {
    test.setTimeout(60_000);
    await injectBridgeModule(page);
    for (const name of ['/etc/passwd', '/abs.json', '/a/b/ok.json']) {
      const r = await probeSibling(page, {
        sourcePath: 'a/b/data.csv',
        name,
        files: { 'a/b/ok.json': [1, 2, 3], 'ok.json': [4, 5, 6] }
      });
      expect(r.threw, `name=${name}：resolver 抛错（应兜 null 不抛）`).toBeNull();
      expect(r.bytes, `name=${name}：未拒读（应返回 null）`).toBeNull();
      expect(r.calls, `name=${name}：触发了 store.read（根逃逸读不应发生）`).toEqual([]);
    }
  });

  test('PAT-03: 桥接契约外输入（空名 / 根级来源 / 目录型来源）返回 null 且零读', async ({ page }) => {
    test.setTimeout(60_000);
    await injectBridgeModule(page);
    // 说明：bridge.ts:239 的「store 缺失 / store 无 read」两形态**不可判别**——该守卫
    // 被摘掉后 read 调用（store.read 非函数）落在 try 内被 catch 吞成 null，外部可观
    // 测面完全一致 → 断言恒真，故本场景不含这两形态（详见域文档 §3.1 断言口径 2）。
    const cases: Array<{ label: string; opts: Parameters<typeof probeSibling>[1] }> = [
      { label: '空名', opts: { sourcePath: 'a/b/data.csv', name: '' } },
      { label: '根级来源(path==="")', opts: { sourcePath: '', name: 'ok.json' } },
      { label: '目录型来源(path 以 / 结尾)', opts: { sourcePath: 'a/b/', name: 'ok.json' } }
    ];
    for (const c of cases) {
      const r = await probeSibling(page, { ...c.opts, files: { 'a/b/ok.json': [1, 2, 3], 'ok.json': [4, 5, 6] } });
      expect(r.threw, `${c.label}：resolver 抛错（应兜 null 不抛）`).toBeNull();
      expect(r.bytes, `${c.label}：未返回 null`).toBeNull();
      expect(r.calls, `${c.label}：触发了 store.read（不应读）`).toEqual([]);
    }
  });

  test('PAT-04: 桥接 store.read 抛错（含 AbortError 取消形态）兜 null，拒绝不外泄到页面未处理拒绝通道', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await injectBridgeModule(page);

    // ① 直调形态：resolver 返回的 promise 必须兑现为 null（自身不抛），且合法兄弟
    //    路径被尝试过一次（区分「取消被兜 null」与「根本没读」）。
    const boom = await probeSibling(page, {
      sourcePath: 'a/b/data.csv',
      name: 'ok.json',
      readError: 'boom'
    });
    expect(boom.threw, 'read 抛错时 resolver 自身抛出（应兜 null）').toBeNull();
    expect(boom.bytes, 'read 抛错时未返回 null').toBeNull();
    expect(boom.calls, 'read 抛错时未尝试读取合法兄弟路径').toEqual(['a/b/ok.json']);

    const abort = await probeSibling(page, {
      sourcePath: 'a/b/data.csv',
      name: 'ok.json',
      readError: 'abort'
    });
    expect(abort.threw, 'read 取消时 resolver 自身抛出（应兜 null）').toBeNull();
    expect(abort.bytes, 'read 取消时未返回 null').toBeNull();
    expect(abort.calls, 'read 取消时未尝试读取合法兄弟路径').toEqual(['a/b/ok.json']);

    // ② 不 await 不 catch 的形态（真实产品页内）：若产品把 read 的失败当未处理拒绝
    //    抛到页面，页面的 unhandledrejection 通道会记录到（去掉 resolver 的
    //    try/catch 即红）。bridge.ts:246-248 的 catch {} 对普通 Error 与 AbortError
    //    同等吞掉——取消语义与读失败语义在 resolver 层不可分，本锚只钉「两者都兑现
    //    为 null 且读被尝试过一次 + 不外泄」（更细的「取消不被误当读失败上屏」在
    //    resolver 层无观测面，登记见域文档 §3.2）。
    const loose = await probeSibling(page, {
      sourcePath: 'a/b/data.csv',
      name: 'ok.json',
      readError: 'boom',
      fireAndForget: true
    });
    expect(loose.calls, 'fire-and-forget 形态下未记录到读尝试').toEqual(['a/b/ok.json']);
    expect(loose.unhandled, 'read 失败外泄为页面未处理拒绝').toEqual([]);
  });

  test('PAT-05: 桥接合法 sibling 命中：读路径为 dirname 拼接、字节精确（不串别的文件），退化形读路径归一', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await injectBridgeModule(page);
    const files = { 'a/b/ok.json': [1, 2, 3], 'a/b/other.json': [9, 9, 9], 'a/sib.json': [7, 7], 'sib.json': [8, 8] };

    const ok = await probeSibling(page, { sourcePath: 'a/b/data.csv', name: 'ok.json', files });
    expect(ok.threw).toBeNull();
    expect(ok.calls, '读路径不是 dirname(source.path) + name 的拼接结果').toEqual(['a/b/ok.json']);
    expect(ok.bytes, '返回字节不是被请求文件的字节').toEqual([1, 2, 3]);

    // 内容不串到别的文件：同目录另一个兄弟文件必须各自返回自己的字节
    const other = await probeSibling(page, { sourcePath: 'a/b/data.csv', name: 'other.json', files });
    expect(other.calls).toEqual(['a/b/other.json']);
    expect(other.bytes, '兄弟文件字节串了').toEqual([9, 9, 9]);

    // 根级来源（source.path 无目录段）→ dirname 为空，sibling 名直接取名
    const top = await probeSibling(page, { sourcePath: 'top.csv', name: 'sib.json', files });
    expect(top.calls, '根级来源的读路径不是直接取名（posixDirname 空串分支走偏）').toEqual(['sib.json']);
    expect(top.bytes).toEqual([8, 8]);

    // 规范化退化形：dirname 带 '//' 尾段 / 来源路径带 './' 前缀 → 读路径归一
    const dbl = await probeSibling(page, {
      sourcePath: 'a//b.csv',
      name: 'sib.json',
      files: { 'a/sib.json': [7, 7] }
    });
    expect(dbl.calls, '退化形 dirname 未归一（posixNormalize 未生效）').toEqual(['a/sib.json']);
    expect(dbl.bytes).toEqual([7, 7]);

    const dot = await probeSibling(page, {
      sourcePath: './a/b.csv',
      name: './sib.json',
      files: { 'a/sib.json': [7, 7] }
    });
    expect(dot.calls, "'.' 段未归一（posixNormalize 未生效）").toEqual(['a/sib.json']);
    expect(dot.bytes).toEqual([7, 7]);
  });

  test('PAT-06: markdown 相对图片越界引用不解析成 store 内文件（同目录相对图仍解析，不落错误卡）', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const md = ['# PAT 相对图片探针', '', '![pat-ok](./img.png)', '', '![pat-escape](../../secret.png)', ''].join('\n');
    await injectDir(page, [
      { name: 'pat-doc/readme.md', content: md, type: 'text/markdown' },
      { name: 'pat-doc/img.png', content: '', type: 'image/png', b64: PIXEL_PNG_B64 },
      { name: 'secret.png', content: '', type: 'image/png', b64: PIXEL_PNG_B64 }
    ]);
    await openNestedTreeFile(page, 'pat-doc', 'readme.md');

    // markdown 渲染根即宿主元素本身（markdownRenderer.ts:587 target.classList.add
    // ('vv-markdown') 加在 dispatch target 上——该元素同时带 .vv-viewer-host 类，
    // 故后代选择器 '.vv-viewer-host .vv-markdown' 恒不匹配）。
    const host = page.locator('.vv-markdown');
    await expect(host).toBeVisible({ timeout: 30_000 });
    const okImg = host.locator('img[alt="pat-ok"]');
    const escapeImg = host.locator('img[alt="pat-escape"]');
    await expect(okImg).toHaveCount(1, { timeout: 20_000 });
    await expect(escapeImg).toHaveCount(1, { timeout: 20_000 });

    // 对照锚：同目录相对图解析为 blob URL 且真的解码出像素（本环境图片链路可用 →
    // 后续「越界图未被物化」才不是「图片还没加载」的假绿）
    await expect(okImg).toHaveAttribute('src', /^blob:/, { timeout: 20_000 });
    await expect
      .poll(async () => okImg.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // 越界锚：'../../secret.png' 越出 store 根 → 不得被解析成任何 store 内文件。
    // src 保持字面量（未被改写成 blob:/data: 等内联 URL）——相对图片的解析发生在
    // 挂载前（markdownRenderer.ts:582 早于 :591），故 markdown 一可见即已完成解析。
    await expect(escapeImg).toHaveAttribute('src', '../../secret.png');
    // 文档内仅对照图被物化成 blob（越界图未被读入 → 无内容串到别的文件）
    await expect(host.locator('img[src^="blob:"]')).toHaveCount(1);
    // 未落错误卡（越界引用不得让渲染链炸成错误面）
    await expect(page.locator('.vv-viewer-host .vv-error-card')).toHaveCount(0);
  });

  test('PAT-07: 归档条目名含 ".." 段（jszip 路径）不越出归档命名空间（树内无穿越段名、内容取归档自身字节）', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const zip = await buildTraversalZip();
    await injectDir(page, [
      { name: 'bundle.zip', content: '', type: 'application/zip', b64: zip.toString('base64') },
      // 宿主同名文件（两条路径各一）：归档读若越界到宿主 store，内容会变成宿主字节
      { name: 'secret.txt', content: 'HOST-SECRET-BYTES', type: 'text/plain' },
      { name: '../secret.txt', content: 'HOST-RAW-SECRET-BYTES', type: 'text/plain' }
    ]);
    await openTreeFile(page, 'bundle.zip');

    const archive = page.locator('.vv-viewer-host .vv-archive');
    await expect(archive).toBeVisible({ timeout: 60_000 });
    // 条目树是异步展开的（archive.ts expandInto → store.listChildren）——先等条目行落定
    await expect
      .poll(async () => archive.locator('.vv-tree-name').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    // 条目名一律不含 '..' 路径段（穿越段不得出现在可见条目名上）
    const names = await archive.locator('.vv-tree-name').allTextContents();
    expect(
      names.filter((n) => n.split('/').includes('..')),
      '归档树出现含 ".." 段的条目名'
    ).toEqual([]);
    await expect(page.locator('.vv-viewer-host .vv-error-card')).toHaveCount(0);

    // 打开穿越命名条目（读侧消解后名为 'secret.txt'）→ 内容必须是归档自身字节，
    // 不得是宿主同名/同路径文件的字节（归档读不得越界到宿主 store）
    const row = archiveEntryRow(page, archive, 'secret.txt');
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(page.locator('.vv-tab.active', { hasText: 'secret.txt' })).toBeVisible({ timeout: 20_000 });
    const code = page.locator('.vv-viewer-host .vv-code-pre');
    await expect(code).toBeVisible({ timeout: 20_000 });
    await expect(code).toContainText('ZIP-ESCAPE-BYTES');
    await expect(code).not.toContainText('HOST-SECRET-BYTES');
    await expect(code).not.toContainText('HOST-RAW-SECRET-BYTES');
  });

  test('PAT-08: 嵌套附件兜底下载名（产品侧合成名）不含路径成分，落盘字节为被点附件自身负载（不串别的附件）', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const evil = Buffer.from('EVIL-ATTACHMENT-BYTES', 'utf8');
    const other = Buffer.from('OTHER-ATTACHMENT-BYTES', 'utf8');
    // 附件名 'x.z/evil'：上游 email 渲染器取 name.lastIndexOf('.') 之后的后缀
    // （@file-viewer/renderer-email dist email.js:211-214）→ extension='z/evil'
    // （含路径分隔符）→ nestedName('z/evil') = 'attachment.z/evil'（foreignRenderers.ts
    // :68-73 的含点分支原样返回）——真正走通的路径成分面。
    const eml = buildEml({
      subject: 'PAT probe',
      boundary: 'PATBOUND',
      parts: [
        { filename: 'x.z/evil', mimeType: 'application/octet-stream', bytes: evil },
        { filename: 'other.zzz', mimeType: 'application/octet-stream', bytes: other }
      ]
    });
    await injectDir(page, [{ name: 'probe.eml', content: '', type: 'message/rfc822', b64: eml.toString('base64') }]);
    await openTreeFile(page, 'probe.eml');
    await expect(page.locator('.vv-viewer-host .email-viewer')).toBeVisible({ timeout: 120_000 });
    // 上游解析期挂 .email-state 遮罩（覆盖整个邮件面，常规 click 会被拦截）——先等遮罩撤除
    await expect(page.locator('.email-state')).toHaveCount(0, { timeout: 120_000 });

    await captureDownloadNames(page);
    const downloads: Download[] = [];
    page.on('download', (d) => downloads.push(d));
    const item = page.locator('.attachment-item').filter({ has: page.locator('strong', { hasText: 'x.z/evil' }) });
    await expect(item).toHaveCount(1, { timeout: 20_000 });
    await item.click();

    await expect
      .poll(() => downloads.length, { timeout: 30_000, message: '未捕获到下载事件（嵌套附件兜底未触发？）' })
      .toBeGreaterThan(0);
    const names = await downloadNames(page);
    expect(names.length, '未观测到 <a download> 点击（兜底下载面未触发？）').toBeGreaterThan(0);
    // 取最后一条：本用例唯一的 <a download> 点击即被点附件的兜底下载
    const productName = names[names.length - 1]!;
    // 产品侧合成名必须是裸文件名：无路径分隔符、无 '..' 段（上游附件名 'x.z/evil'
    // 经 fileNameOnly 取 basename 后应为 'evil'——foreignRenderers.ts:81-109/194）。
    // 观测点选 <a download> 的属性而非 suggestedFilename：浏览器在落盘时对路径
    // 成分做兜底消毒（'../../x' → '_x'），在 suggestedFilename 层观测恒被消毒。
    expect(productName, '兜底下载名为空').not.toBe('');
    expect(productName, '兜底下载名含路径分隔符（产品侧合成名未文件名化）').not.toContain('/');
    expect(productName, '兜底下载名含路径分隔符（产品侧合成名未文件名化）').not.toContain('\\');
    expect(productName.split(/[\\/]/), '兜底下载名含 ".." 路径段').not.toContain('..');
    // 落盘字节必须是被点附件自身负载（不得串到另一个附件）
    const path = await downloads[0]!.path();
    expect(path, '下载未落盘（download.path() 为 null）').not.toBeNull();
    const bytes = readFileSync(path!);
    expect(bytes.equals(evil), '落盘字节不是被点附件的负载').toBe(true);
    expect(bytes.equals(other), '落盘字节串到了另一个附件').toBe(false);
    await expect(page.locator('.vv-viewer-host .vv-error-card')).toHaveCount(0);
  });

  test('PAT-09: 归档条目名含 ".." 段（tar / libarchive 路径）不越出归档命名空间（树内无穿越段名、内容取归档自身字节）', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const tar = buildTraversalTar([
      { name: 'ok.txt', content: 'TAR-OK-BYTES' },
      { name: '../secret.txt', content: 'TAR-ESCAPE-BYTES' }
    ]);
    await injectDir(page, [
      { name: 'bundle.tar', content: '', type: 'application/x-tar', b64: tar.toString('base64') },
      { name: 'secret.txt', content: 'HOST-SECRET-BYTES', type: 'text/plain' },
      { name: '../secret.txt', content: 'HOST-RAW-SECRET-BYTES', type: 'text/plain' }
    ]);
    await openTreeFile(page, 'bundle.tar');

    const archive = page.locator('.vv-viewer-host .vv-archive');
    await expect(archive).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(async () => archive.locator('.vv-tree-name').count(), { timeout: 60_000 })
      .toBeGreaterThan(0);
    // libarchive 的条目列举 API 原样返回 pathname（archive_read_next_header 不消毒），
    // libarchive.js 的 getFilesObject 按 '/' 拆成嵌套对象（不消毒）→ 产品侧聚合期
    // 统一按归档内规范化（libarchiveStore.ts walk → normalizeArchiveEntryPath：
    // '..' 扁平化到上级、不越出归档根）→ 穿越段名不得出现在条目树里，且穿越命名
    // 条目以扁平化后的名字（'secret.txt'，与 jszip 读侧消解后的形态一致）呈现。
    const names = await archive.locator('.vv-tree-name').allTextContents();
    expect(
      names.filter((n) => n.split('/').includes('..')),
      '归档树（libarchive 路径）出现含 ".." 段的条目名'
    ).toEqual([]);
    expect(names.some((n) => n.startsWith('secret.txt')), '穿越命名条目未以扁平化后的名字呈现').toBe(true);
    await expect(page.locator('.vv-viewer-host .vv-error-card')).toHaveCount(0);

    // 打开穿越命名条目 → 内容必须是归档自身字节，不得是宿主同名/同路径文件的字节
    // （归档读不得越界到宿主 store）。libarchive 的解包按条目原始 pathname 定位
    // （上游 compressed-file.ts extractSingleFile(this._path)）→ 解出的仍是归档自身字节。
    const row = archiveEntryRow(page, archive, 'secret.txt');
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(page.locator('.vv-tab.active', { hasText: 'secret.txt' })).toBeVisible({ timeout: 20_000 });
    const code = page.locator('.vv-viewer-host .vv-code-pre');
    await expect(code).toBeVisible({ timeout: 30_000 });
    await expect(code).toContainText('TAR-ESCAPE-BYTES');
    await expect(code).not.toContainText('HOST-SECRET-BYTES');
    await expect(code).not.toContainText('HOST-RAW-SECRET-BYTES');
  });
});
