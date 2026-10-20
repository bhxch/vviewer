// directMountFlow.test.ts — 直连挂载打开与会话恢复分派（目录挂载 spec §4 阶段三
// + §5 阶段四组②「打开」，plan Task 2 评审带入①）源码契约。openFlow.svelte.ts
// 与 AppShell.svelte 为 runes 模块/组件，根 vitest 无 svelte 插件不可挂载——按
// 既有「源码契约断言」先例（settingsCenter.test.ts / appShellZenEsc.test.ts 同
// 形态）锁定分派点；行为由 e2e b-mounts-manager 收口（Task 3 兜底）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('openFlow 直连 store 创建分派（带入①创建链路）', () => {
  const src = readSrc('src/lib/openFlow.svelte.ts');

  it('createDirectMountStore：direct 记录 → createS3DirectStore/createDavDirectStore 工厂分派（配置经 mountsSync.directConfigOf）', () => {
    expect(src).toMatch(/export function createDirectMountStore\(rec: DirectMountRecord\): DirectStore/);
    expect(src).toContain('directConfigOf(rec)');
    expect(src).toContain('createS3DirectStore');
    expect(src).toContain('createDavDirectStore');
  });

  it('watch 接线与 remote 同款：DirectStore.watch 立即 onError → watchHealth.degraded 降级指示', () => {
    expect(src).toMatch(/createDirectMountStore[\s\S]{0,1600}watchHealth\.degraded = true/);
    expect(src).toMatch(/直连挂载不支持变更推送/);
  });

  it('openDirectMount：存活实例复用（storeById(rec.id)——直连 storeId = 记录 id）+ addDirStoreTab 目录 tab 通道', () => {
    expect(src).toMatch(/export function openDirectMount\(rec: DirectMountRecord\): void/);
    expect(src).toMatch(/openDirectMount[\s\S]{0,300}storeById\(rec\.id\)/);
    expect(src).toMatch(/openDirectMount[\s\S]{0,500}addDirStoreTab/);
  });

  it('openRemoteSource 支持 label 覆写（挂载根「在树中打开」显示名；label 参与 storeId hash，覆盖路径恒传同值保证单 store）', () => {
    expect(src).toMatch(/opts\?: \{ file\?: string; size\?: number \| null; label\?: string \}/);
    expect(src).toMatch(/opts\?\.label \?\? remoteSourceLabel\(/);
  });
});

describe('AppShell 快照恢复直连分支（带入①恢复链路同点）', () => {
  const src = readSrc('src/lib/AppShell.svelte');

  it('restore：kind direct 来源按 storeId 查直连记录经 createDirectMountStore 重建；registerStore 入册不依赖目录 tab 时序', () => {
    expect(src).toMatch(/src\.kind === 'direct'/);
    expect(src).toMatch(/listDirectMounts\(\)/);
    expect(src).toMatch(/createDirectMountStore\(/);
    expect(src).toMatch(/registerStore\(/);
  });
});
