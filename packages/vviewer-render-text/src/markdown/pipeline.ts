// pipeline.ts — 转出口（shim）：markdown 五步管线（highlight → diagrams → katex →
// copyCode → lightbox）实现已随 @bhxch/vviewer-markdown 组合包迁出（packages/vviewer-markdown/
// src/pipeline.ts，自本包原样迁入；ctx 另增 ui 文案/themeClassPrefix 等宿主可选
// 项，不传即原语义）。本文件 re-export 保持 test/（../src/markdown/pipeline 相对
// import）与既有消费方的符号面不变；包内新增面（DEFAULT_UI_TEXTS/resolveUiTexts/
// PipelineUiTexts）不属本转出口，需组合包语义时直接 import '@bhxch/vviewer-markdown'。
export {
  runPipeline,
  runSteps,
  getPipelineSteps,
  // 灯箱三导出转出口（原 pipeline.ts:690 同款；组合包包根亦 re-export 同组符号）
  removeLightboxOverlay,
  LIGHTBOX_OVERLAY_ID,
  LIGHTBOX_OWNER_ATTR,
  type PipelineCtx,
  type PipelineStep
} from '@bhxch/vviewer-markdown';
