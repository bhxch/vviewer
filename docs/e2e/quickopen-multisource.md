# QuickOpen 多源扫描域（QO-01..04；富化第三轮）

## 1. 范围与来源

2026-10-13 报告 §6.2 WSX 行缺口：「QuickOpen Ctrl+P 多源扩域（设计承诺扫描全部源、
结果带源名前缀）无 e2e」。多源 = workspace 多根来源扫描（`quickOpen.ts` 按源序串行
DFS、跨源全局 maxFiles=5000、排除规则跨源；结果行带「源名 / path」前缀、按 storeId
定位来源打开）。单测已全钉（`quickOpen.test.ts` 双源拼接/跨源排除/maxFiles/空来源），
本域补端到端；maxFiles 上限由单测承载，e2e 不重复布点。

## 2. 场景清单

| 编号 | 前置 | 步骤 | 期望 |
| --- | --- | --- | --- |
| QO-01 | 本地注入源（2 文件）+ remote 单根假服务（1 文件）并存 | Ctrl+P 开面板，无过滤词 | 结果行同时含两源文件；行带「源名 / path」前缀（`.vv-quickopen-path`） |
| QO-02 | 同上 | 过滤词命中 remote 文件 → Enter | 打开的 tab 数据落 remote store（内容断言 `marker-42`） |
| QO-03 | localStorage 预写 `vviewer:settings.excludedPatterns=['secret.txt']`（addInitScript 先于首次导航） | Ctrl+P | 命中排除的两源同名文件均不出现；其余文件在 |
| QO-04 | 本地空目录来源 + remote 1 文件 | Ctrl+P | 空来源不拖垮扫描：remote 结果在、无错误态 |

## 3. 装置

本地源走 `__vvOpenDirImpl` 注入（t-shell 同款，label 决定 `localfiles:<label>` storeId）；
remote 走 spec 内单根假服务（b-wsx-recovery `startWsxFakeServer` 的单根精简版：
`/api/health`+`/api/ticket`+`/api/events`(SSE 挂起)+`/api/tree`+`/api/file`）。
连接表单沿 `getByLabel('服务器地址')` + 「连接」按钮（t-srv 同款）。
键盘直注前置断言：面板输入框自动聚焦（`.vv-quickopen-input` toBeFocused）——
typing 依赖该焦点（实跑修正：无此前置时键全落空、Enter 开不出文件）。

## 4. 已知边界

- 排除规则命中形态为文件名精确相等或 `*.ext` 后缀（`excluded()` 二分支），目录名
  前缀形态不在快扫面。
- BUG-27（任一目录 403 一票否决）为既有 fixme，归 e2e-server 通道另行立项；
  QO-04 只锚空来源（非失败来源）。
