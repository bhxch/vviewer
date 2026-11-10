// vviewer 根单 ESLint flat config（spec 2026-11-11 前端工程规范 §4.1 / D1）：单仓 monorepo
// 全仓一份 config + 目录级 override。不启用 type-aware lint（projectService）——类型机检
// 由 svelte-check + `tsc -b` 承载，lint 保持秒级。
//
// 机检自身被机检：tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 驱动真实
// eslint 扫 tools/lint-selfcheck/lint-fixtures/ 的必命中/合法样例，断言规则真的在拦。
//
// 分期激活预留（D6）：i18n 三条纪律——CJK 字面量禁令（Literal/TemplateElement/SvelteText）、
// 禁裸 Intl.* / toLocale*、禁直读 catalogs——本文件暂不落，随文案抽取收尾任务同 commit
// 激活（抽取完成前的中间 commit 必须保持 lint 绿）；届时必命中样例与断言同步补进
// lint-selfcheck。
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // 全局 ignores：依赖/构建产物/临时目录/生成物与下载物（ESLint 不读 .gitignore，须显式列）。
  // grammar-builder/out、.wrangler、.zcode 三处缺任一即十万级误报（spec §4.1 记录的实测结论）；
  // lint-fixtures 为必命中样例，常规 lint 不扫，仅自检测试以 --no-ignore 显式驱动。
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.svelte-kit/**',
    '**/.temp/**',
    '**/.zcode/**',
    '**/coverage/**',
    'apps/web/static/**',
    'apps/web/test-results/**',
    'apps/web/playwright-report/**',
    'packages/vviewer-render-diagram/src/markdown/svgbob-wasm-gen/**',
    'tools/grammar-builder/out/**',
    'server/worker/.wrangler/**',
    'tools/lint-selfcheck/lint-fixtures/**',
    // e2e 多源语料：上游仓真实文件（tools/fetch-e2e-corpus.mjs 下载，不入库），非本仓代码
    'apps/web/e2e/fixtures/corpus/**',
    // Rust 构建目录：无可 lint 文件，但数万文件的遍历使本地全量 lint 耗时翻倍（实测 47s→21s）
    'server/target/**',
    'apps/desktop/src-tauri/target/**'
  ]),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  svelte.configs['flat/recommended'],
  {
    // .svelte.ts 必须同列：插件给 runes 状态模块也挂 svelte-eslint-parser，缺内层 parser
    // 即回落 espree，TS 语法整文件 Parsing error（真实违规被遮蔽）
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        // <script lang="ts"> 经 typescript-eslint 解析（svelte-eslint-parser 承担模板层）
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
        // 非 type-aware 下作用域分析器读不到 tsconfig：显式声明 TS lib（与 apps/web
        // tsconfig 的 lib 对齐），否则 ScrollBehavior 等 DOM 纯类型名被 no-undef 误报
        lib: ['esnext', 'dom', 'dom.iterable', 'dom.asynciterable'],
        // 全局强制 runes 的 lint 期执法：与 apps/web/vite.config.ts 里 sveltekit() 的
        // compilerOptions: { runes: true } 同源语义，两处必须同步改。kit 3 不读
        // svelte.config.js，插件的自动加载拿不到该选项，须在此显式传入——否则 lint 期编译
        // 按逐文件自动探测走，export let / $: 的 legacy 组件零报错，要等到构建才拦
        svelteConfig: { compilerOptions: { runes: true } }
      },
      // 运行时全局（window/document/setTimeout…）——lib 只带类型，两者缺一不可
      globals: { ...globals.browser }
    }
  },
  {
    // 本块只列在本 config（非 type-aware + 强制 runes）下真会运行的规则：空转的规则不列，
    // 免得清单看着齐全、实则无人执法
    files: ['**/*.svelte', '**/*.ts'],
    rules: {
      // a11y 硬门槛载体（D12）：eslint-plugin-svelte 没有 a11y-* 前缀规则，Svelte 编译器的
      // a11y 警告经本规则报为 lint error；配套禁僵尸 svelte-ignore。同时是全局 runes 的
      // lint 期执法载体：编译按上方 svelteConfig 的 runes: true 进行，legacy 语法即编译错误
      'svelte/valid-compile': 'error',
      'svelte/no-unused-svelte-ignore': 'error',
      // legacy 写法检测：只列强制 runes 下仍运行的三条（逐条实测能报）。`$:` 系四条
      // （no-reactive-functions / no-reactive-literals / no-immutable-reactive-statements /
      // no-extra-reactive-curlies）不列——它们自带条件只在 legacy/未定模式运行，强制 runes
      // 后是空转；legacy `$:` 六形态已由 valid-compile + runes 以 error 全拦（实测）
      'svelte/no-dupe-on-directives': 'error',
      'svelte/no-not-function-handler': 'error',
      'svelte/no-at-debug-tags': 'error',
      // runes 健壮性
      'svelte/no-unnecessary-state-wrap': 'error',
      // 逐点裁决不 blanket 关（D18）：驱动渲染的改 SvelteMap/SvelteSet；纯数据结构逐行
      // 写 disable-next-line 指令并附理由
      'svelte/prefer-svelte-reactivity': 'error',
      'svelte/require-each-key': 'error',
      'svelte/prefer-derived-over-derived-by': 'warn',
      // 不列 svelte/require-event-prefix 与 svelte/no-unused-props：两条都依赖类型信息
      // （拿不到 TS program 即整条不运行），本 config 不启用 type-aware（D1），列了也是空转。
      // 回调 props 的 onXxx 命名约定因此不由 lint 执法，降级为评审必查项（由规范文档的
      // PR 必查清单承接）
      // 丢弃项与占位参数用 _ 前缀豁免
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // D2：warn/error/debug 是结构化观测留痕（降级警告/错误留痕/调试探针），禁的是 log/info
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }]
    }
  },
  // 测试与 e2e 放开 console
  {
    files: [
      '**/*.test.ts',
      'apps/web/e2e/**',
      'apps/web/e2e-server/**',
      'packages/*/test/**',
      'tools/*/test/**'
    ],
    rules: {
      'no-console': 'off'
    }
  },
  // Playwright 夹具参数：框架按函数源码解析夹具名，首参必须是对象解构——无夹具时
  // `({}, testInfo)` 是官方写法，改成具名形参即运行期抛错。只放行「空对象模式作形参」，
  // 其余空解构照拦
  {
    files: ['apps/web/e2e/**', 'apps/web/e2e-server/**'],
    rules: {
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }]
    }
  },
  // 配置文件与 node 脚本：node 全局
  {
    files: ['*.config.js', '*.config.ts', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  // samples 下的脚本是查看器演示语料（不执行；e2e 打开后按内容断言，不为过 lint 改写
  // 内容）：声明其书写环境——node/浏览器通用全局
  {
    files: ['samples/**/*.js'],
    languageOptions: {
      globals: { ...globals['shared-node-browser'] }
    }
  }
);
