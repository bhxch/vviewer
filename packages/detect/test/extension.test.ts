import { describe, it, expect } from 'vitest';
import { extractExtension } from '../src/detect/extension';

describe('extractExtension', () => {
  it('basic / uppercase / multi-dot', () => {
    expect(extractExtension('a.txt')).toBe('txt');
    expect(extractExtension('README.MD')).toBe('md');
    expect(extractExtension('archive.tar.gz')).toBe('gz');
  });
  it('no extension / dotfile / query', () => {
    expect(extractExtension('Makefile')).toBe('');
    expect(extractExtension('.gitignore')).toBe('');
    expect(extractExtension('file.png?v=1#x')).toBe('png');
  });
});
