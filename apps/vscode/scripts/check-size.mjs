// check-size.mjs — 打包体积门（spec §5「vsce package 体积 <100MB」）。
//
// 两条同门：
// - `dist/` 递归字节 <100MB —— 快速预检（构建内跑）
// - `.vsix` 实包字节 <100MB —— **准**（spec 口径：vsce package 产物）
//
// 体积构成（spec 口径）：lite grammar 集 46.4MiB + pdfjs worker 双支 ~2.6MiB（均有
// 消费面，非死重）+ queries ~1MiB + runtime 0.2MiB + 代码/图表引擎 ~10MiB 量级。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 体积上限（100MB） */
export const SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

/** 递归求目录内全部文件字节和（符号链接按其目标文件计） */
export function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

/** 断言字节数严格小于上限（超限即抛错，附实际值与上限） */
export function assertUnderLimit(bytes, limit = SIZE_LIMIT_BYTES, label = '体积') {
  if (bytes >= limit) {
    throw new Error(
      `[vscode] ${label}超限：${(bytes / 1048576).toFixed(2)}MiB ≥ ${(limit / 1048576).toFixed(0)}MiB`
    );
  }
  return bytes;
}

/** 体积门整体校验（dist/ 预检 + .vsix 实包） */
export function checkSize({ distDir, vsixPath, limit = SIZE_LIMIT_BYTES } = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const appDir = path.resolve(here, '..');
  const dist = distDir ?? path.join(appDir, 'dist');
  const vsix = vsixPath ?? path.join(appDir, 'out', 'vviewer-vscode.vsix');
  const distBytes = dirSize(dist);
  assertUnderLimit(distBytes, limit, 'dist/ 递归字节');
  if (fs.existsSync(vsix)) {
    const vsixBytes = fs.statSync(vsix).size;
    assertUnderLimit(vsixBytes, limit, '.vsix 实包字节');
    return { distBytes, vsixBytes };
  }
  return { distBytes, vsixBytes: null };
}

// CLI：node scripts/check-size.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = checkSize();
  console.log(
    `[vscode] 体积门通过：dist ${(result.distBytes / 1048576).toFixed(2)}MiB` +
      (result.vsixBytes === null
        ? '｜.vsix 未产出（跳过实包校验）'
        : `｜vsix ${(result.vsixBytes / 1048576).toFixed(2)}MiB`)
  );
}
