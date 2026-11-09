// foreignRenderers.test.ts — file-viewer 桥接装配锚（计划 3 Task 2 第一波 + 计划 4 Task 2
// 第二波，spec §6.3）。沿计划 1 源序锚形态（render-text test/diagramFile.test.ts「装配序锚」组）：
// ① 20 组渲染器 id/label/extensions 逐字（spec §6.3 表 + 全局约束「pot 归 presentation」
//   + 第二波 jxl 不绑定裁决——dist 无解码器，见 task-2 报告「API 探针」）；
// ② fresh registry 全量镜像 viewer.ts 语句序 install——零冲突 + byExtension 逐字归属
//   （tsv→foreign-spreadsheet、eml/fods 不被 generated fallback 抢注；第二波 geojson/
//   kml/gpx/typ/typst/sig 同理 + wasm 自 hex 转移 + midi/mid 不与 av 冲突）；
// ③ viewer.ts 源序：桥接块居 diagram 之后、codeRenderer 之前（generated 补空位铁律）。
// viewer.ts 本体 vitest 不可 import（$app/env，diagramFile.test.ts 同款结论）——源序以
// 读源断言锚定，行为以镜像面锚定。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRegistry, GENERATED_EXTENSIONS } from '@bhxch/vviewer-core';
import type { Detection, FileSource, RenderedInstance, TreeStore } from '@bhxch/vviewer-core';
import { codeRenderer } from '@bhxch/vviewer-render-text';
import { createDiagramFileRenderers } from '@bhxch/vviewer-render-text/diagramFile';
import { markdownRenderer } from '@bhxch/vviewer-markdown';
import { htmlRenderer } from '@bhxch/vviewer-render-text/html';
import { imageRenderer } from '@bhxch/vviewer-render-media';
import { avRenderer } from '@bhxch/vviewer-render-media/av';
import { pdfRenderer } from '@bhxch/vviewer-render-doc';
import { docxRenderer } from '@bhxch/vviewer-render-doc/docx';
import { xlsxRenderer } from '@bhxch/vviewer-render-doc/xlsx';
import { pptxRenderer } from '@bhxch/vviewer-render-doc/pptx';
import { hexRenderer } from '@bhxch/vviewer-render-binary';
import { archiveRenderer } from '@bhxch/vviewer-render-archive';
import { jsonlRenderer } from '@bhxch/vviewer-render-text/jsonl';
import {
  createForeignFileRenderers,
  FOREIGN_GROUP_ASSET_PACKAGE,
  nestedDispatchName,
  nestedName,
  wireDesignOrDataSeam
} from './foreignRenderers';
import type { ForeignAssetPackage } from './foreignAssets';

function readViewerSource(): string {
  // vitest 下 import.meta.url 非 file scheme（loader 虚拟协议），按 cwd 双候选兜底
  for (const rel of ['apps/web/src/lib/viewer.ts', '../../apps/web/src/lib/viewer.ts', 'src/lib/viewer.ts']) {
    try {
      return readFileSync(resolve(process.cwd(), rel), 'utf8');
    } catch {
      /* 下一候选 */
    }
  }
  throw new Error('apps/web/src/lib/viewer.ts 不可达（装配序锚须在 monorepo 内运行）');
}

function readForeignSource(): string {
  for (const rel of ['apps/web/src/lib/foreignRenderers.ts', '../../apps/web/src/lib/foreignRenderers.ts', 'src/lib/foreignRenderers.ts']) {
    try {
      return readFileSync(resolve(process.cwd(), rel), 'utf8');
    } catch {
      /* 下一候选 */
    }
  }
  throw new Error('apps/web/src/lib/foreignRenderers.ts 不可达（装配序锚须在 monorepo 内运行）');
}

/** spec §6.3 第一波绑定（逐字）：全局约束增补 pot 归 presentation（§6.3 序 7 注记）。 */
const EXPECTED: readonly { id: string; extensions: readonly string[] }[] = [
  { id: 'foreign-email', extensions: ['eml', 'msg', 'mbox'] },
  { id: 'foreign-epub', extensions: ['epub', 'fb2', 'umd'] },
  { id: 'foreign-ofd', extensions: ['ofd'] },
  { id: 'foreign-chm', extensions: ['chm'] },
  { id: 'foreign-word', extensions: ['docx', 'doc', 'docm', 'dotx', 'dotm', 'odt', 'odp', 'rtf'] },
  { id: 'foreign-presentation', extensions: ['pptx', 'ppt', 'pot', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm'] },
  { id: 'foreign-spreadsheet', extensions: ['xltx', 'xlsb', 'xlt', 'xla', 'xlam', 'xltm', 'ods', 'fods', 'dbf', 'tsv'] },
  { id: 'foreign-iwork', extensions: ['pages', 'numbers', 'key'] },
  { id: 'foreign-hangul', extensions: ['hwp', 'hwpx'] },
  { id: 'foreign-wordperfect', extensions: ['wpd', 'wp', 'wp5', 'wp6'] }
];

/** spec §6.3 第二波绑定（逐字，序 12-21）：jxl 不绑定（探针裁决：renderer-image dist
 * 无 JS 解码器，仅浏览器原生 img 解码面——目标浏览器不支持即恒错误卡，回退未注册）。 */
const EXPECTED_WAVE2: readonly { id: string; extensions: readonly string[] }[] = [
  { id: 'foreign-data', extensions: ['sqlite', 'parquet', 'avro', 'webarchive', 'ttf', 'otf', 'woff', 'woff2', 'wasm'] },
  {
    id: 'foreign-design',
    extensions: [
      'psb', 'pdd', 'psdt', 'psd', 'ait', 'ai', 'idml', 'icml', 'idms', 'inx', 'fla', 'xfl',
      'xd', 'indd', 'indt', 'ps', 'eps', 'ase', 'aco', 'abr', 'csh', 'pat', 'grd', 'asl'
    ]
  },
  { id: 'foreign-image', extensions: ['tiff', 'tif', 'heic', 'heif'] },
  { id: 'foreign-geo', extensions: ['geojson', 'kml', 'gpx', 'shp'] },
  { id: 'foreign-typst', extensions: ['typ', 'typst'] },
  { id: 'foreign-dicom', extensions: ['dcm', 'dicom'] },
  {
    id: 'foreign-signature',
    extensions: [
      'p7m', 'p7s', 'p7c', 'p7b', 'pkcs7', 'cms', 'cmsc', 'tsd', 'tst', 'tsq', 'tsr',
      'asics', 'scs', 'asice', 'sce', 'ers', 'asc', 'sig', 'pgp', 'gpg', 'jws'
    ]
  },
  { id: 'foreign-eda', extensions: ['olb', 'dra', 'gds', 'oas', 'oasis'] },
  { id: 'foreign-drawing', extensions: ['drawio', 'dio'] },
  { id: 'foreign-midi', extensions: ['midi', 'mid'] }
];

const EXPECTED_ALL: readonly { id: string; extensions: readonly string[] }[] = [...EXPECTED, ...EXPECTED_WAVE2];

describe('createForeignFileRenderers（20 组桥接渲染器）', () => {
  it('id/label/extensions 逐字（spec §6.3 表 + docx/pptx 所有权）：118 扩展名零重复', () => {
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    expect(renderers).toHaveLength(20);
    const seen = new Set<string>();
    for (const expected of EXPECTED_ALL) {
      const r = renderers.find((x) => x.id === expected.id);
      expect(r, expected.id).toBeDefined();
      expect(r!.label, `${expected.id}.label`).toBeTruthy();
      expect(r!.extensions, `${expected.id}.extensions`).toEqual([...expected.extensions]);
      expect(r!.streaming, `${expected.id}.streaming`).toBe(false);
      for (const ext of expected.extensions) {
        expect(seen.has(ext), `扩展名 ${ext} 重复绑定`).toBe(false);
        seen.add(ext);
      }
    }
    expect(seen.size).toBe(118); // 41（第一波）+ docx/pptx（内置默认改版式/幻灯片还原）+ 75（第二波，jxl 不绑定）
  });

  it('渲染器对象不携带 mount 装配外的可预期面（label 中文、extensions 小写无点）', () => {
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    for (const r of renderers) {
      for (const ext of r.extensions) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext.startsWith('.')).toBe(false);
      }
    }
  });
});

describe('装配序锚（viewer.ts 语句序：diagram → foreign 桥接块 → code → … → generated fallback）', () => {
  // 镜像范围：web 侧依赖可达（render-text/media/doc/binary/archive/markdown 全在
  // apps/web dependencies），全量复刻 viewer.ts install 语句序；@file-viewer 渲染器
  // 本体不在此安装面（mount 懒加载，chunk 分离），镜像只锁注册面。
  function mirrorViewerInstallOrder(): ReturnType<typeof createRegistry> {
    const registry = createRegistry();
    for (const r of createDiagramFileRenderers({})) registry.install(r); // viewer.ts：图表文件渲染器
    for (const r of createForeignFileRenderers({ nestedDispatch: async () => {} })) registry.install(r); // viewer.ts：file-viewer 桥接块（第一波+第二波）
    registry.install(codeRenderer);
    registry.install(markdownRenderer);
    registry.install(htmlRenderer);
    registry.install(imageRenderer);
    registry.install(avRenderer);
    registry.install(pdfRenderer);
    registry.install(docxRenderer);
    registry.install(xlsxRenderer);
    registry.install(pptxRenderer);
    registry.install(hexRenderer);
    registry.install(archiveRenderer);
    registry.install(jsonlRenderer);
    registry.installFallbackExtensions('code', GENERATED_EXTENSIONS); // 收尾：generated 补空位（冲突跳过）
    return registry;
  }

  it('fresh registry 全序 install 零冲突（RegistryError 即红）', () => {
    expect(() => mirrorViewerInstallOrder()).not.toThrow();
  });

  it('byExtension 118 项逐字归属 + tsv→foreign-spreadsheet 桥（Review Focus 3）', () => {
    const registry = mirrorViewerInstallOrder();
    for (const expected of EXPECTED_ALL) {
      for (const ext of expected.extensions) {
        expect(registry.byExtension(ext)?.id, ext).toBe(expected.id);
        expect(registry.byExtension(ext.toUpperCase())?.id, ext.toUpperCase()).toBe(expected.id);
      }
    }
  });

  it('generated 补空位不回抢：eml/fods 归桥接；csv/xlsx 维持 vviewer 既有渲染器，docx/pptx 归版式/幻灯片还原', () => {
    const registry = mirrorViewerInstallOrder();
    expect(registry.byExtension('eml')?.id).toBe('foreign-email'); // GENERATED_EXTENSIONS 内，桥接块居前才不被 code 抢注
    expect(registry.byExtension('fods')?.id).toBe('foreign-spreadsheet');
    expect(registry.byExtension('tsv')?.id).toBe('foreign-spreadsheet'); // 自 code 内置清单原子转移
    expect(registry.byExtension('csv')?.id).toBe('code'); // spec §6.3：csv 维持 code
    expect(registry.byExtension('docx')?.id).toBe('foreign-word'); // 内置默认：docx-preview 系版式还原
    expect(registry.byExtension('xlsx')?.id).toBe('xlsx');
    expect(registry.byExtension('pptx')?.id).toBe('foreign-presentation'); // 内置默认：逐页幻灯片
    expect(registry.byExtension('dot')?.id).toBe('diagram-graphviz'); // 计划 1 裁决：dot 维持 graphviz
  });

  it('docx/pptx 的 core 渲染器降为候选：仍可经偏好/打开方式选用，且不再占有扩展名', () => {
    const registry = mirrorViewerInstallOrder();
    expect(registry.candidatesOf('docx').map((r) => r.id)).toEqual(['foreign-word', 'docx']);
    expect(registry.candidatesOf('pptx').map((r) => r.id)).toEqual(['foreign-presentation', 'pptx']);
    expect(docxRenderer.extensions).toEqual([]);
    expect(pptxRenderer.extensions).toEqual([]);
    registry.setPreferenceResolver((ext) => ({ docx: 'docx', pptx: 'pptx' })[ext]);
    expect(registry.byExtension('docx')?.id).toBe('docx');
    expect(registry.byExtension('pptx')?.id).toBe('pptx');
    // 两者 label 可区分（registry 全量面同名项会炸 label-keyed each，见 foreignRenderers.ts 注）
    expect(registry.byId('foreign-word')?.label).not.toBe(registry.byId('docx')?.label);
  });

  it('多渲染器候选（altExtensions）：xlsx/xlsm/xls/csv 以 foreign-spreadsheet 为候选，偏好命中即改派、其余不动', () => {
    const registry = mirrorViewerInstallOrder();
    for (const ext of ['xlsx', 'xlsm', 'xls']) {
      expect(registry.candidatesOf(ext).map((r) => r.id), ext).toEqual(['xlsx', 'foreign-spreadsheet']);
    }
    expect(registry.candidatesOf('csv').map((r) => r.id)).toEqual(['code', 'foreign-spreadsheet']);
    registry.setPreferenceResolver((ext) => (ext === 'xlsx' || ext === 'csv' ? 'foreign-spreadsheet' : undefined));
    expect(registry.byExtension('xlsx')?.id).toBe('foreign-spreadsheet');
    expect(registry.byExtension('csv')?.id).toBe('foreign-spreadsheet');
    expect(registry.byExtension('xls')?.id).toBe('xlsx'); // 未设偏好的同族扩展名不受牵连
    expect(registry.ownerOf('xlsx')?.id).toBe('xlsx');
  });

  it('code 内置清单已无 tsv（转移原子性的 code 侧证据）', () => {
    const registry = createRegistry();
    registry.install(codeRenderer);
    expect(codeRenderer.extensions).not.toContain('tsv');
    expect(registry.byExtension('tsv')).toBeUndefined();
  });

  // 计划 4 Task 2（spec §6.3 序 12/15/16/18/21 转移面）：
  it('wasm 双向转移（Review Focus 2）：hex 清单已无 wasm；仅装 hex 的 registry 不认 wasm；全序归属 foreign-data', () => {
    expect(hexRenderer.extensions, 'hex 保留 wasm 即双 owner').not.toContain('wasm');
    const hexOnly = createRegistry();
    hexOnly.install(hexRenderer);
    expect(hexOnly.byExtension('wasm')).toBeUndefined();
    expect(mirrorViewerInstallOrder().byExtension('wasm')?.id).toBe('foreign-data');
  });

  it('generated 兜底不回抢第二波：geojson/kml/gpx/typ/typst/sig 归桥接（装配块居前铁律的第二波证据）', () => {
    const registry = mirrorViewerInstallOrder();
    expect(registry.byExtension('geojson')?.id).toBe('foreign-geo');
    expect(registry.byExtension('kml')?.id).toBe('foreign-geo');
    expect(registry.byExtension('gpx')?.id).toBe('foreign-geo');
    expect(registry.byExtension('typ')?.id).toBe('foreign-typst');
    expect(registry.byExtension('typst')?.id).toBe('foreign-typst');
    expect(registry.byExtension('sig')?.id).toBe('foreign-signature');
  });

  it('midi/mid 归 foreign-midi；av 扩展名清单不含二者（宿主媒体扩展名不注册——av 占优约束）', () => {
    const registry = mirrorViewerInstallOrder();
    expect(registry.byExtension('midi')?.id).toBe('foreign-midi');
    expect(registry.byExtension('mid')?.id).toBe('foreign-midi');
    expect(avRenderer.extensions).not.toContain('midi');
    expect(avRenderer.extensions).not.toContain('mid');
  });

  it('jxl 不绑定（探针裁决）：任一桥接组/镜像 registry/generated 清单/vviewer image 均不认 jxl', () => {
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    for (const r of renderers) expect(r.extensions, r.id).not.toContain('jxl');
    expect(mirrorViewerInstallOrder().byExtension('jxl')).toBeUndefined();
    expect(GENERATED_EXTENSIONS).not.toContain('jxl');
    expect(imageRenderer.extensions).not.toContain('jxl');
  });

  it('字体查看面归 foreign-data 且与 fonts store 互不写（spec §6.3 序 12：fonts store 加载职责不动）', () => {
    const data = EXPECTED_WAVE2.find((e) => e.id === 'foreign-data')!;
    for (const ext of ['ttf', 'otf', 'woff', 'woff2']) expect(data.extensions).toContain(ext);
    // 静态锚：桥接装配面零 fonts store 引用（互不写的源码面证据；store 读写仅
    // fontsStore.ts 消费链）
    expect(readForeignSource()).not.toMatch(/fontsStore|stores\/fonts/);
  });

  it('viewer.ts 源序：diagram 块 → 桥接块 → codeRenderer（generated 补空位铁律，Review Focus 2）', () => {
    const src = readViewerSource();
    const diagramAt = src.indexOf('createDiagramFileRenderers({ remoteCall');
    const foreignAt = src.indexOf('createForeignFileRenderers({ nestedDispatch');
    const codeAt = src.indexOf('registry.install(codeRenderer)');
    const fallbackAt = src.indexOf("registry.installFallbackExtensions('code', GENERATED_EXTENSIONS)");
    expect(diagramAt).toBeGreaterThan(-1);
    expect(foreignAt, 'viewer.ts 未装配 file-viewer 桥接渲染器').toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(foreignAt, '桥接块必须先于 codeRenderer：docm/potx/eml/fods 等会被 generated 补空位抢注').toBeLessThan(codeAt);
    expect(foreignAt, '桥接块居 diagram 块之后（装配叙述序）').toBeGreaterThan(diagramAt);
    expect(foreignAt, '桥接块必须先于 generated fallback').toBeLessThan(fallbackAt);
  });
});

// T2 评审 M2 携带修复锚：nestedName 空/空白 type 回落裸 'attachment'（不得产出
// 'attachment.' 尾点非法文件名）；含点 type 原样透传（email 附件自带扩展名的形态）。
describe('nestedName（renderNestedBuffer type → 合成文件名）', () => {
  it('裸扩展名合成 attachment.<ext>，小写归一', () => {
    expect(nestedName('pdf')).toBe('attachment.pdf');
    expect(nestedName(' PDF ')).toBe('attachment.pdf');
  });

  it('空/空白 type 回落裸 attachment（M2：无尾点）', () => {
    expect(nestedName('')).toBe('attachment');
    expect(nestedName('   ')).toBe('attachment');
  });

  it('含点 type 原样透传（自带扩展名的附件名）', () => {
    expect(nestedName('photo.jpg')).toBe('photo.jpg');
    expect(nestedName('a.b.c')).toBe('a.b.c');
  });
});

// FOM-EX-08 修复锚：嵌套派发名取上游第 4 参 context.filename 的附件原名（此前
// 只取三参 → 原名被丢弃、落盘名退化为 attachment.<ext>）；原名须文件名化，
// 防合成名携带路径成分（PAT-EX-01：恶意附件名 'x.z/evil' 不得派成扩展名
// 'z/evil'、不得落成 'attachment.z/evil'）。
describe('nestedDispatchName（嵌套派发名 = 附件原名，经文件名化）', () => {
  it('原名可用 → 直接采用（扩展名口径随之正确：mystery.zzz → zzz、leaf.pdf → pdf）', () => {
    expect(nestedDispatchName('zzz', 'mystery.zzz')).toBe('mystery.zzz');
    expect(nestedDispatchName('pdf', 'leaf.pdf')).toBe('leaf.pdf');
    expect(nestedDispatchName('eml', 'level2.eml')).toBe('level2.eml');
  });

  it('原名缺失/纯空白 → 回落扩展名派生名（nestedName 语义不变）', () => {
    expect(nestedDispatchName('zzz')).toBe('attachment.zzz');
    expect(nestedDispatchName('pdf', '')).toBe('attachment.pdf');
    expect(nestedDispatchName('pdf', '   ')).toBe('attachment.pdf');
    expect(nestedDispatchName('')).toBe('attachment');
  });

  it('原名含路径成分 → 取 basename（裸文件名，不含 / \\ 与 .. 段）', () => {
    expect(nestedDispatchName('z/evil', 'x.z/evil')).toBe('evil');
    expect(nestedDispatchName('z/evil', 'dir/sub/file.bin')).toBe('file.bin');
    expect(nestedDispatchName('z/evil', 'dir\\sub\\file.bin')).toBe('file.bin');
  });

  it('原名仅路径成分（点/双点/空段）→ 回落扩展名派生名且该派生名亦无路径成分', () => {
    expect(nestedDispatchName('zzz', '..')).toBe('attachment.zzz');
    expect(nestedDispatchName('zzz', '.')).toBe('attachment.zzz');
    expect(nestedDispatchName('z/evil', '..')).not.toContain('/');
    expect(nestedDispatchName('z/evil', '..')).not.toContain('\\');
  });
});

// T2 评审 I-2 携带修复锚（spec §6.3 序 13 注记诉求）：foreign-design 组的 data-asset
// handler 接上游增强缝 renderFileViewerDesignOrData——psd/ai/eps 走 design 高保真，
// 不再落 renderer-data 基础数据视图。行为锚直载两真包（dist 纯数据模块，node/jsdom
// 可安全 import），静态锚防装配面回退。
describe('wireDesignOrDataSeam（design 组 data-asset 缝，T2 评审 I-2）', () => {
  it('data-asset handler === renderFileViewerDesignOrData；design 直接扩展名 handler 不受影响', async () => {
    const [design, data] = await Promise.all([
      import('@file-viewer/renderer-design'),
      import('@file-viewer/renderer-data')
    ]);
    const plugin = wireDesignOrDataSeam(design, data);
    const byId = new Map((plugin.handlers ?? []).map((h) => [h.rendererId, h.handler]));
    expect(byId.get(data.dataRendererDefinition.id), 'data-asset 缝：增强 handler').toBe(
      design.renderFileViewerDesignOrData
    );
    expect(byId.get('photoshop-design'), 'design 直接 definition：原 handler').toBe(design.renderFileViewerDesign);
    // 上游增强格式集语义锚：enhancesExtensions 并集 {psd,ai,eps}（renderFileViewerDesignOrData
    // 内 enhancedDataFormats 的数据源），data-asset definition 自带同三扩展名（裸 registry
    // 下 byExtension('psd') 命中 data-asset——缝的根因面）
    const enhanced = design.designRendererDefinitions.flatMap((d) =>
      d.enhancesRendererId === data.dataRendererDefinition.id ? [...(d.enhancesExtensions ?? [])] : []
    );
    expect([...enhanced].sort()).toEqual(['ai', 'eps', 'psd']);
    for (const ext of ['psd', 'ai', 'eps']) {
      expect(data.dataRendererDefinition.extensions, `data-asset 自带 ${ext}`).toContain(ext);
    }
  });

  it('静态锚：foreign-design 组 load 经 wireDesignOrDataSeam 接线（防装配面回退）', () => {
    const src = readForeignSource();
    const designAt = src.indexOf("id: 'foreign-design'");
    const seamAt = src.indexOf('wireDesignOrDataSeam(design, data)');
    expect(seamAt, 'design 组未接 design-or-data 缝').toBeGreaterThan(-1);
    expect(seamAt, '缝接线必须位于 foreign-design 组 load 内').toBeGreaterThan(designAt);
  });
});

// 计划 3 Task 3：每组资产包归属锚（Task 3 实测映射——jsdelivr data API 逐包核对）。
describe('FOREIGN_GROUP_ASSET_PACKAGE（资产三层链的组包映射，spec §6.2）', () => {
  /** Record 索引访问收窄：缺失即断言失败（noUncheckedIndexedAccess 面友好） */
  const pkgOf = (id: string, ext: string): ForeignAssetPackage | null => {
    const f = FOREIGN_GROUP_ASSET_PACKAGE[id];
    expect(f, `映射表缺组 ${id}`).toBeDefined();
    return f!(ext);
  };

  it('无资产组：email/epub/ofd（epubjs、dltech ofd 随 renderer dist 打包）', () => {
    for (const id of ['foreign-email', 'foreign-epub', 'foreign-ofd']) {
      for (const ext of EXPECTED.find((e) => e.id === id)!.extensions) {
        expect(pkgOf(id, ext), `${id}/${ext}`).toBeNull();
      }
    }
  });

  it('assets-standard 组：word（docx 系 worker）/spreadsheet（xlsx worker）/presentation 的 pptx 系', () => {
    for (const ext of ['doc', 'docm', 'dotx', 'dotm', 'odt', 'odp', 'rtf']) {
      expect(pkgOf('foreign-word', ext), ext).toBe('assets-standard');
    }
    for (const ext of ['xltx', 'xlsb', 'xlt', 'xla', 'xlam', 'xltm', 'ods', 'fods', 'dbf', 'tsv']) {
      expect(pkgOf('foreign-spreadsheet', ext), ext).toBe('assets-standard');
    }
    for (const ext of ['pptm', 'potx', 'potm', 'ppsx', 'ppsm']) {
      expect(pkgOf('foreign-presentation', ext), ext).toBe('assets-standard');
    }
  });

  it('独立资产包组：chm/hangul/iwork/wordperfect；presentation 的 legacy ppt/pot 归 assets-ppt', () => {
    expect(pkgOf('foreign-chm', 'chm')).toBe('assets-chm');
    expect(pkgOf('foreign-hangul', 'hwp')).toBe('assets-hangul');
    expect(pkgOf('foreign-hangul', 'hwpx')).toBe('assets-hangul');
    expect(pkgOf('foreign-iwork', 'pages')).toBe('assets-iwork');
    expect(pkgOf('foreign-wordperfect', 'wpd')).toBe('assets-wordperfect');
    expect(pkgOf('foreign-presentation', 'ppt')).toBe('assets-ppt');
    expect(pkgOf('foreign-presentation', 'pot')).toBe('assets-ppt');
  });

  it('映射表覆盖 20 组（与装配面 id 集合一致）', () => {
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    expect(Object.keys(FOREIGN_GROUP_ASSET_PACKAGE).sort()).toEqual(renderers.map((r) => r.id).sort());
  });

  // 计划 4 Task 2（T2 探针实测：core assets 清单 defaultPath 相对基座派生 + 各 dist
  // 资产解析面）：data→assets-data（sql wasm wasm/data/）、design→assets-design
  // （vendor/design worker/wasm）、typst→assets-typst（wasm/typst 编译器/渲染器/字体）、
  // drawing→assets-drawing（vendor/drawio 官方运行时）。
  it('第二波资产包组：data/design/typst/drawing 各自独立 assets-* 基座', () => {
    expect(pkgOf('foreign-data', 'sqlite')).toBe('assets-data');
    expect(pkgOf('foreign-data', 'ttf')).toBe('assets-data');
    expect(pkgOf('foreign-data', 'wasm')).toBe('assets-data');
    expect(pkgOf('foreign-design', 'psd')).toBe('assets-design');
    expect(pkgOf('foreign-design', 'idml')).toBe('assets-design');
    expect(pkgOf('foreign-design', 'asl')).toBe('assets-design');
    expect(pkgOf('foreign-typst', 'typ')).toBe('assets-typst');
    expect(pkgOf('foreign-typst', 'typst')).toBe('assets-typst');
    expect(pkgOf('foreign-drawing', 'drawio')).toBe('assets-drawing');
    expect(pkgOf('foreign-drawing', 'dio')).toBe('assets-drawing');
  });

  it('第二波无资产组：image/geo/dicom/signature/eda/midi（依赖随 renderer dist/vite 静态发射自包含）', () => {
    const noAsset = [
      'foreign-image', 'foreign-geo', 'foreign-dicom', 'foreign-signature', 'foreign-eda', 'foreign-midi'
    ] as const;
    for (const id of noAsset) {
      for (const ext of EXPECTED_WAVE2.find((e) => e.id === id)!.extensions) {
        expect(pkgOf(id, ext), `${id}/${ext}`).toBeNull();
      }
    }
  });
});

// FOM-SHP-01（spec §6.4「裸单文件维持降级错误卡」）：foreign-geo 组装配层对
// `single:` 来源（createSingleFileStore，拖拽/文件 picker 单选形态）的 .shp 前置
// 拦截。拦截点在 Renderer.render 包装层（withSingleFileShpGuard）——桥接契约
// ForeignMountArgs 不携带 storeId，只有 render 的 FileSource 实参有。
// mock 面：@file-viewer/renderer-geo 换带 definition/handler 的最小插件（真
// @file-viewer/core registry/dispatcher 按扩展名路由，与 wireDesignOrDataSeam 组
// 「真包可 node 直载」同证）；拦截面场景断言 handler 零调用 = 拦截在 mount 之前，
// 非拦截面场景断言 handler 被调 = 回落既有渲染路径（不必真渲染）。
const geoMock = vi.hoisted(() => {
  // 参数按 ForeignHandler 形标注（buffer/target/type/context）——mock.calls 元组随之
  // 带 type 槽（第 2 索引 = 桥接 mount 传入的裸扩展名实参）
  const handler = vi.fn(
    async (_buffer: ArrayBuffer, _target: HTMLElement, type?: string, _context?: unknown) => ({ unmount: () => {} })
  );
  return { handler };
});

vi.mock('@file-viewer/renderer-geo', () => ({
  geoRenderer: {
    definitions: [{ id: 'geo-bridge-mock', label: 'Geo 桥 mock', extensions: ['geojson', 'kml', 'gpx', 'shp'] }],
    handlers: [{ rendererId: 'geo-bridge-mock', handler: geoMock.handler }]
  }
}));

describe('foreign-geo 裸单文件 .shp 前置拦截（FOM-SHP-01，spec §6.4 降级错误卡）', () => {
  /** bridge render 直调形态（viewer dispatch 同参子集：buffer/target/source/det 必填） */
  function renderGeo(name: string, storeId: string, ext: string): Promise<RenderedInstance> {
    const r = createForeignFileRenderers({ nestedDispatch: async () => {} }).find((x) => x.id === 'foreign-geo');
    expect(r, 'foreign-geo 组渲染器').toBeDefined();
    const source: FileSource = { storeId, storeLabel: '测试来源', path: name, name, store: {} as TreeStore };
    return r!.render(new Uint8Array([1, 2, 3]), document.createElement('div'), source, { ext } as unknown as Detection);
  }

  beforeEach(() => {
    geoMock.handler.mockClear();
  });

  it('single: 来源 .shp → render 拒绝含「Shapefile 需同目录」的错误；拦截在 mount 之前（上游 handler 零调用）', async () => {
    await expect(renderGeo('points.shp', 'single:points.shp:840:0', 'shp')).rejects.toThrow(/Shapefile 需同目录/);
    expect(geoMock.handler).not.toHaveBeenCalled();
  });

  it('非 single 来源 .shp 不拦截——回落既有渲染路径（handler 被调，type 实参 = 裸扩展名）', async () => {
    const inst = await renderGeo('points.shp', 'localfiles:e2e-dir', 'shp');
    expect(geoMock.handler).toHaveBeenCalledTimes(1);
    expect(geoMock.handler.mock.calls[0]![2]).toBe('shp');
    expect(typeof inst.destroy).toBe('function');
  });

  it('single: 来源 .geojson 不受影响（geojson 单文件自足）——照常走渲染路径', async () => {
    const inst = await renderGeo('map.geojson', 'single:map.geojson:649:0', 'geojson');
    expect(geoMock.handler).toHaveBeenCalledTimes(1);
    expect(geoMock.handler.mock.calls[0]![2]).toBe('geojson');
    expect(typeof inst.destroy).toBe('function');
  });
});
