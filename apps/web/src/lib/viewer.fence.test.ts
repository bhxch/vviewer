// viewer.fence.test.ts — BUG-22 启发式细化的纯函数锚（spec §2.5）：图表/math 围栏
// 由服务端渲染无需本地高亮，仅「存在非图表语言或无语言围栏」才强制留本地。
// 导入自 markdownFence.ts（无 $app 依赖的纯模块，markdownImages.ts 同款抽出模式；
// viewer.ts 转出口径一致 re-export，直测不拖整份装配单例）。
import { describe, expect, it } from 'vitest';
import { hasNonDiagramFence } from './markdownFence';

describe('hasNonDiagramFence（BUG-22 启发式细化）', () => {
  it('纯图表/math 围栏 → false（可路由服务端）', () => {
    expect(hasNonDiagramFence('```graphviz\ndigraph{a}\n```')).toBe(false);
    expect(hasNonDiagramFence('```dot\ndigraph{a}\n```\n```math\nE=mc^2\n```')).toBe(false);
  });
  it('无语言围栏/普通语言围栏 → true（留本地，高亮语义不变）', () => {
    expect(hasNonDiagramFence('```\nfn main() {}\n```')).toBe(true);
    expect(hasNonDiagramFence('```rust\nfn main() {}\n```')).toBe(true);
  });
  it('混合（图表+普通）→ true；无围栏 → false', () => {
    expect(hasNonDiagramFence('```mermaid\ngraph TD;\n```\n```rust\nx\n```')).toBe(true);
    expect(hasNonDiagramFence('纯文本')).toBe(false);
  });
  it('行首 ≤3 空格容忍与 ~~~ 围栏（既有启发式语义）', () => {
    expect(hasNonDiagramFence('   ```rust\nx\n```')).toBe(true);
    expect(hasNonDiagramFence('~~~graphviz\ndigraph{a}\n~~~')).toBe(false);
  });
});
