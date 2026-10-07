#!/usr/bin/env node
// gen-samples.mjs — 生成 M4 samples（zip 样例；pdf 样例见 gen-sample-pdf.mjs）。
// 运行：node tools/gen-samples.mjs   （默认写入 samples/m4/sample.zip）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// jszip 依赖声明在 render-archive 包内（pnpm 严格布局），从该包目录解析
const require = createRequire(join(root, 'packages', 'render-archive', 'package.json'));
const JSZip = require('jszip');

async function main() {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello vviewer\n');
  zip.file('notes.md', '# sample zip\n\n- 条目一\n- 条目二\n');
  zip.folder('nested').file('inner.txt', 'inner content\n');
  // 内嵌 zip（递归预览样例）：嵌套层内再放一个 zip（第 3 层不可再展开）
  const inner = new JSZip();
  inner.file('deep.txt', 'deep inside nested zip\n');
  zip.file('nested/inner.zip', await inner.generateAsync({ type: 'uint8array' }));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const dest = process.argv[2] ?? join(root, 'samples', 'm4', 'sample.zip');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  console.log(`written: ${dest} (${bytes.length} bytes)`);
}

await main();
