/**
 * lint 自检（机检自身被机检）：规则配对了没有，不能靠「lint 是绿的」证明——绿既可能是代码
 * 干净，也可能是规则压根没生效。这里以 --no-ignore 驱动真实 eslint（根 flat config 全量规则）
 * 扫必命中样例与合法样例，断言「该拦的拦下了、不该拦的没误伤」。
 *
 * 样例位于 tools/lint-selfcheck/lint-fixtures/（已入 eslint 全局 ignores，常规 lint 不扫）。
 * i18n 三条纪律（CJK 字面量 / 裸 Intl / 直读 catalogs）激活时，其必命中样例与断言在此扩展。
 */
import { execFileSync } from 'node:child_process';
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
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    // 必命中样例以 exit 1 收场——非零退出在此捕获，stdout 仍携带 JSON 报告
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
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

// eslint CLI 冷启动（加载 config 与三套插件）在全量并发下明显慢于单测均值——用例级放宽超时
const LINT_TIMEOUT = 30_000;

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

  it('合法样例零报错：console.warn/error/debug 与 _ 前缀未用变量不被误伤', () => {
    const { exitCode, messages } = lintFixture('sample.clean.ts');
    expect(messages, '合法样例被误报').toEqual([]);
    expect(exitCode).toBe(0);
  }, LINT_TIMEOUT);
});
