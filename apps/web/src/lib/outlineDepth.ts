import type { OutlineEntry } from '@bhxch/vviewer-highlight';

/**
 * 大纲缩进层级重归一（栈重算）：提取端 depth 按全量 raw 口径栈深计（highlight 包
 * outline.ts pairsToOutline，reference.* 同样入栈），AppShell 过滤引用后，嵌在被过滤
 * 引用节点内的定义行仍带着已消失父层的层级——直读会缩进跳层（js
 * `register(function alpha(){})`：alpha raw depth 2，显示集内却无 depth 1 父行）。
 *
 * 算法 = pairsToOutline 的同一开放区间栈在显示集上重跑：按文档序遍历，弹栈至栈顶
 * byteEnd > 当前 byteStart（已闭合区间出栈），逻辑深度 = 栈长（= 显示集内 byte 范围
 * 包含当前条目的祖先数），压入当前 byteEnd。不能用 raw depth 做栈：raw depth 序列
 * 丢掉了被过滤节点的区间，无法区分「更深的存活祖先」与「已闭合的同层兄弟」——
 * `function setup(){}  describe('s', function(){ it('x', function namedTest(){}) })`
 * 过滤后 [setup raw0, namedTest raw2]，raw 栈会把 namedTest 误挂为 setup 子项（真值 0）。
 *
 * 前缀稳定：弹栈只依赖前序条目与当前条目，显示集为文档序前缀（AppShell filter 保序 +
 * outlineDisplaySlice 前缀切片）时前缀重算与全量口径一致——截断展开/收起前 N 行缩进
 * 不变。同位双捕获（同 byteStart/byteEnd，罕见）与提取端一致地嵌套一层。
 * 常量自诞生即导出（B10 教训）：钳制层数单点，e2e/场景档对齐锚。
 */

/** 缩进钳制层数（spec §3 builder 裁决：防深嵌套爆版面；渲染端 12px/层 → 最深 96px） */
export const OUTLINE_DEPTH_CLAMP = 8;

/** 显示集各条目的逻辑缩进层级（与 entries 同序同长；空集 []；不改写输入） */
export function outlineLogicalDepths(entries: readonly OutlineEntry[]): number[] {
  const stack: number[] = []; // 开放区间的 byteEnd（pairsToOutline 同款）
  return entries.map((e) => {
    while (stack.length > 0 && stack[stack.length - 1]! <= e.byteStart) stack.pop();
    const logical = Math.min(stack.length, OUTLINE_DEPTH_CLAMP);
    stack.push(e.byteEnd);
    return logical;
  });
}
