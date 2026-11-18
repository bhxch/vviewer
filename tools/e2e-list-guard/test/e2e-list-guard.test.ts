// e2e-list-guard.test.ts — 分片用例守恒护栏脚本的单测（评审 minor：此前零单测——
// 其纯函数输出格式一变即在 CI 以「清单文件无「Total:」行」形态炸）。
//
// 覆盖面：parseListOutput（--list 输出解析/缺 Total 行/单数形态）、normalizeShard
// （分片标识归一/分母校验）、SHARD_COUNT 常量。另注：脚本此前顶层无条件执行 main
// （导入即触发 CLI 分支并改写 process.exitCode → 单测无法导入）——已改为仅直接执行时
// 跑 main（与 check-e2e-surfaces.mjs 同款形态）。
import { describe, expect, it } from 'vitest';
import { SHARD_COUNT, normalizeShard, parseListOutput } from '../../e2e-list-guard.mjs';

describe('parseListOutput（playwright --list 输出解析）', () => {
  it('标准形态：Total: N tests in M files → {tests, files}', () => {
    expect(parseListOutput('Total: 1768 tests in 62 files\n')).toEqual({ tests: 1768, files: 62 });
  });

  it('单数形态（1 test in 1 file）同样解析', () => {
    expect(parseListOutput('Total: 1 test in 1 file\n')).toEqual({ tests: 1, files: 1 });
  });

  it('缺「Total:」行 → null（spec 模块加载失败的形态——调用方据此报错）', () => {
    expect(parseListOutput('Error: Cannot find module\n')).toBeNull();
    expect(parseListOutput('')).toBeNull();
  });

  it('Total 行不在行首（前缀噪声）→ null（严格锚定行首，避免误匹配）', () => {
    expect(parseListOutput('  Total: 10 tests in 2 files\n')).toBeNull();
  });
});

describe('normalizeShard（分片标识归一与分母校验）', () => {
  it(`合法分片（'1/4'）→ '1'（分母须为 ${SHARD_COUNT}）`, () => {
    expect(normalizeShard('1/4')).toBe('1');
    expect(normalizeShard(' 2 / 4 ')).toBe('2');
    expect(normalizeShard('4/4')).toBe('4');
  });

  it('分母不符 → 抛错（分片拓扑漂移即红）', () => {
    expect(() => normalizeShard('1/3')).toThrow(/分母/);
    expect(() => normalizeShard('1/5')).toThrow(/分母/);
  });

  it('非分片形态 → 原样（trim）返回', () => {
    expect(normalizeShard('  1  ')).toBe('1');
    expect(normalizeShard('all')).toBe('all');
  });
});

describe('常量', () => {
  it('SHARD_COUNT = 4（ci.yml 四分片拓扑——变更即须同步 workflow）', () => {
    expect(SHARD_COUNT).toBe(4);
  });
});
