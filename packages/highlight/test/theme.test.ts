import { describe, expect, it } from 'vitest';
import { CODE_CAPTURES, captureToCssClass, captureToCssVar, resolveCapture, resolveCaptureClass, themeToCssVars, type ThemeTable } from '../src/theme';

const theme: ThemeTable = {
  function: { fg: '#00ff00' },
  keyword: { fg: '#ff0000', modifiers: ['italic'] },
  'ui.background': { bg: '#000000' },
};

describe('resolveCapture（最长前缀回退）', () => {
  it('精确命中', () => {
    expect(resolveCapture(theme, 'keyword')).toEqual({ fg: '#ff0000', modifiers: ['italic'] });
  });

  it('未命中逐段剥后缀回退父级', () => {
    expect(resolveCapture(theme, 'function.builtin')).toEqual({ fg: '#00ff00' });
    expect(resolveCapture(theme, 'function.builtin.method')).toEqual({ fg: '#00ff00' });
  });

  it('完全未命中返回空对象', () => {
    expect(resolveCapture(theme, 'nonexistent.capture.path')).toEqual({});
  });
});

describe('captureToCssClass（点转 -，无前缀类片段——与 captureToCssVar 同一转义来源）', () => {
  it('转换 capture 名为无前缀类片段', () => {
    expect(captureToCssClass('function.builtin')).toBe('function-builtin');
    expect(captureToCssClass('keyword')).toBe('keyword');
    expect(captureToCssClass('constant.character.escape')).toBe('constant-character-escape');
  });

  it('与 captureToCssVar 去掉前缀后一致（两端统一唯一来源）', () => {
    for (const c of ['keyword', 'string.special', 'variable.builtin', 'ui.background']) {
      expect(captureToCssClass(c)).toBe(captureToCssVar(c).slice('--vv-ts-'.length));
    }
  });
});

describe('captureToCssVar（点转 -，--vv-ts- 前缀）', () => {
  it('转换 capture 名为 CSS 变量名', () => {
    expect(captureToCssVar('function.builtin')).toBe('--vv-ts-function-builtin');
    expect(captureToCssVar('keyword')).toBe('--vv-ts-keyword');
    expect(captureToCssVar('ui.background')).toBe('--vv-ts-ui-background');
  });
});

describe('themeToCssVars（生成 --vv-ts-* 文本）', () => {
  it('按解析结果生成声明文本，点转 -', () => {
    const css = themeToCssVars(theme, ['function.builtin', 'keyword']);
    expect(css).toBe('--vv-ts-function-builtin: #00ff00;\n--vv-ts-keyword: #ff0000;');
  });

  it('未命中 fg 的 capture 跳过', () => {
    expect(themeToCssVars(theme, ['ui.background', 'missing.thing'])).toBe('');
  });
});

describe('CODE_CAPTURES / resolveCaptureClass（BUG-50：类名 ⊂ 清单的三面对齐）', () => {
  it('清单内 capture 恒等返回（与 captureToCssClass 直转逐字节一致）', () => {
    expect(resolveCaptureClass('keyword')).toBe('keyword');
    expect(resolveCaptureClass('string.special')).toBe('string-special');
    expect(resolveCaptureClass('keyword.control.conditional')).toBe('keyword-control-conditional');
  });

  it('清单外细粒度 capture 归约到最近语义父级（BUG-50 缺口代表项）', () => {
    expect(resolveCaptureClass('constant.numeric.integer')).toBe('constant-numeric');
    expect(resolveCaptureClass('constant.numeric.float')).toBe('constant-numeric');
    expect(resolveCaptureClass('constant.builtin.boolean')).toBe('constant-builtin');
    expect(resolveCaptureClass('keyword.storage')).toBe('keyword');
    expect(resolveCaptureClass('keyword.storage.modifier.mut')).toBe('keyword');
    expect(resolveCaptureClass('keyword.control.return')).toBe('keyword-control');
    expect(resolveCaptureClass('comment.line.documentation')).toBe('comment-line');
    expect(resolveCaptureClass('markup.heading.1')).toBe('markup-heading');
  });

  it('无前缀命中的 capture 原样转义（inherit 行为与旧版一致）', () => {
    expect(resolveCaptureClass('_ann')).toBe('_ann');
    expect(resolveCaptureClass('embedded')).toBe('embedded');
  });

  it('归约结果恒 ⊂ CODE_CAPTURES（任意 highlight 查询 capture 的对齐不变式）', () => {
    const known = new Set(CODE_CAPTURES.map((c) => captureToCssClass(c)));
    for (const c of [
      'constant.numeric.integer',
      'keyword.storage.modifier.ref',
      'variable.parameter.builtin',
      'function.method.private',
      'punctuation.delimiter.special',
      'string.special.url',
      'type.enum.variant.builtin'
    ]) {
      expect(known.has(resolveCaptureClass(c)), c).toBe(true);
    }
  });
});
