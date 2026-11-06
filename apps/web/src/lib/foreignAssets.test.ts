// foreignAssets.test.ts — foreign 资产三层解析链锚（spec §6.2，计划 3 Task 3）。
// ① 三层链形态（grammars 先例）：env 显式 →（同源预留槽，plan 4）→ 缺省 CDN；
//   尾斜杠归一；② per-package 基座派生（Task 3 实测映射：assets-standard 含
//   docx/libarchive/pdf/pptx/xlsx，chm/hangul/iwork/wordperfect/ppt 各自独立包）；
// ③ SW 注册面源码锚：CacheFirst 规则 + BUG-60 清理脚本 + check-pwa-build 清单同步。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FOREIGN_ASSETS_CDN_DEFAULT,
  FOREIGN_ASSET_PACKAGES,
  foreignAssetBaseChain,
  resolveForeignAssetBase,
  resolveForeignAssetPackageBase,
  type ForeignAssetPackage
} from './foreignAssets';

function readSource(rel: string): string {
  for (const base of ['apps/web', '../../apps/web', '.']) {
    try {
      return readFileSync(resolve(process.cwd(), base, rel), 'utf8');
    } catch {
      /* 下一候选 */
    }
  }
  throw new Error(`${rel} 不可达（源码锚须在 monorepo 内运行）`);
}

describe('resolveForeignAssetBase（三层链：env → 同源预留槽 → 缺省 CDN）', () => {
  it('缺省 = jsdelivr assets-standard 精确版本直链，尾斜杠收口', () => {
    expect(FOREIGN_ASSETS_CDN_DEFAULT).toBe('https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/');
    expect(resolveForeignAssetBase('')).toBe(FOREIGN_ASSETS_CDN_DEFAULT);
    expect(resolveForeignAssetBase(undefined)).toBe(FOREIGN_ASSETS_CDN_DEFAULT);
  });

  it('env 显式覆盖最高优先；缺尾斜杠归一补齐', () => {
    expect(resolveForeignAssetBase('https://assets.example.com/fv')).toBe('https://assets.example.com/fv/');
    expect(resolveForeignAssetBase('https://assets.example.com/fv/')).toBe('https://assets.example.com/fv/');
  });

  it('env 空白串视为未设（回落缺省层，不产出坏基座）', () => {
    expect(resolveForeignAssetBase('   ')).toBe(FOREIGN_ASSETS_CDN_DEFAULT);
  });

  it('链形态三槽齐备：env/同源（预留空位，plan 4）/cdn——同源槽缺省空串不参与解析', () => {
    const chain = foreignAssetBaseChain('https://a.test/x/');
    expect(chain.env).toBe('https://a.test/x/');
    expect(chain.sameOrigin).toBe(''); // 预留槽：plan 4 接线前恒空
    expect(chain.cdn).toBe(FOREIGN_ASSETS_CDN_DEFAULT);
    const chainDefault = foreignAssetBaseChain('');
    expect(chainDefault.env).toBe('');
  });
});

describe('resolveForeignAssetPackageBase（per-package 基座派生，Task 3 实测映射）', () => {
  it('包清单：standard + 九个独立资产包（chm/hangul/iwork/ppt/wordperfect + 二波 data/design/typst/drawing）', () => {
    expect([...FOREIGN_ASSET_PACKAGES]).toEqual([
      'assets-standard',
      'assets-chm',
      'assets-hangul',
      'assets-iwork',
      'assets-ppt',
      'assets-wordperfect',
      'assets-data',
      'assets-design',
      'assets-typst',
      'assets-drawing'
    ]);
  });

  it('缺省 CDN 链：按包名替换派生，版本钉死同源（3.3.3）', () => {
    expect(resolveForeignAssetPackageBase('assets-standard')).toBe(FOREIGN_ASSETS_CDN_DEFAULT);
    expect(resolveForeignAssetPackageBase('assets-chm')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-chm@3.3.3/viewer/'
    );
    expect(resolveForeignAssetPackageBase('assets-hangul')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-hangul@3.3.3/viewer/'
    );
    expect(resolveForeignAssetPackageBase('assets-iwork')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-iwork@3.3.3/viewer/'
    );
    expect(resolveForeignAssetPackageBase('assets-ppt')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-ppt@3.3.3/viewer/'
    );
    expect(resolveForeignAssetPackageBase('assets-wordperfect')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-wordperfect@3.3.3/viewer/'
    );
  });

  it('env 自托管形态：asset-installer 合并树语义——全部包同 base（不替换）', () => {
    const merged = 'https://assets.example.com/fv/';
    for (const pkg of FOREIGN_ASSET_PACKAGES) {
      expect(resolveForeignAssetPackageBase(pkg, merged), pkg).toBe(merged);
    }
  });

  it('第二波资产包基座：data/design/typst/drawing 直链（3.3.3）——Task 3 HEAD 实测台账', () => {
    expect(resolveForeignAssetPackageBase('assets-data')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-data@3.3.3/viewer/'
    );
    expect(resolveForeignAssetPackageBase('assets-design')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-design@3.3.3/viewer/'
    );
    expect(resolveForeignAssetPackageBase('assets-typst')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-typst@3.3.3/viewer/'
    );
    expect(resolveForeignAssetPackageBase('assets-drawing')).toBe(
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-drawing@3.3.3/viewer/'
    );
  });

  it('每包基座互异且同版本（缺省链下无碰撞）', () => {
    const bases = new Set<string>();
    const versions = new Set<string>();
    for (const pkg of FOREIGN_ASSET_PACKAGES as readonly ForeignAssetPackage[]) {
      const b = resolveForeignAssetPackageBase(pkg);
      bases.add(b);
      versions.add(b.match(/@(\d+\.\d+\.\d+)\//)?.[1] ?? '');
    }
    expect(bases.size).toBe(FOREIGN_ASSET_PACKAGES.length);
    expect([...versions]).toEqual(['3.3.3']);
  });
});

describe('SW 注册面源码锚（vite.config runtimeCaching + BUG-60 清理 + check-pwa-build）', () => {
  it('vite.config：foreign 资产 CacheFirst 规则居 vv-cdn-engines jsdelivr 通配之前（先匹配先赢）', () => {
    const src = readSource('vite.config.ts');
    const foreignAt = src.indexOf('/^https:\\/\\/cdn\\.jsdelivr\\.net\\/npm\\/@file-viewer\\/assets-/');
    expect(foreignAt, '缺 foreign 资产 CDN 前缀 CacheFirst 规则').toBeGreaterThan(-1);
    const sameOriginAt = src.indexOf('/\\/file-viewer-assets\\//');
    expect(sameOriginAt, '缺同源预留槽 CacheFirst 规则').toBeGreaterThan(-1);
    const cdnEnginesAt = src.indexOf('/^https:\\/\\/cdn\\.jsdelivr\\.net\\/npm\\/.*/');
    expect(cdnEnginesAt).toBeGreaterThan(-1);
    expect(foreignAt, 'foreign 规则必须先于 vv-cdn-engines 通配（否则被吞）').toBeLessThan(cdnEnginesAt);
    expect(src, 'CacheFirst handler').toContain("handler: 'CacheFirst'");
    expect(src).toContain('vv-foreign-assets-${BUILD_REVISION}');
  });

  it('genSwCleanup 清理清单含 vv-foreign-assets（BUG-60 不变量：新运行时缓存必须随 REV 清理）', () => {
    const src = readSource('vite.config.ts');
    expect(src).toContain('`vv-foreign-assets-${BUILD_REVISION}`');
    expect(src).toContain('|vv-foreign-assets');
  });

  it('check-pwa-build 断言清单含 vv-foreign-assets（构建期拦截规则丢失）', () => {
    const src = readSource('scripts/check-pwa-build.mjs');
    expect(src).toContain('vv-foreign-assets');
  });

  it('vite.config define 注入 VV_FOREIGN_ASSETS（VV_GRAMMAR_CDN 同款先例）', () => {
    const src = readSource('vite.config.ts');
    expect(src).toContain("'import.meta.env.VV_FOREIGN_ASSETS'");
  });
});

describe('foreign 代码面 chunk 分组（spec §6.2：chunk 分离进 dist，不进 precache）', () => {
  it('vite.config：@file-viewer 按组带名（foreign- 前缀 chunkFileNames 特判）+ 共享依赖不入组', () => {
    const src = readSource('vite.config.ts');
    expect(src, 'chunkFileNames 的 foreign- 带名特判').toContain("chunkInfo.name.startsWith('foreign-')");
    // 第一波 11 组 + 第二波 10 组（计划 4 Task 3）——与装配面 FOREIGN_GROUP_ASSET_PACKAGE
    // 的 20 组 id 一一对应（foreign-core 为共享基座组，不在装配面）
    for (const group of [
      'foreign-core', 'foreign-email', 'foreign-epub', 'foreign-ofd', 'foreign-chm', 'foreign-word',
      'foreign-presentation', 'foreign-spreadsheet', 'foreign-iwork', 'foreign-hangul', 'foreign-wordperfect',
      'foreign-data', 'foreign-design', 'foreign-image', 'foreign-geo', 'foreign-typst', 'foreign-dicom',
      'foreign-signature', 'foreign-eda', 'foreign-drawing', 'foreign-midi'
    ]) {
      expect(src, `缺分组 ${group}`).toContain(`name: '${group}'`);
    }
  });

  it('vite.config：globIgnores 排除 foreign-*.js（precache 零 foreign 代码面）', () => {
    const src = readSource('vite.config.ts');
    expect(src).toContain("'**/foreign-*.js'");
  });

  it('presentation 组 test 正则含裸包 ppt/pptx（评审 M-1：renderer-ppt/pptx 的传递依赖\n'
    + '  @file-viewer/ppt@1.0.2、@file-viewer/pptx@3.3.3 无 renderer- 前缀，漏写即落默认共享 chunk 入 precache）', () => {
    const src = readSource('vite.config.ts');
    const line = src
      .split('\n')
      .filter((l) => l.includes("name: 'foreign-presentation'"))
      .map((l) => src.slice(src.indexOf(l)).split('\n').slice(0, 4).join('\n'))
      .join('\n');
    expect(line, '缺裸包 ppt').toMatch(/\|ppt\|pptx\)/);
    expect(line, '缺裸包 pptx').toMatch(/renderer-pptx\|ppt\|pptx\)/);
  });

  it('共享依赖铁律锚：jszip/pako/buffer/roughjs/dompurify/xmldom 不入 foreign 组 test 正则（git-engine 组注释同款约束）', () => {
    const src = readSource('vite.config.ts');
    // lastIndexOf：文件内有两处同名注释（chunkFileNames 特判 / groups 块），取后者
    const foreignBlock = src.slice(src.lastIndexOf('foreign 渲染器组（计划 3 Task 3'));
    // 仅查组 test: 正则行（注释内的铁律说明含这些词，属合法）
    const testLines = foreignBlock
      .split('\n')
      .filter((l) => l.trim().startsWith('test:'))
      .join('\n');
    // 终审修复 C2：jszip 收拢进 zip-shared 共享组（foreignBlock 之外的独立组，
    // 非 foreign- 前缀仍进 precache）——组内正则行出现 jszip 即回归
    expect(testLines).not.toMatch(/jszip/);
    expect(testLines).not.toMatch(/pako/);
    // buffer 为 git-engine 组员（email 依赖经其组员满足，懒加载连带合法）
    expect(testLines).not.toMatch(/buffer/);
    // roughjs 为 mermaid（vviewer 图表面）与 renderer-drawing 共享（计划 4 Task 3
    // build 实测：入组后 mermaid precache'd chunk 反向 import foreign chunk）；dompurify
    // 与 vviewer-sanitize 同名共享（regex 无法区分版本，pako@2 同款）
    expect(testLines).not.toMatch(/roughjs/);
    expect(testLines).not.toMatch(/dompurify/);
    // 终审修复 C2：@xmldom/xmldom 曾归 foreign-spreadsheet（三组共享归首组先例），
    // 但 mammoth（vviewer docx 路径，precache'd 面）静态依赖它——出组回默认共享
    // chunk 恢复 precache 地位，foreign 组 test 正则行不得再含 xmldom
    expect(testLines).not.toMatch(/xmldom/);
  });

  it('终审修复 C1+C2：app-preload-helper 与 zip-shared 独立组先于 foreign 组（非 foreign- 前缀 → 进 precache）', () => {
    const src = readSource('vite.config.ts');
    expect(src, '缺 app-preload-helper 组（preload helper 并入 foreign-core 即离线整站断链）').toContain(
      "name: 'app-preload-helper'"
    );
    expect(src, '缺 zip-shared 组（jszip 摊进 foreign-ofd 即离线 zip/docx 断链）').toContain("name: 'zip-shared'");
    // 两组必须位于 foreign-core 之前：preload-helper 虚拟模块不匹配任何组 test 时
    // 被 rolldown 并入先创建的组 chunk；zip-shared 按序首中收拢 jszip 全量
    const preloadAt = src.indexOf("name: 'app-preload-helper'");
    const zipAt = src.indexOf("name: 'zip-shared'");
    const foreignCoreAt = src.indexOf("name: 'foreign-core'");
    expect(preloadAt, 'app-preload-helper 须先于 foreign-core').toBeGreaterThan(-1);
    expect(preloadAt).toBeLessThan(foreignCoreAt);
    expect(zipAt, 'zip-shared 须先于 foreign-core').toBeGreaterThan(-1);
    expect(zipAt).toBeLessThan(foreignCoreAt);
    // zip-shared 组 test 收拢 jszip 包路径全量
    const zipBlock = src.slice(zipAt, foreignCoreAt);
    expect(zipBlock, 'zip-shared 组 test 必须匹配 jszip 包路径').toMatch(/test: \/.*jszip/);
  });
});
