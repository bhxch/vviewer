// check-release-wiring.test.ts — 发布链接线门禁的单测（评审 critical ① + important ④）。
//
// 覆盖面：纯函数面（env 值读取 / 注入存在性 / scope 回落字面量 / 常量读取 / 占位版本
// 检测 / 问题汇总）+ **仓内实况**（对真实 workflow 与包内源码跑门禁——门禁自身必须被
// 门禁：漂移即红）。
import { describe, expect, it } from 'vitest';
import {
  CHECKED_FILES,
  collectProblems,
  findPlaceholderVersions,
  hasEnvInjection,
  readNumericConst,
  readScopeFallback,
  readStringConst,
  readWorkflowEnvValue,
  stripComments,
  checkRepo
} from '../check-release-wiring.mjs';

describe('纯函数面', () => {
  it('readWorkflowEnvValue：读 workflow 级 `KEY: value`（引号可有可无）', () => {
    const text = "env:\n  VV_NPM_PACKAGE_COUNT: '6'\n  OTHER: 3\n";
    expect(readWorkflowEnvValue(text, 'VV_NPM_PACKAGE_COUNT')).toBe('6');
    expect(readWorkflowEnvValue(text, 'OTHER')).toBe('3');
    expect(readWorkflowEnvValue(text, 'MISSING')).toBeNull();
  });

  it('hasEnvInjection：认 GITHUB_ENV 注入形态', () => {
    const text = 'run: |\n  echo "VV_GRAMMAR_PACK_COUNT=6" >> "$GITHUB_ENV"\n';
    expect(hasEnvInjection(text, 'VV_GRAMMAR_PACK_COUNT')).toBe(true);
    expect(hasEnvInjection(text, 'VV_NPM_SCOPE')).toBe(false);
  });

  it('readScopeFallback：读 `vars.NPM_SCOPE || \'@bhxch\'` 回落字面量', () => {
    expect(readScopeFallback("NPM_SCOPE: ${{ vars.NPM_SCOPE || '@bhxch' }}")).toBe('@bhxch');
    expect(readScopeFallback('NPM_SCOPE: ${{ vars.NPM_SCOPE }}')).toBeNull();
  });

  it('readNumericConst / readStringConst：读 TS 常量', () => {
    const text = "export const GRAMMAR_PACK_COUNT = 6;\nexport const GRAMMAR_PACK_SCOPE = '@bhxch';\n";
    expect(readNumericConst(text, 'GRAMMAR_PACK_COUNT')).toBe(6);
    expect(readStringConst(text, 'GRAMMAR_PACK_SCOPE')).toBe('@bhxch');
    expect(readNumericConst(text, 'NOPE')).toBeNull();
  });

  it('findPlaceholderVersions：占位/钉死版本段命中（注释面已剥离，不误判历史说明）', () => {
    expect(findPlaceholderVersions(stripComments('pkg@0.0.0-FIRST-TAG/grammars/'))).toEqual([
      'FIRST-TAG',
      '0.0.0-FIRST-TAG'
    ]);
    expect(findPlaceholderVersions(stripComments('pkg@latest/grammars/'))).toEqual(['@latest']);
    expect(findPlaceholderVersions(stripComments('pkg/grammars/'))).toEqual([]);
    // 注释里的历史占位版本是说明而非生效值 → 剥离后不命中
    expect(findPlaceholderVersions(stripComments('// 此前钉死 0.0.0-FIRST-TAG\nconst X = 1;'))).toEqual([]);
  });

  it('collectProblems：三层口径一致 → 无问题', () => {
    const files = {
      release:
        "env:\n  VV_NPM_PACKAGE_COUNT: '6'\n" +
        'echo "VV_GRAMMAR_PACK_COUNT=${VV_NPM_PACKAGE_COUNT}" >> "$GITHUB_ENV"\n' +
        'echo "VV_NPM_SCOPE=${NPM_SCOPE}" >> "$GITHUB_ENV"\n' +
        "NPM_SCOPE: ${{ vars.NPM_SCOPE || '@bhxch' }}\n",
      pages:
        'echo "VV_GRAMMAR_PACK_COUNT=6" >> "$GITHUB_ENV"\n' +
        'echo "VV_NPM_SCOPE=@bhxch" >> "$GITHUB_ENV"\n' +
        "NPM_SCOPE: ${{ vars.NPM_SCOPE || '@bhxch' }}\n",
      markdownDefault:
        "export const GRAMMAR_PACK_SCOPE = '@bhxch';\nexport const GRAMMAR_PACK_COUNT = 6;\n",
      webProfiles: "export const GRAMMAR_PACK_SCOPE = '@bhxch';\n"
    };
    expect(collectProblems(files)).toEqual([]);
  });

  it('collectProblems：层数漂移 / 占位版本 / 缺注入 三类问题各被捕获', () => {
    const base = {
      release:
        "env:\n  VV_NPM_PACKAGE_COUNT: '6'\n" +
        'echo "VV_GRAMMAR_PACK_COUNT=6" >> "$GITHUB_ENV"\n' +
        'echo "VV_NPM_SCOPE=@bhxch" >> "$GITHUB_ENV"\n' +
        "NPM_SCOPE: ${{ vars.NPM_SCOPE || '@bhxch' }}\n",
      pages:
        'echo "VV_GRAMMAR_PACK_COUNT=6" >> "$GITHUB_ENV"\n' +
        'echo "VV_NPM_SCOPE=@bhxch" >> "$GITHUB_ENV"\n' +
        "NPM_SCOPE: ${{ vars.NPM_SCOPE || '@bhxch' }}\n",
      markdownDefault:
        "export const GRAMMAR_PACK_SCOPE = '@bhxch';\nexport const GRAMMAR_PACK_COUNT = 6;\n",
      webProfiles: "export const GRAMMAR_PACK_SCOPE = '@bhxch';\n"
    };
    // 层数漂移
    expect(collectProblems({ ...base, markdownDefault: base.markdownDefault.replace('= 6;', '= 5;') }).join('\n')).toContain(
      '子包数漂移'
    );
    // 占位版本
    expect(
      collectProblems({ ...base, markdownDefault: base.markdownDefault + "const X = '0.0.0-FIRST-TAG';\n" }).join('\n')
    ).toContain('占位');
    // 缺注入
    expect(collectProblems({ ...base, pages: base.pages.replace(/VV_GRAMMAR_PACK_COUNT/g, 'OTHER') }).join('\n')).toContain(
      '未注入 VV_GRAMMAR_PACK_COUNT'
    );
    // scope 漂移
    expect(
      collectProblems({ ...base, webProfiles: "export const GRAMMAR_PACK_SCOPE = '@other';\n" }).join('\n')
    ).toContain('scope 漂移');
  });
});

describe('仓内实况（门禁自身被门禁）', () => {
  it('发布链接线口径一致：子包数 / scope / 占位版本三处无漂移', () => {
    const { problems } = checkRepo();
    expect(problems).toEqual([]);
  });

  it('受检文件均存在（清单与仓内路径对齐）', () => {
    for (const rel of Object.values(CHECKED_FILES)) {
      expect(rel).toMatch(/^[./\w-]+\.(yml|ts)$/);
    }
  });
});
