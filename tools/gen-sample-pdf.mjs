#!/usr/bin/env node
// gen-sample-pdf.mjs — 手工构造最小合法 PDF 1.4（单页，含文本 "vviewer pdf sample"）。
// 标准字体 Helvetica 免嵌入；xref 偏移由脚本计算保证合法（严格 reader 可解析）。
// 运行：node tools/gen-sample-pdf.mjs > samples/m4/sample.pdf
import { writeFileSync } from 'node:fs';

const TEXT = 'vviewer pdf sample';

const contentStream = `BT\n/F1 24 Tf\n72 720 Td\n(${TEXT}) Tj\nET`;

/** 对象编号 → 序列化体（不含 "n 0 obj" 头尾） */
const objects = new Map([
  [1, '<< /Type /Catalog /Pages 2 0 R >>'],
  [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
  [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
  [4, `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`],
  [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']
]);

let out = '%PDF-1.4\n';
const offsets = new Map();
for (const [num, body] of objects) {
  offsets.set(num, out.length);
  out += `${num} 0 obj\n${body}\nendobj\n`;
}

const xrefStart = out.length;
const count = objects.size + 1;
out += `xref\n0 ${count}\n`;
out += '0000000000 65535 f \n';
for (let n = 1; n < count; n++) {
  out += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
}
out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const dest = process.argv[2];
if (dest) writeFileSync(dest, out, 'latin1');
else process.stdout.write(out, 'latin1');
