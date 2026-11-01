// apps/web/src/lib/stores/session.test.ts
import { describe, it, expect, vi } from 'vitest';

// fake-indexeddb 提供 IDB 实现
import 'fake-indexeddb/auto';
import { normalizeIconTheme } from '@bhxch/vviewer-highlight';
import {
  deleteIconTheme,
  listIconThemes,
  loadSession,
  putIconTheme,
  replaceIconThemeAtomic,
  saveTabs,
  saveDirHandle,
  maxTabSeqOf,
  tabSeqOf,
  type ImportedIconTheme
} from './session';
import { loadSettings, saveSettings } from './settings';
import { DEFAULT_LAYOUT } from '../layout';

describe('session store', () => {
  it('saves and loads tabs', async () => {
    const tabs = [{ id: 't1', storeId: 's1', storeLabel: 'x', path: 'a.txt', name: 'a.txt', kind: 'restorable' as const, scrollTop: 42, active: true }];
    await saveTabs(tabs);
    const { tabs: loaded } = await loadSession();
    expect(loaded).toEqual(tabs);
  });
  it('round-trips optional storeBase on remote tab snapshots', async () => {
    const tabs = [{ id: 't2', storeId: 'remote:abcd1234', storeLabel: '127.0.0.1:8321', storeBase: 'http://127.0.0.1:8321', path: '', name: 'srv', kind: 'rename-only' as const, scrollTop: 0, active: true }];
    await saveTabs(tabs);
    const { tabs: loaded } = await loadSession();
    expect(loaded).toEqual(tabs);
    expect(loaded[0]?.storeBase).toBe('http://127.0.0.1:8321');
  });
  it('round-trips optional size on tab snapshots（项 3：会话恢复免探测）', async () => {
    const tabs = [{
      id: 't3', storeId: 'remote:abcd1234', storeLabel: 'srv', storeBase: 'http://127.0.0.1:8321',
      path: 'data/big.jsonl', name: 'big.jsonl', kind: 'rename-only' as const, scrollTop: 0, active: true,
      size: 12345
    }];
    await saveTabs(tabs);
    const { tabs: loaded } = await loadSession();
    expect(loaded[0]?.size).toBe(12345);
  });
  it('legacy snapshot without size field loads unchanged（旧快照天然兼容，无需迁移）', async () => {
    const legacy = [{ id: 't4', storeId: 's1', storeLabel: 'x', path: 'a.txt', name: 'a.txt', kind: 'restorable' as const, scrollTop: 0, active: true }];
    await saveTabs(legacy);
    const { tabs: loaded } = await loadSession();
    expect(loaded).toEqual(legacy); // 无 size 字段：形状不变（restore 侧走既有探测路径）
  });
  it('settings round-trip with defaults', () => {
    expect(loadSettings()).toEqual({
      themeMode: 'system',
      appearanceLight: 'default',
      appearanceDark: 'default',
      codeThemeLight: 'onelight',
      codeThemeDark: 'serika-dark',
      excludedPatterns: [],
      autoRefresh: true,
      computePolicy: 'auto',
      diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: {}, renderers: {} },
      fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 },
      iconThemes: { theme: 'none', scopes: { tree: true, tabs: false, quickOpen: false, search: false } },
      layout: DEFAULT_LAYOUT
    });
    saveSettings({ themeMode: 'dark', appearanceLight: 'default', appearanceDark: 'default', codeThemeLight: 'onelight', codeThemeDark: 'serika-dark', excludedPatterns: ['node_modules'], autoRefresh: false, computePolicy: 'remote', diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: {}, renderers: {} }, fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 }, iconThemes: { theme: 'none', scopes: { tree: true, tabs: false, quickOpen: false, search: false } }, layout: DEFAULT_LAYOUT });
    expect(loadSettings().themeMode).toBe('dark');
    expect(loadSettings().computePolicy).toBe('remote');
  });
  it('settings computePolicy falls back to default on invalid value', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({ computePolicy: 'bogus' }));
    expect(loadSettings().computePolicy).toBe('auto');
    localStorage.setItem('vviewer:settings', 'not-json');
    expect(loadSettings().computePolicy).toBe('auto');
  });
  it('dir handle round trip stores the handle object', async () => {
    const fake = { name: 'proj', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
    await saveDirHandle(fake);
    const { lastDirHandle } = await loadSession();
    expect(lastDirHandle?.name).toBe('proj');
  });
});

describe('tab id 序号解析（openFlow seq 快照基线）', () => {
  it('tabSeqOf：t 形态取数字，损坏/非 tab id 回 0', () => {
    expect(tabSeqOf('t12')).toBe(12);
    expect(tabSeqOf('t0')).toBe(0);
    expect(tabSeqOf('placeholder:remote:abc')).toBe(0);
    expect(tabSeqOf('')).toBe(0);
  });
  it('maxTabSeqOf：空列表 0、混入损坏 id 不影响最大值', () => {
    expect(maxTabSeqOf([])).toBe(0);
    expect(maxTabSeqOf(['t3', 't17', 'bogus'])).toBe(17);
  });
});

// 图标主题库（IndexedDB v5 `iconThemes` store，图标主题 spec Task 2）：manifest 为
// T1 归一化查表实体（Map 经 structured clone 保形）、fonts 存字体原始字节、origin
// 为 Open VSX 来源元数据（T5 写入，本任务只管形状与 round-trip）。须在多标签
// 升版用例前执行（同文件内库持久，升满版后 db() 不再可用——见文件尾注释）。
describe('iconThemes store（v5 CRUD round-trip）', () => {
  it('putIconTheme/listIconThemes/deleteIconTheme：manifest Map 保形 + origin 字段保留', async () => {
    const manifest = normalizeIconTheme({
      iconDefinitions: { file: { fontCharacter: '\\e001', fontColor: '#5f7a61' } },
      fileExtensions: { JS: 'file' }
    });
    const t: ImportedIconTheme = {
      id: 'imported:icontest',
      name: 'Icon Test',
      manifest,
      fonts: [{ path: 'seti.woff', format: 'woff', data: new TextEncoder().encode('wOFF-bytes').buffer as ArrayBuffer }],
      source: 'json',
      origin: { publisher: 'pub', extension: 'ext', version: '1.2.3', checkedAt: 42 },
      addedAt: 1
    };
    await putIconTheme(t);
    const loaded = (await listIconThemes()).find((x) => x.id === t.id);
    expect(loaded?.name).toBe('Icon Test');
    expect(loaded?.source).toBe('json');
    expect(loaded?.origin).toEqual({ publisher: 'pub', extension: 'ext', version: '1.2.3', checkedAt: 42 });
    expect(loaded?.fonts[0]).toMatchObject({ path: 'seti.woff', format: 'woff' });
    expect(loaded?.fonts[0]?.data.byteLength).toBe(10);
    // manifest 归一化实体：Map 经 IndexedDB structured clone 保形，键落表已 lowercase
    expect(loaded?.manifest.fileExtensions).toBeInstanceOf(Map);
    expect(loaded?.manifest.fileExtensions.get('js')).toMatchObject({ char: '\ue001', color: '#5f7a61' });
    await deleteIconTheme(t.id);
    expect((await listIconThemes()).some((x) => x.id === t.id)).toBe(false);
  });

  it('replaceIconThemeAtomic：批量删临时+覆盖写单事务完成；null=纯清理（评审 Minor 3）', async () => {
    const manifest = normalizeIconTheme({ iconDefinitions: { file: { fontCharacter: '\\e001' } } });
    const mk = (id: string, name: string, source: 'json' | 'vsix'): ImportedIconTheme => ({
      id,
      name,
      manifest,
      fonts: [],
      source,
      addedAt: 1
    });
    const tempA = mk('imported:tmpa', 'TmpA', 'vsix');
    const tempB = mk('imported:tmpb', 'TmpB', 'vsix');
    const keep = mk('imported:keep', 'Keep', 'json');
    await putIconTheme(tempA);
    await putIconTheme(tempB);
    await putIconTheme(keep);
    // 失败收尾路径：updated=null 纯批量清理，无关记录不动
    await replaceIconThemeAtomic(null, [tempA.id, tempB.id]);
    let all = await listIconThemes();
    expect(all.some((x) => x.id === tempA.id)).toBe(false);
    expect(all.some((x) => x.id === tempB.id)).toBe(false);
    expect(all.some((x) => x.id === keep.id)).toBe(true);
    // 成功收尾路径：临时清理 + 原 id 覆盖写一次调用完成（旧内容被刷新、无临时残留）
    const merged = { ...tempB, id: keep.id, name: 'KeepNew' };
    await replaceIconThemeAtomic(merged, [tempA.id, tempB.id]);
    all = await listIconThemes();
    expect(all.filter((x) => [tempA.id, tempB.id, keep.id].includes(x.id))).toHaveLength(1);
    expect(all.find((x) => x.id === keep.id)).toMatchObject({ name: 'KeepNew' });
  });
});

// 注意：此用例会把 'vviewer' 库升到 v6（此后以 DB_VERSION=5 显式 open 会
// VersionError），必须保持本文件最后一个用例——fake-indexeddb 的库在单文件内持久。
describe('多标签让路（db 连接 onversionchange）', () => {
  it('既有连接收到 versionchange 自闭，他方升版不被 blocked 卡死', async () => {
    await loadSession(); // 持有两条 v5 连接（tabs/dirHandle 各一次 kvGet→db()，session.ts 不主动关连接，即"旧标签页"）
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 6); // 另一标签页的新版本先到先升（DB_VERSION=5 → 升 6）
      req.onblocked = () => reject(new Error('旧连接未让路：v6 升版被 blocked'));
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
});
