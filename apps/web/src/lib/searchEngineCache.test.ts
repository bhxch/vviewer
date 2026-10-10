import { afterEach, describe, expect, it } from 'vitest';
import { loadSearchEngine, saveSearchEngine } from './searchEngineCache';

describe('searchEngineCache', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips valid engine kinds', () => {
    saveSearchEngine('grep');
    expect(loadSearchEngine()).toBe('grep');
    saveSearchEngine('rg');
    expect(loadSearchEngine()).toBe('rg');
  });

  it('treats unknown values as absent (旧服务端兼容)', () => {
    saveSearchEngine('bogus');
    expect(loadSearchEngine()).toBeNull();
  });

  it('returns null when nothing cached', () => {
    expect(loadSearchEngine()).toBeNull();
  });
});
