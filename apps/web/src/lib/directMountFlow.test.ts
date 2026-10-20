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

  it('watch 接线（终审 I-1）：DirectStore.watch 立即 onError 只走 console 诊断——不写 watchHealth 全局标志（per-source 文案由 isMountRootStoreId 派生，本不依赖）', () => {
    // 函数体窗口（至首个行首 `}`）内不得出现任何 watchHealth 写点/复位点：
    // 立即 onError 置位会污染健康 remote fs 根等非挂载来源 tab，创建期复位同理
    // 会抹掉 remote 的真实降级指示
    const fn = src.match(
      /export function createDirectMountStore\(rec: DirectMountRecord\): DirectStore \{[\s\S]*?\n\}/
    )![0];
    expect(fn).not.toMatch(/watchHealth\./);
    expect(fn).toMatch(/直连挂载不支持变更推送/);
  });

  it('openDirectMount：存活实例复用（storeById(rec.id)——直连 storeId = 记录 id）+ addDirStoreTab 目录 tab 通道', () => {
    expect(src).toMatch(/export function openDirectMount\(rec: DirectMountRecord\): void/);
    expect(src).toMatch(/openDirectMount[\s\S]{0,300}storeById\(rec\.id\)/);
    expect(src).toMatch(/openDirectMount[\s\S]{0,500}addDirStoreTab/);
  });

  it('openRemoteSource label 单一出处 remoteSourceLabel（终审 I-2：label 参与 storeId hash——不设覆写口，管理页与 RemoteSourceModal 同根同 storeId）', () => {
    expect(src).toMatch(/opts\?: \{ file\?: string; size\?: number \| null \}/);
    expect(src).toMatch(/const label = remoteSourceLabel\(/);
    expect(src).not.toMatch(/opts\?\.label/);
  });

  it('releaseDirectMountStore（终审 I-3）：保存轮换凭据后释放同 id 存活实例——关闭持有 tab（系统动作豁免撤销），下次打开建新 store 实例', () => {
    expect(src).toMatch(/export function releaseDirectMountStore\(storeId: string\): number/);
    expect(src).toMatch(
      /releaseDirectMountStore[\s\S]{0,400}tabStore\.close\(id, \{ undoable: false \}\)/
    );
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
