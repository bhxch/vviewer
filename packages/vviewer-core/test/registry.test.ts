import { describe, it, expect } from 'vitest';
import { createRegistry, RegistryError } from '../src/registry/registry';
import type { Renderer } from '../src/types';

const mk = (id: string, exts: string[]): Renderer => ({
  id, label: id, extensions: exts, render: async () => ({ destroy() {} })
});

describe('createRegistry', () => {
  it('install & lookup by extension/id', () => {
    const reg = createRegistry();
    const text = mk('text', ['txt', 'log']);
    reg.install(text);
    expect(reg.byExtension('TXT')?.id).toBe('text');
    expect(reg.byId('text')).toBe(text);
    expect(reg.all()).toHaveLength(1);
  });
  it('conflicting ownership throws RegistryError', () => {
    const reg = createRegistry();
    reg.install(mk('a', ['bin']));
    expect(() => reg.install(mk('b', ['bin']))).toThrow(RegistryError);
  });
  it('install 归一化扩展名小写：大小写变体视为同一扩展名（查得到且冲突可检）', () => {
    const reg = createRegistry();
    reg.install(mk('text', ['txt']));
    // 大写注册不再各占一键：查询小写即命中，且与既有小写注册冲突可检
    expect(() => reg.install(mk('other', ['TXT']))).toThrow(RegistryError);
    const upper = mk('upper', ['MD', 'Markdown']);
    reg.install(upper);
    expect(reg.byExtension('md')?.id).toBe('upper');
    expect(reg.byExtension('markdown')?.id).toBe('upper');
  });
  it('unknown extension returns undefined', () => {
    expect(createRegistry().byExtension('zzz')).toBeUndefined();
  });
});

describe('候选渲染器与默认渲染器偏好（altExtensions）', () => {
  const mkAlt = (id: string, exts: string[], alt: string[]): Renderer => ({ ...mk(id, exts), altExtensions: alt });

  it('candidatesOf：所有者在前、altExtensions 声明者按安装序在后，去重且大小写归一', () => {
    const reg = createRegistry();
    reg.install(mkAlt('outline', [], ['PPTX']));
    reg.install(mk('slides', ['pptx', 'ppt']));
    reg.install(mkAlt('slides2', [], ['pptx', 'pptx']));
    expect(reg.candidatesOf('pptx').map((r) => r.id)).toEqual(['slides', 'outline', 'slides2']);
    expect(reg.candidatesOf('PPT').map((r) => r.id)).toEqual(['slides']);
    expect(reg.candidatesOf('zzz')).toEqual([]);
  });

  it('altExtensions 不参与冲突检测：多个渲染器可声明同一候选扩展名，也可候选他人已占的扩展名', () => {
    const reg = createRegistry();
    reg.install(mk('xlsx', ['xlsx']));
    expect(() => reg.install(mkAlt('sheet', ['ods'], ['xlsx']))).not.toThrow();
    expect(() => reg.install(mkAlt('sheet2', [], ['xlsx']))).not.toThrow();
    expect(reg.byExtension('xlsx')?.id).toBe('xlsx'); // 未注入偏好：所有者即默认
  });

  it('仅声明 altExtensions 的扩展名没有所有者：byExtension 不会凭候选自动接管', () => {
    const reg = createRegistry();
    reg.install(mkAlt('outline', [], ['pptx']));
    expect(reg.ownerOf('pptx')).toBeUndefined();
    expect(reg.byExtension('pptx')).toBeUndefined();
  });

  it('偏好解析器：命中候选即改用候选，ownerOf 恒为所有者', () => {
    const reg = createRegistry();
    reg.install(mk('slides', ['pptx']));
    reg.install(mkAlt('outline', [], ['pptx']));
    const prefs: Record<string, string> = { pptx: 'outline' };
    reg.setPreferenceResolver((ext) => prefs[ext]);
    expect(reg.byExtension('PPTX')?.id).toBe('outline');
    expect(reg.ownerOf('pptx')?.id).toBe('slides');
    prefs.pptx = 'slides';
    expect(reg.byExtension('pptx')?.id).toBe('slides');
  });

  it('偏好为空串/未知 id/非候选（存在但不支持该扩展名）一律回落所有者', () => {
    const reg = createRegistry();
    reg.install(mk('slides', ['pptx']));
    reg.install(mkAlt('outline', [], ['pptx']));
    reg.install(mk('pdf', ['pdf']));
    for (const pref of ['', 'ghost', 'pdf', undefined]) {
      reg.setPreferenceResolver(() => pref);
      expect(reg.byExtension('pptx')?.id).toBe('slides');
    }
  });

  it('解析器收到的是小写扩展名；setPreferenceResolver(null) 撤销偏好', () => {
    const reg = createRegistry();
    reg.install(mk('slides', ['pptx']));
    reg.install(mkAlt('outline', [], ['pptx']));
    const seen: string[] = [];
    reg.setPreferenceResolver((ext) => {
      seen.push(ext);
      return 'outline';
    });
    expect(reg.byExtension('PpTx')?.id).toBe('outline');
    expect(seen).toEqual(['pptx']);
    reg.setPreferenceResolver(null);
    expect(reg.byExtension('pptx')?.id).toBe('slides');
  });

  it('补空位扩展名（installFallbackExtensions）的所有者同样可被候选偏好替换', () => {
    const reg = createRegistry();
    reg.install(mk('code', []));
    reg.install(mkAlt('sheet', [], ['csv']));
    reg.installFallbackExtensions('code', ['csv']);
    expect(reg.candidatesOf('csv').map((r) => r.id)).toEqual(['code', 'sheet']);
    reg.setPreferenceResolver(() => 'sheet');
    expect(reg.byExtension('csv')?.id).toBe('sheet');
  });
});

describe('installFallbackExtensions', () => {
  it('registers free extensions and skips taken ones without throwing', () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('markdown', ['md']));
    const res = reg.installFallbackExtensions('code', ['jsonl', 'txt', 'md', 'adoc']);
    expect(res.added).toEqual(['adoc', 'jsonl']);   // 升序稳定
    expect(res.skipped).toEqual(['md', 'txt']);
    expect(reg.byExtension('jsonl')?.id).toBe('code');
    expect(reg.byExtension('md')?.id).toBe('markdown'); // 占用者不变
  });

  it('normalizes case and rejects unknown owner', () => {
    const reg = createRegistry();
    expect(() => reg.installFallbackExtensions('ghost', ['x'])).toThrow(/ghost/);
    reg.install(mk('code', []));
    reg.installFallbackExtensions('code', ['JSONL']);
    expect(reg.byExtension('jsonl')?.id).toBe('code');
  });
});
