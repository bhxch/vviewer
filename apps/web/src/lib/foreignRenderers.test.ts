// foreignRenderers.test.ts — file-viewer 第一波桥接装配锚（计划 3 Task 2，spec §6.3）。
// 沿计划 1 源序锚形态（render-text test/diagramFile.test.ts「装配序锚」组）：
// ① 10 组渲染器 id/label/extensions 逐字（spec §6.3 表 + 全局约束「pot 归 presentation」）；
// ② fresh registry 全量镜像 viewer.ts 语句序 install——零冲突 + byExtension 逐字归属
//   （tsv→foreign-spreadsheet、eml/fods 不被 generated fallback 抢注）；
// ③ viewer.ts 源序：桥接块居 diagram 之后、codeRenderer 之前（generated 补空位铁律）。
// viewer.ts 本体 vitest 不可 import（$app/env，diagramFile.test.ts 同款结论）——源序以
// 读源断言锚定，行为以镜像面锚定。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRegistry, GENERATED_EXTENSIONS } from '@bhxch/vviewer-core';
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
import { createForeignFileRenderers, nestedName } from './foreignRenderers';

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

/** spec §6.3 第一波绑定（逐字）：全局约束增补 pot 归 presentation（§6.3 序 7 注记）。 */
const EXPECTED: readonly { id: string; extensions: readonly string[] }[] = [
  { id: 'foreign-email', extensions: ['eml', 'msg', 'mbox'] },
  { id: 'foreign-epub', extensions: ['epub', 'fb2', 'umd'] },
  { id: 'foreign-ofd', extensions: ['ofd'] },
  { id: 'foreign-chm', extensions: ['chm'] },
  { id: 'foreign-word', extensions: ['doc', 'docm', 'dotx', 'dotm', 'odt', 'odp', 'rtf'] },
  { id: 'foreign-presentation', extensions: ['ppt', 'pot', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm'] },
  { id: 'foreign-spreadsheet', extensions: ['xltx', 'xlsb', 'xlt', 'xla', 'xlam', 'xltm', 'ods', 'fods', 'dbf', 'tsv'] },
  { id: 'foreign-iwork', extensions: ['pages', 'numbers', 'key'] },
  { id: 'foreign-hangul', extensions: ['hwp', 'hwpx'] },
  { id: 'foreign-wordperfect', extensions: ['wpd', 'wp', 'wp5', 'wp6'] }
];

describe('createForeignFileRenderers（10 组桥接渲染器）', () => {
  it('id/label/extensions 逐字（spec §6.3 表）：41 扩展名零重复', () => {
    const renderers = createForeignFileRenderers({ nestedDispatch: async () => {} });
    expect(renderers).toHaveLength(10);
    const seen = new Set<string>();
    for (const expected of EXPECTED) {
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
    expect(seen.size).toBe(41);
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
    for (const r of createForeignFileRenderers({ nestedDispatch: async () => {} })) registry.install(r); // viewer.ts：file-viewer 第一波桥接块
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

  it('byExtension 41 项逐字归属 + tsv→foreign-spreadsheet 桥（Review Focus 3）', () => {
    const registry = mirrorViewerInstallOrder();
    for (const expected of EXPECTED) {
      for (const ext of expected.extensions) {
        expect(registry.byExtension(ext)?.id, ext).toBe(expected.id);
        expect(registry.byExtension(ext.toUpperCase())?.id, ext.toUpperCase()).toBe(expected.id);
      }
    }
  });

  it('generated 补空位不回抢：eml/fods 归桥接；csv/docx/pptx 维持 vviewer 既有渲染器', () => {
    const registry = mirrorViewerInstallOrder();
    expect(registry.byExtension('eml')?.id).toBe('foreign-email'); // GENERATED_EXTENSIONS 内，桥接块居前才不被 code 抢注
    expect(registry.byExtension('fods')?.id).toBe('foreign-spreadsheet');
    expect(registry.byExtension('tsv')?.id).toBe('foreign-spreadsheet'); // 自 code 内置清单原子转移
    expect(registry.byExtension('csv')?.id).toBe('code'); // spec §6.3：csv 维持 code
    expect(registry.byExtension('docx')?.id).toBe('docx'); // docx 维持 vviewer mammoth
    expect(registry.byExtension('xlsx')?.id).toBe('xlsx');
    expect(registry.byExtension('pptx')?.id).toBe('pptx');
    expect(registry.byExtension('dot')?.id).toBe('diagram-graphviz'); // 计划 1 裁决：dot 维持 graphviz
  });

  it('code 内置清单已无 tsv（转移原子性的 code 侧证据）', () => {
    const registry = createRegistry();
    registry.install(codeRenderer);
    expect(codeRenderer.extensions).not.toContain('tsv');
    expect(registry.byExtension('tsv')).toBeUndefined();
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
