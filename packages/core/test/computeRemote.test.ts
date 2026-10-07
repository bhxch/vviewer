import { describe, expect, it } from 'vitest';
import {
  COMPUTE_CANCELED_PREFIX,
  decodeHighlightResponse,
  encodeCanceled,
  isCanceledMessage,
  stripCanceledPrefix
} from '../src/compute/remote';

describe('decodeHighlightResponse 紧凑响应展开', () => {
  it('三元组 + 捕获索引表展开为 HighlightInterval[]', () => {
    const body = {
      intervals: [
        [0, 2, 1],
        [3, 9, 0],
        [10, 14, 1]
      ],
      captures: ['string', 'keyword']
    };
    expect(decodeHighlightResponse(body)).toEqual([
      { start: 0, end: 2, capture: 'keyword' },
      { start: 3, end: 9, capture: 'string' },
      { start: 10, end: 14, capture: 'keyword' }
    ]);
  });

  it('空区间合法（空文件/纯空白）', () => {
    expect(decodeHighlightResponse({ intervals: [], captures: [] })).toEqual([]);
  });

  it('形状不对从严抛错', () => {
    expect(() => decodeHighlightResponse(null)).toThrow(/不是 JSON 对象/);
    expect(() => decodeHighlightResponse({ intervals: [[0, 1, 0]] })).toThrow(/captures/);
    expect(() => decodeHighlightResponse({ captures: ['k'] })).toThrow(/intervals/);
    expect(() => decodeHighlightResponse({ intervals: [[0, 1]], captures: ['k'] })).toThrow(
      /区间格式错误/
    );
    expect(() => decodeHighlightResponse({ intervals: [[0, 1, 'x']], captures: ['k'] })).toThrow(
      /区间格式错误/
    );
    expect(() => decodeHighlightResponse({ intervals: [[0, 1, 5]], captures: ['k'] })).toThrow(
      /索引越界/
    );
    // 非有限数值（null/NaN 序列化产物）拒绝
    expect(() => decodeHighlightResponse({ intervals: [[0, null, 0]], captures: ['k'] })).toThrow(
      /区间格式错误/
    );
  });
});

describe('取消身份 message 协议', () => {
  it('encodeCanceled 编入前缀，isCanceledMessage 识别，strip 还原', () => {
    const err = encodeCanceled(new Error('highlight 请求已取消'));
    expect(err.message.startsWith(COMPUTE_CANCELED_PREFIX)).toBe(true);
    expect(isCanceledMessage(err.message)).toBe(true);
    expect(stripCanceledPrefix(err.message)).toBe('highlight 请求已取消');
    // 非 Error 值也能编码
    expect(isCanceledMessage(encodeCanceled('boom').message)).toBe(true);
  });

  it('普通错误不带前缀不误判', () => {
    expect(isCanceledMessage('高亮失败: HTTP 500')).toBe(false);
    expect(isCanceledMessage(undefined)).toBe(false);
    expect(isCanceledMessage('HighlightCanceled-lookalike')).toBe(false);
  });
});
