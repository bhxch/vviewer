// manifest.test.ts — 扩展清单的 nls 本地化契约（spec H 评审 minor ⑤）。
//
// VSCode 的清单文案走**其自身的 nls 机制**（`package.nls.json` 源语言 + `package.nls.<locale>.json`
// 变体 + 清单里的 `%key%` 占位）——与扩展运行时的 i18n 目录（`src/i18n/catalogs/`）是两套
// 独立机制：前者服务设置界面/命令面板，后者服务 webview 内的运行时文案。
//
// 本组断言：清单里的每个 `%key%` 占位都必须有英文与中文两份译文（缺一 → VSCode 显示
// 原始占位符；vsce 的 patchNLS 遇缺键即抛错）。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;
const nls = JSON.parse(fs.readFileSync(path.join(appDir, 'package.nls.json'), 'utf8')) as Record<
  string,
  string
>;
const nlsZh = JSON.parse(
  fs.readFileSync(path.join(appDir, 'package.nls.zh-cn.json'), 'utf8')
) as Record<string, string>;

/** 清单里的全部 %key% 占位键 */
function placeholderKeys(): string[] {
  const text = JSON.stringify(manifest);
  return [...new Set([...text.matchAll(/%([\w\d.]+)%/g)].map((m) => m[1]!))];
}

describe('清单 · nls 本地化', () => {
  it('清单含 nls 占位（命令标题 + 设置项 title/description）', () => {
    const keys = placeholderKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.startsWith('command.'))).toBe(true);
    expect(keys.some((k) => k.startsWith('configuration.vviewer.'))).toBe(true);
  });

  it('每个占位都有英文译文（vsce 的 patchNLS 缺键即抛）', () => {
    for (const key of placeholderKeys()) {
      expect(nls[key], `缺英文译文：${key}`).toBeTruthy();
    }
  });

  it('每个占位都有中文译文（中文 VSCode 下不得显示原始占位符）', () => {
    for (const key of placeholderKeys()) {
      expect(nlsZh[key], `缺中文译文：${key}`).toBeTruthy();
    }
  });

  it('两份译文的键集一致（无孤立条目——漂移源）', () => {
    expect(Object.keys(nlsZh).sort()).toEqual(Object.keys(nls).sort());
  });

  it('英文译文中不含 CJK（源语言面）', () => {
    for (const [key, value] of Object.entries(nls)) {
      expect(value, `英文译文含 CJK：${key}`).not.toMatch(/[一-鿿]/);
    }
  });
});
