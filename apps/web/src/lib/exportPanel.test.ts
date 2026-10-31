// exportPanel.test.ts — MetaPanel 导出动作区的源码契约（md-export Task 2）。
// 根 vitest 无 svelte 插件（metaStore.test.ts 同款约束）：.svelte 组件与 .svelte.ts
// 的 $state 模块无法直接 import/挂载，且本仓无 MetaPanel 组件测试形态——按既有
// 「源码契约断言」先例锁定可见性语义与链路接线；运行时行为由 e2e（md-export
// Task 3：导出钮显隐/下载事件/print 结构断言）兜底。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('导出动作区可见性契约（仅 markdown 渲染 tab 显示）', () => {
  it('MetaPanel：导出区以 exportState.available 门控（markdown 实例句柄可得才渲染），非 markdown tab 不出现', () => {
    const src = readSrc('src/lib/MetaPanel.svelte');
    // 门控：句柄可用 + 文件名在（标题所需）才渲染动作区
    expect(src).toMatch(/\{#if fileMeta\.name && exportState\.available\}/);
    // 两钮与处理器
    expect(src).toContain('导出 HTML');
    expect(src).toContain('导出 PDF');
    expect(src).toContain('onclick={onExportHtml}');
    expect(src).toContain('onclick={onExportPdf}');
    // 降级提示不静默（spec §7/计划 print 可用性探测）
    expect(src).toMatch(/role="status"/);
  });

  it('metaStore：exportState $state + setExportHandle 上行语义（getter 非响应式槽，available 随句柄）', () => {
    const src = readSrc('src/lib/metaStore.svelte.ts');
    expect(src).toMatch(/export const exportState = \$state<\{ available: boolean \}>/);
    expect(src).toMatch(/export function setExportHandle\(/);
    expect(src).toMatch(/exportState\.available = getter !== null/); // null 清空 → 钮消失
    expect(src).toMatch(/export function getExportDoc\(\)/);
  });

  it('ViewerPane：getToc 同款鸭子探测 getExportDocument 上行；清理与错误卡片路径清空句柄', () => {
    const src = readSrc('src/lib/ViewerPane.svelte');
    expect(src).toMatch(/\(res\.instance as \{ getExportDocument\?: \(\) => Document \| null \}\)\.getExportDocument/);
    expect(src).toContain("setExportHandle(typeof readExport === 'function' ? readExport.bind(res.instance) : null)");
    // cleanup 与错误卡片分支都清空（非 markdown/渲染失败 tab 不显示导出钮）
    expect(src.match(/setExportHandle\(null\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('导出链路接线契约', () => {
  it('MetaPanel 消费 Task 1 纯函数与触发壳辅助：装配/打印模板/浅色重画/图片解析', () => {
    const src = readSrc('src/lib/MetaPanel.svelte');
    expect(src).toContain("from '@bhxch/vviewer-render-text/markdown/export'");
    expect(src).toContain('collectExportHtml');
    expect(src).toContain('collectPrintHtml');
    expect(src).toContain('exportBaseCss');
    expect(src).toContain('repaintMermaidForPrint'); // PDF 强制浅色（spec §7）
    expect(src).toContain('resolveExportImage');
    expect(src).toContain('printDocument');
    expect(src).toContain('downloadExport');
    expect(src).toContain("import('./katexExportCss')"); // KaTeX 排印嵌入（Task 2b，惰性 chunk）
  });

  it('app.css：导出动作区按钮样式（对齐既有 MetaPanel 动作形态）', () => {
    const css = readSrc('src/app.css');
    expect(css).toContain('.meta-export');
    expect(css).toContain('.meta-export-actions');
    expect(css).toContain('.meta-export-notice');
  });

  it('MetaPanel：stampMode 双属性打标 + currentStyleCss 文档序 exportBaseCss 先于注入块（终审 I1）', () => {
    const src = readSrc('src/lib/MetaPanel.svelte');
    // 特异性倒挂修复：exportBaseCss 暗块 :root[data-vv-mode="dark"] 是 (0,2,0)，
    // 注入主题文本裸 :root 仅 (0,1,0) 会被压制——data-theme-mode 激活注入文本自身
    // 的 :root[data-theme-mode="dark"] 提权形态（theme.ts THEME_ROOT_SELECTOR）
    expect(src).toMatch(/setAttribute\('data-vv-mode', mode === 'dark' \? 'dark' : 'light'\)/);
    expect(src).toMatch(/setAttribute\('data-theme-mode', mode === 'dark' \? 'dark' : 'light'\)/);
    // 同 (0,2,0) 对决靠文档序：styleCss 合成里 exportBaseCss 先行、注入块 append
    // 在后（collectExportHtml 单 <style> 注入文本按序拼接，文档序即此序）
    const base = src.indexOf('const parts = [exportBaseCss];');
    const inject = src.indexOf('parts.push(el.textContent)');
    expect(base).toBeGreaterThan(-1);
    expect(inject).toBeGreaterThan(base);
  });
});
