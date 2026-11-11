// vviewer 根单 ESLint flat config（spec 2026-11-11 前端工程规范 §4.1 / D1）：单仓 monorepo
// 全仓一份 config + 目录级 override。不启用 type-aware lint（projectService）——类型机检
// 由 svelte-check + `tsc -b` 承载，lint 保持秒级。
//
// 机检自身被机检：tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 驱动真实
// eslint 扫 tools/lint-selfcheck/lint-fixtures/ 的必命中/合法样例，断言规则真的在拦。
//
// 分期激活（D6，Task 10 落地）：i18n 三条纪律——CJK 字面量禁令（Literal/
// TemplateElement/SvelteText 三形态）、禁裸 Intl.* / toLocale*、禁直读 catalogs——
// 随文案抽取收尾任务同 commit 激活；必命中/合法样例与断言见
// tools/lint-selfcheck/lint-fixtures/ 与 lint-config.test.ts（机检自身被机检）。
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// `<svelte:options runes={false} />` 是逐组件退出 runes 的后门：编译器里它优先于全局
// compilerOptions，构建期同样拦不住（实测编译通过、metadata.runes=false）。全局强制 runes
// 「任何位置不得关闭」（AGENTS.md）由本条机检承接。
// 注意：no-restricted-syntax 在多个 config 块之间是「后块整体覆盖前块」而非合并——日后给
// .svelte 追加条目（如 i18n 三条纪律）的块，必须把 runesOptOut 一并展开进去，否则本条在
// 那些文件上被静默顶掉。自检的 sample.optout.svelte 只守样例所在路径：后加块若只作用于
// apps/web/src/lib/** 之类的子集，样例测不出这种覆盖。
const runesOptOut = {
  selector:
    'SvelteElement[name.name="svelte:options"] SvelteAttribute[key.name="runes"] Literal[value=false]',
  message:
    '禁止用 <svelte:options runes={false}> 逐组件退出 runes 模式：全局强制 runes，任何位置不得关闭（AGENTS.md）'
};

// ---------- i18n 三条纪律（D6 分期激活，Task 10 落地） ----------
// CJK 三形态按**源码形态（raw）**匹配而非解码值：`\u 转义`是 D8 审计认可的
// 「非翻译数据值」合法形态（family 名/字形样张/storeId 标识段——运行时值含 CJK
// 但非文案，不随 locale），raw 形态无 CJK 字符即不拦；正则字面量（如
// /[\u4e00-\u9fff]/ 的 source）同此不误伤。esquery 的 value 是解码后字符串，
// 会把转义形态也拦掉（实测），故必须用 raw。
const CJK_RANGE = /[\u4e00-\u9fff]/.source; // 与 i18n 收口扫描同一码位区间
const cjkLiteral = {
  selector: `Literal[raw=/${CJK_RANGE}/]`,
  message:
    '禁止字符串字面量含 CJK：用户可见文案一律走 t()（i18n/index.svelte 响应式 / i18n/core 纯层）；非翻译数据值用 \\u 转义形态（D8 审计）'
};
const cjkTemplateElement = {
  // TemplateElement 的 raw 在 value.raw 嵌套（AST 实测），非顶层属性
  selector: `TemplateElement[value.raw=/${CJK_RANGE}/]`,
  message:
    '禁止模板串静态段含 CJK：插值文案改目录键 + 占位符 t(key, {…})；非翻译数据值用 \\u 转义形态（D8 审计）'
};
// Svelte 模板面(SvelteText 文本 / SvelteLiteral 静态属性值)用 **value** 匹配:
// 这两类节点无 raw 属性(实测 AST 只有解码后的 value),且模板文本/静态属性值
// 天然是显示面——不存在「转义数据值」形态(HTML 实体等绕写恰恰要拦,防绕过)。
// 非文案的动态值一律走表达式({expr} / title={…}),不入这两类节点。
// :not(SvelteStyleElement SvelteText) 排除 <style> 块内容——parser 把 style 内
// 全文(含中文 CSS 注释)作 SvelteText,而 CSS 注释是开发者面注释(与 // /*
// 同口径),不是用户可见文案;组件样式中文注释不入目录(实测缺此排除即 14 文件
// style 块整块误报)。
const cjkSvelteText = {
  selector: `SvelteText[value=/${CJK_RANGE}/]:not(SvelteStyleElement SvelteText), SvelteLiteral[value=/${CJK_RANGE}/]`,
  message:
    '禁止 Svelte 标记文本/静态属性值含 CJK：用户可见文案一律 t() 目录键（{{t("domain.key")}}）；aria-label/title/placeholder 用 {t(…)} 表达式形态'
};
// 禁裸 Intl / toLocale*（apps/web 全域）：日期/数字/列表格式化单点 i18n/format.ts
// （组内集中切 locale、单测直测面），散用 Intl 会在 locale 切换时按浏览器 locale
// 而非应用 locale 渲染（D3 双写机制的旁路）。
const bareIntl = {
  selector:
    "MemberExpression[object.name='Intl'], NewExpression[callee.object.name='Intl'], CallExpression[callee.property.name=/^(toLocaleString|toLocaleDateString|toLocaleTimeString|toLocaleLowerCase|toLocaleUpperCase)$/]",
  message:
    '禁止裸 Intl.* / toLocale*：格式化单点 i18n/format.ts（应用 locale 而非浏览器 locale；新增格式化能力在 format.ts 扩展并单测）'
};

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
    // 查看器演示语料（各格式样例文件，e2e 打开后按内容断言）：是被查看的内容，不是产品代码
    'samples/**',
    // Rust 构建目录：无可 lint 文件，但数万文件的遍历使本地全量 lint 耗时翻倍（实测 47s→21s）
    'server/target/**',
    'apps/desktop/src-tauri/target/**'
  ]),
  {
    // 失效的豁免指令必须红（与 svelte/no-unused-svelte-ignore 禁僵尸 svelte-ignore 对称）：
    // 写了 disable 而规则并未在此报，说明规则丢了、被改名或被配置顶掉——静默即防线上的洞。
    // 注意本项只管 JS 注释指令；.svelte 模板里的 HTML 注释指令（<!-- eslint-disable… -->）
    // 不归 ESLint 核心管，由下方规则块的 svelte/comment-directive 选项承接，两处成对
    linterOptions: { reportUnusedDisableDirectives: 'error' }
  },
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
        // 全局强制 runes 的 lint 期执法：与 apps/web/vite.config.ts 里 sveltekit() 的
        // compilerOptions: { runes: true } 同源语义，两处必须同步改。kit 3 不读
        // svelte.config.js，插件的自动加载拿不到该选项，须在此显式传入——否则 lint 期编译
        // 按逐文件自动探测走，export let / $: 的 legacy 组件零报错，要等到构建才拦
        svelteConfig: { compilerOptions: { runes: true } }
      },
      // 浏览器运行时全局必须留着，消费者不是 no-undef（下面已关）而是
      // svelte/prefer-svelte-reactivity：它按「已声明的全局」追踪 new URL /
      // new URLSearchParams（非 ES 内建，要靠环境声明），去掉即对这两类静默失明——
      // 实测去掉后被变更的 URL / URLSearchParams 实例不再报（Map 照报），serverConnect
      // 的豁免指令当场变成「未使用」
      globals: { ...globals.browser }
    },
    rules: {
      // 未定义标识符/类型由 svelte-check（TS）承载，与 typescript-eslint 对 *.ts 关掉 no-undef
      // 的处置对称：本 config 非 type-aware，no-undef 分不清 DOM 纯类型名（如
      // ScrollBehavior），留着只会误报，还得另补一份 TS lib 声明去喂它
      'no-undef': 'off'
    }
  },
  {
    // 本块显式开启的都是在本 config（非 type-aware + 强制 runes）下真会运行的规则；预设
    // 带入却不运行的，在块尾显式关闭——生效配置（--print-config）里非 off 的 svelte
    // 规则即真在执法的
    files: ['**/*.svelte', '**/*.ts'],
    rules: {
      // a11y 硬门槛载体（D12）：eslint-plugin-svelte 没有 a11y-* 前缀规则，Svelte 编译器的
      // a11y 警告经本规则报为 lint error；配套禁僵尸 svelte-ignore。同时是全局 runes 的
      // lint 期执法载体：编译按上方 svelteConfig 的 runes: true 进行，legacy 语法即编译错误
      'svelte/valid-compile': 'error',
      'svelte/no-unused-svelte-ignore': 'error',
      // 模板内失效的豁免指令同样必须红：与上方 linterOptions.reportUnusedDisableDirectives
      // 成对——核心那项只管 JS 注释指令，.svelte 模板里的 HTML 注释指令归 svelte 插件自己
      // 处理，其同名选项默认关，不开则模板里写错/过期的豁免无人报
      'svelte/comment-directive': ['error', { reportUnusedDisableDirectives: true }],
      // legacy 写法检测：只列强制 runes 下仍运行的三条（逐条实测能报）。`$:` 系规则不开：
      // 它们自带条件只在 legacy/未定模式运行，强制 runes 后不运行；legacy `$:` 六形态已由
      // valid-compile + runes 以 error 全拦（实测）
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
      // —— 显式关闭：recommended 预设带入、但在本配置下不执法的规则。关掉不是放松（它们
      // 本来就不运行），是让生效配置如实 ——
      // · 依赖类型信息，非 type-aware 下整条不运行（D1）；日后启用 type-aware 时重新评估
      'svelte/no-unused-props': 'off',
      // · 自带条件只在 legacy/未定模式运行，强制 runes 后不运行（legacy `$:` 已由
      //   valid-compile 以 error 全拦，见自检样例）
      'svelte/no-reactive-functions': 'off',
      'svelte/no-reactive-literals': 'off',
      'svelte/no-immutable-reactive-statements': 'off',
      'svelte/infinite-reactive-loop': 'off',
      'svelte/no-reactive-reassign': 'off',
      // · 只适用于 Svelte 3/4（本仓 Svelte 5）
      'svelte/require-event-dispatcher-types': 'off',
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
  // 禁逐组件退出 runes（选择器与覆盖语义的注意事项见文件顶部 runesOptOut）
  {
    files: ['**/*.svelte'],
    rules: {
      'no-restricted-syntax': ['error', runesOptOut]
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
  // ---------- i18n 三条纪律（D6 分期激活落地，Task 10）----------
  // 块 A：apps/web/src/lib 子集——CJK 三形态 + bareIntl + 禁直读 catalogs。
  // i18n/** 整体豁免（catalog 本体与 core/index 门面即「直读」的合法点，D6：
  // 豁免 i18n/index.svelte.ts 与 i18n/core.ts 的实现面）；*.test.ts 豁免（目录值
  // 双锁断言直读 catalogs 是 S5 锚改写的既定形态）。svelte 面必须把 runesOptOut
  // 一并展开（Task 1 裁决：no-restricted-syntax 后块整体覆盖前块不合并——本块
  // 在 runesOptOut 旧块之后，漏展开即 lib 内 .svelte 的逐组件退 runes 防线被
  // 静默顶掉；runesOptOut 选择器对 .ts 无匹配，双侧共用无副作用）。
  {
    files: ['apps/web/src/lib/**/*.{svelte,ts}'],
    ignores: ['apps/web/src/lib/i18n/**', 'apps/web/src/lib/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', runesOptOut, cjkLiteral, cjkTemplateElement, cjkSvelteText, bareIntl],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/i18n/catalogs', '**/i18n/catalogs/**'],
              message:
                '禁止直读 catalogs：消费方一律经 i18n/index.svelte（响应式 t）或 i18n/core（纯 translate）门面——直读绕过 locale 状态与聚合机检的单一入口'
            }
          ]
        }
      ]
    }
  },
  // 块 A2（评审 M-3，bareIntl 豁免面收窄）：i18n/** 在块 A 整体豁免（catalog 本体
  // 含 CJK 键值、core/index 是 catalogs 直读的合法点），但 bareIntl 的唯一豁免点
  // 是 format.ts——门面/核心文件日后引入裸 Intl 必须照红。只挂 bareIntl（不挂 CJK，
  // catalogs 键值是 CJK 本体）；runesOptOut 按覆盖纪律照常展开（.svelte.ts 无匹配
  // 面，防后加块覆盖语义的惯例保持）。
  {
    files: ['apps/web/src/lib/i18n/**'],
    ignores: ['apps/web/src/lib/i18n/format.ts'],
    rules: {
      'no-restricted-syntax': ['error', runesOptOut, bareIntl]
    }
  },
  // 块 B：apps/web 全域（lib 除外，其由块 A 承担）——bareIntl + runesOptOut。
  // 同样的覆盖展开纪律：本块在旧 runesOptOut 块之后，.svelte 面漏展开 runesOptOut
  // 即 routes 层的退 runes 防线被顶掉。bareIntl 对 test/e2e 不豁免（存量零命中：
  // 格式化断言一律经 format.ts 出口，散用 Intl 无正当面）。
  {
    files: ['apps/web/**/*.{svelte,ts}'],
    ignores: ['apps/web/src/lib/**', 'apps/web/src/lib/i18n/format.ts'],
    rules: {
      'no-restricted-syntax': ['error', runesOptOut, bareIntl]
    }
  }
);
