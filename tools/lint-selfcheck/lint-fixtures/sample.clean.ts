/* lint 自检样例（合法代码，零报错——防误伤回归）：console 三放行（warn/error/debug）与
 * `_` 前缀的未用形参/变量都不该命中。
 * 本目录已入 eslint.config.js 的全局 ignores，常规 lint 不扫，仅
 * tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 显式驱动。
 * 注意：本注释勿以 eslint 指令形态开头（会被当成文件级配置解析）。 */

export function report(message: string, _reserved?: unknown): void {
  const _unusedPlaceholder = message.length;
  console.warn(message);
  console.error(message);
  console.debug(message);
}
