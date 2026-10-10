import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * t-fsearch E2E（2026-10-10 覆盖缺口补齐轮，t- 前缀 = 本轮新增）。
 * 场景来源：docs/e2e/in-file-search.md §2/§3；缺口判定见该域盘点结论——
 * FSEARCH-01（既有覆盖挂在 "BUG-18:" 标题下，缺编号前缀用例，本文件补齐编号映射）
 * FSEARCH-03（既有 BUG-23 用例未覆盖验收 2 的不敏感口径逐形式与 3MB 样例不回退项）
 * FSEARCH-04（既有 m3-search 用例未做 active 逐个转移的元素级断言与还原无损比对）
 * FSEARCH-06（既有 m4 用例仅计数 ≥1，无精确基准与跨页逐次步进）。
 * 装置与写法复刻自 b-in-file-search.spec.ts / b-media-office-viewer.spec.ts
 * （openDir 注入通道、drawer 适配、手写 PDF 构造），不改任何既有文件。
 */
const samples = fileURLToPath(new URL('../../../samples', import.meta.url));

interface FilePayload {
  name: string;
  type: string;
  b64?: string;
  content?: string;
  bytes?: Uint8Array;
}

const SAMPLE_TS: FilePayload = {
  name: 'sample.ts',
  type: 'text/plain',
  b64: readFileSync(`${samples}/m2/sample.ts`).toString('base64')
};

/** FSEARCH-03/BUG-23 基准样例：AlphaCase×2 + alphacase×2 + ALPHACASE×1 + AlPhAcAsE×1 = 6 处 */
const CASE_TEST = [
  'AlphaCase one',
  'AlphaCase two',
  'alphacase three',
  'alphacase four',
  'ALPHACASE five',
  'AlPhAcAsE six'
].join('\n');

/** FSEARCH-03 的 3MB 载体：48,000 行 × ~62B ≈ 3.0MB ∈ (2MB, 200MB] → lazy chunk + 虚拟滚动；
 * 每 4,800 行埋一处小写 zzneedleqz（行 100/4900/…/43300，共 10 处），构造同 b-in-file-search FSEARCH-02 */
const SPARSE_3MB_JS = Array.from({ length: 48_000 }, (_, i) =>
  i % 4_800 === 100 ? `const n${i} = 'zzneedleqz'; // hit` : `const v${i} = '${'x'.repeat(40)}'; // pad`
).join('\n');

/** FSEARCH-04 自造载体：'pinpoint' 恰 6 处（标题 1 + 段落 1 + 列表 2 + 引用 1 + 末段 1），满足场景 6 处门槛 */
const MD_6HITS = [
  '# pinpoint notes',
  '',
  'First paragraph mentions pinpoint once for the search baseline.',
  '',
  '- list item with pinpoint inside',
  '- another item also has pinpoint here',
  '',
  '> quoted line carrying pinpoint as well',
  '',
  'Final paragraph closes with pinpoint at the end.',
  ''
].join('\n');

/** FSEARCH-06 三页 PDF 页文本：gamma 不敏感口径共 4 处（p1×1 + p2 同页×2 + p3 大写×1），
 * 对应报告两档样例中的「3 页多命中跨页」档（06b-multipage-gamma） */
const PDF_PAGES = ['alpha gamma report', 'gamma header\nsecond gamma line', 'GAMMA tail page'];

/** 手写最小多页 PDF（复刻 b-media-office-viewer buildMultiPagePdf，扩展：页文本按 '\n'
 * 拆行生成多个 BT/ET 文本块，同页多命中各成一 item；内容须纯 ASCII 且无 ()\\ 字符） */
function buildMultiPagePdf(pages: string[]): Uint8Array {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((pageText, i) => {
    const pid = 4 + i * 2;
    const cid = pid + 1;
    objs[pid] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 900] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
    const stream = pageText
      .split('\n')
      .map((line, r) => `BT /F1 28 Tf 40 ${700 - r * 60} Td (${line}) Tj ET`)
      .join('\n');
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

/** FSEARCH-06 外部基准（域文档 §4 手法）：pdftotext 提取全文统计查询词命中数；
 * 环境无 pdftotext 时返回 null（调用方降级为构造基准——每页文本由本文件写入，恒已知） */
function pdftotextCount(pdf: Uint8Array, word: string): number | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'vv-fsearch-'));
    const path = join(dir, 'multipage.pdf');
    writeFileSync(path, pdf);
    const out = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
    return (out.match(new RegExp(word, 'gi')) ?? []).length;
  } catch {
    return null;
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
}

/** 注入指定文件集（页面内 File + webkitRelativePath 经 __vvOpenDirImpl，同既有套件通道） */
async function openDir(page: Page, items: FilePayload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const files = list.map(({ name, type, b64, content, bytes }) => {
      const part: BlobPart =
        bytes !== undefined
          ? (bytes as unknown as BlobPart)
          : content !== undefined
            ? content
            : Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0));
      const f = new File([part], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `tfsearch/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, items);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

async function openPanelAndSearch(page: Page, term: string): Promise<void> {
  await page.keyboard.press('/'); // 树行/查看区持焦，非输入框 → 面板打开
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText(term);
}

/** 当前命中行（data-line，0 起）——active 行级高亮是跳转定位的直接证据 */
async function activeLine(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.vv-code-line.vv-search-hit-line-active');
    return el instanceof HTMLElement ? Number(el.dataset.line) : null;
  });
}

/** markdown 渲染视图当前 active mark 的文档序索引（-1 = 无 active） */
async function activeMarkIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('.vv-markdown');
    if (host === null) return -2;
    const marks = Array.from(host.querySelectorAll('mark.vv-search-hit'));
    return marks.indexOf(host.querySelector('mark.vv-search-hit-active'));
  });
}

/** 第 n 页（0 起）wrap 顶相对 PDF 滚动容器可视顶的偏移（px）——
 * gotoMatch 为 scrollIntoView({block:'start'})，跨页跳转到位时偏移 ≈0；
 * 工具条页码指示器是 IO 可视集合（含 200px 预热边距）的最小页号，跳转后
 * 前一页仍落在预热区内、文案停留前一页属既有口径，不作为跳转断言 */
async function pageTopOffset(page: Page, nth: number): Promise<number> {
  return page.evaluate((n) => {
    const host = document.querySelector('.vv-pdf-pages');
    const wrap = document.querySelectorAll('.vv-pdf-page')[n];
    if (!(host instanceof HTMLElement) || !(wrap instanceof HTMLElement)) return Number.NaN;
    return Math.round(wrap.getBoundingClientRect().top - host.getBoundingClientRect().top);
  }, nth);
}

test('FSEARCH-01: sample.ts 搜索——/ 唤起、计数 1/4 与 grep 基准吻合、4 处命中全部词级高亮、Enter/Shift+Enter 首尾循环、Esc 还原（BUG-18 验收 1/2/3）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [SAMPLE_TS]);
  await openFile(page, 'sample.ts');
  await expect(page.locator('.vv-code-pre')).toBeVisible();

  await openPanelAndSearch(page, 'Point');
  // 基准：sample.ts 恰 4 处 Point（grep -o Point | wc -l = 4，场景文档 §4 判据基准）
  await expect(page.locator('.vv-search-count')).toHaveText('1/4', { timeout: 5_000 });
  // 验收 1：全部 4 处命中同时有可见高亮——词级 mark 存在且背景色非透明（缺陷态：全 DOM 无 mark）
  const marks = page.locator('mark.vv-search-hit');
  await expect(marks).toHaveCount(4);
  const bgs = await marks.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  for (const bg of bgs) expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  // 验收 2：全部命中行（3 行，其中一行两处）都有行级背景；active 恰 1 处与全部命中可区分
  await expect(page.locator('.vv-code-line.vv-search-hit-line')).toHaveCount(3);
  await expect(page.locator('.vv-code-line.vv-search-hit-line-active')).toHaveCount(1);
  expect(await activeLine(page)).toBe(1); // 第一命中行（0 起）

  // 验收 3：Enter 下一个 / Shift+Enter 上一个 / 首尾循环（行号与 sample.ts 结构吻合）
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('2/4');
  expect(await activeLine(page)).toBe(6);
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('3/4');
  expect(await activeLine(page)).toBe(8); // 两处同行的第三命中行
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('2/4');
  for (const n of ['3/4', '4/4', '1/4']) {
    await page.keyboard.press('Enter');
    await expect(page.locator('.vv-search-count')).toHaveText(n);
  }

  // Esc 关闭：面板与词级/行级高亮全部还原（验收 3 不回退项）
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);
  await expect(page.locator('.vv-code-line.vv-search-hit-line')).toHaveCount(0);
});

test('FSEARCH-03: 大小写开关——不敏感口径四形式逐个 1/6、敏感口径 2/2/1/1、导航在新集合工作、3MB 样例三写法均 1/10 不回退、阴性对照（BUG-23 验收 2/3/4/5）', async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'case-test.txt', type: 'text/plain', content: CASE_TEST },
    { name: 'sparse-3mb.js', type: 'text/javascript', content: SPARSE_3MB_JS }
  ]);
  await openFile(page, 'case-test.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible();

  // 验收 1：面板枚举到大小写敏感开关（input/计数/↑/↓/✕ 之外新增），且默认关闭（不敏感）
  const count = page.locator('.vv-search-count');
  const input = page.locator('.vv-search-input');
  const toggle = page.locator('.vv-search-btn[title="区分大小写"]');
  await openPanelAndSearch(page, 'alphacase');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // 验收 2（case-test 前半）：不敏感口径四种查询形式均 1/6（缺陷态基线不回退）
  for (const form of ['alphacase', 'AlphaCase', 'ALPHACASE', 'AlPhAcAsE']) {
    await input.fill(form);
    await expect(count).toHaveText('1/6', { timeout: 5_000 });
  }

  // 验收 3：开关打开（敏感）→ 区分口径 2/2/1/1（计数显示 current/total：1/2、1/2、1/1、1/1）
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // 切换即时重搜（跳过防抖）：此刻查询词仍为验收 2 循环残留的 'AlPhAcAsE'——敏感口径恰
  // 1 处，计数即时 1/6→1/1（BUG-23 验收 4 前半「计数即时随口径变化」的直接证据）
  await expect(count).toHaveText('1/1');
  await input.fill('AlphaCase');
  await expect(count).toHaveText('1/2', { timeout: 5_000 });
  await input.fill('alphacase');
  await expect(count).toHaveText('1/2', { timeout: 5_000 });
  await input.fill('ALPHACASE');
  await expect(count).toHaveText('1/1', { timeout: 5_000 });
  await input.fill('AlPhAcAsE');
  await expect(count).toHaveText('1/1', { timeout: 5_000 });

  // 验收 4：切换后导航在新命中集合上工作（敏感 total=2，Enter 环绕到 2/2）
  await input.fill('alphacase');
  await expect(count).toHaveText('1/2', { timeout: 5_000 });
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('2/2');

  // 验收 2（case-test 后半）：关回不敏感，total 恢复 6
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(count).toHaveText('1/6');

  // 验收 5：阴性对照不回退——不存在的词无结果、Enter 无异常、无错误卡片
  await input.fill('nonexistentzz');
  await expect(count).toHaveText('无结果', { timeout: 5_000 });
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('无结果');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);

  // 验收 2（3MB 样例）：开关关闭（不敏感）下三种写法均 1/10——报告 BUG-23 数据证据口径
  await openFile(page, 'sparse-3mb.js');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();
  for (const form of ['zzneedleqz', 'ZZNEEDLEQZ', 'ZzNeedleQz']) {
    await openPanelAndSearch(page, form);
    await expect(count).toHaveText('1/10', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  }
});

test('FSEARCH-04: markdown 渲染视图——6 处命中全部词级 mark、active 逐个转移并首尾环绕、Esc 退出渲染内容还原无损', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'fsearch04.md', type: 'text/markdown', content: MD_6HITS }]);
  await openFile(page, 'fsearch04.md');
  await expect(page.locator('.vv-markdown')).toBeVisible();

  // 还原无损比对基准：搜索前渲染 DOM 快照（自造载体无图片等异步增强，快照稳定）
  const before = await page.locator('.vv-markdown').evaluate((el) => el.innerHTML);

  await openPanelAndSearch(page, 'pinpoint');
  // 场景门槛：查询词在渲染正文恰 6 处（报告口径 6 个 mark）
  await expect(page.locator('.vv-search-count')).toHaveText('1/6', { timeout: 5_000 });
  await expect(page.locator('.vv-markdown mark.vv-search-hit')).toHaveCount(6);
  expect(await activeMarkIndex(page)).toBe(0); // active 初始在第一个命中

  // 逐个转移：每次 Enter 后 active（vv-search-hit-active）转移到文档序下一个 mark 元素
  const count = page.locator('.vv-search-count');
  for (let k = 1; k <= 5; k++) {
    await page.keyboard.press('Enter');
    await expect(count).toHaveText(`${k + 1}/6`);
    expect(await activeMarkIndex(page)).toBe(k);
  }
  // 首尾环绕：第 6 命中再 Enter 回到第 1 个
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('1/6');
  expect(await activeMarkIndex(page)).toBe(0);

  // Esc 退出：面板关、mark 清除、渲染内容与搜索前逐字节一致（还原无损）
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  await expect(page.locator('.vv-markdown mark.vv-search-hit')).toHaveCount(0);
  expect(await page.locator('.vv-markdown').evaluate((el) => el.innerHTML)).toBe(before);
});

test('FSEARCH-06: 3 页 PDF 搜索——计数与 pdftotext 基准吻合（1/4）、Enter 逐个跨页步进到位（滚动顶对齐命中页+命中页闪现）', async ({
  page
}) => {
  test.setTimeout(90_000);
  const pdf = buildMultiPagePdf(PDF_PAGES);
  // 外部基准（域文档 §4）：pdftotext 提取全文统计 'gamma' 命中 = 4（p1×1 + p2×2 + p3 大写×1）；
  // 环境无 pdftotext 时降级为构造基准（每页文本由本文件写入，恒为 4）
  expect(pdftotextCount(pdf, 'gamma') ?? 4).toBe(4);

  await page.goto('/');
  await openDir(page, [{ name: 'multipage.pdf', type: 'application/pdf', bytes: pdf }]);
  await openFile(page, 'multipage.pdf');
  await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 20_000 });

  const count = page.locator('.vv-search-count');
  const indicator = page.locator('.vv-pdf-page-indicator');
  await openPanelAndSearch(page, 'gamma');
  // 计数与基准精确吻合（缺陷口径修正：非 m4 旧断言的仅 ≥1）；不敏感口径含 p3 的 GAMMA
  await expect(count).toHaveText('1/4', { timeout: 10_000 });
  await expect(indicator).toHaveText('第 1 / 3 页', { timeout: 5_000 });

  // Enter 步进 2/4：跨页跳到第 2 页——命中页 wrap 闪现（gotoMatch → vv-pdf-page-hit，1.2s 窗口），
  // 且滚动容器顶对齐命中页（判据「跨页跳转到位」的几何证据）
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('2/4');
  await expect(page.locator('.vv-pdf-page').nth(1)).toHaveClass(/vv-pdf-page-hit/, { timeout: 2_000 });
  await expect.poll(() => pageTopOffset(page, 1), { timeout: 5_000 }).toBeLessThan(5);

  // Enter 步进 3/4：同页第 2 处命中（页 2 两个 BT 文本块各成一命中），视口驻留第 2 页
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('3/4');
  await expect.poll(() => pageTopOffset(page, 1), { timeout: 5_000 }).toBeLessThan(5);

  // Enter 步进 4/4：跨页跳到第 3 页（大写 GAMMA 在不敏感口径命中），顶对齐第 3 页
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('4/4');
  await expect(page.locator('.vv-pdf-page').nth(2)).toHaveClass(/vv-pdf-page-hit/, { timeout: 2_000 });
  await expect.poll(() => pageTopOffset(page, 2), { timeout: 5_000 }).toBeLessThan(5);

  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
});
