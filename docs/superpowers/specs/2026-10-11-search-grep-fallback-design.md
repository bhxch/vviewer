# 设计：rg 缺失时自动 fallback 系统 grep（跨文件搜索引擎降级链）

- 日期：2026-10-11
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-06-vviewer-design.md`（M6 `/api/search`）、`2026-10-08-e2e-fixes.md`（BUG-10 前后）

## 1. 背景与目标

现状：`POST /api/search`（`server/src/routes/search.rs`）spawn 系统 `rg --json`；rg 缺失时 501，前端 `ComputeRouter` auto 策略静默降级为浏览器内 `grepStoreLocal`（内存 grep，受 TreeStore 已加载范围与浏览器内存限制，大数据集不可用），显式 remote 策略直接报错。健康检查不宣告搜索引擎能力。

目标：rg 缺失时服务端自动 fallback 到系统 `grep`（GNU/BSD 皆可），跨文件搜索在无 rg 环境保持服务端执行；`/api/health` 宣告实际引擎；NDJSON 协议与前端消费逻辑不变。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 引擎选择链 | `state.rg_path`（保留，仅作 rg 覆盖/测试注入）→ PATH 探测 `rg` → PATH 探测 `grep` → 双缺才 501 |
| 协议 | 命中帧 `{file,line,col,text}` 与终帧 `{done,truncated,error?}` 完全不变 |
| grep 无列号 | col 恒为 1（rg 主路径精确列不变；前端定位以行为主，可接受） |
| grep 无 `--sort path` | 输出顺序不保证，不做服务端收集排序（保流式与低延迟） |
| health 宣告 | 新增 `searchEngine: "rg" \| "grep"`（双缺省略）；前端搜索面板显示引擎徽标 |
| 探测缓存 | 不引入（每请求 PATH 探测，与现状一致，探测为毫秒级 stat） |

### 非目标

- 不改前端搜索路由策略（auto/local/remote 语义不变；501 → auto 降级链保留为最终兜底）。
- 不做 grep 输出顺序保证、不做大文件跳过等价物。
- 不引入缓存/索引型搜索（未来项）。

## 2. 设计

### 2.1 引擎选择

```rust
enum SearchEngine { Rg, Grep }
```

- `AppState` 新增 `grep_path: Option<String>`（builder `with_grep_path`，测试注入；与 `rg_path` 对称）。
- `resolve_engine(state) -> Result<(SearchEngine, String), AppError>`：
  1. `state.rg_path` → `(Rg, path)`（即便路径不存在，spawn 失败按现状 501）；
  2. `probe("rg")` → `(Rg, ..)`；
  3. `probe("grep")` → `(Grep, ..)`；
  4. 皆无 → 501 `"cross-file search unavailable: neither ripgrep (rg) nor grep found on server"`。
- 现有 `probe_rg()` 泛化为 `probe(exe)`；spawn `ErrorKind::NotFound` 的 501 分支保留（消息提及当前引擎）。
- 集成测试「rg 缺失 → 501」（`server/tests/search.rs`）同步注入不存在的 rg 与 grep 路径。

### 2.2 grep 参数映射（`grep_args()`）

行格式用 `-rHn --null`：每命中输出 `path\0line:content`，NUL 分隔文件名与行内容，文件名含冒号也无歧义。**NUL 选项必须用长形式 `--null`**：短参 `-Z` 在 GNU grep 是 `--null`、在 BSD grep 是 `--decompress`，不可移植。

| rg 现参数 | grep 对应 | 说明 |
| --- | --- | --- |
| `--json` | `--null` + `-rHn` | 行解析协议见 §2.3 |
| `-e <pattern>` | `-e <pattern>` | 同（防 `-` 开头 pattern） |
| `-F` / `-i` | `-F` / `-i` | 直接映射 |
| （regex 模式） | `-E` | ERE 方言；Rust regex 语法（`\d` 等）不支持，注释与 deploy 文档注明 |
| `-g <glob>` | `--include=<glob>` | basename 匹配语义，`**/` 形态有边缘差异，注明 |
| `--max-count 50` | `-m 50` | 均为每文件命中上限 |
| `--max-filesize 2M` | （无） | grep 全读大文件，靠 60s 墙钟 + 1000 命中上限兜底 |
| `--sort path` | （无） | 顺序不保证 |
| `--no-ignore` / `--hidden` | （天然） | grep -r 不读 ignore、含 dot 条目 |
| `--no-messages` | `-s` | 压制权限等错误输出 |
| 二进制跳过 | `-I` | 对齐 rg「二进制不计入结果」语义 |
| 退出码 0/1/2 | 同 | 有命中/无命中/出错，pump 判定不变 |

`hidden` / `glob` / 大小写 / 字面量与正则的分支逻辑与 `rg_args` 一一对应，便于单测断言。

### 2.3 输出解析（pump 分发）

- 现 `pump()` 改为 `pump_rg()`（逻辑不动）；新增 `pump_grep()`，二者共用超时/截断/断连 kill 与终帧下发骨架（提取公共读循环，注入「行 → 命中帧」解析闭包）。
- `pump_grep` 行解析：按**首个** `\0` 切分 `path` 与 `line:content`；`line:content` 按**首个** `:` 切分行号与内容（行号为十进制；解析失败跳过该行）。
- 相对路径、UTF-16 列换算、`PREVIEW_MAX_CHARS` 截断复用现有约定；col 恒 1。
- grep 不会回显二进制命中（`-I`），无「二进制帧不计截断」分支需求。
- stderr 收集与错误消息提取、`SEARCH_TIMEOUT`、`MAX_MATCHES`、`FRAME_CHANNEL` 全部复用。

### 2.4 health 宣告与前端展示

- `Health` 新增：

```rust
/// 跨文件搜索引擎；rg/grep 均缺失时字段整体省略。
#[serde(rename = "searchEngine", skip_serializing_if = "Option::is_none")]
pub search_engine: Option<&'static str>,
```

- 前端：连接时缓存自然携带新字段（JSON 加字段向后兼容）；`GlobalSearchPanel` 状态区显示「服务端搜索：rg / grep」，grep 时 tooltip 注明限制（无列定位、顺序不保证、ERE 方言）；字段缺失（旧服务器/未连接）不显示。
- 前端唯一改动点为该展示层；`grepRemote`、`ComputeRouter`、NDJSON 解析零改动。

## 3. 测试

- 单测：`grep_args` 各分支映射断言（对齐 `rg_args` 既有三例的覆盖方式）；`pump_grep` 行解析（含冒号路径、UTF-8 中文/emoji 内容、超长行截断、畸形行跳过）；health 字段（有引擎/双缺省略）。
- 集成（`server/tests/search.rs`）：注入真 grep 路径跑通全链路 NDJSON（命中帧字段、`-m` 上限、终帧）；rg+grep 双缺 → 501；rg 缺失 + grep 存在 → 200。CI（ubuntu）自带 GNU grep，测试用 `state.grep_path` 注入探测到的路径。
- e2e 不新增：协议与前端消费不变，既有 `m6` / `b-compute-global-search-server` 套件即回归。

## 4. 风险与已知限制

- grep 在大目录显著慢于 rg，60s 超时截断概率更高（终帧 `error: search timeout` 语义一致）。
- 无 `--max-filesize`：超大文件全文扫描（内存由 grep 进程承担，不占服务端堆）。
- BSD/GNU grep 差异以参数子集 + 长选项规避；`--include` 与 rg `-g` 语义仅常用形态（`*.rs`）等价。
- ERE 方言与 Rust regex 语法差异：不合法 ERE 由 grep 退出码 2 → 终帧 error 透传。

## 5. 验收

| 项 | 标准 |
| --- | --- |
| 服务端 | `cargo test` 全绿；无 rg 有 grep 环境下 `/api/search` 返回 200 NDJSON 且字段正确 |
| health | `searchEngine` 按环境宣告 `rg`/`grep`/省略 |
| 前端 | typecheck / vitest / playwright 既有套件全绿；搜索面板引擎徽标正确 |
| 文档 | README/deploy.md 依赖说明更新为「rg 可选（缺失时自动 fallback grep）」 |

交付为单阶段实施（TDD），独立 commit。
