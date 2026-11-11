<!-- lint 自检样例（子集覆盖探针，Task 1 裁决的防静默机检）：no-restricted-syntax
     在多 config 块间是「后块整体覆盖前块」而非合并——i18n 三规则的挂载块（apps/
     web/src/lib 子集）在旧 runesOptOut 块之后，若其后加块漏把 runesOptOut 展开，
     lib 内 .svelte 的逐组件退 runes 防线即被静默顶掉。本样例经 --stdin
     --stdin-filename（lib 路径形态）驱动，断言「退 runes」与「SvelteText CJK」
     两条同时命中：缺其一即说明子集块丢了旧条目或没挂上。
     注意：本注释勿以 eslint 指令形态开头（会被当成行内配置解析）。 -->
<svelte:options runes={false} />
<div>子集探针中文文本</div>
