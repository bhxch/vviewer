// @bhxch/vviewer-sanitize 包根——不可信渲染 HTML 的唯一净化出口。
// 导出面按既有消费点闭包聚合：sanitizeHtml（render-doc docx、render-text
// markdownRenderer / html 渲染器）、sanitizeDiagramFragment（render-text pipeline
// 服务端图表承接）、hostOf / isExternalMediaSrc（render-text enrich）、
// ALLOWED_URI_REGEXP（render-text html 渲染器 URI 二层复核）。
export * from './sanitize';
