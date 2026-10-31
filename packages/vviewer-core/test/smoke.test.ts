import { describe, it, expect } from 'vitest';
import { CORE_VERSION } from '../src/index';
describe('core', () => { it('exports version', () => expect(CORE_VERSION).toBe('0.1.0')); });
