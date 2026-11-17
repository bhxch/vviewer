/**
 * collect-extensions.ts — 扩展名清单生成入口（spec H T1）。
 *
 * 单一来源纪律：custom editor 的 selector 集合 = **注册表有效认领扩展名全集**，
 * 由本脚本实跑真实注册表得出（不手维护清单）——认领面与 selector 同源于一次装配，
 * 两侧天然一致（Review Focus 8：认领面大于 selector → 用户双击不接管；小于 selector
 * → 接管后无渲染器）。
 *
 * 装序铁律：**专有渲染器先于 generated 兜底安装**——`installFallbackExtensions` 遇已
 * 认领扩展名即跳过（`md`/`markdown`/`html`/`htm` 由 code 渲染器显式不认领，归
 * markdown/html 渲染器）。
 *
 * 本文件是 esbuild 打包后在 Node 中实跑的入口（gen-manifest.mjs 消费其 stdout JSON）；
 * 同时导出 `collectClaimedExtensions` 供单测直测。
 */
import { createRegistry, GENERATED_EXTENSIONS } from '@bhxch/vviewer-core';
import { codeRenderer } from '@bhxch/vviewer-render-text';
import { markdownRenderer } from '@bhxch/vviewer-markdown';
import { htmlRenderer } from '@bhxch/vviewer-render-text/html';
import { imageRenderer } from '@bhxch/vviewer-render-media';
import { avRenderer } from '@bhxch/vviewer-render-media/av';
import { pdfRenderer } from '@bhxch/vviewer-render-doc';
import { hexRenderer } from '@bhxch/vviewer-render-binary';
import { jsonlRenderer } from '@bhxch/vviewer-render-text/jsonl';

/** 有效认领扩展名与其所有者渲染器 id */
export interface ClaimedExtensions {
  /** 扩展名全集（小写、升序） */
  extensions: string[];
  /** 扩展名 → 所有者渲染器 id */
  owners: Record<string, string>;
}

/**
 * 实跑注册表得出有效认领扩展名全集。
 *
 * 注意：`installFallbackExtensions` 只写注册表的「扩展名 → 所有者」映射，**不改**所有者
 * 渲染器的 `extensions` 数组——故认领集必须经 `registry.byExtension()` 求取（登记项 ∪
 * 渲染器自身扩展名，逐个查其是否被有效认领），不能只读 `renderer.extensions`。
 */
export function collectClaimedExtensions(): ClaimedExtensions {
  const registry = createRegistry();

  // 装序：专有渲染器先注册（generated 兜底只补空位）
  registry.install(codeRenderer);
  registry.install(markdownRenderer);
  registry.install(htmlRenderer);
  registry.install(imageRenderer);
  registry.install(avRenderer);
  registry.install(pdfRenderer);
  registry.install(hexRenderer);
  registry.install(jsonlRenderer);
  registry.installFallbackExtensions('code', GENERATED_EXTENSIONS);

  const candidates = new Set<string>();
  for (const renderer of registry.all()) {
    for (const ext of renderer.extensions) candidates.add(ext.toLowerCase());
  }
  for (const ext of GENERATED_EXTENSIONS) candidates.add(ext.toLowerCase());

  const owners: Record<string, string> = {};
  for (const ext of [...candidates].sort()) {
    const owner = registry.byExtension(ext);
    if (owner) owners[ext] = owner.id;
  }
  return { extensions: Object.keys(owners), owners };
}

// CLI 形态：stdout 输出 JSON（gen-manifest.mjs 以 VV_COLLECT_EXTENSIONS_PRINT=1 消费）。
// 用环境变量而非 argv 判定——本文件既被 esbuild 打包成 CJS 在 Node 中实跑（import.meta
// 在 CJS 产物下为空，argv 判定不可靠），也被单测直接 import（此时不得污染 stdout）。
if (process.env.VV_COLLECT_EXTENSIONS_PRINT === '1') {
  process.stdout.write(JSON.stringify(collectClaimedExtensions()));
}
