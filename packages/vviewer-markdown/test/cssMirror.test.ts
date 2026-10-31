// cssMirror.test.ts — CSS 单源契约锁：src/css.ts 的 MARKDOWN_CSS 常量是单源，
// src/markdown.css 为 <link>/CSS import 消费面的镜像文件——两者逐字节等价；
// 另锁令牌形态契约（var(--token, 默认值)、不定义 :root 令牌块）与 .ts-* 默认色
// 对 highlight 包 themes.json onelight 主题（应用默认代码主题）的逐条等价
// （theme.ts DEFAULT_CODE_THEME light 项；宿主运行时注入 style#vv-code-theme 覆盖）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CODE_CAPTURES, captureToCssClass, resolveCapture, type ThemeTable } from '@bhxch/vviewer-highlight';
import { MARKDOWN_CSS } from '../src/css';

// markdown.css 镜像从文件系统读（vitest 对 css 导入会桩化；与原 export.test.ts 读
// app.css 同款双 cwd 兼容——仓库根/包内两种运行目录）
const markdownCssFile = readFileSync(
  ['packages/vviewer-markdown/src/markdown.css', 'src/markdown.css'].map((p) => resolve(p)).find((p) => existsSync(p))!,
  'utf8'
);

// themes.json 为 @bhxch/vviewer-highlight 的发布资产（包 files 含 assets/；onelight 为
// theme.ts DEFAULT_CODE_THEME 的 light 默认代码主题）
const themesJson = JSON.parse(
  readFileSync(
    ['packages/vviewer-highlight/assets/themes.json', '../../../packages/vviewer-highlight/assets/themes.json']
      .map((p) => resolve(p))
      .find((p) => existsSync(p))!,
    'utf8'
  )
) as Record<string, ThemeTable>;

describe('markdown.css 镜像等价（单源漂移锁）', () => {
  it('镜像文件与 MARKDOWN_CSS 常量逐字节等价（改样式须改 css.ts 再同步镜像，本测试兜底）', () => {
    expect(markdownCssFile).toBe(MARKDOWN_CSS + '\n');
  });
});

describe('令牌形态契约（不与宿主主题打架）', () => {
  it('不定义 :root 令牌块：全部令牌以 var(--token, 默认值) 消费', () => {
    expect(MARKDOWN_CSS).not.toMatch(/:root\s*\{/);
    expect(MARKDOWN_CSS).not.toMatch(/:root\[|\[data-vv-mode\]|\[data-theme-mode\]/);
  });

  it('var() 无缺省值仅限三个例外（--hljs-type/variable/tag 默认未定义语义，app.css 同注）', () => {
    const EXCUSED = new Set(['--hljs-type', '--hljs-variable', '--hljs-tag']);
    for (const m of MARKDOWN_CSS.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      expect(EXCUSED.has(m[1]!), `var(${m[1]}) 缺缺省值且不在例外集`).toBe(true);
    }
  });
});

describe('.ts-* 默认色与 onelight 主题逐条等价（应用默认代码主题）', () => {
  const theme = themesJson['onelight']!;
  // 与 highlight 包 themeToCssVars 同款最长前缀回退：无 fg 的 capture 缺省=inherit
  //（onelight 无 variable/number 的 fg 值）
  function expectedDefault(capture: string): string {
    return resolveCapture(theme, capture).fg ?? 'inherit';
  }

  it('53 条 capture 一一锁定：.ts-<cls> { color: var(--vv-ts-<cls>, <onelight 解析值|inherit>); }', () => {
    for (const capture of CODE_CAPTURES) {
      const cls = captureToCssClass(capture);
      expect(MARKDOWN_CSS, `.ts-${cls} 默认色漂移`).toContain(
        `.ts-${cls} { color: var(--vv-ts-${cls}, ${expectedDefault(capture)}); }`
      );
    }
  });

  it('规模佐证：.ts-* 规则数与 CODE_CAPTURES 等长（53）', () => {
    const count = [...MARKDOWN_CSS.matchAll(/\.ts-[a-z0-9-]+ \{/g)].length;
    expect(count).toBe(CODE_CAPTURES.length);
  });
});
