import { describe, expect, it } from 'vitest';
import {
  abortReadError,
  classifyDispatchError,
  DispatchReadError,
  isAbortError
} from '../src/dispatch/errors';

describe('classifyDispatchError（错误身份与字节映射：纯身份三分类）', () => {
  it('AbortError 双形态 → abort（jsdom DOMException 非 Error 子类环境兜底形态并判）', () => {
    expect(classifyDispatchError(new DOMException('读取已取消', 'AbortError'))).toBe('abort');
    expect(classifyDispatchError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('abort');
  });

  it('DispatchReadError → read（其 message 来自被包装原始错误，身份由 name 判别）', () => {
    const e = new DispatchReadError(new Error('net down'));
    expect(e.name).toBe('DispatchReadError');
    expect(e.message).toBe('net down');
    expect(classifyDispatchError(e)).toBe('read');
  });

  it('普通 Error / 非 Abort 的 DOMException / 非 Error 值 → generic', () => {
    expect(classifyDispatchError(new Error('boom'))).toBe('generic');
    expect(classifyDispatchError(new DOMException('普通 DOM 异常', 'SyntaxError'))).toBe('generic');
    expect(classifyDispatchError('str')).toBe('generic');
    expect(classifyDispatchError(null)).toBe('generic');
    expect(classifyDispatchError(undefined)).toBe('generic');
  });

  it('abortReadError：统一抛出形态（DOMException AbortError「读取已取消」，isAbortError 恒真）', () => {
    const e = abortReadError();
    expect(e.name).toBe('AbortError');
    expect(e.message).toBe('读取已取消');
    expect(isAbortError(e)).toBe(true);
  });
});
