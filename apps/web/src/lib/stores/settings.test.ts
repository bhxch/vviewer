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
  computePolicy: 'auto',
  diagrams: { krokiHost: '', modes: {} },
  fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 }
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

  it("裸 'default' 原样通过（白名单合法形态之一）", () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ ...BASE, appearanceLight: 'default', appearanceDark: 'default' })
    );
    const s = loadSettings();
    expect(s.appearanceLight).toBe('default');
    expect(s.appearanceDark).toBe('default');
  });

  it('非字符串脏值（JSON 数字）字段级归位，不整体回落其余字段', () => {
    // autoRefresh/excludedPatterns 刻意写成非默认值：若整体回落 defaults() 则两断言必炸
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ ...BASE, appearanceLight: 42, autoRefresh: false, excludedPatterns: ['.git'] })
    );
    const s = loadSettings();
    expect(s.appearanceLight).toBe('default');
    expect(s.autoRefresh).toBe(false);
    expect(s.excludedPatterns).toEqual(['.git']);
  });
});

describe('diagrams 设置节白名单（spec 2026-10-19 §2.1）', () => {
  it('默认 krokiHost 空 + modes 空', () => {
    localStorage.removeItem('vviewer:settings');
    expect(loadSettings().diagrams).toEqual({ krokiHost: '', modes: {} });
  });

  it('krokiHost 非 http(s) 归空；modes 非法值剔除、非法键剔除', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      diagrams: { krokiHost: 'ftp://x', modes: { mermaid: 'wasm', vega: 'kroki', rust: 'local', bpmn: 'source' } }
    }));
    const s = loadSettings();
    expect(s.diagrams.krokiHost).toBe('');
    // mermaid 值非法剔除；rust 非注册表键剔除
    expect(s.diagrams.modes).toEqual({ vega: 'kroki', bpmn: 'source' });
  });

  it('合法值原样通过：http(s) host 保留、注册表键配三枚举值保留', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      diagrams: {
        krokiHost: 'https://kroki.example.com',
        modes: { mermaid: 'kroki', 'vega-lite': 'source', plantuml: 'local' }
      }
    }));
    const s = loadSettings();
    expect(s.diagrams.krokiHost).toBe('https://kroki.example.com');
    expect(s.diagrams.modes).toEqual({ mermaid: 'kroki', 'vega-lite': 'source', plantuml: 'local' });
  });

  it('diagrams 节整体缺失或脏值回落默认形态，不影响其余字段', () => {
    // excludedPatterns/autoRefresh 刻意非默认：若整体回落 defaults() 则断言必炸
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ diagrams: 42, excludedPatterns: ['.git'], autoRefresh: false })
    );
    const s = loadSettings();
    expect(s.diagrams).toEqual({ krokiHost: '', modes: {} });
    expect(s.excludedPatterns).toEqual(['.git']);
    expect(s.autoRefresh).toBe(false);
  });
});

describe('fonts 设置节白名单/clamp（spec 2026-10-19 字体系统 §2.1）', () => {
  it('默认：双 family 空栈（= 默认栈）+ uiSize 16 / codeSize 13', () => {
    localStorage.removeItem('vviewer:settings');
    expect(loadSettings().fonts).toEqual({ uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 });
  });

  it('合法值原样通过（含边界内值）', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      fonts: { uiFamily: 'Segoe UI', uiSize: 22, codeFamily: 'JetBrains Mono, monospace', codeSize: 9 }
    }));
    expect(loadSettings().fonts).toEqual({
      uiFamily: 'Segoe UI', uiSize: 22, codeFamily: 'JetBrains Mono, monospace', codeSize: 9
    });
  });

  it('字号 clamp：uiSize 10–28 / codeSize 9–28（越界夹紧）', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      fonts: { uiFamily: '', uiSize: 3, codeFamily: '', codeSize: 2 }
    }));
    let s = loadSettings().fonts;
    expect(s.uiSize).toBe(10);
    expect(s.codeSize).toBe(9);
    localStorage.setItem('vviewer:settings', JSON.stringify({
      fonts: { uiFamily: '', uiSize: 99, codeFamily: '', codeSize: 50 }
    }));
    s = loadSettings().fonts;
    expect(s.uiSize).toBe(28);
    expect(s.codeSize).toBe(28);
  });

  it('字号 clamp 取整：13.7 → 14 / 9.2 → 9（终审 M-2：与面板输入口径一致）', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      fonts: { uiFamily: '', uiSize: 13.7, codeFamily: '', codeSize: 9.2 }
    }));
    const s = loadSettings().fonts;
    expect(s.uiSize).toBe(14);
    expect(s.codeSize).toBe(9);
  });

  it('脏 JSON 不抛：fonts 节/字段级归位默认，不影响其余字段', () => {
    // excludedPatterns/autoRefresh 刻意非默认：若整体回落 defaults() 则断言必炸
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ fonts: 42, excludedPatterns: ['.git'], autoRefresh: false })
    );
    let s = loadSettings();
    expect(s.fonts).toEqual({ uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 });
    expect(s.excludedPatterns).toEqual(['.git']);
    expect(s.autoRefresh).toBe(false);
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ fonts: { uiFamily: 7, uiSize: 'big', codeFamily: null, codeSize: NaN } })
    );
    s = loadSettings();
    expect(s.fonts).toEqual({ uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 });
  });

  it('saveSettings 订阅回调收到 fonts 副本：误改不回灌', () => {
    const off = onSettingsChanged((s) => {
      s.fonts.codeSize = 28; // 订阅方误改引用
    });
    saveSettings(aSettings({ fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 } }));
    off();
    expect(loadSettings().fonts.codeSize).toBe(13);
  });
});
