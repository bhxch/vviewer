import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { injectDir, openTreeFile, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * b-ext-bindings —— 扩展名绑定与抢占秩序（BND 域）e2e 锚。
 *
 * 被测面：viewer.ts 的注册面装配（diagram 29 型 → foreign 20 组 → 自有 12 类 →
 * 生成物补空位 670 项）与各渲染器的扩展名绑定清单。本域只钉「扩展名 → 渲染器」的
 * 归属与「绑定 vs 探测链改派」的语义，不重复渲染内容锚（既有渲染锚见 §承接）。
 *
 * 场景（BND-01~10，场景清单与打红面见 docs/e2e/extension-bindings.md）：
 * - BND-01 .hex → hex（二进制）渲染器：扩展名主路由命中，文本载荷也不落 code 面
 *   （若 hex 认领被撤 → 文本探测链把 .hex 送 code → 源码面出现 → 红）。
 * - BND-02 .mpeg → av 渲染器（视频形态）：状态栏渲染器标识 + 候选面 av 项 +
 *   非 hex/code 面。'.mpeg' 不在生成物清单内，绑定被撤即落 hex 兜底 → 红。
 * - BND-03 .weba → av 渲染器（音频形态）：同 BND-02 的归属锚（判据不依赖媒体元素
 *   存活——av 运行期解码失败会自办错误卡并摘除媒体元素，媒体面是短命面）。
 * - BND-04 archive 绑定清单逐项一致：语料清单 ⊇ 绑定清单（单一事实源同源比对）
 *   + 26 项逐项唯一归属 archive 且检出扩展名未被签名改派（扩展名主路由 vs 探测链）。
 * - BND-05 剔除项 zst/tzst 不绑定 archive：走探测链尾 hex 兜底，候选面无专有 owner。
 * - BND-06 剔除项 zipx 不绑定 archive：走 PK 签名探测链改派（检出扩展名被纠偏为
 *   zip 而非 zipx）。
 * - BND-07 foreign 资产三层链层选：.sqlite → foreign-data 组（assets-data 包基座）
 *   的资产请求落链首非空层（env → 同源 → 缺省 CDN），同源层未接线时该层不入判据。
 * - BND-08 专有先注册、generated 补空位（不抢注半边）：生成物清单内被专有渲染器
 *   认领的 9 个扩展名逐个归属唯一 owner（跨组一致性表）。
 * - BND-09 generated 补空位（补空位半边）：仅在生成物清单内、未进任何渲染器显式
 *   清单的扩展名（ipynb/dockerfile/caddyfile/jenkinsfile）归 code 认领；未注册
 *   扩展名同载荷落 hex 兜底（对照锚）。删掉 viewer.ts:143 的
 *   installFallbackExtensions 整行 → 本锚红。
 * - BND-10 嵌套展开门（ARCHIVE_EXTS 派生）：depth=3 的 store 内归档类条目按
 *   isArchiveEntry 被拒展、非归档类条目照常可读、剔除项（zst 不在清单）不被拒展。
 *
 * 既有锚承接（不重复）：DIA-FILE-01（.dot 抢注）、FO-07（.tsv 转移）、FO2-06
 * （geojson/kml/gpx 转移）、FO2-02（wasm 转移）、FO2-01（sqlite/wasm 渲染面）、
 * FOM-CDN-01（CDN 资产不可达收口）、m4.spec.ts 的 zip 4 层深度拒绝锚（BND-10
 * 的增量在「拒展按扩展名集合判定」这一侧，m4 只证 .zip 被拒）。
 *
 * 断言面（两处可观测面，均由产品实况校准）：
 * - 状态栏「打开方式: {渲染器 label}（{检出扩展名}）」（.vv-status-openwith，
 *   ViewerPane.svelte:1227）：label = dispatch 命中的渲染器、括号内 = 派发后
 *   det.ext（扩展名主路由命中即原值；签名改派即纠偏值）——归属与「绑定 vs 改派」
 *   的唯一联合锚。
 * - 属性面板「打开方式」下拉候选面（.meta-openwith，MetaPanel.svelte:238）：
 *   option value 列表 = ['', dispatch 渲染器, 扩展名注册渲染器…, code, markdown,
 *   hex]（openWith.ts:13-33 构造，set 去重；code/markdown/hex 为恒在兜底项）。
 *   → 「首个非自动候选」= dispatch 渲染器；「恒在兜底项以外的候选」= 该扩展名的
 *   专有 owner 集合（恰一项 = 唯一归属；多项 = 冲突检查被放宽）。
 *
 * 装置：目录注入经 __vvOpenDirImpl（injectDir/openTreeFile，b-markdown-html-docs
 * 组 helper 只读引用）；语料在本文件内合成（最小 zip / 4 层嵌套 zip / zstd 魔数 /
 * 非文本垃圾字节 / 文本载荷），零外部语料依赖。
 *
 * 桌面专属（仅 chromium project，b-save-as/b-diagram-file beforeEach 跳过同款）：
 * 右栏属性面板（打开方式下拉）在 ≤600px 收进抽屉，候选面断言为桌面面。
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// ---------- 语料构造 ----------

/** 非文本垃圾字节（NUL 开头 → 非文本；不匹配任何 magic 签名 → 探测链不签名改派） */
function garbageBytes(n = 64): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 7 + 13) & 0xff;
  b[0] = 0x00;
  b[1] = 0x00;
  b[2] = 0x00;
  b[3] = 0x00;
  return b;
}

/** zstd 帧魔数载荷（28 B5 2F FD）：签名嗅探表无 zstd 项（magic.ts 无该签名） */
function zstdBytes(): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x28, 0xb5, 0x2f, 0xfd], 0);
  return b;
}

/** 最小合法 zip（PK 头 + 一个条目）——archive 绑定语料的统一载荷 */
async function makeZipB64(): Promise<string> {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello vviewer');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return Buffer.from(bytes).toString('base64');
}

/**
 * 4 层嵌套 zip 语料：outer ⊃ l1.zip ⊃ l2.zip ⊃ l3.zip ⊃ {deep.txt, inner.7z, inner.zst}
 * 链段数 = 嵌套层数（zipStore.ts createZipStore 的 parentChain 段数）：l3.zip 的
 * store depth=3 → 命中 MAX_ARCHIVE_DEPTH=3 的拒展门（zipStore.ts:238）。
 * 条目三类：deep.txt（非归档类 → 照常可读）、inner.7z（ARCHIVE_EXTS 成员 → 拒展）、
 * inner.zst（剔除项，不在 ARCHIVE_EXTS → 不拒展，按扩展名路由落 hex 兜底）。
 */
async function makeNestedArchiveB64(): Promise<string> {
  const l3 = new JSZip();
  l3.file('deep.txt', 'deep payload');
  l3.file('inner.7z', new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  l3.file('inner.zst', new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]));
  const l2 = new JSZip();
  l2.file('l3.zip', await l3.generateAsync({ type: 'uint8array' }));
  const l1 = new JSZip();
  l1.file('l2.zip', await l2.generateAsync({ type: 'uint8array' }));
  const outer = new JSZip();
  outer.file('l1.zip', await l1.generateAsync({ type: 'uint8array' }));
  const bytes = await outer.generateAsync({ type: 'uint8array' });
  return Buffer.from(bytes).toString('base64');
}

/** 语料序号文件名（两位定宽 → 文件名互不为子串，树行定位无歧义） */
function corpusName(index: number, ext: string): string {
  return `p${String(index + 1).padStart(2, '0')}.${ext}`;
}

// ---------- 可观测面读取（page.evaluate 直读 DOM：不等待元素，缺席即空） ----------

/** 状态栏「打开方式: {label}（{detExt}）」文本（nbsp 归一为空格；缺席→空串） */
async function statusOpenWithText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('.vv-status-openwith');
    return (el?.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  });
}

/** 属性面板「打开方式」候选面 option value 列表（首项恒为 ''=自动） */
async function openWithValues(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.meta-openwith option')).map((o) => (o as HTMLOptionElement).value)
  );
}

/**
 * 候选面里「非渲染器项」以外的候选 = 该扩展名的专有 owner 集合。
 * 排除项两类：① openWith.ts:30-32 无条件 push 的恒在兜底项（code/markdown/hex，
 *    加首项 ''=自动）——它们的「出现」不携带归属信息；② MetaPanel 的候选面哨兵
 *    「更多渲染器…/收起附加候选」（RendererPickerMenu.ts:15-17 的 __more__/__less__，
 *    纯 UI 语义项，不进 FileOpenWith 数据面）——不是渲染器 id。
 * 其余 id 的出现即扩展名认领（registry.byExtension 的唯一 owner 语义）。
 */
const NON_RENDERER_IDS = new Set(['', 'code', 'markdown', 'hex', '__more__', '__less__']);
function dedicatedCandidates(values: readonly string[]): string[] {
  return values.filter((v) => !NON_RENDERER_IDS.has(v));
}

/** 状态栏文本 → 检出扩展名（括号内取值；签名改派即纠偏值） */
function detExtOf(statusText: string): string {
  const m = /（([^（]*)）/.exec(statusText);
  return m?.[1] ?? '';
}

/** 正则转义（语料扩展名入正则用） */
function reEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 绑定清单语料 ----------

/**
 * archive 绑定语料清单（覆盖 zipStore.ts ARCHIVE_BINDINGS 全部条目）。
 * 断言只做「逐项归属」与「语料 ⊇ 绑定清单」两向比对，不写死注册面数量。
 */
const ARCHIVE_CORPUS: readonly string[] = [
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'jar', 'war', 'ear', 'apk', 'cbz', 'cbr',
  'gzip', 'bzip2', 'tbz', 'tbz2', 'txz', 'lzma',
  'cab', 'ar', 'cpio', 'xar', 'lha', 'lzh'
];

/** archive 绑定清单单一事实源（packages/vviewer-render-archive/src/zipStore.ts） */
const ARCHIVE_BINDINGS: readonly string[] = (() => {
  const src = readFileSync(`${repoRoot}/packages/vviewer-render-archive/src/zipStore.ts`, 'utf8');
  const m = /ARCHIVE_BINDINGS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)\s*as readonly string\[\]/.exec(src);
  if (!m) throw new Error('未能从 zipStore.ts 解析 ARCHIVE_BINDINGS（绑定清单单一事实源）');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
})();

/**
 * 生成物清单内被专有渲染器认领的扩展名 → 期望唯一 owner（跨组一致性表）。
 * 语料只取未被既有锚覆盖的载体（.dot/.eml/.geojson/.kml/.gpx/.tsv/.wasm 已锚）。
 */
const DEDICATED_OWNERS: ReadonlyArray<readonly [string, string]> = [
  ['mmd', 'diagram-mermaid'],
  ['bpmn', 'diagram-bpmn'],
  ['dbml', 'diagram-dbml'],
  ['pot', 'foreign-presentation'],
  ['fods', 'foreign-spreadsheet'],
  ['typ', 'foreign-typst'],
  ['sig', 'foreign-signature'],
  ['svg', 'image'],
  ['jsonl', 'jsonl']
];

/**
 * 「生成物补空位」语料：只在 GENERATED_EXTENSIONS 内、未进任何渲染器显式扩展名
 * 清单的扩展名 → 其 owner 只能来自 installFallbackExtensions('code', …) 的补空位
 * （viewer.ts:143）。对照项：未注册扩展名（zzz）→ 无 owner → 探测链尾 hex 兜底。
 */
const FALLBACK_ONLY_EXTS: readonly string[] = ['ipynb', 'dockerfile', 'caddyfile', 'jenkinsfile'];
/** 对照扩展名：不在生成物清单内、无人认领 */
const UNREGISTERED_EXT = 'zzz';

// ---------- foreign 资产三层链常量（源常量直读，期望基座随接线状态自适应） ----------

const FOREIGN_ASSETS_SRC = readFileSync(`${repoRoot}/apps/web/src/lib/foreignAssets.ts`, 'utf8');
/** 同源预留槽（plan 4 接线用；当前为空串 = 该层未启用） */
const SAME_ORIGIN_PREFIX = /FOREIGN_ASSETS_SAME_ORIGIN_PREFIX\s*=\s*'([^']*)'/.exec(FOREIGN_ASSETS_SRC)?.[1] ?? '';
/** 缺省 CDN 层基座 */
const CDN_DEFAULT = /FOREIGN_ASSETS_CDN_DEFAULT\s*=\s*'([^']*)'/.exec(FOREIGN_ASSETS_SRC)?.[1] ?? '';
/** foreign-data 组的资产相对路径（core 的 DEFAULT_FILE_VIEWER_DATA_SQL_WASM_URL 尾段） */
const DATA_SQL_WASM_REL_PATH = 'wasm/data/sql-wasm.wasm';

/**
 * 构建期 env 层（VV_FOREIGN_ASSETS 镜像域）的实际注入值：vite define 以字符串字面量
 * 注入（apps/web/vite.config.ts:819），e2e 跑的是构建产物 → 从产物反查。
 * 构建目录缺失 / 候选不唯一 → 按「未注入」处理（CI 的 e2e 构建只注入
 * VV_GRAMMAR_CDN，ci.yml:163-165 → 链首层 = 同源槽或缺省 CDN 层）。
 */
function buildEnvMirrorBase(): string | null {
  const buildDir = `${repoRoot}/apps/web/build`;
  if (!existsSync(buildDir)) return null;
  const stack: string[] = [buildDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      // SW 与 workbox 产物含 runtimeCaching 的正则串，非 define 注入面 → 排除
      if (entry.name === 'sw.js' || entry.name.startsWith('workbox-')) continue;
      let src: string;
      try {
        src = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      // 锚：foreignAssets 模块所在 chunk（其内含 CDN 默认基座字面量）
      if (!src.includes(CDN_DEFAULT)) continue;
      const urls = [...src.matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/g)].map((m) => m[1]!);
      const candidates = [...new Set(urls.filter((u) => u !== CDN_DEFAULT && u.endsWith('/')))];
      // 唯一候选 = env 镜像域；零/多候选 → 保守按「未注入」处理
      return candidates.length === 1 ? candidates[0]! : null;
    }
  }
  return null;
}

/**
 * 三层链链首非空层基座（env → 同源预留槽 → 缺省 CDN），镜像 foreignAssets.ts
 * resolveForeignAssetBase 的解析序（:86）；尾斜杠归一同款（normalizeBaseDir）。
 */
function chainHeadBase(): string {
  const env = buildEnvMirrorBase();
  const raw = env ?? (SAME_ORIGIN_PREFIX.trim() !== '' ? SAME_ORIGIN_PREFIX.trim() : CDN_DEFAULT.trim());
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * foreign-data 组的包基座（镜像 resolveForeignAssetPackageBase：仅当基座含
 * '/@file-viewer/assets-standard@' 段才按包名替换——env/same-origin 形态为合并树根，
 * 不做替换）。
 */
function assetsDataBase(head: string): string {
  return head.includes('/@file-viewer/assets-standard@')
    ? head.replace('/@file-viewer/assets-standard@', '/@file-viewer/assets-data@')
    : head;
}

/** 基座归属判定：绝对基座比 URL 前缀；路径基座比 URL pathname 前缀 */
function hitsBase(url: string, base: string): boolean {
  if (base.startsWith('http')) return url.startsWith(base);
  try {
    return new URL(url).pathname.startsWith(base);
  } catch {
    return false;
  }
}

test.describe('b-ext-bindings 扩展名绑定与抢占秩序（BND 域）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（候选面在右栏属性面板，≤600px 收抽屉）');
  });

  test('BND-01: .hex 绑定 hex（二进制）渲染器——文本载荷也落 hex 面而非 code 面', async ({ page }) => {
    test.setTimeout(90_000);
    await injectDir(page, [
      { name: 'probe.hex', content: 'hello hex binding\nsecond line\n', type: 'text/plain' }
    ]);
    await openTreeFile(page, 'probe.hex');

    // hex 面在场（扩展名主路由命中 hex 渲染器）
    await expect(page.locator('.vv-hex-row').first()).toBeVisible({ timeout: 30_000 });
    // 否定面：未落 code 文本面（.hex 认领被撤 → 文本探测链 → code → 此断言红）
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
    // 归属锚：渲染器 = 二进制（hex 渲染器），检出扩展名 = hex（未被任何链路改派）
    await expect.poll(() => statusOpenWithText(page), { timeout: 30_000 }).toMatch(/二进制\s*（hex）/);
  });

  test('BND-02: .mpeg 绑定 av 渲染器（视频形态）——不落 hex/code 面', async ({ page }) => {
    test.setTimeout(90_000);
    await injectDir(page, [
      {
        name: 'clip.mpeg',
        content: '',
        type: 'application/octet-stream',
        b64: Buffer.from(garbageBytes()).toString('base64')
      }
    ]);
    await openTreeFile(page, 'clip.mpeg');

    // 归属锚：状态栏渲染器标识 = 音视频（av），检出扩展名 = mpeg
    await expect.poll(() => statusOpenWithText(page), { timeout: 40_000 }).toMatch(/音视频\s*（mpeg）/);
    // 候选面 av 项（av 非恒在兜底 id，其在场即扩展名绑定证据）
    await expect.poll(() => openWithValues(page), { timeout: 30_000 }).toContain('av');
    // 否定面：既非 hex 兜底面也非 code 文本面
    await expect(page.locator('.vv-hex-row')).toHaveCount(0);
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('BND-03: .weba 绑定 av 渲染器（音频形态）——不落 hex/code 面', async ({ page }) => {
    test.setTimeout(90_000);
    await injectDir(page, [
      {
        name: 'tone.weba',
        content: '',
        type: 'application/octet-stream',
        b64: Buffer.from(garbageBytes()).toString('base64')
      }
    ]);
    await openTreeFile(page, 'tone.weba');

    // 归属锚：状态栏渲染器标识 = 音视频（av），检出扩展名 = weba
    await expect.poll(() => statusOpenWithText(page), { timeout: 40_000 }).toMatch(/音视频\s*（weba）/);
    // 候选面 av 项（av 非恒在兜底 id）
    await expect.poll(() => openWithValues(page), { timeout: 30_000 }).toContain('av');
    // 否定面：既非 hex 兜底面也非 code 文本面
    await expect(page.locator('.vv-hex-row')).toHaveCount(0);
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('BND-04: archive 绑定清单逐项一致——语料覆盖绑定清单且每项唯一归属 archive（扩展名未被签名改派）', async ({
    page
  }) => {
    // 余量分档：单项 2 段断言预算（状态栏轮询 15s + 归档面可见 5s）→ 单项最坏 ~21s
    // → 26 项最坏 ~546s < 总预算 600s（任一项卡住时该步定点失败并带扩展名上下文，
    // 而非整例静默超时）；本机实测 26 项合计 ~3s
    test.setTimeout(600_000);
    // ① 语料清单 vs 绑定清单（单一事实源同源比对）：绑定清单新增项而语料未覆盖 → 红
    const uncovered = ARCHIVE_BINDINGS.filter((ext) => !ARCHIVE_CORPUS.includes(ext));
    expect(uncovered, `archive 绑定清单新增扩展名未纳入语料：${uncovered.join(', ')}`).toEqual([]);

    // ② 逐项归属：每项的 owner = archive，且检出扩展名保持原值（未被 PK 签名改派）
    const zipB64 = await makeZipB64();
    const specs: TextFileSpec[] = ARCHIVE_CORPUS.map((ext, i) => ({
      name: corpusName(i, ext),
      content: '',
      type: 'application/octet-stream',
      b64: zipB64
    }));
    await injectDir(page, specs);

    for (const [i, ext] of ARCHIVE_CORPUS.entries()) {
      await openTreeFile(page, corpusName(i, ext));
      // 归属 + 未改派：状态栏 = 压缩包（<ext>）——若该项不在绑定清单，PK 签名改派
      // 会把检出扩展名纠偏为 zip（显示（zip））→ 此断言红
      await expect
        .poll(() => statusOpenWithText(page), { timeout: 15_000 })
        .toMatch(new RegExp(`压缩包\\s*（${reEsc(ext)}）`));
      // 归档面渲染在场（owner = archive 渲染器本体，且渲染成功而非错误卡）
      await expect(page.locator('.vv-archive')).toBeVisible({ timeout: 5_000 });
    }
  });

  test('BND-05: 剔除项 zst/tzst 不绑定 archive——走探测链尾 hex 兜底且候选面无专有 owner', async ({ page }) => {
    test.setTimeout(150_000);
    const zstdB64 = Buffer.from(zstdBytes()).toString('base64');
    await injectDir(page, [
      { name: corpusName(0, 'zst'), content: '', type: 'application/octet-stream', b64: zstdB64 },
      { name: corpusName(1, 'tzst'), content: '', type: 'application/octet-stream', b64: zstdB64 }
    ]);

    for (const [i, ext] of ['zst', 'tzst'].entries()) {
      await openTreeFile(page, corpusName(i, ext));
      // 探测链尾 hex 兜底：在场信号 = hex 面已渲染
      await expect(page.locator('.vv-hex-row').first()).toBeVisible({ timeout: 30_000 });
      // 归属锚：渲染器 = 二进制（hex 兜底），检出扩展名保持原值（未被改派）
      await expect
        .poll(() => statusOpenWithText(page), { timeout: 30_000 })
        .toMatch(new RegExp(`二进制\\s*（${reEsc(ext)}）`));
      // 候选面就位的前置信号用「位置」而非「出现」：code/markdown/hex 是恒在兜底项，
      // 恒在项的出现不构成「本 tab 候选面已算好」的证据；首个非自动候选 = hex
      // （探测链尾兜底的 dispatch 渲染器）才是本 tab 的专属信号
      await expect.poll(async () => (await openWithValues(page))[1] ?? '', { timeout: 30_000 }).toBe('hex');
      // 未绑定语义：该扩展名在注册面里无专有 owner（恒在兜底项之外为空集）——
      // 若被 archive 等认领则此项红（比「候选面不含 archive」更强：任何认领都红）
      await expect.poll(async () => dedicatedCandidates(await openWithValues(page)), { timeout: 30_000 }).toEqual([]);
    }
  });

  test('BND-06: 剔除项 zipx 不绑定 archive——走 PK 签名探测链改派（检出扩展名纠偏为 zip）', async ({ page }) => {
    test.setTimeout(150_000);
    await injectDir(page, [
      {
        name: corpusName(0, 'zipx'),
        content: '',
        type: 'application/zip',
        b64: await makeZipB64()
      }
    ]);
    await openTreeFile(page, corpusName(0, 'zipx'));

    // 探测链改派进 archive：归档面渲染在场（PK 签名路由）
    await expect(page.locator('.vv-archive')).toBeVisible({ timeout: 40_000 });
    // 归属 + 改派锚：状态栏 = 压缩包（zip）——若 zipx 入绑定清单则显示（zipx）→ 红
    await expect.poll(() => statusOpenWithText(page), { timeout: 40_000 }).toMatch(/压缩包\s*（zip）/);
    // 检出扩展名取值精确比对（正则已隐含「zip 后紧跟右括号」，此处给出可读断言）
    expect(detExtOf(await statusOpenWithText(page)), 'zipx 未绑定 → 检出扩展名应被签名改派纠偏为 zip').toBe('zip');
  });

  // BND-07 单列 describe：SW block 是本用例的拦截面前提（见下），不污染其余用例
  test.describe('BND-07 拦截面（SW block：SW 在位时请求经 SW 发出，页面网络栈拦不到）', () => {
    test.use({ serviceWorkers: 'block' });

    test('BND-07: .sqlite 绑定 foreign-data 组且其资产请求落三层链链首非空层', async ({ page }) => {
      test.setTimeout(180_000);
      // 拦截面用 context.route（仓内 b-diagram-file-2 实测：context.route 在 SW 在位
      // 与不在位均能命中；本用例另配 SW block，双保险）+ abort 兜底，不裸依赖真网。
      // 拦截面取「非同源外域请求」全量（宽面）：外域资产若改投别的基座（如 env 镜像域）
      // 也要被记录，否则「落期望基座」的判据会被拦截面自己遮蔽。
      const externalHits: string[] = [];
      // 应用同源基座取自 playwright 配置的 baseURL（注入前页面仍是 about:blank，
      // 不能用 page.url() 判同源）
      const appOrigin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4173').origin;
      await page.context().route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(appOrigin)) return route.continue();
        externalHits.push(url);
        return route.abort('failed');
      });

      await injectDir(page, [
        {
          name: 'probe.sqlite',
          content: '',
          type: 'application/octet-stream',
          b64: Buffer.from(garbageBytes()).toString('base64')
        }
      ]);
      await openTreeFile(page, 'probe.sqlite');

      // 归属锚：候选面 foreign-data 项（sqlite 归 foreign-data 组，非 hex/code）
      await expect.poll(() => openWithValues(page), { timeout: 60_000 }).toContain('foreign-data');

      // 资产请求（命中 mock 态）：foreign-data 组的 sql-wasm 资产请求发出并被拦截
      const assetHits = externalHits.filter((u) => u.endsWith(DATA_SQL_WASM_REL_PATH));
      await expect.poll(() => assetHits.length, { timeout: 90_000 }).toBeGreaterThan(0);
      // 层选锚：请求落链首非空层（env → 同源预留槽 → 缺省 CDN），且是 foreign-data
      // 组的包基座（per-package 派生：缺省 CDN 形态下 assets-standard@ → assets-data@；
      // env/同源形态为合并树根，不做替换）
      const expectedBase = assetsDataBase(chainHeadBase());
      for (const url of assetHits) {
        expect(hitsBase(url, expectedBase), `资产请求未落期望链首层基座 ${expectedBase}：${url}`).toBe(true);
      }
      // 同源预留槽：仅当源常量接线时才入判据（当前为空串 → 该层不参与判定，
      // 不用「零请求」恒真断言；接线后拦截面按同一前缀派生并断言请求落该层）
      if (SAME_ORIGIN_PREFIX.trim() === '') {
        console.info('[BND-07] 同源预留槽未接线（源常量为空串）→ 该层不在本次判据内');
      } else {
        expect(
          assetHits.some((u) => hitsBase(u, SAME_ORIGIN_PREFIX.trim())),
          `同源层已接线，资产请求应落同源前缀 ${SAME_ORIGIN_PREFIX}`
        ).toBe(true);
      }
    });
  });

  test('BND-08: 专有先注册、generated 补空位（不抢注半边）——生成物清单内被专有渲染器认领的扩展名逐个归属唯一 owner', async ({
    page
  }) => {
    test.setTimeout(240_000);
    // 外域引擎资产 abort 兜底（bpmn/typst/fods 等 CDN 引擎组）：本域只锚归属，
    // 渲染成败与判据无关——但真网不可达时会让渲染挂到超时，故一律 abort 收口
    await page.context().route('**cdn.jsdelivr.net/**', (route) => route.abort('failed'));

    await injectDir(
      page,
      DEDICATED_OWNERS.map(([ext], i) => ({
        name: corpusName(i, ext),
        content: `probe ${ext}\n`,
        type: 'text/plain'
      }))
    );

    for (const [i, [ext, owner]] of DEDICATED_OWNERS.entries()) {
      await openTreeFile(page, corpusName(i, ext));
      // 单次原子读出（不拆成「轮询长度 → 一次性读取」两步，避免读到半更新的候选面）：
      // ① 「自动」入口恰一项；② 恒在兜底项之外的专有候选恰一项且等于期望 owner。
      // ② 的判别力：owner 变更 / owner 被撤（落 code）/ 冲突检查被放宽（同扩展名被两
      // 渲染器认领 → 候选面出现两项）三种变更均打红。
      await expect
        .poll(
          async () => {
            const values = await openWithValues(page);
            return {
              auto: values.filter((v) => v === '').length,
              dedicated: dedicatedCandidates(values)
            };
          },
          { timeout: 60_000 }
        )
        .toEqual({ auto: 1, dedicated: [owner] });
    }
  });

  test('BND-09: generated 补空位（补空位半边）——仅在生成物清单内的扩展名归 code 认领，未注册扩展名同载荷落 hex 兜底', async ({
    page
  }) => {
    test.setTimeout(150_000);
    // 载荷为二进制（非文本）→ 若扩展名无 owner，探测链尾落 hex；owner 若是 code，
    // 则渲染器认领该扩展名并出 code 源码面（不做二进制拒收）
    const payloadB64 = Buffer.from(garbageBytes()).toString('base64');
    const specs: TextFileSpec[] = [
      ...FALLBACK_ONLY_EXTS.map((ext, i) => ({
        name: corpusName(i, ext),
        content: '',
        type: 'application/octet-stream',
        b64: payloadB64
      })),
      {
        name: corpusName(FALLBACK_ONLY_EXTS.length, UNREGISTERED_EXT),
        content: '',
        type: 'application/octet-stream',
        b64: payloadB64
      }
    ];
    await injectDir(page, specs);

    for (const [i, ext] of FALLBACK_ONLY_EXTS.entries()) {
      await openTreeFile(page, corpusName(i, ext));
      // 归属锚：owner = code（生成物补空位），检出扩展名保持原值
      await expect
        .poll(() => statusOpenWithText(page), { timeout: 30_000 })
        .toMatch(new RegExp(`代码/文本\\s*（${reEsc(ext)}）`));
      // code 源码面在场（补空位真的把该扩展名派给了 code 渲染器）
      await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 15_000 });
      // 否定面：未落 hex 兜底面（补空位失效 → 无 owner → 探测链尾 hex）
      await expect(page.locator('.vv-hex-row')).toHaveCount(0);
    }

    // 对照锚：同载荷 + 未注册扩展名 → 无 owner → 探测链尾 hex 兜底（渲染器 = 二进制）
    const ctlName = corpusName(FALLBACK_ONLY_EXTS.length, UNREGISTERED_EXT);
    await openTreeFile(page, ctlName);
    await expect
      .poll(() => statusOpenWithText(page), { timeout: 30_000 })
      .toMatch(new RegExp(`二进制\\s*（${reEsc(UNREGISTERED_EXT)}）`));
    await expect(page.locator('.vv-hex-row').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  });

  test('BND-10: 嵌套展开门按扩展名集合判定——depth=3 的归档类条目被拒展、非归档类条目可读、剔除项不拒展', async ({
    page
  }) => {
    test.setTimeout(180_000);
    await injectDir(page, [
      {
        name: 'nest.zip',
        content: '',
        type: 'application/zip',
        b64: await makeNestedArchiveB64()
      }
    ]);
    await openTreeFile(page, 'nest.zip');

    // 逐层下钻：outer ⊃ l1 ⊃ l2 ⊃ l3（l3 的 store 链段数 = 3 = MAX_ARCHIVE_DEPTH）
    const drill = async (entry: string): Promise<void> => {
      await page.locator('.vv-archive .vv-tree-row', { hasText: entry }).click();
      await expect(page.locator('.vv-tab.active', { hasText: entry })).toBeVisible({ timeout: 30_000 });
    };
    await drill('l1.zip');
    await drill('l2.zip');
    await drill('l3.zip');

    // ① 归档类条目（inner.7z ∈ ARCHIVE_EXTS）→ depth=3 命中拒展门
    await page.locator('.vv-archive .vv-tree-row', { hasText: 'inner.7z' }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'inner.7z' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-error-card')).toContainText('嵌套层数超限');

    // ② 非归档类条目（deep.txt ∉ ARCHIVE_EXTS）→ 同深度照常可读（深度门只拦归档类）
    await page.locator('.vv-tab', { hasText: 'l3.zip' }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'l3.zip' })).toBeVisible();
    await page.locator('.vv-archive .vv-tree-row', { hasText: 'deep.txt' }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'deep.txt' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-code-pre')).toContainText('deep payload');

    // ③ 剔除项（inner.zst 不在 ARCHIVE_EXTS）→ 不被拒展，按扩展名路由落 hex 兜底
    await page.locator('.vv-tab', { hasText: 'l3.zip' }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'l3.zip' })).toBeVisible();
    await page.locator('.vv-archive .vv-tree-row', { hasText: 'inner.zst' }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'inner.zst' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-hex-row').first()).toBeVisible({ timeout: 15_000 });
  });
});
