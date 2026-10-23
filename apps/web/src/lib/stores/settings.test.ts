import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from './settings';
import { DEFAULT_LAYOUT } from '../layout';

const BASE: Settings = {
  themeMode: 'system',
  codeThemeLight: 'onelight',
  codeThemeDark: 'serika-dark',
  appearanceLight: 'default',
  appearanceDark: 'default',
  excludedPatterns: [],
  autoRefresh: true,
  computePolicy: 'auto',
  diagrams: { krokiHost: '', krokiVia: 'client', modes: {}, renderers: {} },
  fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 },
  layout: { ...DEFAULT_LAYOUT }
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
  it('默认 krokiHost 空 + modes/renderers 空', () => {
    localStorage.removeItem('vviewer:settings');
    expect(loadSettings().diagrams).toEqual({ krokiHost: '', krokiVia: 'client', modes: {}, renderers: {} });
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
    expect(s.diagrams).toEqual({ krokiHost: '', krokiVia: 'client', modes: {}, renderers: {} });
    expect(s.excludedPatterns).toEqual(['.git']);
    expect(s.autoRefresh).toBe(false);
  });

  it('krokiVia 白名单（spec §8.3）：server 与 modes 四枚举值原样通过、脏值归位 client', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      diagrams: { krokiVia: 'server', modes: { graphviz: 'server', svgbob: 'server', mermaid: 'wasm' } }
    }));
    let s = loadSettings();
    expect(s.diagrams.krokiVia).toBe('server');
    // modes 'server' 值合法（注册表 server 旗标面由设置 UI 门控，白名单只挡枚举外值）
    expect(s.diagrams.modes).toEqual({ graphviz: 'server', svgbob: 'server' });
    localStorage.setItem('vviewer:settings', JSON.stringify({ diagrams: { krokiVia: 'p2p' } }));
    s = loadSettings();
    expect(s.diagrams.krokiVia).toBe('client');
  });

  it('renderers 白名单（spec 2026-10-23 §9.1）：合法值原样通过、非法值/非注册表键/无多渲染器类型剔除', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      diagrams: { renderers: { graphviz: 'hpcc', mermaid: 'hpcc', graphvizx: 'viz-js' } }
    }));
    // graphviz=hpcc 命中注册表选择面保留；mermaid 无 renderers 剔除（per-type 而非
    // 扁平枚举——hpcc 仅 graphviz 合法）；未知键剔除
    expect(loadSettings().diagrams.renderers).toEqual({ graphviz: 'hpcc' });
    localStorage.setItem('vviewer:settings', JSON.stringify({
      diagrams: { renderers: { graphviz: 'wasm' } }
    }));
    expect(loadSettings().diagrams.renderers).toEqual({}); // 选择面外值剔除 = 默认 viz-js
  });

  it('renderers 非对象值（数字）字段级归位默认空，不拖垮同节其余字段', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      diagrams: { renderers: 42, krokiVia: 'server' }
    }));
    const s = loadSettings();
    expect(s.diagrams.renderers).toEqual({});
    expect(s.diagrams.krokiVia).toBe('server');
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

describe('layout 设置节白名单/clamp（spec 2026-10-19 布局自由化 §2）', () => {
  it('默认：DEFAULT_LAYOUT（不折叠/260/230/全件可见/非 zen）', () => {
    localStorage.removeItem('vviewer:settings');
    expect(loadSettings().layout).toEqual(DEFAULT_LAYOUT);
  });

  it('持久化往返：saveSettings 写入 layout 后 loadSettings 读回一致', () => {
    saveSettings(aSettings({
      layout: {
        leftCollapsed: true,
        rightCollapsed: false,
        leftWidth: 400,
        rightWidth: 200,
        topBarVisible: false,
        tabBarVisible: true,
        zen: false
      }
    }));
    expect(loadSettings().layout).toEqual({
      leftCollapsed: true,
      rightCollapsed: false,
      leftWidth: 400,
      rightWidth: 200,
      topBarVisible: false,
      tabBarVisible: true,
      zen: false
    });
  });

  it('宽度越界 clamp：leftWidth 9999 → 480 / rightWidth 1 → 160', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      layout: { ...DEFAULT_LAYOUT, leftWidth: 9999, rightWidth: 1 }
    }));
    const l = loadSettings().layout;
    expect(l.leftWidth).toBe(480);
    expect(l.rightWidth).toBe(160);
  });

  it('布尔脏值字段级归位：不拖垮同节其余字段', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({
      layout: { ...DEFAULT_LAYOUT, leftCollapsed: 'yes', leftWidth: 360, zen: 1 }
    }));
    const l = loadSettings().layout;
    expect(l.leftCollapsed).toBe(false);
    expect(l.leftWidth).toBe(360);
    expect(l.zen).toBe(false);
  });

  it('layout 节整体缺失/脏值回落默认，不影响其余字段', () => {
    // excludedPatterns/autoRefresh 刻意非默认：若整体回落 defaults() 则断言必炸
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ layout: 42, excludedPatterns: ['.git'], autoRefresh: false })
    );
    const s = loadSettings();
    expect(s.layout).toEqual(DEFAULT_LAYOUT);
    expect(s.excludedPatterns).toEqual(['.git']);
    expect(s.autoRefresh).toBe(false);
  });

  it('订阅回调收到 layout 副本：误改不回灌', () => {
    const off = onSettingsChanged((s) => {
      s.layout.leftWidth = 480; // 订阅方误改引用
    });
    saveSettings(aSettings({ layout: { ...DEFAULT_LAYOUT } }));
    off();
    expect(loadSettings().layout.leftWidth).toBe(DEFAULT_LAYOUT.leftWidth);
  });
});
