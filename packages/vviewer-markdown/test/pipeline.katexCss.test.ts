// pipeline.katexCss.test.ts — katex 排印样式加载的源码契约（Task 2b 预览修复）。
// jsdom 对 css 动态导入无运行时观察面（根 vitest css:false 将其 stub 为空模块），
// 按既有「源码契约断言」形态锁定修复存在性与容错形态；样式 chunk 实际产出由
// build:e2e 产物核实（报告记录 precache 条数变化）。
// （自 render-text 迁入：源码路径改指本包；无 bundler 独立使用需自行引入 katex
// css 的注记见包 README——bundler 消费形态的动态导入契约不变。）
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  ['packages/vviewer-markdown/src/pipeline.ts', 'src/pipeline.ts']
    .map((p) => resolve(p))
    .find((p) => existsSync(p))!,
  'utf8'
);

describe('runKatex 排印样式加载（Task 2b）', () => {
  it('katex 步动态导入 katex.min.css（预览公式排印修复：此前自 M3 起为无样式 HTML）', () => {
    expect(source).toContain("import('katex/dist/katex.min.css')");
  });

  it('css 加载失败不阻断公式排版（catch 降级，与修复前现状一致）', () => {
    // 动态导入行带 .catch(() => null) 容错
    expect(source).toMatch(/await import\('katex\/dist\/katex\.min\.css'\)\.catch/);
  });
});
