#!/usr/bin/env node
// gen-samples.mjs — 生成 M4 samples（zip/tar/mp4/docx/xlsx/pptx 样例；pdf 样例见 gen-sample-pdf.mjs）。
// 运行：node tools/gen-samples.mjs   （写入 samples/m4/ 下各样例）
// tar 为纯 node 手写 USTAR 头（512B header + 内容 512 对齐 + 两个结束零块），不依赖系统 tar；
// mp4 为内嵌 base64 的最小合法 H.264 Baseline 视频（921B，ffmpeg+libopenh264 生成，moov 前置），
// 环境无关可复现；docx 为手写最小 OOXML（[Content_Types].xml + _rels/.rels + word/document.xml，
// 实测可被 mammoth 解析）；xlsx 用 SheetJS 生成真实工作簿；pptx 为手写最小 OOXML 幻灯片包。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// jszip 依赖声明在 render-archive 包内（pnpm 严格布局），从该包目录解析
const requireFromArchive = createRequire(join(root, 'packages', 'render-archive', 'package.json'));
const JSZip = requireFromArchive('jszip');
// xlsx 依赖声明在 render-doc 包内（M4 Task 5 起提供）
const requireFromDoc = createRequire(join(root, 'packages', 'render-doc', 'package.json'));
const XLSX = requireFromDoc('xlsx');

/** 最小合法 mp4（64x64 黑帧 x4，h264 baseline，faststart；ffmpeg -f lavfi -i color=... 生成） */
const SAMPLE_MP4_B64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMpbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAKAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlN0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAACgAAAAAAABAAAAAAHLbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABdm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAATZzdGJsAAAArnN0c2QAAAAAAAAAAQAAAJ5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABGUxhdmM2Mi4yOC4xMDIgbGlib3BlbmgyNjQAAAAAAAAAGP//AAAAJGF2Y0MBQsAU/+EADWdCwBSMaEJMBAeEQjUBAARozjyAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAADIAAAAyAAAAAGHN0dHMAAAAAAAAAAQAAAAQAAAIAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAQAAAABAAAAJHN0c3oAAAAAAAAAAAAAAAQAAAAcAAAADAAAAAwAAAAMAAAAFHN0Y28AAAAAAAAAAQAAA1kAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMgAAAAhmcmVlAAAASG1kYXQAAAAYZbgABAnkxQABGfk5OTrrrrrrrrqSuuvAAAAACGHgAH5AnhGAAAAACGHgAL5A/hGAAAAACGHgAP5AV4Rg';

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

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** OPC 包通用：[Content_Types].xml + _rels/.rels（指向 main 部件） */
function opcZip(contentTypesXml, mainPart) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', XML_DECL + contentTypesXml);
  zip.file(
    '_rels/.rels',
    XML_DECL
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/>`
    + '</Relationships>'
  );
  return zip;
}

/** 最小合法 docx：三件套即可被 mammoth 解析（实测见 task-5 报告） */
async function buildSampleDocx() {
  const zip = opcZip(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>',
    'word/document.xml'
  );
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  zip.file(
    'word/document.xml',
    XML_DECL
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + p('vviewer docx 样例')
    + p('此文件由 tools/gen-samples.mjs 手工构造为最小 OOXML 包（无 Word 依赖），供 E2E 与人工预览。')
    + p('列表项一')
    + p('列表项二')
    + '</w:body></w:document>'
  );
  return zip.generateAsync({ type: 'uint8array' });
}

/** 最小合法 pptx：presentation + 两张幻灯片（vviewer pptx 渲染器按 slideN 提取文本） */
async function buildSamplePptx() {
  const zip = opcZip(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
    + '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
    + '</Types>',
    'ppt/presentation.xml'
  );
  zip.file(
    'ppt/presentation.xml',
    XML_DECL
    + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:sldIdLst/></p:presentation>'
  );
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const slide = (paras) =>
    XML_DECL
    + `<p:sld ${A} ${P}><p:cSld><p:spTree><p:sp><p:txBody>`
    + paras.map((t) => `<a:p><a:r><a:t xml:space="preserve">${t}</a:t></a:r></a:p>`).join('')
    + '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  zip.file('ppt/slides/slide1.xml', slide(['vviewer pptx 样例', '第一张幻灯片要点']));
  zip.file('ppt/slides/slide2.xml', slide(['第二张', '要点 A', '要点 B']));
  return zip.generateAsync({ type: 'uint8array' });
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

  // mp4 样例（ArtPlayer 视频路径；最小合法 H.264 Baseline）
  write(join(root, 'samples', 'm4', 'sample.mp4'), Uint8Array.from(atob(SAMPLE_MP4_B64), (c) => c.charCodeAt(0)));

  // docx 样例（mammoth 渲染路径；手写最小 OOXML）
  write(join(root, 'samples', 'm4', 'sample.docx'), await buildSampleDocx());

  // xlsx 样例（SheetJS 渲染路径；双 sheet 含中文表头与数字）
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['名称', '数量', '单价'],
      ['苹果', 3, 5.2],
      ['香蕉', 12, 2.8]
    ]),
    '清单'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['季度', '营收'], ['Q1', 1024], ['Q2', 2048]]),
    '汇总'
  );
  write(join(root, 'samples', 'm4', 'sample.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  // pptx 样例（文本提纲降级路径；手写最小 OOXML 幻灯片包）
  write(join(root, 'samples', 'm4', 'sample.pptx'), await buildSamplePptx());
}

await main();
