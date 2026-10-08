import { describe, it, expect, vi } from 'vitest';
import type { FileSource, RenderedInstance } from '@vviewer/core';
import { imageRenderer, sanitizeSvg } from '../src/image';

describe('sanitizeSvg', () => {
  it('strips scripts, event handlers, external refs', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(2)</script>
      <a href="javascript:alert(3)"><text>x</text></a>
      <image href="https://evil.example/x.png"/>
      <circle fill="red" r="10"/>
    </svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('<circle');
  });
});

// BUG-04（SHELL-12 验收）：打开 pixel.png 状态栏至少含大小与编码——image 渲染器
// 实例暴露 getMeta（ViewerPane 按 'getMeta' in 探测，core 类型零改动）。
describe('imageRenderer getMeta（BUG-04 代工）', () => {
  it('返回 buffer 大小与 det.encoding；destroy 撤销 blob URL', async () => {
    // jsdom 不实现 createObjectURL/revokeObjectURL，测试桩之（同 av.test.ts）
    const create = vi.fn(() => 'blob:mock-img');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const source: FileSource = {
      storeId: 's',
      storeLabel: '样本',
      path: 'pixel.png',
      name: 'pixel.png',
      store: { id: 's', displayName: () => '样本', listChildren: async () => [], read: async () => new Uint8Array() }
    };
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await imageRenderer.render(new Uint8Array(16), target, source, {
      ext: 'png',
      encoding: 'utf-8'
    } as never);
    expect(target.querySelector('img')).not.toBeNull();
    const meta = (instance as RenderedInstance & { getMeta(): { size: number; encoding?: string } }).getMeta();
    expect(meta.size).toBe(16);
    expect(meta.encoding).toBe('utf-8');
    instance.destroy();
    expect(revoke).toHaveBeenCalledTimes(1);
    target.remove();
  });
});
