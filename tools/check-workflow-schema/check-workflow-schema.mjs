// check-workflow-schema.mjs — GitHub Actions workflow schema 门禁。
//
// 背景（2026-11-19 首轮 push 的 CI-only 事故）：`.github/workflows/publish-vscode.yml`
// 用了 `if: ${{ secrets.OVSX_PAT != '' }}`——**`secrets` context 在 job 级 `if` 与
// step 级 `if` 的可用 context 中均不存在**（GitHub 官方可用 context 表：job 级 if 为
// github/needs/vars/inputs；step 级 if 为 github/strategy/matrix/job/runner/env/vars/
// steps/inputs）。GitHub 在**校验期**即拒绝整个 workflow 文件 → 该 workflow 0 job、
// 0 秒失败，且 **workflow 名回落为文件路径**（GitHub 用路径当名字 = 解析失败特征）。
//
// 为什么本地静态校验抓不到：本地 yaml.safe_load / Python yaml 解析**只验 YAML 语法**，
// 不验 workflow schema。GitHub 的 context 可用性规则不在 YAML 语法层——故「本地全绿 +
// GitHub 整个文件拒绝」是可同时成立的。本门禁把该规则前置成本地可跑的文本门禁。
//
// 规则（本门禁覆盖的 context 可用性违规）：
//   R1  `if:` 表达式内出现 `secrets.` —— job 级与 step 级 `if` 均不可用（合法用法：
//       把 secret 注入 step 的 `env`，再在 run 脚本内判空）。
//   R2  `if:` 表达式内出现 `inputs.` 于 job 级 —— job 级 if 的可用 context 含 inputs，
//       本门禁不拦；但为免误报，只拦 secrets（唯一确定违规项）。
//
// 明确的非目标：
//   - 不做完整 workflow schema 校验（GitHub 的 actionlint 覆盖面远大于此）；本门禁
//     只拦「本地可静态判定且已实证会导致整文件被拒」的违规项。
//   - 不引 yaml 依赖（与 check-release-wiring 同款：纯文本解析，避免新增依赖面）。
//
// 用法：node tools/check-workflow-schema/check-workflow-schema.mjs
// 退出码：0 = 全过；1 = 有违规（逐条打印文件:行号 + 违规原文 + 修法提示）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 受检目录（相对仓库根）——workflow 与 composite action 都在其下。 */
export const CHECKED_DIRS = ['.github/workflows', '.github/actions'];

/** 受检文件后缀。 */
export const CHECKED_SUFFIXES = ['.yml', '.yaml'];

/**
 * 违规规则表：id → { pattern, message, fix }。
 * pattern 在**单行**文本上匹配（if 表达式按 GitHub 惯例写在同一行）。
 */
export const RULES = [
  {
    id: 'R1',
    pattern: /\$\{\{[^}]*\bsecrets\.[^}]*\}\}/,
    message: 'if 表达式内使用 secrets context',
    fix:
      "GitHub 的 job 级 if 与 step 级 if 的可用 context 均**不含 secrets**（校验期直接拒绝整个 workflow 文件 → 0 job 失败）。" +
      '修法：把 secret 注入该 step 的 env，再在 run 脚本内判空（例：if [ -z "${TOKEN}" ]; then … exit 0; fi）。',
  },
];

/**
 * 收集受检文件（递归）。
 * @returns {string[]} 仓库相对路径（排序）
 */
export function collectWorkflowFiles() {
  const out = [];
  for (const dir of CHECKED_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (CHECKED_SUFFIXES.some((s) => entry.name.endsWith(s))) {
          out.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }
  return out.sort();
}

/**
 * 逐行扫描一个 workflow 文本，命中违规即产出条目。
 * @param {string} relPath 仓库相对路径（用于定位）
 * @param {string} text 文件文本
 * @returns {{ file: string, line: number, ruleId: string, text: string, message: string, fix: string }[]} 违规条目
 */
export function scanWorkflowText(relPath, text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    // 只看 if 行：`if:` 表达式所在行（GitHub 允许 if 同行或次行写表达式，
    // 次行写法为 `if: >-` 折叠块——那种形态下表达式落在续行上，故不限定同行）。
    if (!/^\s*if\s*:/.test(line)) return;
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        file: relPath,
        line: idx + 1,
        ruleId: rule.id,
        text: line.trim(),
        message: rule.message,
        fix: rule.fix,
      });
    }
  });
  return findings;
}

/**
 * 主入口：扫描全部受检文件。
 * @returns {{ file: string, line: number, ruleId: string, text: string, message: string, fix: string }[]} 全部违规
 */
export function run() {
  const findings = [];
  for (const rel of collectWorkflowFiles()) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    findings.push(...scanWorkflowText(rel, text));
  }
  return findings;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const findings = run();
  if (findings.length === 0) {
    const files = collectWorkflowFiles();
    console.log(`[check-workflow-schema] ${files.length} 个 workflow/action 文件全过（${RULES.map((r) => r.id).join(',')}）`);
    process.exit(0);
  }
  for (const f of findings) {
    console.error(`[check-workflow-schema] ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
    console.error(`  原文：${f.text}`);
    console.error(`  ${f.fix}`);
  }
  console.error(`[check-workflow-schema] ${findings.length} 条违规（退出码 1）`);
  process.exit(1);
}
