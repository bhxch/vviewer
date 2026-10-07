#!/usr/bin/env node
// gen-samples.mjs — 生成 M4 samples（zip/tar 样例；pdf 样例见 gen-sample-pdf.mjs）。
// 运行：node tools/gen-samples.mjs   （写入 samples/m4/sample.zip 与 samples/m4/sample.tar）
// tar 为纯 node 手写 USTAR 头（512B header + 内容 512 对齐 + 两个结束零块），不依赖系统 tar。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// jszip 依赖声明在 render-archive 包内（pnpm 严格布局），从该包目录解析
const require = createRequire(join(root, 'packages', 'render-archive', 'package.json'));
const JSZip = require('jszip');

/** 手写 USTAR（posix tar）header：512B，chksum 以空格占位求和后回填 */
function tarHeader(path, size, typeflag) {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (off, s, len) => {
    h.set(enc.encode(s).subarray(0, len), off);
  };
  put(0, path, 100); // name
  put(100, '0000644\0', 8); // mode
  put(108, '0000000\0', 8); // uid
  put(116, '0000000\0', 8); // gid
  put(124, `${size.toString(8).padStart(11, '0')}\0`, 12); // size（八进制）
  put(136, '00000000000\0', 12); // mtime
  put(148, '        ', 8); // chksum 占位参与求和
  h[156] = typeflag.charCodeAt(0);
  put(257, 'ustar\0', 6); // magic
  put(263, '00', 2); // version
  let sum = 0;
  for (const b of h) sum += b;
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `, 8);
  return h;
}

function align512(n) {
  return Math.ceil(n / 512) * 512;
}

/** entries: { path, content? } —— content 缺省视为目录条目 */
function buildTar(entries) {
  const chunks = [];
  const enc = new TextEncoder();
  for (const e of entries) {
    if (e.content === undefined) {
      chunks.push(tarHeader(`${e.path}/`, 0, '5'), new Uint8Array(512));
    } else {
      const body = typeof e.content === 'string' ? enc.encode(e.content) : e.content;
      chunks.push(tarHeader(e.path, body.length, '0'));
      chunks.push(body, new Uint8Array(align512(body.length) - body.length));
    }
  }
  chunks.push(new Uint8Array(1024)); // 结束块
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function write(dest, bytes) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  console.log(`written: ${dest} (${bytes.length} bytes)`);
}

async function main() {
  // zip 样例（jszip 生成）
  const zip = new JSZip();
  zip.file('hello.txt', 'hello vviewer\n');
  zip.file('notes.md', '# sample zip\n\n- 条目一\n- 条目二\n');
  zip.folder('nested').file('inner.txt', 'inner content\n');
  // 内嵌 zip（递归预览样例）：嵌套层内再放一个 zip（第 3 层不可再展开）
  const inner = new JSZip();
  inner.file('deep.txt', 'deep inside nested zip\n');
  zip.file('nested/inner.zip', await inner.generateAsync({ type: 'uint8array' }));
  write(join(root, 'samples', 'm4', 'sample.zip'), await zip.generateAsync({ type: 'uint8array' }));

  // tar 样例（libarchive 路径；含 hello.txt + nested/inner.txt 供 T7 E2E）
  write(
    join(root, 'samples', 'm4', 'sample.tar'),
    buildTar([
      { path: 'hello.txt', content: 'hello vviewer\n' },
      { path: 'nested/inner.txt', content: 'inner content\n' }
    ])
  );
}

await main();
