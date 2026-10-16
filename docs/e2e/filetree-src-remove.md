# 文件树源级移除域（FTSRC-01..04；富化第三轮）

## 1. 范围与来源

源级移除是文件树唯一源级操作（`FileTree.svelte` requestRemove confirm → AppShell
`removeSource`：关该组内该源全部 tab + `workspaceStore.removeSource`），2026-10-13
报告缺口清单指出 `.vv-tree-src-remove` e2e 零覆盖。组内移除语义（AppShell 注释在案）：
其他 workspace 若共享同一 storeId 不受影响。

## 2. 场景清单

| 编号 | 前置 | 步骤 | 期望 |
| --- | --- | --- | --- |
| FTSRC-01/03 | 双源（本地注入 + remote）各开 1 tab | 点 remote 源标签 ✕ → confirm 接受 | 该源 tab 全关 + 源标签消失；同组他源 tab 与标签保留 |
| FTSRC-02 | 同上 | 点 ✕ → confirm 取消 | tab 与源标签均不动 |
| FTSRC-04 | localfiles 同 label 跨组注入（新建工作区后二注） | 见 §4 裁决 | 锚定 openDir 路由回原组的现状行为 |

## 3. 装置

confirm 为原生 `window.confirm`（Playwright `page.on('dialog')` accept/dismiss，
文案断言含「将关闭该来源下全部 tab」）；mobile 375px 树区在抽屉内——树行点击与
移除按钮经 `openDrawerIfNarrow`/`closeDrawerIfOpened` 适配（T4a 先例）。

## 4. FTSRC-04 裁决记录（2026-10-16）

「跨组共享 storeId 并存」在当前 UI 不可达：localfiles 同 label 二次注入经
`addDirStoreTab` existing 分支路由回原组（setActive 原组 + 激活既有目录 tab），
新组不产生重复源（实测：新建工作区后二注 → 活动组切回、组 B 保持空）。
FTSRC-04 按预授权降级路径改为锚定该路由行为本身；「他组同 storeId 不受影响」的
组内移除保护（AppShell 注释）定性为防御性实现——若未来 UI 打开跨组并存形态，
需另行布点真跨组断言。
