// extensions.test.ts — 扩展名清单契约（spec H T1 Step 3）。
//
// 覆盖面（计划 T1 Step 3 明列）：markdown 类扩展名（md/markdown）由 markdown 认领
// （非 code）、generated 兜底扩展名在集内、集合非空且与渲染器 extensions 并集一致（RF 8）。
//
// 单一来源纪律：清单由**实跑真实注册表**得出（scripts/collect-extensions.ts），
// custom editor 的 selector 由该清单生成——认领面与 selector 同源（Review Focus 8）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GENERATED_EXTENSIONS } from '@bhxch/vviewer-core';
import { collectClaimedExtensions } from '../scripts/collect-extensions';
import { MVP_RENDERERS } from '../src/webview/renderers';
import { assembleViewer, type AssembleDeps } from '../src/webview/assemble';
import { DEFAULT_WEBVIEW_SETTINGS } from '../src/host/protocol';
import { GENERATED_EXTENSIONS_PATH, REPO_ROOT, toSelector } from '../scripts/gen-manifest.mjs';

/** 装配入参夹具（与 assemble.test.ts 同款——跨文件守卫需真实装配层注册表） */
function makeDeps(overrides: Partial<AssembleDeps> = {}): AssembleDeps {
  return {
    settings: DEFAULT_WEBVIEW_SETTINGS,
    assets: {
      grammarsBase: 'https://webview/assets/grammars/',
      queriesBase: 'https://webview/assets/queries/',
      runtimeDir: 'https://webview/assets/',
      grammars: {},
      binaryWorkerUrl: 'https://webview/binary-worker.js',
      pdfWorkerModernUrl: 'https://webview/pdf/pdf.worker.min.mjs',
      pdfWorkerLegacyUrl: 'https://webview/pdf/pdf.worker.legacy.min.mjs',
      fontsBase: 'https://webview/fonts/',
      katexCssUrl: 'https://webview/katex.min.css',
      katexExportCssUrl: 'https://webview/katex.export.css',
      themesUrl: 'https://webview/assets/themes.json',
      highlightWorkerSourceUrl: 'https://webview/highlight-worker.js'
    },
    themeKind: 'light',
    resolveImage: async () => null,
    resolveLink: async () => ({ kind: 'missing' as const }),
    openLink: () => undefined,
    text: (key) => key,
    ...overrides
  };
}

/** 生成物缺失即 fail-fast 并给出修复命令（生成物不入库） */
function assertGeneratedFile(): void {
  const file = path.join(REPO_ROOT, GENERATED_EXTENSIONS_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`生成物缺失：${GENERATED_EXTENSIONS_PATH}\n修复命令：pnpm gen:sources`);
  }
}

describe('扩展名清单 · 注册表实跑', () => {
  it('生成物存在（缺失即 fail-fast，提示 pnpm gen:sources）', () => {
    assertGeneratedFile();
  });

  it('集合非空且升序、无重复', () => {
    assertGeneratedFile();
    const { extensions } = collectClaimedExtensions();
    expect(extensions.length).toBeGreaterThan(0);
    expect(new Set(extensions).size).toBe(extensions.length);
    expect([...extensions].sort()).toEqual(extensions);
  });

  it('markdown 类扩展名（md/markdown）由 markdown 认领（非 code）', () => {
    assertGeneratedFile();
    const { owners } = collectClaimedExtensions();
    expect(owners['md']).toBe('markdown');
    expect(owners['markdown']).toBe('markdown');
  });

  it('专有渲染器的扩展名各归其主（html/htm→html、pdf→pdf、png→image、mp4→av、jsonl→jsonl）', () => {
    assertGeneratedFile();
    const { owners } = collectClaimedExtensions();
    expect(owners['html']).toBe('html');
    expect(owners['htm']).toBe('html');
    expect(owners['pdf']).toBe('pdf');
    expect(owners['png']).toBe('image');
    expect(owners['mp4']).toBe('av');
    expect(owners['jsonl']).toBe('jsonl');
    expect(owners['ndjson']).toBe('jsonl');
  });

  it('**跨文件守卫**：selector（生成脚本输出）与运行时认领面（装配层实际注册表）同源', () => {
    // 认领面 > selector → 用户双击不接管；< selector → 接管后无渲染器。两面必须逐项
    // 相等——若只在装配层加渲染器而生成脚本未同步，本断言即红（Review Focus 8）。
    const claimed = collectClaimedExtensions().extensions;
    const { registry } = assembleViewer(makeDeps());
    const runtime = new Set<string>();
    for (const renderer of registry.all()) {
      for (const ext of renderer.extensions) runtime.add(ext.toLowerCase());
    }
    for (const ext of GENERATED_EXTENSIONS) {
      if (registry.byExtension(ext)) runtime.add(ext.toLowerCase());
    }
    expect([...runtime].sort()).toEqual([...claimed].sort());
  });

  it('generated 兜底扩展名在集内（装序铁律：generated 只补空位，不覆盖专有认领）', () => {
    assertGeneratedFile();
    const { extensions, owners } = collectClaimedExtensions();
    const set = new Set(extensions);
    const dedicated = new Set(
      MVP_RENDERERS.flatMap((r) => r.extensions.map((e) => e.toLowerCase()))
    );
    // generated 中未被任何专有渲染器认领的项 → 兜底归 code（全集断言，不取样）
    const fallbackOnly = GENERATED_EXTENSIONS.filter((e) => !dedicated.has(e.toLowerCase()));
    expect(fallbackOnly.length).toBeGreaterThan(0);
    for (const ext of fallbackOnly) {
      const key = ext.toLowerCase();
      expect(set.has(key), `generated 兜底扩展名 ${ext} 缺失`).toBe(true);
      expect(owners[key]).toBe('code');
    }
    // 已被专有渲染器认领的 generated 项不被兜底覆盖
    expect(owners['jsonl']).toBe('jsonl');
    expect(owners['pdf']).toBe('pdf');
    expect(owners['md']).toBe('markdown');
  });

  it('集合与渲染器 extensions 并集一致（每个渲染器的每个扩展名都在集内）', () => {
    assertGeneratedFile();
    const { extensions } = collectClaimedExtensions();
    const set = new Set(extensions);
    for (const renderer of MVP_RENDERERS) {
      for (const ext of renderer.extensions) {
        expect(set.has(ext.toLowerCase()), `渲染器 ${renderer.id} 的扩展名 ${ext} 缺失`).toBe(true);
      }
    }
  });

  it('selector glob 形态为「*.<ext>」且与清单一一对应', () => {
    assertGeneratedFile();
    const { extensions } = collectClaimedExtensions();
    const selector = toSelector(extensions);
    expect(selector).toHaveLength(extensions.length);
    expect(selector).toContain('*.md');
    expect(selector).toContain('*.markdown');
    expect(selector.every((g) => g.startsWith('*.') && g.length > 2)).toBe(true);
    // glob 元字符不得出现在扩展名里（否则 selector 语义漂移）
    expect(selector.filter((g) => /[*?[\]{}]/.test(g.slice(2)))).toEqual([]);
  });
});
