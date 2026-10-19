// appShellFontScroll.test.ts — AppShell j/k 滚动步长与代码字号联动的源码契约
// （字体系统台账 M2）。根 vitest 无 svelte 插件，AppShell 不可挂载——按既有
// 「源码契约断言」先例（exportPanel.test.ts/MetaPanel）锁定接线；步长公式本身
// 是纯函数，theme.fonts.test.ts 已覆盖（9→16 / 13→20 / 28→42），此处不复测。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('j/k 步长联动（台账 M2：CODE_LINE_HEIGHT 常量退役）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('j/k 键处理器即时同源读取：codeLineHeight(loadSettings().fonts.codeSize)，常量已移除', () => {
    expect(src).toContain("import { codeLineHeight } from './theme';");
    expect(src.match(/codeLineHeight\(loadSettings\(\)\.fonts\.codeSize\)/g)?.length).toBe(2); // j 与 k 各一处
    expect(src).not.toContain('CODE_LINE_HEIGHT'); // 常量声明与消费点均退役（e2e 注释引用除外）
  });

  it('同源契约：theme.ts 的 codeLineHeight 即注入公式（max(16, round(codeSize × 1.5))）', () => {
    expect(readSrc('src/lib/theme.ts')).toMatch(
      /export function codeLineHeight\(codeSize: number\): number \{\s*return Math\.max\(16, Math\.round\(codeSize \* 1\.5\)\);/
    );
  });
});
