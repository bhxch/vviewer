// index.svelte.contract.test.ts — 响应式胶水源码契约锚（D4：根 vitest 无 svelte
// 插件，.svelte.ts 含 $state 不可在 vitest 直测导入——ReferenceError，仓库先例），
// 以文本断言锁胶水关键形态：$state 镜像 / core 委托 / html[lang] 同步 /
// document 守卫。运行时行为由 e2e b-i18n-locale 域收口。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest 会转译 import.meta.url（settingsCenter.test 同款处理）：双 cwd 兼容根/apps/web
const SRC = readFileSync(
  ['apps/web/src/lib/i18n/index.svelte.ts', 'src/lib/i18n/index.svelte.ts']
    .map((p) => resolve(p))
    .find((p) => existsSync(p))!,
  'utf8'
);

describe('index.svelte.ts 源码契约锚（D4 胶水形态）', () => {
  it('locale $state 镜像在位（初值锚 core 当前值）', () => {
    expect(SRC).toMatch(/let locale = \$state<Locale>\(coreGetLocale\(\)\)/);
  });

  it('t() 读 $state（依赖锚）后委托 core.translate', () => {
    expect(SRC).toMatch(/void locale;/);
    expect(SRC).toMatch(/coreTranslateLoose\(key, \.\.\.args\)/);
  });

  it('setLocale 双写（$state + core 纯变量）并同步 html[lang]（D3）', () => {
    expect(SRC).toMatch(/export function setLocale\(l: Locale\): void/);
    expect(SRC).toMatch(/setLocaleInternal\(l\)/);
    expect(SRC).toMatch(/documentElement\.lang = l/);
  });

  it('SSR/构建期 document 守卫（adapter-static 构建链无 DOM）', () => {
    expect(SRC).toMatch(/typeof document !== 'undefined'/);
  });
});
