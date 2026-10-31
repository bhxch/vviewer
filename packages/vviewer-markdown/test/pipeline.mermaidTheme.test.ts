// pipeline.mermaidTheme.test.ts — 图表选项注入通道（Task 5）。
// 裁决（2026-10-19）：brief 原稿引用的 themeStub 不存在也不创建——mermaid 主题映射
// 纯函数（resolveMermaidTheme）落 apps/web/src/lib/theme.ts，映射断言在同目录
// theme.mermaid.test.ts；本文件只锁 render-text 侧注入通道：setDiagramOptions →
// getDiagramOptions 透传，mermaidTheme 随 ctx 进入管线（本地渲染与 Task 5 重渲染
// 同源消费该值）。
import { afterEach, expect, it } from 'vitest';
import { getDiagramOptions, setDiagramOptions } from '../src/markdownRenderer';

afterEach(() => {
  setDiagramOptions(null); // 模块级单例：用后解绑，不污染同进程其他用例
});

it('setDiagramOptions 注入的 mermaidTheme 经 getDiagramOptions 透传', () => {
  setDiagramOptions(() => ({ krokiHost: '', mermaidTheme: 'dark', modeOf: () => 'local' }));
  expect(getDiagramOptions()?.mermaidTheme).toBe('dark');
});

it('未注入时 getDiagramOptions 返回 null（管线按注册表 defaultMode）', () => {
  expect(getDiagramOptions()).toBeNull();
});
