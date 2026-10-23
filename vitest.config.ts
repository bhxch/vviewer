import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tools/*/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    environment: 'jsdom',
    // vitest 的 css-disable 对 *.css?raw 一并 stub 成空串（enforce:pre 早于 vite 的
    // ?raw 资产处理，css.exclude 亦不可逃）；md-export Task 2b 的 katexExportCss
    // 需真实读取 katex.min.css 文本——按 id 精准放行 katex 系 css，其余维持 stub
    // （全量 css:true 会让普通 css 导入走 postcss 编译链，无谓拖慢）
    css: { include: [/katex/] },
    server: {
      deps: {
        // svgbob wasm glue（wasm-bindgen --target web 产物，gen:svgbob-wasm 构建期
        // 生成）external 交 node 原生 ESM 加载：经 vite transform 时 glue 内
        // new URL('svgbob_wasm_bg.wasm', import.meta.url) 的资产引用会被静态改写成
        // dev server 虚拟 URL（实测 http://localhost:3000/packages/...，jsdom 下
        // fetch 无真服务直接失败）；原生加载保持 import.meta.url 为 file://，wasm
        // 解析到同目录真实文件（测试内对 file: fetch 兜底读盘，见
        // diagramEngines.test.ts）。该目录为 gen 产物独占命名，不涉其他模块。
        external: [/svgbob-wasm-gen/]
      }
    }
  }
});
