import { describe, expect, it } from 'vitest';
import {
  errorMessageOf,
  abortReadError,
  classifyDispatchError,
  DispatchReadError,
  isAbortError
} from '../src/dispatch/errors';

describe('classifyDispatchError（错误身份与字节映射：纯身份三分类）', () => {
  it('AbortError 双形态 → abort（jsdom DOMException 非 Error 子类环境兜底形态并判）', () => {
    expect(classifyDispatchError(new DOMException('Read cancelled', 'AbortError'))).toBe('abort');
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

  it('abortReadError：统一抛出形态（DOMException AbortError「Read cancelled」，isAbortError 恒真；message 为内部身份携带面不上屏，i18n Task 7 同日志串英文化口径）', () => {
    const e = abortReadError();
    expect(e.name).toBe('AbortError');
    expect(e.message).toBe('Read cancelled');
    expect(isAbortError(e)).toBe(true);
  });
});

describe('errorMessageOf（错误卡文案提取）', () => {
  it('Error 取 message；带 string message 的普通对象取 message（上游诊断错误形态）', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
    expect(errorMessageOf({ name: 'PptxDiagnosticError', message: '解析失败' })).toBe('解析失败');
  });
  it('无 message 的对象序列化；基础类型 String()；空串回落注入兜底缺省（apps/web 装配注入目录值「渲染失败」，包内缺省英文）', () => {
    expect(errorMessageOf({ code: 42 })).toBe('{"code":42}');
    expect(errorMessageOf('raw')).toBe('raw');
    expect(errorMessageOf(undefined)).toBe('undefined');
    expect(errorMessageOf(new Error(''))).toBe('Render failed');
    expect(errorMessageOf({ message: '' })).toBe('Render failed');
  });
  it('不可序列化对象（循环引用）回落 String()', () => {
    const o: { self?: unknown } = {};
    o.self = o;
    expect(errorMessageOf(o)).toBe('[object Object]');
  });
});

