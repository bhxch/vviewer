import { describe, expect, it } from 'vitest';
import { createRegistry, type Renderer } from '@vviewer/core';
// openWith.test.ts — 终审 Important 1：openWithOf 存在性守卫。
// 纯函数（无 runes/DOM），真 registry 注入即可单测；钉住「dispatch 渲染失败返回的
// 'error' id（registry 未注册）不得进入下拉 options（错误卡片 current 维持 ''/自动）」。
import { openWithOf } from './openWith';

const mk = (id: string, exts: string[]): Renderer => ({
  id, label: `${id}-label`, extensions: exts, render: async () => ({ destroy() {} })
});

/** code/txt、hex（无扩展名兜底）、image/png——贴近真实 registry 的最小集 */
function makeRegistry(): ReturnType<typeof createRegistry> {
  const reg = createRegistry();
  reg.install(mk('code', ['txt']));
  reg.install(mk('image', ['png']));
  reg.install(mk('hex', []));
  return reg;
}

describe('openWithOf 存在性守卫（终审 Important 1）', () => {
  it('rendererId 为未注册的 error id 时不进 options，current 维持自动', () => {
    const res = openWithOf(makeRegistry(), undefined, 'error', '');
    expect(res.current).toBe('');
    expect(res.manual).toBe(false);
    expect(res.options.map((o) => o.id)).toEqual(['', 'code', 'hex']);
    expect(res.options.every((o) => o.id !== 'error')).toBe(true);
  });

  it('生效渲染器 id 在首位且 label 取自 registry（非英文 id 回退）', () => {
    const res = openWithOf(makeRegistry(), undefined, 'image', 'png');
    expect(res.options.map((o) => o.id)).toEqual(['', 'image', 'code', 'hex']);
    expect(res.options.find((o) => o.id === 'image')?.label).toBe('image-label');
  });

  it('override 手选生效：current=override、manual=true；override id 未注册时不进 options', () => {
    const res = openWithOf(makeRegistry(), 'hex', 'hex', '');
    expect(res.current).toBe('hex');
    expect(res.manual).toBe(true);
    expect(res.options.filter((o) => o.id === 'hex')).toHaveLength(1);
  });

  it('去重：detExt 命中已列渲染器不重复；detExt 为空跳过扩展名候选', () => {
    const byExt = openWithOf(makeRegistry(), undefined, 'code', 'txt');
    expect(byExt.options.map((o) => o.id)).toEqual(['', 'code', 'hex']);
    const noExt = openWithOf(makeRegistry(), undefined, 'code', '');
    expect(noExt.options.map((o) => o.id)).toEqual(['', 'code', 'hex']);
  });
});
