import { describe, expect, it } from 'vitest';
import { detectLanguage, detectableLanguageNames } from '../src/langdetect';

describe('detectLanguage（fileTypes 精确表）', () => {
  it('rs → rust', () => {
    expect(detectLanguage('rs')).toBe('rust');
  });

  it('py → python；md → markdown', () => {
    expect(detectLanguage('py')).toBe('python');
    expect(detectLanguage('md')).toBe('markdown');
  });

  it('ext 大小写不敏感', () => {
    expect(detectLanguage('RS')).toBe('rust');
  });

  it('扩展名映射到 grammar 字段（cs → c-sharp）', () => {
    expect(detectLanguage('cs')).toBe('c-sharp');
  });

  it('未知扩展名返回 null', () => {
    expect(detectLanguage('xyzzy')).toBeNull();
    expect(detectLanguage('')).toBeNull();
  });

  it('跨语言重复扩展：胜者为字典序最小语言名（BUG-65，与 server detect.rs 断言同集）', () => {
    // .pl 首表曾按插入序命中先出现的 prolog（hljs 以 prolog 语法着色 Perl 源且
    // 状态栏语言标注错误）；排序迭代后 perl < prolog 胜出，与服务端 x-vv-lang 一致
    expect(detectLanguage('pl')).toBe('perl'); // perl < prolog
    expect(detectLanguage('v')).toBe('v'); // v < verilog
    expect(detectLanguage('fs')).toBe('forth'); // forth < fsharp
    expect(detectLanguage('bas')).toBe('basic'); // basic < freebasic
    expect(detectLanguage('properties')).toBe('ini'); // ini < properties
    // 前端返回值契约 = grammar 清单键（common-lisp 条目的 grammar 字段）；
    // 服务端 x-vv-lang 同扩展名给条目名 common-lisp，胜负语义一致
    expect(detectLanguage('cl')).toBe('commonlisp');
    expect(detectLanguage('sc')).toBe('scala');
  });
});

describe('detectLanguage（shebang 首行检测）', () => {
  it('#!/usr/bin/env python3 → python（版本号被剥掉）', () => {
    expect(detectLanguage('xyzzy', '#!/usr/bin/env python3\nprint(1)\n')).toBe('python');
  });

  it('#!/bin/bash → bash', () => {
    expect(detectLanguage('xyzzy', '#!/bin/bash\nset -e\n')).toBe('bash');
  });

  it('#!/bin/sh → bash（shebangs 别名表）', () => {
    expect(detectLanguage('xyzzy', '#!/bin/sh\n')).toBe('bash');
  });

  it('#!/usr/bin/env node → javascript', () => {
    expect(detectLanguage('xyzzy', '#!/usr/bin/env node\n')).toBe('javascript');
  });

  it('fileTypes 命中优先于 shebang', () => {
    // .py 文件带 bash shebang 仍按扩展名判 python
    expect(detectLanguage('py', '#!/bin/bash\n')).toBe('python');
  });

  it('非 shebang 文本返回 null', () => {
    expect(detectLanguage('xyzzy', 'hello world\n')).toBeNull();
    expect(detectLanguage('xyzzy')).toBeNull();
  });

  it('shebang 带空行前缀不算（正则锚定行首）', () => {
    expect(detectLanguage('xyzzy', '\n#!/bin/bash\n')).toBeNull();
  });
});

describe('detectableLanguageNames（手动指定候选集，spec §4.2）', () => {
  it('detectableLanguageNames 返回 canonical 名字典序去重集', () => {
    const names = detectableLanguageNames();
    expect(names).toContain('rust');
    expect(names).toEqual([...new Set(names)].sort());
  });

  it('grammar 字段优先于语言键名（common-lisp 条目给 commonlisp 不给 common-lisp）', () => {
    const names = detectableLanguageNames();
    expect(names).toContain('commonlisp');
    expect(names).not.toContain('common-lisp');
  });
});
