import { crc32 } from 'node:zlib';

/**
 * 真 PPTX 夹具（运行时构造，png-fixture.ts goodPng 同款——不入库二进制）：完整 OPC 部件链
 * presentation → slideMaster → slideLayout → slide + theme（clr/font/fmtScheme 齐全）。
 *
 * 为什么不用 samples/m4/sample.pptx：那是 gen-samples.mjs 手工构造的最小包（只有
 * presentation.xml + slides，无 theme/master/layout），vviewer 自有文本提纲渲染器只读
 * slide XML 可以渲染，但 file-viewer 演示文稿引擎按真实 PowerPoint 结构解析主题线型等
 * （缺 theme 即逐页 `Cannot read properties of undefined (reading 'a:ln')`、
 * PPTX_NO_RENDERABLE_SLIDES）。上游语料「presentation 组无小体量夹具」（fetch-e2e-corpus.mjs
 * file-viewer-fixtures rationale），故在此按 ECMA-376 最小合法结构现地生成。
 *
 * zip 用 stored（不压缩）条目 + CRC32（node:zlib），每张幻灯片一个标题文本框。
 */
export function realPptx(slides: readonly string[]): Uint8Array {
  const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const xml = (body: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rels = (items: { id: string; type: string; target: string }[]): string =>
    xml(
      `<Relationships xmlns="${PKG_REL}">${items
        .map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"/>`)
        .join('')}</Relationships>`
    );
  const solid = (c: string): string => `<a:solidFill><a:schemeClr val="${c}"/></a:solidFill>`;
  const ln = (w: number): string => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid('phClr')}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const theme = xml(
    `<a:theme xmlns:a="${NS_A}" name="Office Theme"><a:themeElements>` +
      `<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
      `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>` +
      `<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
      `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>` +
      `<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>` +
      `<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
      `<a:fmtScheme name="Office"><a:fillStyleLst>${solid('phClr')}${solid('phClr')}${solid('phClr')}</a:fillStyleLst>` +
      `<a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>` +
      `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
      `<a:bgFillStyleLst>${solid('phClr')}${solid('phClr')}${solid('phClr')}</a:bgFillStyleLst></a:fmtScheme>` +
      `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
  );
  const spTree = (inner: string): string =>
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${inner}</p:spTree>`;
  const master = xml(
    `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${spTree('')}</p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`
  );
  const layout = xml(
    `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank">${spTree('')}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  );
  const slideXml = (title: string, i: number): string =>
    xml(
      `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>${spTree(
        `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="Title ${i + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
          `<p:spPr><a:xfrm><a:off x="838200" y="2130425"/><a:ext cx="10515600" cy="1470025"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
          `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="4000"/><a:t>${esc(title)}</a:t></a:r></a:p></p:txBody></p:sp>`
      )}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    );

  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
          `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
          `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
          `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
          slides
            .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
            .join('') +
          `</Types>`
      )
    ],
    ['_rels/.rels', rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }])],
    [
      'ppt/presentation.xml',
      xml(
        `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
          `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst>` +
          `<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
      )
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      rels([
        { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
        { id: 'rId2', type: 'theme', target: 'theme/theme1.xml' },
        ...slides.map((_, i) => ({ id: `rId${i + 3}`, type: 'slide', target: `slides/slide${i + 1}.xml` }))
      ])
    ],
    ['ppt/slideMasters/slideMaster1.xml', master],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      rels([
        { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }
      ])
    ],
    ['ppt/slideLayouts/slideLayout1.xml', layout],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }])],
    ['ppt/theme/theme1.xml', theme],
    ...slides.flatMap((title, i): [string, string][] => [
      [`ppt/slides/slide${i + 1}.xml`, slideXml(title, i)],
      [`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }])]
    ])
  ];
  return storedZip(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

/** 最小 stored（不压缩）zip 写入器：本地头 + 中央目录 + EOCD（UTF-8 文件名标志位 0x0800） */
function storedZip(entries: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
