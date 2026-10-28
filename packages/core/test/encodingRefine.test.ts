import { describe, expect, it, vi } from 'vitest';
import { refineEncoding } from '../src/detect/encodingRefine';
import type { Detection } from '../src/types';

const det = (): Detection => ({ ext: 'txt', encoding: 'gb18030', binary: false, signature: null });

/** 「日本語のテキスト。// comment\n」×3 的 Shift-JIS（cp932）字节——2026-10-28 probe
 * 实测 analyse 返回 [{confidence:100, name:'Shift_JIS', lang:'ja'}, …]（chardet 2.2.0
 * 置信度为 0–100 量纲）。 */
function sjisBytes(): Uint8Array {
  return new Uint8Array([
    0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67,
    0x81, 0x42, 0x2f, 0x2f, 0x20, 0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x0a, 0x93, 0xfa, 0x96,
    0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67, 0x81, 0x42, 0x2f,
    0x2f, 0x20, 0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x0a, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea,
    0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67, 0x81, 0x42, 0x2f, 0x2f, 0x20, 0x63,
    0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x0a
  ]);
}

describe('refineEncoding 精判分层（议题三 §4.3）', () => {
  it('Shift-JIS 文本精判为 shift_jis', async () => {
    const d = det();
    await refineEncoding(sjisBytes(), d);
    expect(d.encoding).toBe('shift_jis');
  });

  it('UTF-8（严格校验通过）文件不被精判触碰', async () => {
    const d = det();
    d.encoding = 'utf-8';
    await refineEncoding(new TextEncoder().encode('plain ascii'), d);
    expect(d.encoding).toBe('utf-8');
  });

  it('二进制样本（looksTextual=false）门控跳过', async () => {
    const d = det();
    const bin = new Uint8Array(256).fill(0);
    bin[7] = 0x89; // 含 NUL 即非文本
    await refineEncoding(bin, d);
    expect(d.encoding).toBe('gb18030');
  });

  it('低置信不采纳（mock analyse confidence=5 < 90）', async () => {
    vi.resetModules(); // 先清模块缓存（连带 chardetPromise 单例），mock 才能注入
    vi.doMock('chardet', () => ({ analyse: () => [{ confidence: 5, name: 'Shift_JIS', lang: 'ja' }] }));
    const { refineEncoding: refineMocked } = await import('../src/detect/encodingRefine');
    const d = det();
    await refineMocked(sjisBytes(), d);
    expect(d.encoding).toBe('gb18030');
    vi.doUnmock('chardet');
    vi.resetModules();
  });

  it('映射白名单外不采纳（mock name=Unknown8bit）', async () => {
    vi.resetModules();
    vi.doMock('chardet', () => ({ analyse: () => [{ confidence: 95, name: 'Unknown8bit', lang: '' }] }));
    const { refineEncoding: refineMocked } = await import('../src/detect/encodingRefine');
    const d = det();
    await refineMocked(sjisBytes(), d);
    expect(d.encoding).toBe('gb18030');
    vi.doUnmock('chardet');
    vi.resetModules();
  });

  it('GB18030 自匹配守卫：高置信 GB18030 在列时维持现状（fix round 1）', async () => {
    vi.resetModules(); // 先清模块缓存（连带 chardetPromise 单例），mock 才能注入
    // sbcs 错配居首（windows-1252:98）但 GB18030 高置信在列——真 GB18030 已被
    // chardet 确认，现状解码正确，任何改写都是「今天正确 → 明天 mojibake」
    vi.doMock('chardet', () => ({
      analyse: () => [
        { confidence: 98, name: 'windows-1252', lang: 'pt' },
        { confidence: 95, name: 'GB18030', lang: 'zh' }
      ]
    }));
    const { refineEncoding: refineMocked } = await import('../src/detect/encodingRefine');
    const d = det();
    await refineMocked(sjisBytes(), d);
    expect(d.encoding).toBe('gb18030');
    vi.doUnmock('chardet');
    vi.resetModules();
  });
});
