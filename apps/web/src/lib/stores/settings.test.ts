import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from './settings';

const BASE: Settings = {
  themeMode: 'system',
  codeThemeLight: 'onelight',
  codeThemeDark: 'serika-dark',
  appearanceLight: 'default',
  appearanceDark: 'default',
  excludedPatterns: [],
  autoRefresh: true,
  computePolicy: 'auto'
};

function aSettings(overrides: Partial<Settings>): Settings {
  return { ...BASE, ...overrides, excludedPatterns: [...(overrides.excludedPatterns ?? BASE.excludedPatterns)] };
}

beforeEach(() => localStorage.removeItem('vviewer:settings'));
afterEach(() => localStorage.removeItem('vviewer:settings'));

describe('settings 变更订阅（BUG-05 前置基建）', () => {
  it('saveSettings 持久化且 loadSettings 读回一致', () => {
    saveSettings(aSettings({ excludedPatterns: ['node_modules'], autoRefresh: false }));
    const s = loadSettings();
    expect(s.excludedPatterns).toEqual(['node_modules']);
    expect(s.autoRefresh).toBe(false);
  });

  it('saveSettings 触发订阅回调，回调收到含新值的设置对象', () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    saveSettings(aSettings({ excludedPatterns: ['.git'] }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].excludedPatterns).toEqual(['.git']);
    off();
  });

  it('退订后不再收到通知', () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    off();
    saveSettings(aSettings({ autoRefresh: false }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('回调收到的是副本：改动回调参数不污染持久化值与后续通知', () => {
    const received: string[][] = [];
    const off = onSettingsChanged((s) => {
      received.push([...s.excludedPatterns]); // 收到即快照
      s.excludedPatterns.push('pollution'); // 订阅方误改引用
    });
    saveSettings(aSettings({ excludedPatterns: ['.git'] }));
    saveSettings(aSettings({ excludedPatterns: ['node_modules'] }));
    off();
    // 误改副本不回灌持久化值，也不影响下一次通知的初始值
    expect(loadSettings().excludedPatterns).toEqual(['node_modules']);
    expect(received[1]).toEqual(['node_modules']);
  });

  it('多个订阅者互不影响，各收到独立副本', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onSettingsChanged(a);
    const offB = onSettingsChanged(b);
    saveSettings(aSettings({ excludedPatterns: ['dist'] }));
    offA();
    offB();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]![0]).not.toBe(b.mock.calls[0]![0]);
  });
});

describe('loadSettings 外观槽格式白名单（spec 2026-10-12 §2.3）', () => {
  it('非法格式（无前缀的任意串）归位 default', () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ ...BASE, appearanceLight: 'javascript:dark', appearanceDark: '42' })
    );
    const s = loadSettings();
    expect(s.appearanceLight).toBe('default');
    expect(s.appearanceDark).toBe('default');
  });

  it('合法形态原样通过：default / vscode: 内置名 / imported:<id>', () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ ...BASE, appearanceLight: 'vscode:Dark Modern', appearanceDark: 'imported:abc123' })
    );
    const s = loadSettings();
    expect(s.appearanceLight).toBe('vscode:Dark Modern');
    expect(s.appearanceDark).toBe('imported:abc123');
  });
});
