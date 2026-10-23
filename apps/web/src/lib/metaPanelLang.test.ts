// metaPanelLang.test.ts — renderer-lang-override Task 5：MetaPanel 语言行升级
// （input + datalist，spec §4.2）。MetaPanel.svelte 为 runes 组件，根 vitest 无
// svelte 插件不可挂载（watchHealth.test.ts 同因同形态）：UI 行为直测不可达，按
// 「源码契约断言」先例钉住语言行的结构面与提交语义；langdetect 候选集行为在
// packages/highlight/test/langdetect.test.ts 行为直测，运行期交互由 e2e 收口。
//
// 契约面：
// ① datalist 结构配对：input[list="vv-lang-datalist"] + <datalist id="vv-lang-datalist">
//    （Task 6 跳转聚焦目标的查询锚，AppShell 侧同 id 选择器依赖本面）；
// ② langNames 一次性取值（语言表静态，顶层 const 非 $derived/$state）；
// ③ onLangCommit 提交语义：trim 判空 → setHighlightLang(null) 清除回自动，否则
//    原值宽松透传（不校验候选集，引擎链自兜底）；
// ④ 显示值/「（手动）」徽标自激活 tab 的 overrideLang 派生（openWithUi 同款 tab
//    侧直读，不随 meta 实例出现/消失）；
// ⑤ placeholder 回显自动检测语言（highlightAuto 嗅探不回写本行 = 既有现状）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest 会转译 import.meta.url（watchHealth.test.ts 同款双 cwd 兼容根/apps/web）
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

/** 函数体窗口：自签名行至首个列 2 闭合 `}`（内层块均有缩进，watchHealth.test.ts 同款）。 */
function fnWindow(src: string, signature: RegExp): string {
  const fn = src.match(signature);
  expect(fn, `函数窗口未命中：${signature}`).not.toBeNull();
  return fn![0];
}

describe('MetaPanel 语言行（Task 5 源码契约锚）', () => {
  const src = readSrc('src/lib/MetaPanel.svelte');

  it('datalist 结构配对：input[list=vv-lang-datalist] + datalist id 同名（Task 6 聚焦锚）', () => {
    expect(src).toContain('list="vv-lang-datalist"');
    expect(src).toContain('<datalist id="vv-lang-datalist">');
  });

  it('langNames 一次性取值：顶层 const 直调 detectableLanguageNames（非 $derived/$state）', () => {
    expect(src).toMatch(/const langNames = detectableLanguageNames\(\);/);
    // 防回归：候选集静态，不得裹进响应式包装（每次派生重算无意义）
    expect(src).not.toMatch(/\$derived[^;]*detectableLanguageNames/);
    expect(src).not.toMatch(/\$state[^;]*detectableLanguageNames/);
  });

  it('onLangCommit 提交语义：trim 判空 → null 清除，否则原值宽松透传（单点走 setHighlightLang）', () => {
    const fn = fnWindow(src, /function onLangCommit\(raw: string\): void \{[\s\S]*?\n  \}/);
    const call = fn.indexOf('tabStore.setHighlightLang(');
    expect(call).toBeGreaterThan(-1); // 唯一下行通道（setHighlightLang，Task 3 接口）
    expect(fn.indexOf('tabStore.setHighlightLang(', call + 1)).toBe(-1);
    expect(fn).toContain('raw.trim() === \'\' ? null : raw');
    // 不校验候选集：无 detectableLanguageNames/names.includes 等校验写点（宽松透传）
    expect(fn).not.toMatch(/includes|langNames/);
  });

  it('显示值/徽标自激活 tab 的 overrideLang 派生（openWithUi 同款 tab 侧直读）', () => {
    const derived = fnWindow(
      src,
      /const langOverrideUi = \$derived\.by\(\(\) => \{[\s\S]*?\n  \}\);/
    );
    expect(derived).toContain("tabStore.list.find((t) => t.active)");
    expect(derived).toContain('tab?.overrideLang ?? \'\'');
    expect(derived).toContain('tab?.overrideLang !== undefined');
    // 徽标复用打开方式行的既有类（（手动）文案同款）
    expect(src).toContain('{#if langOverrideUi.active}<span class="meta-openwith-manual">（手动）</span>{/if}');
  });

  it('placeholder 回显自动检测语言（嗅探不回写既有现状）：fileMeta.lang 缺省「自动」', () => {
    expect(src).toContain("placeholder={fileMeta.lang ? `自动（${fileMeta.lang}）` : '自动'}");
  });

  it('a11y 面：aria-label「高亮语言（留空自动检测）」+ spellcheck=false', () => {
    expect(src).toContain('aria-label="高亮语言（留空自动检测）"');
    expect(src).toContain('spellcheck="false"');
  });
});
