// tools/diagram-budget.mjs — spec §2.6 预算门禁：dist 图表引擎 chunk 总量 ≤4MB。
// 图表引擎（@viz-js/viz/nomnoml/mermaid/katex）经 vite.config.ts manualChunks 确定性
// 命名为 diagram-engines-*.js（并已排除出 PWA precache）。本脚本按该前缀统计产物
// 总体积，超预算即失败（exit 1），输出超限清单（按体积降序），提示按 spec 启用集
// 取舍（减引擎回落 kroki）。无第三方依赖；在仓库根运行（CI 与本地一致）。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET_BYTES = 4 * 1024 * 1024;
const dir = 'apps/web/build/_app/immutable/chunks';
let entries;
try {
  entries = readdirSync(dir)
    .filter((f) => f.startsWith('diagram-engines'))
    .map((f) => ({ file: f, size: statSync(join(dir, f)).size }));
} catch {
  console.error(`diagram-budget: 产物目录不存在（${dir}）——先构建（pnpm --filter web build / build:e2e）`);
  process.exit(1);
}
if (entries.length === 0) {
  console.error('diagram-engines chunk 未找到——manualChunks 未生效？');
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
