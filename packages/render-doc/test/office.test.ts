// office.test.ts — Office 三件套渲染器单测（M4 Task 5）。
// docx：手工构造最小 OOXML（[Content_Types].xml + _rels/.rels + word/document.xml
// 三件套，实测可被 mammoth 解析，无需入库真实 fixture）；xlsx：SheetJS 在测试内
// 构造 workbook 后 XLSX.write 造真实 xlsx buffer；pptx：手工 zip 造 slide XML
// （降级路径为文本提取，见 pptxText）。渲染类断言在 jsdom 下直接跑 render()。
import { describe, expect, it } from 'vitest';
import * as JsZipNs from 'jszip';
import * as XlsxNs from 'xlsx';
import type { Detection, FileSource } from '@vviewer/core';
import { docxRenderer } from '../src/docx';
import { xlsxRenderer } from '../src/xlsx';
import { pptxRenderer } from '../src/pptx';
import { decodeXmlEntities, extractSlideLines } from '../src/pptxText';

// CJS 双形态互操作（先例：render-archive zipStore.ts）
const JSZip = ((JsZipNs as unknown as { default?: typeof JsZipNs }).default ?? JsZipNs);
const XLSX = ((XlsxNs as unknown as { default?: typeof XlsxNs }).default ?? XlsxNs);

const source: FileSource = {
  storeId: 't',
  storeLabel: '测试',
  path: '/sample',
  name: 'sample',
  store: {} as never
};
const det: Detection = { ext: 'docx', signature: 'zip' };

function xmlDecl(s: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`;
}

/** 最小合法 docx：OPC 三件套（实测 mammoth 1.13 可解析，含中文与实体） */
async function buildMinimalDocx(paragraphsXml: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    xmlDecl(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>'
    )
  );
  zip.file(
    '_rels/.rels',
    xmlDecl(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>'
    )
  );
  const body = paragraphsXml
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    xmlDecl(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${body}</w:body></w:document>`
    )
  );
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

async function renderInto(
  renderer: typeof docxRenderer | typeof xlsxRenderer | typeof pptxRenderer,
  buffer: Uint8Array
): Promise<HTMLElement> {
  const target = document.createElement('div');
  const inst = await renderer.render(buffer, target, source, det);
  expect(typeof inst.destroy).toBe('function');
  return target;
}

describe('docxRenderer', () => {
  it('段落渲染为 .vv-docx-content 内的 p', async () => {
    const buf = await buildMinimalDocx(['Hello vviewer', '第二段中文']);
    const target = await renderInto(docxRenderer, buf);
    const ps = [...target.querySelectorAll('.vv-docx-content p')];
    expect(ps.map((p) => p.textContent)).toEqual(['Hello vviewer', '第二段中文']);
  });

  it('XML 实体经 mammoth 解码为文本后输出', async () => {
    const buf = await buildMinimalDocx(['a &amp; b &lt;c&gt;']);
    const target = await renderInto(docxRenderer, buf);
    const p = target.querySelector('.vv-docx-content p');
    expect(p?.textContent).toBe('a & b <c>');
  });

  it('destroy 移除渲染 DOM', async () => {
    const buf = await buildMinimalDocx(['x']);
    const target = document.createElement('div');
    const inst = await docxRenderer.render(buf, target, source, det);
    expect(target.querySelector('.vv-docx')).not.toBeNull();
    inst.destroy();
    expect(target.querySelector('.vv-docx')).toBeNull();
  });

  it('非 ZIP 输入早失败并给出中文错误（错误卡语义）', async () => {
    const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]); // "%PDF-"
    await expect(docxRenderer.render(garbage, document.createElement('div'), source, det))
      .rejects.toThrow(/ZIP/);
  });

  it('sniff 永不改派（SDD 裁决：部件缺失由 render 报错卡）', async () => {
    const notZip = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(docxRenderer.sniff?.(notZip, det)).resolves.toBeNull();
    const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(docxRenderer.sniff?.(zipHead, det)).resolves.toBeNull();
  });
});

describe('xlsxRenderer', () => {
  /** 测试内用 SheetJS 造真实 xlsx buffer（type:'array' → ArrayBuffer） */
  function buildWorkbook(sheets: Record<string, unknown[][]>): Uint8Array {
    const wb = XLSX.utils.book_new();
    for (const [name, aoa] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    }
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
  }

  it('渲染首个 sheet 为 table，单元格文本正确', async () => {
    const buf = buildWorkbook({ 表一: [['名称', '数量'], ['苹果', 3], ['香蕉', 12]] });
    const target = await renderInto(xlsxRenderer, buf);
    const rows = [...(target.querySelector('.vv-xlsx-sheet table') as HTMLTableElement).rows];
    expect(rows.map((r) => [...r.cells].map((c) => c.textContent))).toEqual([
      ['名称', '数量'],
      ['苹果', '3'],
      ['香蕉', '12']
    ]);
  });

  it('多 sheet 页签切换：默认首个可见，点击后切换', async () => {
    const buf = buildWorkbook({ 甲: [['a1']], 乙: [['b1']] });
    const target = await renderInto(xlsxRenderer, buf);
    const tabs = [...target.querySelectorAll<HTMLButtonElement>('.vv-xlsx-tab')];
    expect(tabs.map((b) => b.textContent)).toEqual(['甲', '乙']);
    const hosts = [...target.querySelectorAll<HTMLDivElement>('.vv-xlsx-sheet')];
    expect(hosts[0]?.hidden).toBe(false);
    expect(hosts[1]?.hidden).toBe(true);
    tabs[1]!.click();
    expect(hosts[0]?.hidden).toBe(true);
    expect(hosts[1]?.hidden).toBe(false);
    expect(target.textContent).toContain('b1');
  });

  it('大 sheet 截断为前 200 行并显示提示条', async () => {
    const rows: unknown[][] = [['列']];
    for (let i = 1; i <= 249; i++) rows.push([`r${i}`]);
    const buf = buildWorkbook({ 大表: rows });
    const target = await renderInto(xlsxRenderer, buf);
    const table = target.querySelector('.vv-xlsx-sheet table') as HTMLTableElement;
    expect(table.rows).toHaveLength(200);
    expect(table.rows[0]!.textContent).toBe('列');
    expect(table.rows[199]!.textContent).toBe('r199');
    const note = target.querySelector('.vv-xlsx-truncated');
    expect(note?.textContent).toContain('250');
    expect(note?.textContent).toContain('200');
  });

  it('垃圾输入不抛错（SheetJS 宽容解析，最坏渲染空表不崩溃）', async () => {
    // 实测 xlsx@0.18.5 对任意/空输入均不抛错（宽容解析，可能得到近乎空的
    // workbook）；错误卡语义仅来自 docx/pptx 的 ZIP 早失败。此处固化宽容行为，
    // 防回归为崩溃。
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const target = document.createElement('div');
    await expect(xlsxRenderer.render(garbage, target, source, det)).resolves.toBeTruthy();
  });

  it('sniff 永不改派', async () => {
    const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(xlsxRenderer.sniff?.(zipHead, det)).resolves.toBeNull();
  });
});

describe('pptxRenderer（降级：文本提纲）', () => {
  const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

  function slideXml(paragraphs: string[]): string {
    const ps = paragraphs
      .map((t) => `<a:p><a:r><a:t xml:space="preserve">${t}</a:t></a:r></a:p>`)
      .join('');
    return xmlDecl(
      `<p:sld ${A_NS} ${P_NS}><p:cSld><p:spTree><p:sp><p:txBody>${ps}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    );
  }

  async function buildMinimalPptx(slideFiles: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    // 有意乱序插入，断言渲染按 slideN 数字序
    for (const [name, xml] of Object.entries(slideFiles)) zip.file(name, xml);
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  }

  it('extractSlideLines：每段一行，段内 run 拼接', () => {
    const xml = slideXml(['标题A']).replace(
      '</p:txBody>',
      '<a:p><a:r><a:t>要点1</a:t></a:r><a:br/><a:r><a:t>要点2</a:t></a:r></a:p></p:txBody>'
    );
    expect(extractSlideLines(xml)).toEqual(['标题A', '要点1要点2']);
  });

  it('decodeXmlEntities：命名实体与数字字符引用', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#20013; &#x4E2D;')).toBe(
      'a & b <c> "d" \'e\' 中 中'
    );
  });

  it('每页一张卡片，按 slideN 数字序渲染', async () => {
    const buf = await buildMinimalPptx({
      'ppt/slides/slide2.xml': slideXml(['第二页']),
      'ppt/slides/slide10.xml': slideXml(['第十页']),
      'ppt/slides/slide1.xml': slideXml(['第一页', '副标题'])
    });
    const target = await renderInto(pptxRenderer, buf);
    const cards = [...target.querySelectorAll('.vv-pptx-slide')];
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain('第一页');
    expect(cards[1]?.textContent).toContain('第二页');
    expect(cards[2]?.textContent).toContain('第十页');
    expect(cards[0]?.querySelectorAll('p')).toHaveLength(2);
  });

  it('空页与实体解码经 textContent 输出', async () => {
    const buf = await buildMinimalPptx({
      'ppt/slides/slide1.xml': slideXml(['a &amp; b']),
      'ppt/slides/slide2.xml': xmlDecl(
        `<p:sld ${A_NS} ${P_NS}><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`
      )
    });
    const target = await renderInto(pptxRenderer, buf);
    const cards = [...target.querySelectorAll('.vv-pptx-slide')];
    expect(cards[0]?.querySelector('p')?.textContent).toBe('a & b');
    expect(cards[1]?.querySelector('.vv-pptx-empty')?.textContent).toContain('无文本');
  });

  it('无幻灯片部件时抛中文错误', async () => {
    const buf = await buildMinimalPptx({ 'docProps/core.xml': xmlDecl('<cp:coreProperties/>') });
    await expect(pptxRenderer.render(buf, document.createElement('div'), source, det))
      .rejects.toThrow(/pptx|幻灯片/);
  });

  it('sniff 永不改派', async () => {
    const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(pptxRenderer.sniff?.(zipHead, det)).resolves.toBeNull();
  });
});
