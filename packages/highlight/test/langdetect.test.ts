import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/langdetect';

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
