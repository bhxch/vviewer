import { describe, expect, it } from 'vitest';
import { createRegistry, type Renderer } from '@bhxch/vviewer-core';
// rendererPickerMenu.test.ts — 布局自由化 Task 3：渲染器自选双入口（状态栏指示器 +
// tab 右键子菜单）共享候选构造的单测。纯函数无 runes/DOM（openWith.test.ts 同款），
// 钉住四条源码契约：
// ① 候选集与 openWithOf 输出等价（同 id 同 label 同序——两新壳与既有 MetaPanel
//    下拉必须同一候选面，委托构造之外仍显式验收防将来分叉）；
// ② 「自动」恒首位、id ''（选择即清 override 的语义锚）；
// ③ current 标记随 override（自动 → 仅「自动」；手选 hex → 仅 hex）；
// ④ 'error' 等未注册 id 不进候选（openWithOf 存在性守卫沿用——错误卡片场景候选
//    照常可用、current 维持「自动」）。
// rendererCandidatesOfTab 的 Tab 运行时字段缺口（未渲染过的 tab）以名称扩展名兜底，
// 一并直测（extOfName 边界：无扩展名/隐藏文件/大写归一）。
import {
  candidatesOf,
  extOfName,
  rendererCandidates,
  rendererCandidatesOfTab
} from './RendererPickerMenu';
import { openWithOf } from './openWith';

const mk = (id: string, exts: string[]): Renderer => ({
  id, label: `${id}-label`, extensions: exts, render: async () => ({ destroy() {} })
});

/** code/txt、markdown/md、hex（无扩展名兜底）——贴近真实 registry 的最小集 */
function makeRegistry(): ReturnType<typeof createRegistry> {
  const reg = createRegistry();
  reg.install(mk('code', ['txt']));
  reg.install(mk('markdown', ['md']));
  reg.install(mk('hex', []));
  return reg;
}

describe('rendererCandidates 与 openWithOf 等价（Task 3 契约①）', () => {
  const scenarios: { name: string; override: string | undefined; rendererId: string; detExt: string }[] = [
    { name: '自动路由 code/txt', override: undefined, rendererId: 'code', detExt: 'txt' },
    { name: '自动路由 markdown/md', override: undefined, rendererId: 'markdown', detExt: 'md' },
    { name: '手选 override hex', override: 'hex', rendererId: 'hex', detExt: 'txt' },
    { name: '错误卡片 rendererId=error', override: undefined, rendererId: 'error', detExt: '' },
    { name: '无扩展名兜底', override: undefined, rendererId: 'code', detExt: '' }
  ];
  for (const s of scenarios) {
    it(`等价：${s.name}`, () => {
      const ow = openWithOf(makeRegistry(), s.override, s.rendererId, s.detExt);
      const cands = rendererCandidates(makeRegistry(), s.override, s.rendererId, s.detExt);
      expect(cands.map((c) => ({ id: c.id, label: c.label }))).toEqual(ow.options);
      expect(cands.some((c) => c.id === ow.current)).toBe(true);
    });
  }
});

describe('rendererCandidates 形状契约（Task 3 契约②③④）', () => {
  it('「自动」恒首位且 id 为空串（清除 override 的语义锚）', () => {
    const cands = rendererCandidates(makeRegistry(), undefined, 'code', 'txt');
    expect(cands[0]).toEqual({ id: '', label: '自动（按扩展名）', current: true });
  });

  it('自动时仅「自动」标 current；手选 hex 时仅 hex 标 current', () => {
    const auto = rendererCandidates(makeRegistry(), undefined, 'markdown', 'md');
    expect(auto.map((c) => c.current)).toEqual([true, false, false, false]);
    expect(auto.map((c) => c.id)).toEqual(['', 'markdown', 'code', 'hex']);
    const manual = rendererCandidates(makeRegistry(), 'hex', 'hex', 'md');
    expect(manual.find((c) => c.id === 'hex')?.current).toBe(true);
    expect(manual.filter((c) => c.current)).toHaveLength(1);
  });

  it('未注册 id（error）不进候选且「自动」维持 current（守卫沿用）', () => {
    const cands = rendererCandidates(makeRegistry(), undefined, 'error', '');
    expect(cands.some((c) => c.id === 'error')).toBe(false);
    expect(cands[0]?.current).toBe(true);
  });
});

describe('candidatesOf（FileOpenWith → 候选，ViewerPane 复用同一映射）', () => {
  it('current 标记与 openWithOf.current 一致', () => {
    const ow = openWithOf(makeRegistry(), 'hex', 'hex', 'md');
    const cands = candidatesOf(ow);
    expect(cands.map((c) => ({ id: c.id, label: c.label, current: c.current })))
      .toEqual(rendererCandidates(makeRegistry(), 'hex', 'hex', 'md'));
  });
});

describe('rendererCandidatesOfTab（右键壳的 Tab 入口）', () => {
  it('渲染过的 tab 用 lastRendererId/lastDetExt 真值', () => {
    const cands = rendererCandidatesOfTab(makeRegistry(), {
      overrideRenderer: undefined,
      lastRendererId: 'markdown',
      lastDetExt: 'md',
      source: { name: 'ignored.md' }
    });
    expect(cands.map((c) => c.id)).toEqual(['', 'markdown', 'code', 'hex']);
  });

  it('未渲染过的 tab 以名称扩展名兜底（lastRendererId 缺省被守卫滤除）', () => {
    const cands = rendererCandidatesOfTab(makeRegistry(), {
      source: { name: 'restored.md' }
    });
    expect(cands.map((c) => c.id)).toEqual(['', 'markdown', 'code', 'hex']);
  });

  it('名称亦无扩展名：跳过扩展名候选，恒兜底 code/markdown/hex', () => {
    const cands = rendererCandidatesOfTab(makeRegistry(), { source: { name: 'README' } });
    expect(cands.map((c) => c.id)).toEqual(['', 'code', 'markdown', 'hex']); // spec 2026-10-23 §3.1 markdown 恒兜底
  });

  it('override 随 tab：手选态 current 落在 override 候选上', () => {
    const cands = rendererCandidatesOfTab(makeRegistry(), {
      overrideRenderer: 'hex',
      lastRendererId: 'hex',
      lastDetExt: 'md',
      source: { name: 'a.md' }
    });
    expect(cands.find((c) => c.id === 'hex')?.current).toBe(true);
    expect(cands.find((c) => c.id === '')?.current).toBe(false);
  });
});

describe('extOfName（名称扩展名派生）', () => {
  it('常规/大写归一/多点/无扩展名/隐藏文件/尾点', () => {
    expect(extOfName('a.txt')).toBe('txt');
    expect(extOfName('A.TS')).toBe('ts');
    expect(extOfName('archive.tar.gz')).toBe('gz');
    expect(extOfName('README')).toBe('');
    expect(extOfName('.gitignore')).toBe('');
    expect(extOfName('a.')).toBe('');
  });
});
