import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

const samples = fileURLToPath(new URL('../../../samples/m2', import.meta.url));

/** samples/m2 的入库样例（b64 携带）+ E2E 内生成的大文件（content 携带） */
interface FilePayload {
  name: string;
  type: string;
  b64?: string;
  content?: string;
}

const SAMPLES: FilePayload[] = [
  { name: 'sample.ts', type: 'text/plain' },
  { name: 'sample.rs', type: 'text/plain' },
  { name: 'sample.md', type: 'text/markdown' }
].map((f) => ({ ...f, b64: readFileSync(`${samples}/${f.name}`).toString('base64') }));

/**
 * M2 E2E 通道：复用 m1.spec.ts 的模式——页面内 new File + Object.defineProperty 写
 * webkitRelativePath 后经调试钩子 __vvOpenDirImpl 注入，走真实 openDirectoryViaInput 通道。
 */
async function openDir(page: Page, payloads: FilePayload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, b64, content }) => {
      const f =
        content !== undefined
          ? new File([content], name, { type })
          : new File([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], name, { type });
      // webkitRelativePath 是原型上仅 getter 的访问器，defineProperty 写自有属性遮蔽（与真实 input 一致）
      Object.defineProperty(f, 'webkitRelativePath', { value: `m2/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

test('sample.ts 走 tree-sitter 主路径（ts-* span），切换代码主题零重解析', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, SAMPLES);
  await openFile(page, 'sample.ts');

  // tree-sitter 生效：ts-<capture> span（hljs 兜底产物是 hljs-*，两者可分辨引擎来源）。
  // helix 查询无裸 keyword 捕获，关键字走 keyword.storage.type / keyword.function 等子类
  const tsSpans = page.locator('.vv-code-pre span[class^="ts-"]');
  await expect(tsSpans.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible();

  const before = await page.evaluate(() => ({
    count: document.querySelectorAll('.vv-code-pre span[class^="ts-"]').length,
    firstClass: document.querySelector('.vv-code-pre span[class^="ts-"]')?.className ?? '',
    styleText: document.getElementById('vv-code-theme')?.textContent ?? ''
  }));
  expect(before.count).toBeGreaterThan(0);

  // 持有当前 DOM 节点引用，切主题后应仍是同一节点（未重渲染=零重解析的直接证据）
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__vvProbeEl = document.querySelector(
      '.vv-code-pre span[class^="ts-"]'
    );
  });

  // 代码主题切换（TopBar select）：只整体替换 style#vv-code-theme 的 CSS 变量
  await page.getByLabel('代码主题').selectOption('github_dark');
  await page.waitForFunction(
    (prev) => (document.getElementById('vv-code-theme')?.textContent ?? '') !== prev,
    before.styleText
  );

  const after = await page.evaluate(() => ({
    count: document.querySelectorAll('.vv-code-pre span[class^="ts-"]').length,
    firstClass: document.querySelector('.vv-code-pre span[class^="ts-"]')?.className ?? '',
    sameNode:
      (window as unknown as { __vvProbeEl?: Element }).__vvProbeEl ===
      document.querySelector('.vv-code-pre span[class^="ts-"]')
  }));
  expect(after.count).toBe(before.count); // span 数量不变
  expect(after.firstClass).toBe(before.firstClass); // 类名不变
  expect(after.sameNode).toBe(true); // 同一 DOM 节点：零重解析
});

test('sample.rs（查询失配）与 sample.md（不在 wasm 清单）自动降级 hljs 整文件', async ({ page }) => {
  await page.goto('/');
  await openDir(page, SAMPLES);

  // rust 在 14 失败清单内（查询引用预编译 grammar 没有的节点）→ 引擎报错 → hljs 兜底
  await openFile(page, 'sample.rs');
  const hljsSpans = page.locator('.vv-code-pre span[class^="hljs-"]');
  await expect(hljsSpans.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);

  // markdown 不在 36 个 grammar wasm 清单内 → 同样 hljs 兜底
  await openFile(page, 'sample.md');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
});

test('6MB 文本按降级链走 hljs 分块，不发起 tree-sitter 高亮', async ({ page }) => {
  await page.goto('/');
  // 19B × 320000 = 6.08MB ∈ (5MB, 20MB] → resolveStrategy = 'hljs-block'
  await openDir(page, [{ name: 'big.js', type: 'text/javascript', content: 'const vv = 1; // c\n'.repeat(320000) }]);
  await openFile(page, 'big.js');

  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
  // 本页面从未发起过 tree-sitter 高亮请求（__vvLastHighlight* 未被写入）
  const lang = await page.evaluate(() => (window as unknown as { __vvLastHighlightLang?: string }).__vvLastHighlightLang);
  expect(lang).toBeUndefined();
});

test('5MB 文本 tree-sitter 高亮性能计时（__vvLastHighlightMs，目标 <2s）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // 19B × 266000 = 5.054MB ≤ TREE_SITTER_MAX_BYTES(5MB) → tree-sitter 主路径
  await openDir(page, [{ name: 'big5.ts', type: 'text/plain', content: 'const vv = 1; // c\n'.repeat(266000) }]);
  await openFile(page, 'big5.ts');

  const tsSpans = page.locator('.vv-code-pre span[class^="ts-"]');
  await expect(tsSpans.first()).toBeVisible({ timeout: 60_000 });

  const ms = await page.evaluate(() => ({
    ms: (window as unknown as { __vvLastHighlightMs?: number }).__vvLastHighlightMs,
    lang: (window as unknown as { __vvLastHighlightLang?: string }).__vvLastHighlightLang
  }));
  expect(ms.lang).toBe('typescript');
  expect(ms.ms).toBeGreaterThan(0);
  // 性能数值仅记录不阻塞（验收门槛：超标写入报告）
  console.log(`[perf] 5MB tree-sitter 高亮耗时（含 worker 往返）: ${Math.round(ms.ms ?? -1)}ms`);
});
