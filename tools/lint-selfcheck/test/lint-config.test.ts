/**
 * lint 自检（机检自身被机检）：规则配对了没有，不能靠「lint 是绿的」证明——绿既可能是代码
 * 干净，也可能是规则压根没生效。这里以 --no-ignore 驱动真实 eslint（根 flat config 全量规则）
 * 扫必命中样例与合法样例，断言「该拦的拦下了、不该拦的没误伤」。
 *
 * 样例位于 tools/lint-selfcheck/lint-fixtures/（已入 eslint 全局 ignores，常规 lint 不扫）。
 * i18n 三条纪律（CJK 字面量 / 裸 Intl / 直读 catalogs）激活时，其必命中样例与断言在此扩展。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const ESLINT = path.join(REPO, 'node_modules', '.bin', 'eslint');
const FIXTURES = path.join(REPO, 'tools', 'lint-selfcheck', 'lint-fixtures');

interface LintMessage {
  ruleId: string | null;
  /** 1 = warn，2 = error */
  severity: number;
  message: string;
}

interface LintRun {
  /** eslint 退出码：0 = 无 error，1 = 有 lint error，2 = 配置/运行期崩溃 */
  exitCode: number;
  messages: LintMessage[];
}

// eslint CLI 冷启动（加载 config 与三套插件）在全量并发下明显慢于单测均值——用例级放宽超时
const LINT_TIMEOUT = 30_000;
// 子进程自身的超时，必须小于用例超时：execFileSync 同步阻塞，eslint 一旦挂住，vitest 的
// 用例超时根本没机会触发（事件循环被占着），整个 worker 会被拖死——只能靠它先把子进程杀掉
const ESLINT_TIMEOUT = 25_000;

function lintFixture(file: string): LintRun {
  const target = path.join(FIXTURES, file);
  let exitCode = 0;
  let stdout: string;
  let stderr = '';
  try {
    // cwd=仓库根：flat config 自仓库根解析；--no-ignore 越过全局 ignores 显式扫样例
    stdout = execFileSync(ESLINT, ['--no-ignore', '--format', 'json', target], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ESLINT_TIMEOUT
    });
  } catch (error) {
    const failure = error as {
      status?: number | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    if (failure.signal) {
      // 超时被杀（status 为 null、带 signal）：单独报出，别混进下面的「未产出 JSON」
      throw new Error(
        `eslint 子进程 ${ESLINT_TIMEOUT}ms 内未结束，已被 ${failure.signal} 终止（样例：${file}）`,
        { cause: error }
      );
    }
    // 必命中样例以 exit 1 收场——非零退出在此捕获，stdout 仍携带 JSON 报告
    exitCode = failure.status ?? -1;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
  }
  let reports: Array<{ messages: LintMessage[] }>;
  try {
    reports = JSON.parse(stdout) as Array<{ messages: LintMessage[] }>;
  } catch (parseError) {
    // 配置加载失败等崩溃形态（exit 2、stdout 非 JSON）：带 stderr 直接报出，免得被误读成「未命中」
    throw new Error(`eslint 未产出 JSON 报告（exit ${exitCode}）：${stderr || stdout}`, {
      cause: parseError
    });
  }
  return { exitCode, messages: reports.flatMap((report) => report.messages) };
}

/**
 * stdin 驱动（i18n 三纪律专用）：把 fixtures 样例内容以**虚拟路径**喂给 eslint。
 * 三规则的挂载块只作用 apps/web/src/lib 子集，而 fixtures 目录在全局 ignores 且
 * 不落该子集——--stdin-filename 让样例按 lib 路径形态匹配规则块，同时验证
 * 「块真的挂上了」与「内容真的命中」；同一内容换虚拟路径（如 i18n/format.ts）
 * 即可双向验证豁免面。
 */
function lintStdin(file: string, virtualPath: string): LintRun {
  const content = readFileSync(path.join(FIXTURES, file), 'utf8');
  let exitCode = 0;
  let stdout: string;
  let stderr = '';
  try {
    stdout = execFileSync(
      ESLINT,
      ['--no-ignore', '--stdin', '--stdin-filename', path.join(REPO, virtualPath), '--format', 'json'],
      { cwd: REPO, encoding: 'utf8', input: content, stdio: ['pipe', 'pipe', 'pipe'], timeout: ESLINT_TIMEOUT }
    );
  } catch (error) {
    const failure = error as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    if (failure.signal) {
      throw new Error(
        `eslint 子进程 ${ESLINT_TIMEOUT}ms 内未结束，已被 ${failure.signal} 终止（stdin 样例：${file} → ${virtualPath}）`,
        { cause: error }
      );
    }
    exitCode = failure.status ?? -1;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
  }
  let reports: Array<{ messages: LintMessage[] }>;
  try {
    reports = JSON.parse(stdout) as Array<{ messages: LintMessage[] }>;
  } catch (parseError) {
    throw new Error(`eslint 未产出 JSON 报告（exit ${exitCode}）：${stderr || stdout}`, { cause: parseError });
  }
  return { exitCode, messages: reports.flatMap((report) => report.messages) };
}

describe('eslint 机检样例（规则自身被机检）', () => {
  it('a11y 必命中：带 onclick 的静态 div 被 svelte/valid-compile 以 error 拦下（无键盘可达 + 缺 role）', () => {
    const { exitCode, messages } = lintFixture('sample.markup.svelte');
    // 只认 error 级：a11y 是硬门槛，规则若被降成 warn，CI 不再失败，此处必须红
    const compileErrors = messages.filter(
      (m) => m.ruleId === 'svelte/valid-compile' && m.severity === 2
    );
    const hit = (code: string): boolean => compileErrors.some((m) => m.message.includes(code));
    expect(hit('a11y_click_events_have_key_events'), '键盘可达性违规未以 error 命中').toBe(true);
    expect(hit('a11y_no_static_element_interactions'), '静态元素交互（缺 role）违规未以 error 命中').toBe(true);
    expect(exitCode, 'eslint 应以 lint error 收场').toBe(1);
  }, LINT_TIMEOUT);

  it('legacy 必命中：export let + $: 的组件在全局 runes 模式下被 svelte/valid-compile 以 error 拦下', () => {
    const { exitCode, messages } = lintFixture('sample.legacy.svelte');
    const compileErrors = messages.filter(
      (m) => m.ruleId === 'svelte/valid-compile' && m.severity === 2
    );
    // 编译错误是抛出式的，一次编译只报首个：两种 legacy 写法命中其一，即证明 lint 期编译
    // 确实拿到了 runes: true（config 的 svelteConfig 一旦丢失，本样例零报错）
    const legacyCodes = ['legacy_export_invalid', 'legacy_reactive_statement_invalid'];
    expect(
      compileErrors.some((m) => legacyCodes.some((code) => m.message.includes(code))),
      'legacy 语法未被 valid-compile 以 error 命中——lint 期的 runes 强制失效？'
    ).toBe(true);
    expect(exitCode, 'eslint 应以 lint error 收场').toBe(1);
  }, LINT_TIMEOUT);

  it('runes 退出口必命中：<svelte:options runes={false}> 被 no-restricted-syntax 以 error 拦下', () => {
    const { exitCode, messages } = lintFixture('sample.optout.svelte');
    // 该标记在编译器里优先于全局 runes 选项：样例以 legacy 模式编译通过，valid-compile 不报，
    // 能拦它的只有 config 里的 runesOptOut 选择器——选择器丢了，或被后加的
    // no-restricted-syntax 块整体覆盖掉，本样例即零报错
    expect(
      messages.some(
        (m) =>
          m.ruleId === 'no-restricted-syntax' &&
          m.severity === 2 &&
          m.message.includes('逐组件退出 runes')
      ),
      'svelte:options runes={false} 未被 no-restricted-syntax 以 error 命中'
    ).toBe(true);
    expect(exitCode, 'eslint 应以 lint error 收场').toBe(1);
  }, LINT_TIMEOUT);

  it('模板内失效指令必命中：未生效的 <!-- eslint-disable-next-line --> 被 svelte/comment-directive 以 error 报出', () => {
    const { exitCode, messages } = lintFixture('sample.stale-directive.svelte');
    // ESLint 核心的 reportUnusedDisableDirectives 只管 JS 注释指令；.svelte 模板里的 HTML
    // 注释指令归 svelte 插件的 comment-directive 上报，其同名选项默认关——config 里那一行
    // 丢了，模板内写错/过期的豁免就没人报，本样例即零报错
    expect(
      messages.some(
        (m) =>
          m.ruleId === 'svelte/comment-directive' &&
          m.severity === 2 &&
          m.message.includes('Unused eslint-disable-next-line directive')
      ),
      '模板内的失效豁免指令未被 svelte/comment-directive 以 error 报出'
    ).toBe(true);
    expect(exitCode, 'eslint 应以 lint error 收场').toBe(1);
  }, LINT_TIMEOUT);

  it('合法样例零报错：console.warn/error/debug 与 _ 前缀未用变量不被误伤', () => {
    const { exitCode, messages } = lintFixture('sample.clean.ts');
    expect(messages, '合法样例被误报').toEqual([]);
    expect(exitCode).toBe(0);
  }, LINT_TIMEOUT);

  // ---------- i18n 三纪律（D6，Task 10 激活）----------
  // 三规则块只挂 apps/web/src/lib 子集，样例内容经 --stdin --stdin-filename 以
  // lib 路径形态驱动（lintStdin）——「块挂上了」与「内容命中了」同时被验。

  it('i18n 必命中（stdin→lib 路径）：CJK 字面量/模板静态段/裸 toLocale*/直读 catalogs/console.log/未用实参全数拦下', () => {
    const { exitCode, messages } = lintStdin('sample.script.ts', 'apps/web/src/lib/sample.script.ts');
    const errors = messages.filter((m) => m.severity === 2);
    const hit = (ruleId: string, marker: string): boolean =>
      errors.some((m) => m.ruleId === ruleId && m.message.includes(marker));
    expect(hit('no-restricted-syntax', '字符串字面量含 CJK'), 'CJK 字面量未命中').toBe(true);
    expect(hit('no-restricted-syntax', '模板串静态段含 CJK'), 'CJK 模板静态段未命中').toBe(true);
    expect(hit('no-restricted-syntax', '裸 Intl'), '裸 toLocale* 未命中').toBe(true);
    expect(hit('no-restricted-imports', '直读 catalogs'), '直读 catalogs 未命中').toBe(true);
    expect(hit('no-console', 'Unexpected console statement'), 'console.log 未命中（no-console 双向化）').toBe(true);
    expect(
      errors.some((m) => m.ruleId === '@typescript-eslint/no-unused-vars'),
      '未用实参未命中'
    ).toBe(true);
    // 门面导入（对照行）不命中：拦的只是 catalogs 直读
    expect(
      errors.filter((m) => m.ruleId === 'no-restricted-imports').length,
      '门面导入被误拦（只应 catalogs 一条）'
    ).toBe(1);
    expect(exitCode, 'eslint 应以 lint error 收场').toBe(1);
  }, LINT_TIMEOUT);

  it('i18n 合法面（stdin→lib 路径）：\\u 转义正则/转义数据值串/i18n 门面导入与 t() 调用零误伤', () => {
    const { exitCode, messages } = lintStdin('sample.clean.ts', 'apps/web/src/lib/sample.clean.ts');
    expect(messages, 'i18n 合法面被误报').toEqual([]);
    expect(exitCode).toBe(0);
  }, LINT_TIMEOUT);

  it('SvelteText 必命中（stdin→lib 路径）：标记文本 CJK 与 a11y 同文件双规则各自命中', () => {
    const { exitCode, messages } = lintStdin('sample.markup.svelte', 'apps/web/src/lib/sample.markup.svelte');
    const errors = messages.filter((m) => m.severity === 2);
    expect(
      errors.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('标记文本')),
      'SvelteText 标记文本 CJK 未命中'
    ).toBe(true);
    // 评审 M-2①:静态属性值 CJK(SvelteLiteral)必命中——aria/title/placeholder 形态
    // 是 Task 10 抽取的最大面,漏挂即防线缺口
    expect(
      errors.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('静态属性值')),
      'SvelteLiteral 静态属性值 CJK 未命中'
    ).toBe(true);
    // 同文件旧规则并存：块覆盖语义下 valid-compile 的 a11y 面不得被顶掉
    expect(
      errors.some((m) => m.ruleId === 'svelte/valid-compile' && m.message.includes('a11y_click_events_have_key_events')),
      'a11y 面被子集块覆盖顶掉'
    ).toBe(true);
    expect(exitCode).toBe(1);
  }, LINT_TIMEOUT);

  it('子集覆盖探针（stdin→lib 路径）：lib 子集块的 no-restricted-syntax 必须同时含退 runes 与 CJK 条目', () => {
    const { exitCode, messages } = lintStdin('sample.libprobe.svelte', 'apps/web/src/lib/sample.libprobe.svelte');
    const errors = messages.filter((m) => m.ruleId === 'no-restricted-syntax' && m.severity === 2);
    expect(
      errors.some((m) => m.message.includes('逐组件退出 runes')),
      'runesOptOut 条目被子集块顶掉（后块覆盖前块未展开）——静默防线的洞'
    ).toBe(true);
    expect(
      errors.some((m) => m.message.includes('标记文本')),
      '子集块未挂上（CJK 条目缺失）'
    ).toBe(true);
    expect(exitCode).toBe(1);
  }, LINT_TIMEOUT);

  it('style 块 CSS 注释合法样例（stdin→lib 路径）：:not(SvelteStyleElement SvelteText) 排除面零误报（评审 M-2②）', () => {
    const { exitCode, messages } = lintStdin('sample.svelte-clean.svelte', 'apps/web/src/lib/sample.svelte-clean.svelte');
    expect(messages, 'style 块中文 CSS 注释被误报（:not 排除面失效）').toEqual([]);
    expect(exitCode).toBe(0);
  }, LINT_TIMEOUT);

  it('裸 Intl 双向探针：lib 普通路径必命中、i18n/format.ts 虚拟路径零报（唯一豁免点）', () => {
    const hitRun = lintStdin('sample.intl.ts', 'apps/web/src/lib/sample.intl.ts');
    expect(
      hitRun.messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.severity === 2 && m.message.includes('裸 Intl')
      ),
      '裸 Intl 在 lib 普通路径未命中'
    ).toBe(true);
    expect(hitRun.exitCode).toBe(1);

    const exemptRun = lintStdin('sample.intl.ts', 'apps/web/src/lib/i18n/format.ts');
    expect(exemptRun.messages, 'format.ts 豁免面被误报').toEqual([]);
    expect(exemptRun.exitCode).toBe(0);
  }, LINT_TIMEOUT);

  it('runesOptOut 全局块仍挂载（fixtures 路径常规驱动）：子集块化后旧块防线不丢', () => {
    // sample.optout.svelte 的既有断言（上文）已覆盖旧块；此处补验「lib 之外」的
    // svelte 文件仍被旧块覆盖——fixtures 路径不落 lib 子集块，退 runes 命中
    // 只能来自全局旧块，恰好证明两条块并存互不顶掉
    const { exitCode, messages } = lintFixture('sample.optout.svelte');
    expect(
      messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.severity === 2 && m.message.includes('逐组件退出 runes')
      )
    ).toBe(true);
    expect(exitCode).toBe(1);
  }, LINT_TIMEOUT);
});
