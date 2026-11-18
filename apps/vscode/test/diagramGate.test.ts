// diagramGate.test.ts — 图表外联闸契约（spec H T5）。
//
// 覆盖面（计划 T5 Step 3 明列）：**逐类型断言**（遍历 DIAGRAM_TYPES 全部 30 类）——
// 闸关时 mermaid/graphviz/nomnoml/math/svgbob 五类 → 'local'；其余 25 类（17 kroki-only
// + 8 CDN 引擎族）→ 'source'；闸关时**任何类型都不返回** 'kroki'/'official'/'server'；
// 闸开 + 'off' → 全部 'source'；闸开 + 'kroki' → 有 krokiType 者 'kroki'、其余 'source'；
// `rendererOf` 恒 undefined（**不得选 'hpcc'**——外联渲染器）。
import { describe, expect, it } from 'vitest';
import { DIAGRAM_TYPES } from '@bhxch/vviewer-render-diagram';
import {
  OFFLINE_ENGINES,
  allowRemoteOf,
  resolveDiagramMode,
  resolveDiagramRenderer
} from '../src/webview/diagramGate';

const GATE_OFF = { diagramMode: 'local', allowRemoteServices: false } as const;
const GATE_ON_LOCAL = { diagramMode: 'local', allowRemoteServices: true } as const;
const GATE_ON_KROKI = { diagramMode: 'kroki', allowRemoteServices: true } as const;
const GATE_ON_OFF = { diagramMode: 'off', allowRemoteServices: true } as const;

/** 离线引擎族（注册表内 local 且 engine 在离线集内） */
const OFFLINE_TYPES = DIAGRAM_TYPES.filter(
  (t) => t.local && t.engine !== undefined && OFFLINE_ENGINES.has(t.engine)
);
/** kroki-only 类型（local:false 但有 krokiType——请求 local 会被 effectiveModeOf 升格为 kroki） */
const KROKI_ONLY_TYPES = DIAGRAM_TYPES.filter((t) => !t.local && t.krokiType !== '');
/** CDN 引擎族（local:true 但 engine 走 jsdelivr 直链） */
const CDN_ENGINE_TYPES = DIAGRAM_TYPES.filter(
  (t) => t.local && t.engine !== undefined && !OFFLINE_ENGINES.has(t.engine)
);

describe('图表外联闸 · 注册表分型', () => {
  it('注册表 30 类；离线 5 / kroki-only 17 / CDN 引擎 8', () => {
    expect(DIAGRAM_TYPES).toHaveLength(30);
    expect(OFFLINE_TYPES.map((t) => t.id).sort()).toEqual(
      ['graphviz', 'math', 'mermaid', 'nomnoml', 'svgbob'].sort()
    );
    expect(KROKI_ONLY_TYPES).toHaveLength(17);
    expect(CDN_ENGINE_TYPES).toHaveLength(8);
    expect(OFFLINE_TYPES.length + KROKI_ONLY_TYPES.length + CDN_ENGINE_TYPES.length).toBe(30);
  });
});

describe('图表外联闸 · 闸关（默认，allowRemoteServices=false）', () => {
  it('仅离线引擎族给 local；其余 25 类全 source（逐类型断言）', () => {
    for (const type of DIAGRAM_TYPES) {
      const mode = resolveDiagramMode(type.id, GATE_OFF);
      const expected = OFFLINE_TYPES.some((o) => o.id === type.id) ? 'local' : 'source';
      expect(mode, `类型 ${type.id} 的闸关模式`).toBe(expected);
    }
  });

  it('**任何类型都不返回 kroki / official / server**', () => {
    for (const type of DIAGRAM_TYPES) {
      const mode = resolveDiagramMode(type.id, GATE_OFF);
      expect(['kroki', 'official', 'server'], `类型 ${type.id} 闸关返回了外联模式`).not.toContain(mode);
    }
  });

  it('17 个 kroki-only 类型全 source（不被 effectiveModeOf 升格为 kroki）', () => {
    for (const type of KROKI_ONLY_TYPES) {
      expect(resolveDiagramMode(type.id, GATE_OFF), `kroki-only ${type.id}`).toBe('source');
    }
  });

  it('8 个 CDN 引擎族全 source（不外联 jsdelivr）', () => {
    for (const type of CDN_ENGINE_TYPES) {
      expect(resolveDiagramMode(type.id, GATE_OFF), `CDN 引擎 ${type.id}`).toBe('source');
    }
  });

  it('未知语言 → source', () => {
    expect(resolveDiagramMode('not-a-diagram', GATE_OFF)).toBe('source');
    expect(resolveDiagramMode('', GATE_OFF)).toBe('source');
  });
});

describe('图表外联闸 · 闸开（allowRemoteServices=true）', () => {
  it("'off' → 全部 source（设置枚举直映射）", () => {
    for (const type of DIAGRAM_TYPES) {
      expect(resolveDiagramMode(type.id, GATE_ON_OFF), `类型 ${type.id} off 档`).toBe('source');
    }
  });

  it("'kroki' → 有 krokiType 者 kroki、其余 source", () => {
    for (const type of DIAGRAM_TYPES) {
      const mode = resolveDiagramMode(type.id, GATE_ON_KROKI);
      expect(mode, `类型 ${type.id} kroki 档`).toBe(type.krokiType !== '' ? 'kroki' : 'source');
    }
  });

  it("'local' → 有本地引擎者 local、kroki-only 者 kroki（与 web 端同语义，允许升格）", () => {
    for (const type of DIAGRAM_TYPES) {
      const mode = resolveDiagramMode(type.id, GATE_ON_LOCAL);
      const expected =
        type.local && type.engine !== undefined ? 'local' : type.krokiType !== '' ? 'kroki' : 'source';
      expect(mode, `类型 ${type.id} local 档`).toBe(expected);
    }
  });
});

describe('图表外联闸 · 渲染器与包内 allowRemote 缝', () => {
  it('rendererOf 恒 undefined（禁选 hpcc 外联渲染器）', () => {
    for (const type of DIAGRAM_TYPES) {
      expect(resolveDiagramRenderer(type.id, GATE_OFF), `类型 ${type.id} 的渲染器`).toBeUndefined();
      expect(resolveDiagramRenderer(type.id, GATE_ON_LOCAL), `类型 ${type.id} 的渲染器`).toBeUndefined();
    }
    // graphviz 是唯一的多渲染器类型（viz-js 本地 / hpcc 外联）——hpcc 禁选
    expect(resolveDiagramRenderer('graphviz', GATE_ON_LOCAL)).toBeUndefined();
  });

  it('allowRemoteOf 随闸开关（闸关 → false：包内降级链不经 kroki）', () => {
    expect(allowRemoteOf(GATE_OFF)).toBe(false);
    expect(allowRemoteOf(GATE_ON_LOCAL)).toBe(true);
  });
});
