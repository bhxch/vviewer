import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from '../src/image';

describe('sanitizeSvg', () => {
  it('strips scripts, event handlers, external refs', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(2)</script>
      <a href="javascript:alert(3)"><text>x</text></a>
      <image href="https://evil.example/x.png"/>
      <circle fill="red" r="10"/>
    </svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('<circle');
  });
});
