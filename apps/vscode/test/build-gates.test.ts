// build-gates.test.ts — 构建门纯函数契约（spec H T1）。
//
// 覆盖面：spec §5 两条打包门锚的判定逻辑——
// - 「esbuild 产物无未解析 import」：metafile 扫描，唯一豁免 = host bundle 的 vscode
// - 「vsce package 体积 <100MB」：dist/ 递归字节预检 + .vsix 实包字节断言
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SIZE_LIMIT_BYTES,
  assertUnderLimit,
  dirSize
} from '../scripts/check-size.mjs';
import {
  assertNoUnresolvedImports,
  findUnresolvedImports
} from '../scripts/check-unresolved-imports.mjs';

describe('构建门 · 未解析 import 扫描', () => {
  const metafile = {
    outputs: {
      'dist/extension.js': {
        imports: [{ path: 'vscode', kind: 'require-call', external: true }]
      },
      'dist/webview/main.js': {
        imports: [{ path: './chunk-ABC.js', kind: 'import-statement' }]
      }
    }
  };

  it('host bundle 的 vscode 是唯一豁免——不报', () => {
    expect(findUnresolvedImports(metafile, ['vscode'])).toEqual([]);
    expect(() => assertNoUnresolvedImports(metafile, ['vscode'])).not.toThrow();
  });

  it('未豁免的 external import 即报（产物图可审计）', () => {
    const bad = {
      outputs: {
        'dist/webview/main.js': {
          imports: [{ path: 'some-missing-pkg', kind: 'import-statement', external: true }]
        }
      }
    };
    const found = findUnresolvedImports(bad, ['vscode']);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe('some-missing-pkg');
    expect(() => assertNoUnresolvedImports(bad, ['vscode'])).toThrow(/未解析 import/);
  });

  it('非 external 的 chunk 间 import 不算未解析', () => {
    expect(findUnresolvedImports(metafile, [])).toHaveLength(1); // 仅 vscode 那条
    expect(findUnresolvedImports(metafile, [])[0]!.path).toBe('vscode');
  });
});

describe('构建门 · 体积门', () => {
  it('递归求目录字节和', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-vscode-size-'));
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(100));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), Buffer.alloc(50));
    expect(dirSize(dir)).toBe(150);
  });

  it('小于上限即通过；达到上限即失败（严格小于 100MB）', () => {
    expect(assertUnderLimit(SIZE_LIMIT_BYTES - 1, SIZE_LIMIT_BYTES, 'x')).toBe(SIZE_LIMIT_BYTES - 1);
    expect(() => assertUnderLimit(SIZE_LIMIT_BYTES, SIZE_LIMIT_BYTES, 'x')).toThrow(/超限/);
    expect(() => assertUnderLimit(SIZE_LIMIT_BYTES + 1, SIZE_LIMIT_BYTES, 'x')).toThrow(/超限/);
  });

  it('上限常量即 100MB', () => {
    expect(SIZE_LIMIT_BYTES).toBe(100 * 1024 * 1024);
  });
});
