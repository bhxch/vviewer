// @vviewer/render-diagram 包根导出面：按消费符号闭包聚合——render-text 侧
//（pipeline.ts:12-13 的 resolveDiagramType/createKrokiUrl/createPlantumlUrl/
// DEFAULT_KROKI_HOST/DiagramMode/DiagramType/renderDiagramEngine，markdownRenderer.ts:36
// 的 renderMermaidInto/MermaidTheme 及 :136 的 import('./diagrams').DiagramMode 类型位）
// 与 web 侧（settingsDraft/viewer/markdownFence/stores/settings/DiagramsSection.svelte/
// markdownExport/theme.mermaid.test 的 DIAGRAM_TYPES/MERMAID_THEMES/DiagramType/
// resolveDiagramType/DEFAULT_KROKI_HOST/renderMermaidInto/MermaidTheme）。
// cdnEngines.ts 为包内实现细节不经根导出（跨包无子路径 mock 面；包内测试走相对引用）。
// 图表 SVG 净化（sanitizeDiagramFragment）由留守的 render-text pipeline 调用，不在本包；
// 回退链编排（local→kroki→official→错误卡）同样留在 pipeline，本包只管单引擎渲染。
export {
  DIAGRAM_TYPES,
  DEFAULT_KROKI_HOST,
  DEFAULT_PLANTUML_HOST,
  createKrokiUrl,
  createPlantumlUrl,
  resolveDiagramType,
  type DiagramMode,
  type DiagramType
} from './markdown/diagrams';
export {
  MERMAID_THEMES,
  renderDiagramEngine,
  renderMermaidInto,
  type DiagramEngineId,
  type MermaidTheme
} from './markdown/diagramEngines';
