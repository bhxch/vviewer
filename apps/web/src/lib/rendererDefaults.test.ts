import { describe, expect, it } from 'vitest';
import { createRegistry, type Renderer } from '@bhxch/vviewer-core';
// rendererDefaults.test.ts — 设置中心「打开方式」节的纯函数层：多渲染器格式行集派生
// （注册表 altExtensions 候选声明 → 行）与下拉显示值裁决（偏好不在候选内时显示内置默认）。
import { multiRendererFormats, selectedDefault } from './rendererDefaults';

const mk = (id: string, exts: string[], alt?: string[]): Renderer => ({
  id,
  label: `${id}-label`,
  extensions: exts,
  ...(alt ? { altExtensions: alt } : {}),
  render: async () => ({ destroy() {} })
});

function makeRegistry(): ReturnType<typeof createRegistry> {
  const reg = createRegistry();
  reg.install(mk('slides', ['pptx']));
  reg.install(mk('word', ['docx', 'doc']));
  reg.install(mk('sheet', ['ods'], ['xlsx', 'CSV']));
  reg.install(mk('code', ['csv', 'txt']));
  reg.install(mk('xlsx', ['xlsx']));
  reg.install(mk('outline', [], ['pptx']));
  reg.install(mk('simple', [], ['docx']));
  reg.install(mk('orphan', [], ['zzz'])); // 无所有者的候选扩展名：不成行
  return reg;
}

describe('multiRendererFormats', () => {
  it('仅列「有所有者且有候选」的扩展名，按扩展名升序；所有者为内置默认、候选按安装序', () => {
    const rows = multiRendererFormats(makeRegistry());
    expect(rows.map((r) => r.ext)).toEqual(['csv', 'docx', 'pptx', 'xlsx']);
    const pptx = rows.find((r) => r.ext === 'pptx')!;
    expect(pptx.owner).toEqual({ id: 'slides', label: 'slides-label' });
    expect(pptx.alternatives).toEqual([{ id: 'outline', label: 'outline-label' }]);
    expect(rows.find((r) => r.ext === 'csv')!.owner.id).toBe('code');
    expect(rows.find((r) => r.ext === 'csv')!.alternatives.map((a) => a.id)).toEqual(['sheet']);
  });

  it('无候选声明的注册表返回空表', () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    expect(multiRendererFormats(reg)).toEqual([]);
  });
});

describe('selectedDefault', () => {
  const row = { ext: 'pptx', owner: { id: 'slides', label: 's' }, alternatives: [{ id: 'outline', label: 'o' }] };

  it('偏好为候选 id 时原样显示', () => {
    expect(selectedDefault({ pptx: 'outline' }, row)).toBe('outline');
  });

  it("缺省/''/所有者 id/陈旧未知 id 一律显示内置默认 ''", () => {
    expect(selectedDefault({}, row)).toBe('');
    expect(selectedDefault({ pptx: '' }, row)).toBe('');
    expect(selectedDefault({ pptx: 'slides' }, row)).toBe('');
    expect(selectedDefault({ pptx: 'ghost' }, row)).toBe('');
  });
});
