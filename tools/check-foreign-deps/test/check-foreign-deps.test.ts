// check-foreign-deps.test.ts — @file-viewer/* 白名单校验的纯函数单测（fixture 内联，不依赖真实 lock）。
// 三锚：范围前缀检出、lockfile 不一致检出、合规（含零依赖 plan-3-not-applied）通过。
// 测试目录落 tools/check-foreign-deps/test/（vitest include 为 tools/*/test/**），
// 校验器本体按简报平铺在 tools/check-foreign-deps.mjs。
import { describe, expect, it } from 'vitest';
import { checkForeignDeps, isExactVersion, parseImporterDeps } from '../../check-foreign-deps.mjs';

const WEB_DEPS_OK = {
  dependencies: {
    '@bhxch/vviewer-core': 'workspace:*',
    '@file-viewer/core': '3.3.3',
    '@file-viewer/renderer-email': '3.3.3',
    buffer: '^6.0.3'
  }
};

const LOCK_FIXTURE = `
importers:

  .:
    devDependencies:
      typescript:
        specifier: ^6.0.3
        version: 6.0.3
  apps/web:
    dependencies:
      '@bhxch/vviewer-core':
        specifier: workspace:*
        version: link:../../packages/vviewer-core
      '@file-viewer/core':
        specifier: 3.3.3
        version: 3.3.3
      '@file-viewer/renderer-email':
        specifier: 3.3.3
        version: 3.3.3(typescript@6.0.3)
      buffer:
        specifier: ^6.0.3
        version: 6.0.3
  packages/vviewer-render-media:
    dependencies:
      artplayer:
        specifier: ^5.2.2
        version: 5.2.2

packages: {}
`;

describe('isExactVersion', () => {
  it('精确版本通过（含 prerelease/build 后缀）', () => {
    expect(isExactVersion('3.3.3')).toBe(true);
    expect(isExactVersion('0.3.39')).toBe(true);
    expect(isExactVersion('3.3.3-beta.1')).toBe(true);
  });

  it('范围前缀与通配/x-range 全部拒绝', () => {
    for (const spec of ['^3.3.3', '~3.3.3', '>=3.3.3', '>3.3.3', '<4', '3.x', '*', '3.3', 'latest', 'workspace:*']) {
      expect(isExactVersion(spec), spec).toBe(false);
    }
  });
});

describe('parseImporterDeps', () => {
  it('解析单 importer 的 specifier/version，scoped 键带引号亦可', () => {
    const deps = parseImporterDeps(LOCK_FIXTURE, 'apps/web');
    expect(deps['@file-viewer/core']).toEqual({ specifier: '3.3.3', version: '3.3.3' });
    expect(deps['@file-viewer/renderer-email']).toEqual({ specifier: '3.3.3', version: '3.3.3(typescript@6.0.3)' });
    expect(deps.buffer).toEqual({ specifier: '^6.0.3', version: '6.0.3' });
  });

  it('不串到相邻 importer（packages/vviewer-render-media 只有 artplayer）', () => {
    const deps = parseImporterDeps(LOCK_FIXTURE, 'packages/vviewer-render-media');
    expect(Object.keys(deps)).toEqual(['artplayer']);
  });

  it('importer 不存在返回空对象', () => {
    expect(parseImporterDeps(LOCK_FIXTURE, 'apps/nope')).toEqual({});
  });
});

describe('checkForeignDeps', () => {
  it('锚一：范围前缀检出（^ 被拒，即便 lock 版本一致）', () => {
    const { violations, count } = checkForeignDeps(
      { dependencies: { ...WEB_DEPS_OK.dependencies, '@file-viewer/core': '^3.3.3' } },
      parseImporterDeps(LOCK_FIXTURE, 'apps/web')
    );
    expect(count).toBe(2); // 夹具含 core + renderer-email 两个 foreign 依赖
    const v = violations.find((x) => x.name === '@file-viewer/core');
    expect(v?.kind).toBe('range');
    expect(v?.spec).toBe('^3.3.3');
  });

  it('锚二：lockfile 解析版本与声明不一致检出', () => {
    const lock = LOCK_FIXTURE.replace("'@file-viewer/core':\n        specifier: 3.3.3\n        version: 3.3.3", "'@file-viewer/core':\n        specifier: 3.3.3\n        version: 3.3.4");
    const { violations } = checkForeignDeps(WEB_DEPS_OK, parseImporterDeps(lock, 'apps/web'));
    const v = violations.find((x) => x.name === '@file-viewer/core');
    expect(v?.kind).toBe('lock-mismatch');
    expect(v?.resolved).toBe('3.3.4');
  });

  it('锚二变体：lockfile 缺该包条目同样检出', () => {
    const lock = LOCK_FIXTURE.replace(/      '@file-viewer\/core':\n        specifier: 3\.3\.3\n        version: 3\.3\.3\n/, '');
    const { violations } = checkForeignDeps(WEB_DEPS_OK, parseImporterDeps(lock, 'apps/web'));
    expect(violations.some((x) => x.name === '@file-viewer/core' && x.kind === 'lock-missing')).toBe(true);
  });

  it('锚二变体：workspace 链接解析为 link: 亦不一致', () => {
    const lock = LOCK_FIXTURE.replace("'@file-viewer/core':\n        specifier: 3.3.3\n        version: 3.3.3", "'@file-viewer/core':\n        specifier: 3.3.3\n        version: link:../../packages/foreign");
    const { violations } = checkForeignDeps(WEB_DEPS_OK, parseImporterDeps(lock, 'apps/web'));
    expect(violations.some((x) => x.name === '@file-viewer/core' && x.kind === 'lock-mismatch')).toBe(true);
  });

  it('锚三：合规清单通过（lock 带 peer 后缀取主版本比较）', () => {
    const { violations, count } = checkForeignDeps(WEB_DEPS_OK, parseImporterDeps(LOCK_FIXTURE, 'apps/web'));
    expect(violations).toEqual([]);
    expect(count).toBe(2);
  });

  it('零 @file-viewer 依赖放行（plan-3-not-applied 状态）', () => {
    const { violations, count } = checkForeignDeps({ dependencies: { buffer: '^6.0.3' } }, parseImporterDeps(LOCK_FIXTURE, 'apps/web'));
    expect(violations).toEqual([]);
    expect(count).toBe(0);
  });

  it('devDependencies 段的 @file-viewer/* 同在白名单约束内', () => {
    const { violations } = checkForeignDeps({ devDependencies: { '@file-viewer/core': '~3.3.3' } }, parseImporterDeps(LOCK_FIXTURE, 'apps/web'));
    expect(violations.some((x) => x.name === '@file-viewer/core' && x.kind === 'range')).toBe(true);
  });
});
