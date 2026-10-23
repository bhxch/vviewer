// apps/web/src/lib/stores/session.test.ts
import { describe, it, expect, vi } from 'vitest';

// fake-indexeddb 提供 IDB 实现
import 'fake-indexeddb/auto';
import { loadSession, saveTabs, saveDirHandle, maxTabSeqOf, tabSeqOf } from './session';
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
      layout: DEFAULT_LAYOUT
    });
    saveSettings({ themeMode: 'dark', appearanceLight: 'default', appearanceDark: 'default', codeThemeLight: 'onelight', codeThemeDark: 'serika-dark', excludedPatterns: ['node_modules'], autoRefresh: false, computePolicy: 'remote', diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: {}, renderers: {} }, fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 }, layout: DEFAULT_LAYOUT });
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

// 注意：此用例会把 'vviewer' 库升到 v5（此后以 DB_VERSION=4 显式 open 会
// VersionError），必须保持本文件最后一个用例——fake-indexeddb 的库在单文件内持久。
describe('多标签让路（db 连接 onversionchange）', () => {
  it('既有连接收到 versionchange 自闭，他方升版不被 blocked 卡死', async () => {
    await loadSession(); // 持有两条 v4 连接（tabs/dirHandle 各一次 kvGet→db()，session.ts 不主动关连接，即"旧标签页"）
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 5); // 另一标签页的新版本先到先升（DB_VERSION=4 → 升 5）
      req.onblocked = () => reject(new Error('旧连接未让路：v5 升版被 blocked'));
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
});
