// check-notices.test.ts — NOTICES 完整性检查的纯函数单测（fixture 内联，不依赖真实 lock）。
import { describe, expect, it } from 'vitest';
import { collectRuntimeDeps, findLicense, isRegistered, parseNoticesNames, readLicense } from '../check-notices.mjs';

const LOCK_FIXTURE = `
importers:
  .:
    devDependencies:
      typescript:
        specifier: ^5.9.0
        version: 5.9.0
  apps/web:
    dependencies:
      '@vviewer/core':
        specifier: workspace:*
        version: link:../../packages/core
      libarchive.js:
        specifier: ^2.0.2
        version: 2.0.2
  packages/render-media:
    dependencies:
      '@vviewer/core':
        specifier: workspace:*
        version: link:../core
      artplayer:
        specifier: ^5.2.2
        version: 5.2.2
      hls.js:
        specifier: ^1.5.0
        version: 1.5.0
    devDependencies:
      vitest:
        specifier: ^3.2.0
        version: 3.2.0

packages: {}
`;

describe('collectRuntimeDeps', () => {
  it('汇总各 importer 的 dependencies 段，跳过 workspace 链接与 devDependencies', () => {
    expect(collectRuntimeDeps(LOCK_FIXTURE)).toEqual(['libarchive.js', 'artplayer', 'hls.js']);
  });

  it('无 importers 段返回空数组', () => {
    expect(collectRuntimeDeps(`lockfileVersion: '9.0'\n`)).toEqual([]);
  });
});

describe('parseNoticesNames / isRegistered', () => {
  const md = [
    '# Third-Party Notices',
    '',
    '| 组件 | 许可 | 用途 |',
    '| --- | --- | --- |',
    '| dompurify | MPL-2.0 OR Apache-2.0（取 Apache-2.0） | 消毒 |',
    '| xlsx（SheetJS community） | Apache-2.0 | Excel |',
    '| helix-editor/helix | MPL-2.0 | 资产 |'
  ].join('\n');
  const names = parseNoticesNames(md);

  it('解析表格第一列，跳过表头与分隔行', () => {
    expect(names).toEqual(['dompurify', 'xlsx（SheetJS community）', 'helix-editor/helix']);
  });

  it('全等或 "<dep>（注记" 前缀都算已登记', () => {
    expect(isRegistered('dompurify', names)).toBe(true);
    expect(isRegistered('xlsx', names)).toBe(true); // 带注记的登记名
    expect(isRegistered('left-pad', names)).toBe(false);
  });
});

describe('readLicense / findLicense', () => {
  it('readLicense 读 importer 就近的 node_modules（render-archive 的 jszip）', () => {
    expect(readLicense('packages/render-archive', 'jszip')).toContain('MIT');
  });

  it('findLicense 跨根与 workspace 找真实安装包（jszip）', () => {
    expect(findLicense(process.cwd(), 'jszip')).toContain('MIT');
  });

  it('未安装的包返回 null', () => {
    expect(findLicense(process.cwd(), 'vv-definitely-not-installed')).toBeNull();
  });
});
