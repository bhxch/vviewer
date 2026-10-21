// tools/worker-budget.mjs — 多端发布阶段三体积门禁：worker 脚本产物（wasm+js，
// server/worker/build/——worker-build 生成，`wrangler deploy --dry-run
// --outdir=build` 或本地 wrangler dev 刷新）总体积 <5MB（plan Global
// Constraints「worker 脚本产物 <5MB，CI 断言」）。统计口径为产物目录全部文件
// （部署面 = wasm+js 主体，worker-build 输出形态变化时口径自动覆盖）。超预算
// 即失败（exit 1）并输出按体积降序清单——处置面为 wasm 依赖树瘦身（compute/
// reqwest 全家已经 core feature 裁剪挡在构建图外，新增重依赖前先过本门），
// 不得放宽门禁。无第三方依赖；在仓库根运行（CI 与本地一致）。
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BUDGET_BYTES = 5 * 1024 * 1024;
const dir = 'server/worker/build';

// 递归收集产物文件（worker-build 输出含平铺 wasm/js 与可能的子目录 shim）
function walk(d, base = d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p, base) : [{ file: relative(base, p), size: statSync(p).size }];
  });
}

let entries;
try {
  entries = walk(dir);
} catch {
  console.error(
    `worker-budget: 产物目录不存在（${dir}）——先构建（cd server/worker && npx wrangler deploy --dry-run --outdir=build；本地冒烟经 wrangler dev 亦可）`
  );
  process.exit(1);
}
if (entries.length === 0) {
  console.error('worker-budget: 产物目录为空——worker-build 未生效？');
  process.exit(1);
}
const total = entries.reduce((sum, e) => sum + e.size, 0);
const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`worker 产物（${entries.length} 文件）: ${mb(total)}MB / 预算 ${mb(BUDGET_BYTES)}MB`);
for (const e of [...entries].sort((a, b) => b.size - a.size)) {
  console.log(`  ${e.file} ${mb(e.size)}MB`);
}
if (total > BUDGET_BYTES) {
  console.error('超出预算——处置：wasm 依赖树瘦身（feature 裁剪/依赖替换），不得放宽门禁。');
  process.exit(1);
}
