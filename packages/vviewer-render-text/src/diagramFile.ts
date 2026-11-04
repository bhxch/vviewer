// diagramFile.ts — 图表文件渲染器注册面（spec 2026-11-04-file-viewer-integration
// §5.1/§5.2）：29 型（diagram 注册表全集去 math——.tex 维持 latex 源码高亮；drawio
// 不在注册表归批次三）→ 扩展名映射逐字取 spec §5.1 表，createDiagramFileRenderers
// 产出 29 个 Renderer 实例（id `diagram-<type>`）供装配点安装。
//
// 扩展名计数注记：spec §5.1 标题写「31 扩展名」，但其表行逐行累加为 33——两处含
// 「/」的行（plantuml/c4plantuml、vega/vegalite）各 3 个扩展名，「31」疑为把该两行
// 按 2 计的笔误。表行是逐字规范面（测试 test/diagramFile.test.ts 内联锚定），实现
// 以表行为准；漏绑任一扩展名都会让对应图表文件落不进图形预览。
//
// render 体本任务（Task 3）为最小抛错桩——三分发（local/kroki/server）+ 失败回退
// + 2MB 大小门 + 源码/渲染切换在 Task 4 实装；viewer.ts 装配序（diagram 先于 code
// 安装，generated 补空位铁律）在 Task 5 落地。注册面（映射表/工厂签名/remoteCall
// 通道）即本任务交付物，Task 4/5 依赖其形态不变。
import type { Renderer } from '@bhxch/vviewer-core';
import { resolveDiagramType } from '@bhxch/vviewer-render-diagram';

/** Task 4/5 注入缝：server 模式单图渲染的远端调用通道（同 md 管线 PipelineCtx.diagram.remoteCall 形态）。 */
export interface DiagramFileRenderOpts {
  remoteCall?: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
}

/**
 * 29 型 → 扩展名映射，逐字取 spec 2026-11-04 §5.1 表（键序 = 表行序）。标「造」
 * 行 = 无通行扩展名按类型同名（或格式约定 umlet→uxf）注册的扩展名；扩展名小写
 * 无点（registry 登记侧亦归一小写）。不得出现既有 owner 扩展名
 * （md/markdown/html/htm/jsonl/ndjson/svg——测试锚定），装配序保证图表渲染器先于
 * generated fallback 安装（dot/gv/mermaid/mmd/bpmn/dbml/d2 与 670 项生成物重叠由
 * 「专有先注册、generated 补空位」消解）。
 */
export const DIAGRAM_FILE_EXTS: Readonly<Record<string, readonly string[]>> = {
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

/**
 * 可读名表：DiagramType（diagrams.ts 实态）无 label 字段，注册面 label 由本表提供
 * （键 = 类型 id；通行专名保留官方拼写）。上游注册表若补 label 字段可切换取值来源。
 */
const DIAGRAM_LABELS: Readonly<Record<string, string>> = {
  mermaid: 'Mermaid',
  plantuml: 'PlantUML',
  c4plantuml: 'PlantUML C4',
  graphviz: 'Graphviz',
  d2: 'D2',
  dbml: 'DBML',
  vega: 'Vega',
  vegalite: 'Vega-Lite',
  excalidraw: 'Excalidraw',
  bpmn: 'BPMN',
  nomnoml: 'Nomnoml',
  svgbob: 'SVGBob',
  pikchr: 'Pikchr',
  ditaa: 'Ditaa',
  blockdiag: 'BlockDiag',
  nwdiag: 'NWDiag',
  actdiag: 'ActDiag',
  seqdiag: 'SeqDiag',
  erd: 'ERD',
  structurizr: 'Structurizr',
  bytefield: 'Bytefield',
  wavedrom: 'WaveDrom',
  tikz: 'TikZ',
  umlet: 'UMLet',
  goat: 'Goat',
  wireviz: 'WireViz',
  packetdiag: 'PacketDiag',
  rackdiag: 'RackDiag',
  symbolator: 'Symbolator'
};

/**
 * 29 个图表文件渲染器（id `diagram-<type>`，label 取可读名，streaming false——
 * 图表源按全量文本渲染，Task 4 的三分发/回退/大小门都建立在全量在手前提上）。
 * 映射表类型若与 diagram 注册表漂移（resolveDiagramType 落空）即抛错——注册一个
 * 不可达 id 属装配期错误，宁可响 fail-fast 也不静默缩容。
 * opts.remoteCall 本任务不消费（render 为桩），Task 4 server 分支经闭包取用。
 */
export function createDiagramFileRenderers(opts: DiagramFileRenderOpts): Renderer[] {
  void opts;
  return Object.entries(DIAGRAM_FILE_EXTS).map(([type, extensions]) => {
    const diagram = resolveDiagramType(type);
    if (!diagram) throw new Error(`diagramFile: 映射表类型 "${type}" 不在 diagram 注册表`);
    return {
      id: `diagram-${type}`,
      label: DIAGRAM_LABELS[diagram.id] ?? diagram.id,
      extensions: [...extensions],
      streaming: false,
      async render() {
        throw new Error('diagramFile: render 实装于 Task 4');
      }
    };
  });
}
