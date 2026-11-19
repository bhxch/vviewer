// check-workflow-schema.test.ts — workflow schema 门禁的单测。
//
// 覆盖面：纯函数面（规则命中/不命中、只扫 if 行、env 取 secrets 的合法形态不误报）
// + **仓内实况**（对真实 workflow/action 跑门禁——门禁自身必须被门禁：违规即红）。
import { describe, expect, it } from 'vitest';
import {
  CHECKED_DIRS,
  RULES,
  collectWorkflowFiles,
  run,
  scanWorkflowText,
} from '../check-workflow-schema.mjs';

describe('纯函数面', () => {
  it('R1：if 表达式内出现 secrets. 即违规（job 级与 step 级同判）', () => {
    const jobLevel = "jobs:\n  pub:\n    if: ${{ secrets.TOKEN != '' }}\n    runs-on: ubuntu-latest\n";
    const stepLevel = "    - name: 上传\n      if: ${{ secrets.TOKEN != '' }}\n      run: echo hi\n";
    expect(scanWorkflowText('x.yml', jobLevel)).toHaveLength(1);
    expect(scanWorkflowText('x.yml', stepLevel)).toHaveLength(1);
  });

  it('R1：违规条目带 file/line/ruleId/修法提示', () => {
    const text = 'a:\n  b:\n    if: ${{ secrets.X }}\n';
    const f = scanWorkflowText('wf.yml', text);
    expect(f).toHaveLength(1);
    expect(f[0].file).toBe('wf.yml');
    expect(f[0].line).toBe(3);
    expect(f[0].ruleId).toBe('R1');
    expect(f[0].fix.length).toBeGreaterThan(10);
  });

  it('合法形态不误报：secret 注入 step 的 env + run 脚本内判空', () => {
    const text = [
      '    - name: 上传',
      '      env:',
      '        TOKEN: ${{ secrets.TOKEN }}',
      '      run: |',
      '        if [ -z "${TOKEN}" ]; then exit 0; fi',
      '        echo publish',
    ].join('\n');
    expect(scanWorkflowText('x.yml', text)).toHaveLength(0);
  });

  it('非 if 行不误报（env 里的 secrets 合法、注释里的 secrets 合法）', () => {
    const text = [
      '# 注释：if: ${{ secrets.X }} 只是举例',
      '      env:',
      '        TOKEN: ${{ secrets.TOKEN }}',
    ].join('\n');
    expect(scanWorkflowText('x.yml', text)).toHaveLength(0);
  });

  it('非 secrets 的 context 表达式不误报（vars/inputs/github 在 if 中合法）', () => {
    const text = "    if: \${{ vars.NPM_SCOPE != '' && inputs.dry_run == 'false' }}\n";
    expect(scanWorkflowText('x.yml', text)).toHaveLength(0);
  });

  it('规则表非空且每条有 message/fix', () => {
    expect(RULES.length).toBeGreaterThan(0);
    for (const r of RULES) {
      expect(r.id.length).toBeGreaterThan(0);
      expect(r.message.length).toBeGreaterThan(0);
      expect(r.fix.length).toBeGreaterThan(0);
    }
  });
});

describe('仓内实况', () => {
  it('受检文件收集：workflows + actions 下的 yml/yaml 全收且非空', () => {
    const files = collectWorkflowFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const dir of CHECKED_DIRS) {
      expect(files.some((f) => f.startsWith(dir))).toBe(true);
    }
    expect(files.every((f) => f.endsWith('.yml') || f.endsWith('.yaml'))).toBe(true);
    // 排序稳定（幂等）
    expect([...files].sort()).toEqual(files);
  });

  it('仓内全部 workflow/action 过门禁（漂移即红——门禁自身必须被门禁）', () => {
    expect(run()).toEqual([]);
  });
});
