import { describe, expect, it } from 'vitest';
import { captureToCssVar, resolveCapture, themeToCssVars, type ThemeTable } from '../src/theme';

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
