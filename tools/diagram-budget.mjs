// tools/diagram-budget.mjs — spec §2.6 预算门禁：图表引擎 chunk 总量 ≤4MB。
// 统计口径仅本期新增引擎 @viz-js/viz + nomnoml：经 vite.config.ts diagramEngineChunk
// 的 codeSplitting.groups 归堆 + chunkFileNames 特判命名为 diagram-engines-*.js
//（并已排除出 PWA precache）。mermaid/katex 为存量引擎不在口径（维持 SvelteKit
// 默认分块与 precache 地位，裁决备案见 vite.config.ts 同名注释）。
// spec §7 起追加 svgbob 前端 wasm 引擎：diagram-engines chunk 之外，同包动态
// import 的 wasm-bindgen glue 内 new URL(..., import.meta.url) 经 vite 资产 emit
// 到 immutable/assets/，实测命名 svgbob_wasm_bg.BbNMU48o.wasm（内容 hash 后缀，
// ~0.37MB，wasm-opt -Oz 后），一并计入总量。本脚本按上述口径统计产物总体积，
// 超预算即失败（exit 1），输出超限清单（按体积降序），提示按 spec 启用集取舍
//（减引擎回落 kroki）。无第三方依赖；在仓库根运行（CI 与本地一致）。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET_BYTES = 4 * 1024 * 1024;
const dir = 'apps/web/build/_app/immutable/chunks';
let entries;
try {
  entries = readdirSync(dir)
    .filter((f) => f.startsWith('diagram-engines'))
    .map((f) => ({ file: f, size: statSync(join(dir, f)).size }));
  // spec §7：svgbob wasm 资产计入口径。正则按 svgbob 前缀 + .wasm 后缀匹配，
  // hash 段（.BbNMU48o. 之类）由中间 .* 覆盖——bindgen 升级改 glue 资产命名形态时
  // 按实际 emit 名回修本行。assets 目录缺失与 chunk 缺失同判：构建产物不存在错误出口
  const assetsDir = 'apps/web/build/_app/immutable/assets';
  for (const f of readdirSync(assetsDir).filter((f) => /svgbob.*\.wasm$/.test(f))) {
    entries.push({ file: `assets/${f}`, size: statSync(join(assetsDir, f)).size });
  }
} catch {
  console.error(`diagram-budget: 产物目录不存在（${dir}）——先构建（pnpm --filter web build / build:e2e）`);
  process.exit(1);
}
if (entries.length === 0) {
  console.error('diagram-engines chunk 未找到——codeSplitting.groups/chunkFileNames 特判未生效？');
  process.exit(1);
}
const total = entries.reduce((sum, e) => sum + e.size, 0);
const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`diagram-engines: ${mb(total)}MB / 预算 ${mb(BUDGET_BYTES)}MB`);
if (total > BUDGET_BYTES) {
  console.error('超出预算，按体积降序：');
  for (const e of [...entries].sort((a, b) => b.size - a.size)) {
    console.error(`  ${e.file} ${mb(e.size)}MB`);
  }
  console.error('处置：按 spec §2.6 调整图表引擎启用集（减引擎回落 kroki），不得放宽门禁。');
  process.exit(1);
}
