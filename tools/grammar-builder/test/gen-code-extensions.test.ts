import { describe, expect, it } from 'vitest';
import { collectExtensions } from '../gen-code-extensions.mjs';

describe('collectExtensions', () => {
  it('normalizes, filters and sorts fileTypes tokens', () => {
    const languages = {
      rust: { fileTypes: ['rs'] },
      json: { fileTypes: ['json', 'jsonc', 'jsonl', '.json5'] },
      noise: { fileTypes: ['Makefile', '**/*.rs', 'a/b', 'x y'] },
      lock: { fileTypes: ['Cargo.lock'] },
    };
    expect(collectExtensions(languages as never)).toEqual([
      'cargo.lock', 'json', 'json5', 'jsonc', 'jsonl', 'makefile', 'rs',
    ]);
  });

  it('dedupes across languages', () => {
    const languages = { a: { fileTypes: ['x'] }, b: { fileTypes: ['x', 'y'] } };
    expect(collectExtensions(languages as never)).toEqual(['x', 'y']);
  });

  it('derives jsonl from the real asset (C 项锚点：D 项 jsonl 渲染器依赖此条)', () => {
    // 真资产锚点：languages.json 的 json 语言 fileTypes 含 jsonl
    const languages = { json: { fileTypes: ['json', 'jsonl'] } };
    expect(collectExtensions(languages as never)).toContain('jsonl');
  });
});
