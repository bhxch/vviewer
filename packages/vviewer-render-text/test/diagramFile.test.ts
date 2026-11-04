// diagramFile.test.ts — Task 3（spec 2026-11-04-file-viewer-integration §5.1）：
// 图表文件渲染器注册面锚——映射表逐字一致、扩展名跨型去重、fresh registry 零
// RegistryError 安装、byExtension 大小写归一、与既有 owner（markdown/html/jsonl）
// 不撞。本任务只锚注册面：render 体为最小抛错桩（Task 4 实装三分发/回退后追加
// 行为锚），装配序锚在 Task 5（viewer.ts 先 diagram 后 generated）。
import { describe, it, expect } from 'vitest';
import { createRegistry, type Renderer } from '@bhxch/vviewer-core';
import { resolveDiagramType } from '@bhxch/vviewer-render-diagram';
import { markdownRenderer } from '../src/markdown/markdownRenderer';
import { htmlRenderer } from '../src/html';
import { jsonlRenderer } from '../src/jsonl/index';
import { DIAGRAM_FILE_EXTS, createDiagramFileRenderers } from '../src/diagramFile';

/**
 * spec 2026-11-04 §5.1 表逐字内联（防实现漂移）。29 型（diagram 注册表全集去
 * math——.tex 维持 latex 源码高亮；drawio 不在注册表归批次三），标「造」= 无通行
 * 扩展名按类型同名（或格式约定 umlet→uxf）注册。表行：
 *   mermaid=mermaid,mmd ｜ plantuml=plantuml,puml ／ c4plantuml=c4plantuml（造）｜
 *   graphviz=dot,gv ｜ d2=d2 ｜ dbml=dbml ｜ vega=vega,vg ／ vegalite=vl（后两个造）｜
 *   excalidraw=excalidraw ｜ bpmn=bpmn ｜ nomnoml=nomnoml（造）｜ svgbob=svgbob ｜
 *   pikchr=pikchr ｜ ditaa=ditaa ｜ blockdiag/nwdiag/actdiag/seqdiag 同名（造）｜
 *   erd=erd ｜ structurizr=dsl ｜ bytefield=bytefield（造）｜ wavedrom=wavedrom（造）｜
 *   tikz=tikz（造）｜ umlet=uxf（格式约定）｜ goat=goat（造）｜ wireviz=wireviz（造）｜
 *   packetdiag/rackdiag 同名（造）｜ symbolator=symbolator（造）
 * 注：spec §5.1 标题写「31 扩展名」，但其表行逐行累加为 33——两处含「/」的行
 * （plantuml/c4plantuml、vega/vegalite）各 3 个扩展名，「31」疑为把该两行按 2 计的
 * 笔误。表行才是逐字规范面（task-3-brief：「Each row's extension list is exact」），
 * 此处按表行实测值锚定，防止实现按错误总数漏绑扩展名。
 */
const EXPECTED_EXTS: Readonly<Record<string, readonly string[]>> = {
  mermaid: ['mermaid', 'mmd'],
  plantuml: ['plantuml', 'puml'],
  c4plantuml: ['c4plantuml'],
  graphviz: ['dot', 'gv'],
  d2: ['d2'],
  dbml: ['dbml'],
  vega: ['vega', 'vg'],
  vegalite: ['vl'],
  excalidraw: ['excalidraw'],
  bpmn: ['bpmn'],
  nomnoml: ['nomnoml'],
  svgbob: ['svgbob'],
  pikchr: ['pikchr'],
  ditaa: ['ditaa'],
  blockdiag: ['blockdiag'],
  nwdiag: ['nwdiag'],
  actdiag: ['actdiag'],
  seqdiag: ['seqdiag'],
  erd: ['erd'],
  structurizr: ['dsl'],
  bytefield: ['bytefield'],
  wavedrom: ['wavedrom'],
  tikz: ['tikz'],
  umlet: ['uxf'],
  goat: ['goat'],
  wireviz: ['wireviz'],
  packetdiag: ['packetdiag'],
  rackdiag: ['rackdiag'],
  symbolator: ['symbolator']
};

const TYPES = Object.keys(EXPECTED_EXTS);
const ALL_EXTS = TYPES.flatMap((t) => [...(EXPECTED_EXTS[t] ?? [])]);

describe('diagramFile 注册面（spec 2026-11-04 §5.1）', () => {
  it('映射表全锚：29 型 resolveDiagramType 均非空，DIAGRAM_FILE_EXTS 与 spec 表逐字一致', () => {
    expect(TYPES).toHaveLength(29);
    for (const type of TYPES) {
      const diagram = resolveDiagramType(type);
      expect(diagram, `resolveDiagramType(${type})`).not.toBeNull();
      expect(diagram!.id, type).toBe(type);
      expect([...(DIAGRAM_FILE_EXTS[type] ?? [])], `DIAGRAM_FILE_EXTS.${type}`).toEqual(EXPECTED_EXTS[type]);
    }
    // 无多余键：映射表键集与 29 型全集精确相等
    expect(Object.keys(DIAGRAM_FILE_EXTS).slice().sort()).toEqual(TYPES.slice().sort());
  });

  it('扩展名跨型去重：全表扁平化无重复（表行实测 33 个）', () => {
    const all = TYPES.flatMap((t) => [...(DIAGRAM_FILE_EXTS[t] ?? [])]);
    expect(all).toHaveLength(ALL_EXTS.length);
    expect(new Set(all).size, '存在跨型重复扩展名').toBe(all.length);
  });

  it('既有 owner 扩展名（md/markdown/html/htm/jsonl/ndjson/svg）不入映射表', () => {
    const owned = ['md', 'markdown', 'html', 'htm', 'jsonl', 'ndjson', 'svg'];
    const all = new Set(TYPES.flatMap((t) => [...(DIAGRAM_FILE_EXTS[t] ?? [])]));
    for (const ext of owned) expect(all.has(ext), `映射表不得认领 ".${ext}"`).toBe(false);
  });

  it('fresh registry 安装 29 渲染器零 RegistryError；byExtension 大小写归一锚', () => {
    const registry = createRegistry();
    const renderers = createDiagramFileRenderers({});
    expect(renderers).toHaveLength(29);
    expect(() => {
      for (const r of renderers) registry.install(r);
    }).not.toThrow();
    // 注册面形态：id diagram-<type>、label 非空、streaming false、扩展名同映射表
    for (const r of renderers as Renderer[]) {
      const type = r.id.slice('diagram-'.length);
      expect(TYPES, r.id).toContain(type);
      expect(r.label, r.id).toBeTruthy();
      expect(r.streaming, `${r.id}.streaming`).toBe(false);
      expect(r.extensions, `${r.id}.extensions`).toEqual([...(DIAGRAM_FILE_EXTS[type] ?? [])]);
    }
    // 大小写归一（Review Focus 1）：查询侧大写命中小写注册键
    expect(registry.byExtension('dot')?.id).toBe('diagram-graphviz');
    expect(registry.byExtension('MERMAID')?.id).toBe('diagram-mermaid');
    // 格式约定别名锚：umlet→uxf、structurizr→dsl
    expect(registry.byExtension('uxf')?.id).toBe('diagram-umlet');
    expect(registry.byExtension('dsl')?.id).toBe('diagram-structurizr');
  });

  it('与既有 owner 不撞：先装 markdown/html/jsonl 再装 diagram 系零 RegistryError，既有扩展名不被 diagram-* 认领', () => {
    const registry = createRegistry();
    registry.install(markdownRenderer);
    registry.install(htmlRenderer);
    registry.install(jsonlRenderer);
    const renderers = createDiagramFileRenderers({});
    expect(() => {
      for (const r of renderers) registry.install(r);
    }).not.toThrow();
    for (const ext of ['md', 'markdown', 'html', 'htm', 'svg', 'jsonl', 'ndjson']) {
      const owner = registry.byExtension(ext);
      expect(owner?.id ?? '(未注册)', `".${ext}" 的 owner`).not.toMatch(/^diagram-/);
    }
  });
});
