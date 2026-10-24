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
  // FE-1 拆分锚随迁：connectServer/applyMountRootIndexMigrations 已迁 serverConnect.svelte.ts，
  // dirTabNameOf/addDirStoreTab/addDirTabForRestore 已迁 tabsModel.svelte.ts——
  // 正则与断言逐字保留，仅 readSrc 目标随迁
  const scSrc = readSrc('src/lib/serverConnect.svelte.ts');
  const tmSrc = readSrc('src/lib/tabsModel.svelte.ts');

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

  it('台账 3-21：批量关闭接状态栏提示——挂载释放按关闭计数提示，0（无存活实例）静默', () => {
    const fn = src.match(
      /export function releaseDirectMountStore\(storeId: string\): number \{[\s\S]*?\n\}/
    )![0];
    expect(fn).toMatch(/showStatusNotice\(`已关闭 \$\{ids\.length\} 个标签页（挂载已释放）`\)/);
    expect(fn).toMatch(/if \(ids\.length > 0\)/);
  });

  it('台账 3-21：connectServer 同 base 重连清扫旧 tab 补状态栏提示（系统替换动作的可见性）', () => {
    const sweep = scSrc.match(
      /const staleTabIds = tabStore\.list[\s\S]*?for \(const id of staleTabIds\) \{[\s\S]*?\n  \}[\s\S]*?\n  \}/
    )![0];
    expect(sweep).toMatch(/已关闭 \$\{staleTabIds\.length\} 个旧标签页（服务器已重新连接）/);
    expect(sweep).toMatch(/if \(staleTabIds\.length > 0\)/);
  });

  it('台账 3-1：迁移消费接线 applyMountRootIndexMigrations——sources 面走 rewriteSourceForMigration，存活 tab 面重建实例换挂（registerStore + 旧实例 close）', () => {
    expect(scSrc).toMatch(
      /export function applyMountRootIndexMigrations\(moves: RootIndexMove\[\], token: string \| null\): void/
    );
    const fn = scSrc.match(
      /export function applyMountRootIndexMigrations\(moves: RootIndexMove\[\], token: string \| null\): void \{[\s\S]*?\n\}/
    )![0];
    expect(fn).toContain('rewriteSourceForMigration');
    expect(fn).toContain('workspaceStore.rewriteSources');
    expect(fn).toContain('createRemoteStore'); // 冻结 label + 新 rootIndex 重建
    expect(fn).toContain('registerStore(store)');
    expect(fn).toMatch(/old\?\.close\?\.\(\)/); // 旧实例停 SSE + 清旧 base 登记
    expect(fn).toContain('void persist()'); // 快照恢复面跟随改写落盘
  });

  it('台账 3-1：syncMountsOnConnect 迁移回调注入（connectServer 与 AppShell restore 重连两处，token 闭包）', () => {
    expect(scSrc).toMatch(/syncMountsOnConnect\(base, tok, \(ms\) => applyMountRootIndexMigrations\(ms, tok\)\)/);
    const shell = readSrc('src/lib/AppShell.svelte');
    expect(shell).toMatch(
      /syncMountsOnConnect\(base, token, \(ms\) => applyMountRootIndexMigrations\(ms, token\)\)/
    );
  });

  it('台账 3-20：目录 tab 命名消费显示名映射——addDirStoreTab 与 addDirTabForRestore 同走 dirTabNameOf（映射优先、回落 displayName），不回写 storeLabel（hash 输入零改动）', () => {
    expect(tmSrc).toMatch(/function dirTabNameOf\(store: TreeStore\): string/);
    expect(tmSrc).toMatch(/dirTabNameOf[\s\S]{0,200}displayLabelForStore\(store\.id, \{ storeBase: getRemoteBase\(store\.id\) \}\) \?\? store\.displayName\(\)/);
    // 两个目录 tab 通道都经 dirTabNameOf 命名（addTab(store, '', dirTabNameOf(store))）
    expect(tmSrc.match(/addTab\(store, '', dirTabNameOf\(store\)\)/g)?.length).toBe(2);
    // displayName 直呼命名点不残留（挂载来源统一走映射）
    expect(tmSrc).not.toMatch(/addTab\(store, '', store\.displayName\(\)\)/);
  });

  it('台账 3-20：来源列表显示名同走映射——AppShell sources 派生 label 映射优先、回落 storeLabel', () => {
    const shell = readSrc('src/lib/AppShell.svelte');
    expect(shell).toMatch(
      /label: displayLabelForStore\(s\.storeId, \{ storeBase: s\.storeBase \}\) \?\? s\.storeLabel/
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
