import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tools/*/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    environment: 'jsdom',
    // vitest 的 css-disable 对 *.css?raw 一并 stub 成空串（enforce:pre 早于 vite 的
    // ?raw 资产处理，css.exclude 亦不可逃）；md-export Task 2b 的 katexExportCss
    // 需真实读取 katex.min.css 文本——按 id 精准放行 katex 系 css，其余维持 stub
    // （全量 css:true 会让普通 css 导入走 postcss 编译链，无谓拖慢）
    css: { include: [/katex/] }
  }
});
