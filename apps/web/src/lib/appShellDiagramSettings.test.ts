// appShellDiagramSettings.test.ts — mermaid theme 设置即时生效派发源码契约（spec §9.2）。
// 背景：根 vitest 无 svelte 插件，AppShell 不可挂载——按既有「源码契约断言」先例
//（appShellZenMobile.test.ts/appShellZenEsc.test.ts）锁定 onSettingsChanged 回调内的
// 派发接线；重画行为由 packages/render-text markdownRenderer.mermaidTheme.test.ts
// 挂载实例级单测收口。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('vv:diagram-settings-applied 派发（spec §9.2，Task 7）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('onSettingsChanged 内 diff diagrams.mermaidTheme：仅实际变化才派发（无关设置保存零重画）', () => {
    expect(src).toContain("vv:diagram-settings-applied");
    // 旧值捕获先于 settings 赋值（赋值后即失旧值），diff 通过才 dispatch
    expect(src).toMatch(/prevMermaidTheme = settings\.diagrams\.mermaidTheme;[\s\S]{0,400}settings = s;/);
    expect(src).toMatch(/mermaidTheme !== prevMermaidTheme[\s\S]{0,300}dispatchEvent/);
  });

  it("detail.mermaidTheme 为生效主题：auto 解析为当前亮暗映射（resolveMermaidTheme(effectiveMode)），显式值原样", () => {
    expect(src).toMatch(
      /mermaidTheme:\s*\w+ === 'auto'\s*\?\s*resolveMermaidTheme\(effectiveMode\(s\.themeMode\)\)\s*:\s*\w+/
    );
  });

  it("theme.ts 导入接线：effectiveMode 与 resolveMermaidTheme 经 './theme' 引入", () => {
    expect(src).toMatch(/import\s*\{\s*[^}]*\beffectiveMode\b[^}]*\bresolveMermaidTheme\b[^}]*\}\s*from\s*'\.\/theme'/s);
  });
});
