// fontPresets.test.ts — 预设网络字体清单契约（spec C §3.3，Task 4）：形态/多源/
// family 唯一（已添加态判定键）/URL 实测形态/D8 CJK 转义纪律（源码 raw 形态）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssPresetFontPackExclusions, FONT_PRESETS } from './fontPresets';

const sourceText = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), './fontPresets.ts'),
  'utf8'
);

describe('FONT_PRESETS 预设清单（spec C §3.3 builder 实测选定终版）', () => {
  it('7 条目、双 kind 齐备（中文 css ×3 + 西文 single ×4），family 唯一（已添加态判定键）', () => {
    expect(FONT_PRESETS.length).toBe(7);
    expect(FONT_PRESETS.filter((p) => p.kind === 'css').map((p) => p.family)).toEqual([
      'LXGW WenKai',
      'Noto Sans SC',
      'Noto Serif SC'
    ]);
    expect(FONT_PRESETS.filter((p) => p.kind === 'single').map((p) => p.family)).toEqual([
      'JetBrains Mono',
      'Fira Code',
      'Iosevka',
      'Inter'
    ]);
    const families = FONT_PRESETS.map((p) => p.family);
    expect(new Set(families).size).toBe(families.length);
  });

  it('每条多源 ≥2（计划硬门）：css 型三源含中文源 npmmirror；single 型双源 jsdelivr+unpkg', () => {
    for (const p of FONT_PRESETS) {
      expect(p.sources.length, `${p.family} sources`).toBeGreaterThanOrEqual(2);
      expect(p.sources[0]!.label).toBe('jsdelivr'); // 首源=缺省推荐源
      if (p.kind === 'css') {
        expect(p.sources.map((s) => s.label)).toEqual(['jsdelivr', 'unpkg', 'npmmirror']);
      } else {
        expect(p.sources.map((s) => s.label)).toEqual(['jsdelivr', 'unpkg']);
      }
    }
  });

  it('URL 形态：全部 https 且**不以** / 结尾（css=.css / single=.woff2）；版本段为精确版本（钉死纪律，禁 @5 浮动段）', () => {
    for (const p of FONT_PRESETS) {
      for (const s of p.sources) {
        expect(s.url.startsWith('https://'), `${p.family} ${s.label}`).toBe(true);
        expect(s.url.endsWith('/'), `${p.family} ${s.label}`).toBe(false);
        if (p.kind === 'css') expect(s.url.endsWith('.css'), s.url).toBe(true);
        else expect(s.url.endsWith('.woff2'), s.url).toBe(true);
        // 钉死纪律：@fontsource 系与 lxgw 均带精确版本段（非主版本浮动 @5/@1 形态）
        expect(s.url).toMatch(/@5\.\d+\.\d+|@1\.\d+\.\d+|\//);
        expect(s.url, `浮动主版本段禁入：${s.url}`).not.toMatch(/@fontsource\/[^/]+@5\//);
      }
    }
  });

  it('D8 CJK 转义纪律：displayName 赋值行源码 raw 形态无未转义 CJK（注释 CJK 合法——lint 三形态只拦 Literal/Template/SvelteText）', () => {
    // fontPresets.ts 位于 lib（CJK 字面量禁令 lint 面）——displayName 数据值的 CJK
    // 以 \u 转义形态保留（lint 按 raw 匹配）；注释里的 CJK 不属三形态合法在场
    for (const line of sourceText.split('\n').filter((l) => l.includes('displayName:'))) {
      expect(line, `未转义 CJK 字面量：${line.trim()}`).not.toMatch(/[\u4e00-\u9fff]/);
    }
    // 运行时值含 CJK（霞鹜文楷）：转义后解码正确
    expect(FONT_PRESETS[0]!.displayName).toContain('LXGW WenKai');
    expect(FONT_PRESETS[0]!.displayName).toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('cssPresetFontPackExclusions（SW 排除集——spec §7 css 型切片不入缓存）', () => {
  it('css 型 jsdelivr 包全名集合（含 scope 段）；single 型包不在集；无裸 scope 段（防单段捕获误排整个 scope）', () => {
    expect(cssPresetFontPackExclusions().sort()).toEqual([
      '@fontsource/noto-sans-sc',
      '@fontsource/noto-serif-sc',
      'lxgw-wenkai-webfont'
    ]);
    // single 型（@fontsource/jetbrains-mono 等）不在排除集——SW 命中无害（每包 1 文件）
    for (const p of FONT_PRESETS.filter((x) => x.kind === 'single')) {
      const scopePack = /npm\/((?:@[^/]+\/)?[^/]+)\//.exec(p.sources[0]!.url)?.[1];
      expect(scopePack, `${p.family} 不应入排除集`).not.toBe(cssPresetFontPackExclusions().includes(scopePack as string));
      expect(cssPresetFontPackExclusions()).not.toContain(scopePack!);
    }
  });
});
