# 终审新增挂账候选清偿批实施计划（C1–C5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿递延清偿批终审新增的 5 条挂账候选：C1 占位 tab 快照缺陷修复（真缺陷，TDD RED 先行）、C2 worker 416 parity、C3 Debug 字段数锚测、C4 桌面 SIGTERM 护栏、C5 workerd CL:0 探针脚本落库挂 CI。

**Architecture:** C1 修 restore 读侧（AppShell.svelte 四处剥 `placeholder:` 前缀，snapshot 写侧不动）；C2 把 native 面（8c5fe16）的 Range 语法前置判定镜像到 worker 适配层（http.rs 拆分 syntax/resolve 与 native 对齐 + dispatch 前置闸）；C3 五个手工 Debug 面加字段清单锚测；C4 `ServerState` 加 `restarting` AtomicBool + RAII guard + shutdown_now 双检等待；C5 bash 探针脚本落库 + deploy-worker workflow 挂 step。

**Tech Stack:** Svelte 5（.svelte.ts runes）/ Playwright / Rust（axum 原生面 + workers-rs wasm 面 + Tauri 桌面壳）/ GitHub Actions / bash。

**Spec:** docs/superpowers/specs/2026-10-22-deferred-new-candidates-design.md（裁决与门禁口径以 spec 为准）

## Global Constraints

- 门禁基线：typecheck 0E；vitest **仓库根**跑（包目录直跑缺 jsdom）；`cargo test --workspace` 全绿；`cargo clippy --workspace -- -D warnings` 零告警；桌面 crate 独立门 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` + 同 manifest clippy 零告警；worker wasm 编译锚 `cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features`；前端重建一律 `pnpm --filter web build:e2e`（禁裸 build，防 CDN 注入冲掉使 GRF 系假红）+ budget 1.36MB/4MB。
- playwright：默认套件跑法 `cd apps/web && npx playwright test`；服务端套件 `cd apps/web && npx playwright test -c playwright.server.config.ts`（不带 `.ts` 会路径解析失败）。基线默认 658 / e2e-server 91；本批默认套件 +1 用例 ×2 project = 目标 660。
- 提交纪律：main 直行、原子 commit、Angular 中文 message（先 why 后 what）。git add 前逐文件确认；`.superpowers/` 永不入库。
- 本批产出测试不得引入网络依赖（C5 探针脚本只在 CI 跑，本批不执行）。
- 实机 8 项（MinIO/DAV smoke、桌面三平台首跑、deploy-worker 实跑、3xx follow、desktop CI 校准四项）不碰——C5 只落脚本与 workflow 挂点。
- 行号基准 1d3547b；实施时以当前工作区实码为准（允许 ±少量行漂移）。

---

### Task 1: C1 restore 查表剥占位前缀（真缺陷，TDD RED 先行）

**Files:**
- Modify: `apps/web/src/lib/openFlow.svelte.ts:99-103`（originStoreIdOf 加 export）
- Modify: `apps/web/src/lib/AppShell.svelte:565,592,615,632-636`（四处剥前缀）
- Test: `apps/web/e2e/b-wsx-recovery.spec.ts`（追加 WSX-13 用例）
- Modify: `docs/e2e/workspace-enrichment.md`（WSX-13 域文档登记）

**Interfaces:**
- Consumes: `originStoreIdOf(snap: TabSnapshot): string`（openFlow.svelte.ts 现私有函数，本任务导出）；`startWsxFakeServer`/`connectForm`/`waitSnapshotTabs`/`openDrawerIfNarrow`（b-wsx-recovery.spec.ts 与 ./drawer 既有装置）。
- Produces: 导出的 `originStoreIdOf`（同签名）；WSX-13 编号（后续回归口径引用）。

缺陷链（已核实）：`snapshot()`（openFlow.svelte.ts:74-93）无过滤，占位 tab 的 storeId 带 `placeholder:` 前缀（addPlaceholder :441）原样入快照；restore 侧 `rebuilt` 表键来自 `sources[].storeId` 原始 id，AppShell.svelte:636 `rebuilt.get(t.storeId)` 对前缀 id 必 miss → :646 恒再落占位；:632-635 exists 查重前缀逐字比较（merge 窗口可重复）；目录条目经三处 dirSnap 查找（:565/:592/:615）按 `t.storeId === src.storeId` 匹配，前缀 id 永不命中 → 占位目录条目（undo 栈窄径产出：close 目录 tab → store 失活 → reopenClosed 落 addPlaceholder 得 `path===''`）整条丢弃。

- [ ] **Step 1: 写 RED e2e 用例（追加到 b-wsx-recovery.spec.ts）**

在文件尾部追加（沿用文件头部既有 import 与装置函数，不新增 import 之外的依赖）：

```typescript
  test('WSX-13: 占位前缀快照在来源重建后复活（文件+目录条目，C1）', async ({ page }) => {
    const fake = await startWsxFakeServer({
      rootPaths: ['/r0'],
      files: { 0: { 'hello.txt': '占位复活验证内容' } }
    });
    await page.goto('/');
    await connectForm(page, fake.base);
    await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello.txt' }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'hello.txt' })).toBeVisible();
    await waitSnapshotTabs(page, ['hello.txt']);

    // 构造缺陷态 = snapshot() 无过滤缺陷的真实产物形态：存活快照的文件 tab
    // storeId 全部加 placeholder: 前缀 + 注入一条占位目录条目（undo 栈窄径产物）
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        const open = indexedDB.open('vviewer');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          const get = tx.objectStore('kv').get('workspaces');
          get.onsuccess = () => {
            const snap = get.result as {
              workspaces: {
                sources: { storeId: string }[];
                tabs: { id: string; storeId: string; path: string; name: string }[];
              }[];
            };
            for (const w of snap.workspaces) {
              for (const t of w.tabs) {
                if (t.path !== '' && !t.storeId.startsWith('placeholder:')) {
                  t.storeId = `placeholder:${t.storeId}`;
                }
              }
              const srcId = w.sources[0]?.storeId;
              if (srcId !== undefined) {
                w.tabs.push({
                  id: 't9001',
                  storeId: `placeholder:${srcId}`,
                  storeLabel: '占位目录',
                  path: '',
                  name: 'r0',
                  kind: 'rename-only',
                  scrollTop: 0,
                  active: false
                });
              }
            }
            tx.objectStore('kv').put(snap, 'workspaces');
            tx.oncomplete = () => { db.close(); resolve(); };
          };
        };
      });
    });

    // 服务器存活 → 来源可重建；修复前前缀 tab 查表 miss 恒再落占位（RED）
    await page.reload();
    await expect(page.locator('.vv-tab.active', { hasText: 'hello.txt' })).toBeVisible();
    // 文件 tab 复活：内容渲染，非错误卡片
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await expect(page.getByText('占位复活验证内容')).toBeVisible();
    // 目录条目复活：真实目录 tab 在列（修复前整条丢弃）——快照侧断言持久化形态
    await expect
      .poll(async () =>
        page.evaluate(() => {
          return new Promise<string[]>((resolve) => {
            const open = indexedDB.open('vviewer');
            open.onsuccess = () => {
              const db = open.result;
              const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
              get.onsuccess = () => {
                db.close();
                const snap = get.result as { workspaces: { tabs: { path: string; storeId: string }[] }[] };
                const tabs = snap.workspaces.flatMap((w) => w.tabs);
                resolve(tabs.filter((t) => t.path === '').map((t) => t.storeId));
              };
            };
          });
        })
      )
      .toEqual([expect.stringMatching(/^remote:/)]); // 目录条目复活且 storeId 无前缀
  });

  test('WSX-14: 占位快照在来源仍不可达时保持单层前缀（幂等，C1）', async ({ page }) => {
    const fake = await startWsxFakeServer({
      rootPaths: ['/r0'],
      files: { 0: { 'hello.txt': 'x' } }
    });
    await page.goto('/');
    await connectForm(page, fake.base);
    await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello.txt' }).click();
    await waitSnapshotTabs(page, ['hello.txt']);
    // 同 WSX-13 加前缀后，断连态 reload（health 探测被浏览器层掐断 → 来源不重建）
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        const open = indexedDB.open('vviewer');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          const get = tx.objectStore('kv').get('workspaces');
          get.onsuccess = () => {
            const snap = get.result as {
              workspaces: { tabs: { storeId: string; path: string }[] }[];
            };
            for (const w of snap.workspaces) {
              for (const t of w.tabs) {
                if (t.path !== '' && !t.storeId.startsWith('placeholder:')) {
                  t.storeId = `placeholder:${t.storeId}`;
                }
              }
            }
            tx.objectStore('kv').put(snap, 'workspaces');
            tx.oncomplete = () => { db.close(); resolve(); };
          };
        };
      });
    });
    await page.route('**/api/health*', (route) => route.abort());
    await page.reload();
    // 落占位（错误卡片在场）且快照 storeId 仍为单层前缀（addPlaceholder 的
    // originStoreIdOf 防线：不得叠加成 placeholder:placeholder:）
    await expect(page.locator('.vv-error-card').first()).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          return new Promise<string[]>((resolve) => {
            const open = indexedDB.open('vviewer');
            open.onsuccess = () => {
              const db = open.result;
              const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
              get.onsuccess = () => {
                db.close();
                const snap = get.result as { workspaces: { tabs: { storeId: string }[] }[] };
                resolve(snap.workspaces.flatMap((w) => w.tabs.map((t) => t.storeId)));
              };
            };
          });
        })
      )
      .toEqual([expect.stringMatching(/^placeholder:(?!placeholder:).*$/)]);
  });
```

实施注记：`page.route` 掐断 health 使 reconnectRemoteStore 探测失败（BUG-08 通道：失败不重试、store 为 null）→ rebuilt 空 → 全部文件 tab 落占位。若 `startWsxFakeServer` 的 label/根行文案与本计划假设不符，以装置实际为准微调定位串，不动断言语义。

- [ ] **Step 2: 跑测试确认 RED**

Run: `cd apps/web && npx playwright test b-wsx-recovery -g "WSX-13" --project=chromium`
Expected: WSX-13 FAIL（`.vv-error-card` 在场 / 目录条目断言为 `[]`）。WSX-14 可能 PASS（现状已落占位且 addPlaceholder 有防双前缀——幂等锚属护栏性用例，现状绿是合法基线，记录即可）。

- [ ] **Step 3: 实现修复**

3a. `apps/web/src/lib/openFlow.svelte.ts:99`：`function originStoreIdOf` 前加 `export`（签名与 doc 注释不动）。

3b. `apps/web/src/lib/AppShell.svelte` 五处（import 行 :31 附近的 openFlow import 清单加 `originStoreIdOf`）：

```svelte
<!-- :565 localfs dirSnap -->
const dirSnap = wsItem.tabs.find((t) => t.path === '' && originStoreIdOf(t) === src.storeId);
```
```svelte
<!-- :592 remote dirSnap（同形） -->
const dirSnap = wsItem.tabs.find((t) => t.path === '' && originStoreIdOf(t) === src.storeId);
```
```svelte
<!-- :615 direct dirSnap（同形） -->
const dirSnap = wsItem.tabs.find((t) => t.path === '' && originStoreIdOf(t) === src.storeId);
```
```svelte
<!-- :632-636 exists 查重 + 查表 -->
const exists = tabStore
  .tabsOf(wsItem.id)
  .some((t2) => t2.source.path === t.path && t2.source.storeId === originStoreIdOf(t));
if (exists) continue;
const store = rebuilt.get(originStoreIdOf(t));
```

:623-625 的循环头注释补一句（保持原有注释风格）：

```
// C1：占位前缀快照（snapshot() 无过滤的历史产物/断连刷新产物）查表前剥
// prefix——来源重建成功即内容/目录复活；仍 miss 落占位（addPlaceholder 内部
// originStoreIdOf 防双前缀，幂等）
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `cd apps/web && npx playwright test b-wsx-recovery --project=chromium`
Expected: 全部 PASS（WSX-13 转绿、WSX-14 保持绿、既有用例零翻转）。

- [ ] **Step 5: 域文档登记**

`docs/e2e/workspace-enrichment.md` 第 2/3 节相应小节追加 WSX-13/14 两行（编号、场景一句话、断言面），风格随现有条目。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/openFlow.svelte.ts apps/web/src/lib/AppShell.svelte apps/web/e2e/b-wsx-recovery.spec.ts docs/e2e/workspace-enrichment.md
git commit -m "fix(web): restore 查表剥占位前缀——断连刷新会话的内容/目录 tab 恒再落占位

占位 tab 的 placeholder: 前缀 storeId 原样入快照（snapshot 写侧不动，忠实
记录），restore 侧 rebuilt 查表/dirSnap 匹配/exists 查重四处剥前缀：来源重
建成功即复活，仍 miss 落占位（防双前缀既有防线，幂等）。WSX-13 RED→GREEN
+ WSX-14 单层前缀幂等锚。终审新增候选 C1。"
```

---

### Task 2: C2 worker 416 前置 parity

**Files:**
- Modify: `server/worker/src/http.rs`（RawRange + parse_range_syntax + resolve_range 拆分；parse_range 改组合；should_pre_reject_range 纯判定；单测）
- Modify: `server/worker/src/dispatch.rs:168-201`（file() locate 前置语法闸 + range_not_satisfiable_unbounded）
- Test: `server/worker/src/http.rs` tests 模块（追加）

**Interfaces:**
- Consumes: native 参照 `server/src/routes/file.rs:48-103`（parse_range_syntax/resolve_range 逐行同源语义）、`invalid_range_wins_over_missing_file`（server/tests/tree_file.rs，行为参照不改动）。
- Produces: `parse_range_syntax(h: &str) -> Result<Option<RawRange>, ()>`（pub）、`should_pre_reject_range(if_range_present: bool, range_header: Option<&str>) -> bool`（pub）、`RawRange { first: Option<u64>, last: Option<u64> }`（derive Debug/PartialEq）——dispatch.rs 消费；既有 `parse_range` 签名不变。

- [ ] **Step 1: http.rs 追加失败单测（先红）**

tests 模块追加：

```rust
    /// C2 parity：语法面锁测（native routes/file.rs 同款用例——非法集逐项 +
    /// 三形态合法集 + 空串防御 None）。
    #[test]
    fn parse_range_syntax_faces_mirror_native() {
        assert!(parse_range_syntax("bytes=x-y").is_err());
        assert!(parse_range_syntax("units=0-1").is_err());
        assert!(parse_range_syntax("bytes=-").is_err());
        assert_eq!(
            parse_range_syntax("bytes=0-1"),
            Ok(Some(RawRange { first: Some(0), last: Some(1) }))
        );
        assert_eq!(
            parse_range_syntax("bytes=-4"),
            Ok(Some(RawRange { first: None, last: Some(4) }))
        );
        assert_eq!(
            parse_range_syntax("bytes=250-"),
            Ok(Some(RawRange { first: Some(250), last: None }))
        );
        assert_eq!(parse_range_syntax(""), Ok(None));
    }

    /// C2 parity：前置闸纯判定——语法非法即拒（与文件存在性无关，native
    /// invalid_range_wins_over_missing_file 的判定式）；if-range 在场 / 多区间 /
    /// 无头 / 越界合法语法均不拒（后三者交 locate 后既有链）。
    #[test]
    fn should_pre_reject_range_gates_syntax_only() {
        assert!(should_pre_reject_range(false, Some("bytes=x-y")));
        assert!(should_pre_reject_range(false, Some("units=0-1")));
        assert!(!should_pre_reject_range(false, Some("bytes=0-1")));
        // 越界是 size 相关判定：语法合法不前置拒（416 带 size 由 locate 后路径答）
        assert!(!should_pre_reject_range(false, Some("bytes=999999-")));
        assert!(!should_pre_reject_range(true, Some("bytes=x-y")));
        assert!(!should_pre_reject_range(false, Some("bytes=0-1,3-4")));
        assert!(!should_pre_reject_range(false, None));
    }
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cargo test -p vviewer-worker http`
Expected: 编译错误（parse_range_syntax/should_pre_reject_range/RawRange 未定义）。

- [ ] **Step 3: 实现拆分与闸**

http.rs 主体（`parse_range` 上方）插入，并替换既有 `parse_range` 本体：

```rust
/// Range 语法面（C2 parity，不依赖 size）：`bytes=` 前缀 + 首段 `a-b`/`a-`/`-n`
/// 数字解析。Err = 语法非法（RFC 9110 §14.2 请求语法错误，locate 前即可判
/// 416）；Ok(None) = 空串（无 Range 头形态由调用方保证非空，防御性放行）。
/// native routes/file.rs parse_range_syntax 逐行同源。
#[allow(clippy::result_unit_err)]
pub fn parse_range_syntax(h: &str) -> Result<Option<RawRange>, ()> {
    if h.is_empty() {
        return Ok(None);
    }
    let spec = h.strip_prefix("bytes=").ok_or(())?;
    let first = spec.split(',').next().ok_or(())?.trim();
    let (start_s, end_s) = first.split_once('-').ok_or(())?;
    let (start_s, end_s) = (start_s.trim(), end_s.trim());

    let raw = if start_s.is_empty() {
        // -suffix：后缀形态 first=None
        RawRange { first: None, last: Some(end_s.parse().map_err(|_| ())?) }
    } else {
        let first = Some(start_s.parse().map_err(|_| ())?);
        let last = if end_s.is_empty() {
            // a-：开区间 last=None
            None
        } else {
            Some(end_s.parse().map_err(|_| ())?)
        };
        RawRange { first, last }
    };
    Ok(Some(raw))
}

/// Range 定界面（C2 parity，依赖 size）：钳制与不可满足判定——suffix 0 /
/// size 0 后缀 / start ≥ size / 起止倒挂均不可满足。native resolve_range 同源。
fn resolve_range(raw: RawRange, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let (start, end) = match (raw.first, raw.last) {
        // -suffix
        (None, Some(suffix)) => {
            if suffix == 0 || size == 0 {
                return Err(());
            }
            (size.saturating_sub(suffix), size - 1)
        }
        (Some(start), last) => {
            if start >= size {
                return Err(());
            }
            match last {
                // a-
                None => (start, size - 1),
                Some(end) => {
                    if start > end {
                        return Err(());
                    }
                    (start, end.min(size - 1))
                }
            }
        }
        // 语法面保证形态必为 a-b/a-/-n 之一
        (None, None) => return Err(()),
    };
    Ok(Some((start, end - start + 1)))
}

/// Range 语法解析的中间形态（native RawRange 同构）。
#[derive(Debug, PartialEq)]
pub struct RawRange {
    first: Option<u64>,
    last: Option<u64>,
}
```

既有 `parse_range` 本体替换为组合（签名、doc、`#[allow]` 不动）：

```rust
pub fn parse_range(h: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    // C2：syntax + resolve 组合（与 native 拆分对齐）；空串防御性 None 与旧
    // strip_prefix 失败同型 Err
    match parse_range_syntax(h)? {
        None => Err(()),
        Some(raw) => resolve_range(raw, size),
    }
}
```

模块尾部（strip_base_path 之后）追加闸纯函数：

```rust
/// C2 parity：locate 前置语法闸纯判定（native routes/file.rs file() 同序同语义）。
/// dispatch 面被 wasm 门控、不可 host 单测——判定式抽纯函数使次序语义可锚。
pub fn should_pre_reject_range(if_range_present: bool, range_header: Option<&str>) -> bool {
    match range_header {
        Some(h) => !if_range_present && !has_multiple_ranges(h) && parse_range_syntax(h).is_err(),
        None => false,
    }
}
```

模块头 doc 注释（`//! routes/file.rs 的 parse_range/has_multiple_ranges 逐行同源`）扩为含 `parse_range_syntax`/`resolve_range` 拆分对齐说明（8c5fe16 后 native 已拆分，本模块随之）。

- [ ] **Step 4: dispatch.rs 接线**

`file()`（:170 起）改为：

```rust
async fn file(req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    let url = req.url()?;
    let (p, root) = query_tree(&url)?;

    // If-Range（BUG-47）：本服务器从不下发 ETag/Last-Modified，客户端携带的
    // 任何 If-Range 值都不可能匹配 → 按 RFC 9110 §13.1.5 忽略 Range 回 200
    let if_range_present = req.headers().has("if-range")?;
    let range_header = req.headers().get("range")?;

    // C2 parity（native 8c5fe16）：Range 语法非法与文件存在性无关（RFC 9110
    // §14.2 请求语法错误），locate 之前即 416——否则语法非法 + 缺失文件时 404
    // 抢答。size 未知形态 Content-Range: bytes */*。
    if should_pre_reject_range(if_range_present, range_header.as_deref()) {
        return range_not_satisfiable_unbounded();
    }

    let located = file::locate(&state.core, root, p.as_deref()).await;
    let located = match located {
        Ok(located) => located,
        Err(err) => return respond(Err(err)),
    };
    let size = located.size();

    let range: Option<(u64, u64)> = if if_range_present {
        None
    } else {
        match range_header
            .as_deref()
            .filter(|h| !has_multiple_ranges(h))
            .map(|h| parse_range(h, size))
        {
            None => None,
            Some(Ok(parsed)) => parsed,
            Some(Err(())) => return range_not_satisfiable(size),
        }
    };
    let window = range.map(|(start, len)| RangeSpec { start, len });

    respond(file::read(located, window).await)
}
```

`range_not_satisfiable`（:206）旁追加：

```rust
/// 416（size 未知形态，C2 parity）：语法非法在 locate 之前即判，尚无 size 可
/// 回——Content-Range 用 RFC 9110 §14.4 的 incomplete-length 形态 `bytes */*`
/// （native range_not_satisfiable_unbounded 同构）。
fn range_not_satisfiable_unbounded() -> worker::Result<Response> {
    let mut res = json_error(416, "range not satisfiable")?;
    res.headers_mut().set("content-range", "bytes */*")?;
    Ok(res)
}
```

import 行（:23）补 `parse_range_syntax, should_pre_reject_range`（should_pre_reject_range 在函数内使用；parse_range_syntax 若 dispatch 不直接用则只 import should_pre_reject_range——以编译器提示为准，不留未用 import）。

- [ ] **Step 5: 跑测试与双门**

Run: `cargo test -p vviewer-worker && cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features && cargo clippy -p vviewer-worker --all-targets -- -D warnings`
Expected: 单测全绿（既有 parse_range 语义锁测不动即绿——组合重构行为等价）、wasm check 过、clippy 零告警。

- [ ] **Step 6: Commit**

```bash
git add server/worker/src/http.rs server/worker/src/dispatch.rs
git commit -m "fix(worker): Range 语法非法前置 416——对齐 native 双重故障优先级

native 面（8c5fe16）已把语法非法在 locate 前置 416；worker 面仍先 locate
后 parse，语法非法 + 缺失文件时 404 抢答。http.rs 拆分 syntax/resolve 与
native 对齐（既有 parse_range 改组合，语义锁测不动即绿），闸判定抽纯函数
（dispatch wasm 门控不可 host 单测）；416 unbounded 用 bytes */*。终审新
增候选 C2。"
```

---

### Task 3: C3 手工 Debug 字段数锚测

**Files:**
- Modify: `server/src/config.rs`（tests 模块追加三面锚测）
- Modify: `server/core/src/mounts.rs`（tests 模块追加两面锚测）

**Interfaces:**
- Consumes: 既有测试 `mount_config_debug_redacts_credentials`（config.rs:458）、`token_is_redacted_in_all_config_debug_faces`（:490）、`cfg(kind)` 夹具（mounts.rs:374）、`build_mount(cfg, transport)`（mounts.rs:133）。
- Produces: 无跨任务接口（纯测试增量）。

锚测三道防线（每面同构）：①字段全集字面量——结构体增删字段而未更新本测试即**编译错**（编译期强制）；②字段名清单常量长度断言；③Debug 输出逐字段名断言——字面量/清单已更新但 Debug impl 漏改即**运行期红**（新增字段静默丢显的直接抓取面；脱敏面只遮值不遮名，字段名必在场）。

- [ ] **Step 1: config.rs tests 追加三面锚测**

放 `token_is_redacted_in_all_config_debug_faces` 之后：

```rust
    // ---------- C3：手工 Debug 字段清单同步锚（三道防线，见各常量注释） ----------

    const FILE_CONFIG_DEBUG_FIELDS: &[&str] = &[
        "root", "web_dist", "port", "token", "allow_lan",
        "hidden", "cors_origin", "compute", "log_file", "mounts",
    ];

    #[test]
    fn file_config_debug_field_inventory_locked() {
        // ① 编译期字段全集锚（缺/多字段此字面量即编译失败）
        let probe = FileConfig {
            root: vec!["/tmp".into()],
            web_dist: Some("dist".into()),
            port: Some(1),
            token: Some("t".into()),
            allow_lan: Some(true),
            hidden: Some(true),
            cors_origin: Some("http://x".into()),
            compute: Some(true),
            log_file: Some("v.log".into()),
            mounts: Vec::new(),
        };
        assert_eq!(FILE_CONFIG_DEBUG_FIELDS.len(), 10);
        // ③ Debug 逐字段名（值选无字段名子串的形态，防误配）
        let dbg = format!("{probe:?}");
        for name in FILE_CONFIG_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }

    const RESOLVED_CONFIG_DEBUG_FIELDS: &[&str] = &[
        "root", "web_dist", "port", "token", "token_gen", "allow_lan",
        "hidden", "cors_origin", "compute", "log_file", "mounts",
    ];

    #[test]
    fn resolved_config_debug_field_inventory_locked() {
        let probe = ResolvedConfig {
            root: vec!["/tmp".into()],
            web_dist: Some("dist".into()),
            port: 1,
            token: Some("t".into()),
            token_gen: true,
            allow_lan: true,
            hidden: true,
            cors_origin: Some("http://x".into()),
            compute: true,
            log_file: Some("v.log".into()),
            mounts: Vec::new(),
        };
        assert_eq!(RESOLVED_CONFIG_DEBUG_FIELDS.len(), 11);
        let dbg = format!("{probe:?}");
        for name in RESOLVED_CONFIG_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }

    const SERVE_ARGS_DEBUG_FIELDS: &[&str] = &[
        "root", "web_dist", "port", "token", "token_gen", "allow_lan",
        "hidden", "cors_origin", "compute", "log_file",
    ];

    #[test]
    fn serve_args_debug_field_inventory_locked() {
        let probe = ServeArgs {
            root: vec!["/tmp".into()],
            web_dist: Some("dist".into()),
            port: Some(1),
            token: Some("t".into()),
            token_gen: true,
            allow_lan: true,
            hidden: true,
            cors_origin: Some("http://x".into()),
            compute: true,
            log_file: Some("v.log".into()),
        };
        assert_eq!(SERVE_ARGS_DEBUG_FIELDS.len(), 10);
        let dbg = format!("{probe:?}");
        for name in SERVE_ARGS_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }
```

- [ ] **Step 2: mounts.rs tests 追加两面锚测**

放 `cfg(kind)` 夹具之后（MountRoot 的构造走 build_mount + MockTransport——backend 为 trait 对象，无 Default）：

```rust
    // ---------- C3：手工 Debug 字段清单同步锚 ----------

    const MOUNT_CONFIG_DEBUG_FIELDS: &[&str] = &[
        "kind", "label", "endpoint", "bucket", "prefix", "access_key_id",
        "secret_access_key", "username", "password", "path_style", "region",
    ];

    #[test]
    fn mount_config_debug_field_inventory_locked() {
        // ① 编译期字段全集锚
        let probe = cfg(MountKind::S3);
        assert_eq!(MOUNT_CONFIG_DEBUG_FIELDS.len(), 11);
        // ③ 脱敏面只遮值不遮名——凭据字段名必须在场
        let dbg = format!("{probe:?}");
        for name in MOUNT_CONFIG_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
    }

    const MOUNT_ROOT_DEBUG_FIELDS: &[&str] = &["meta"];

    #[test]
    fn mount_root_debug_field_inventory_locked() {
        // build_mount 通道构造（backend 为 dyn 无字面量形态）；断言面锚
        // 「meta 在场 + backend 故意不暴露 + non_exhaustive 标记在场」——
        // backend 的省略是 impl 注释的在案裁决，不得静默回归。
        let transport: std::sync::Arc<dyn HttpTransport> =
            std::sync::Arc::new(MockTransport::new());
        let root = build_mount(&cfg(MountKind::S3), transport).unwrap();
        let dbg = format!("{root:?}");
        assert_eq!(MOUNT_ROOT_DEBUG_FIELDS.len(), 1);
        for name in MOUNT_ROOT_DEBUG_FIELDS {
            assert!(dbg.contains(&format!("{name}:")), "Debug 缺字段 {name}: {dbg}");
        }
        assert!(!dbg.contains("backend:"), "backend 不得经 Debug 暴露: {dbg}");
        assert!(dbg.contains(".."), "non_exhaustive 标记须在场: {dbg}");
    }
```

transport 构造形态照抄既有先例（server/core/src/state.rs:364-366 测试装置）：`use vviewer_storage::transport::MockTransport;` + `Arc<dyn HttpTransport>` 包裹 `MockTransport::new()`（HttpTransport/Arc 在 mounts.rs :27/:20 已 import，tests 模块内补 MockTransport use）。

- [ ] **Step 3: 跑测试与 clippy**

Run: `cargo test -p vviewer-server -p vviewer-core && cargo clippy --workspace --all-targets -- -D warnings`
Expected: 新锚测全绿；clippy 零告警。（crate 名以 workspace 实际为准：`cargo test -p vviewer` / `-p vviewer-core`——实施时以 Cargo.toml package name 为准。）

- [ ] **Step 4: 变异核验（防线有效性实证）**

临时在某一个 Debug impl 删掉一个 `.field(...)` 行（如 ResolvedConfig 的 token_gen）→ 跑锚测确认红 → 还原。

Run: `cargo test -p vviewer resolved_config_debug_field_inventory_locked`
Expected: 还原后 PASS；删除期间 FAIL（"Debug 缺字段 token_gen"）。

- [ ] **Step 5: Commit**

```bash
git add server/src/config.rs server/core/src/mounts.rs
git commit -m "test(config): 五面手工 Debug 字段清单同步锚——新增字段忘改 Debug 即红

FileConfig/ResolvedConfig/ServeArgs/MountConfig/MountRoot 的手工 Debug 与
结构体定义靠人工同步，字段清单锚测三道防线：编译期字段全集字面量、清单
长度、Debug 输出逐字段名。终审新增候选 C3（终审分诊 #1 建议）。"
```

---

### Task 4: C4 desktop SIGTERM×重启孤儿窄窗护栏

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`（ServerState 字段、RestartGuard、start_and_wait 置位、shutdown_now/wait_restart_window、测试）

**Interfaces:**
- Consumes: 既有 `kill_server`（:321）、`READY_TIMEOUT`（ready 模块）、既有测试 `shutdown_reaps_child_process`（:557，ServerState 字面量构造）。
- Produces: `ServerState.restarting: AtomicBool`；`wait_restart_window(restarting: &AtomicBool, timeout: Duration)`；`RestartGuard<'a>(&'a AtomicBool)`（RAII 清位）。

- [ ] **Step 1: 写失败单测**

tests 模块追加（与 `shutdown_reaps_child_process` 邻位）：

```rust
    /// C4：护栏等待——在飞时阻塞至清位（后台线程延时清位）。
    #[test]
    fn restart_window_wait_blocks_until_cleared() {
        let flag = std::sync::Arc::new(AtomicBool::new(true));
        let f = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            f.store(false, Ordering::Release);
        });
        let t0 = std::time::Instant::now();
        wait_restart_window(&flag, std::time::Duration::from_secs(5));
        assert!(
            t0.elapsed() >= std::time::Duration::from_millis(25),
            "见位须等待至清位（elapsed={:?}）",
            t0.elapsed()
        );
    }

    /// C4：护栏等待超时上限（防御性死等保险——早退路径由 RAII 清位，正常不触顶）。
    #[test]
    fn restart_window_wait_times_out_defensively() {
        let flag = AtomicBool::new(true);
        let t0 = std::time::Instant::now();
        wait_restart_window(&flag, std::time::Duration::from_millis(20));
        assert!(t0.elapsed() >= std::time::Duration::from_millis(15));
    }

    /// C4：RestartGuard RAII 清位（start_and_wait 全部早退路径的防线）。
    #[test]
    fn restart_guard_clears_on_drop() {
        let flag = AtomicBool::new(true);
        {
            let _g = RestartGuard(&flag);
            assert!(flag.load(Ordering::Acquire));
        }
        assert!(!flag.load(Ordering::Acquire), "guard drop 须清位");
    }
```

同时给既有 `shutdown_reaps_child_process` 的 `ServerState` 字面量补 `restarting: AtomicBool::new(false),`（否则编译失败——这一步先确认红）。

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 编译错误（restarting 字段/wait_restart_window/RestartGuard 未定义）。

- [ ] **Step 2: 实现护栏**

main.rs 顶部 import 补 `AtomicBool`（现 import AtomicU64/Ordering 处）与 `std::time::Duration`（按需）。ServerState（:44-48）加字段：

```rust
struct ServerState {
    child: Mutex<Option<Child>>,
    generation: AtomicU64,
    stderr_tail: Arc<Mutex<String>>,
    /// C4：重启在飞护栏——start_and_wait 开场置位、槽位放回/早退清位；
    /// shutdown_now 据此等待孤儿窗口收口后再统一 kill。
    restarting: AtomicBool,
}
```

ServerState 全部构造点补字段（grep `ServerState {` ——含 :563 测试；若有 bootstrap 处构造一并补 `AtomicBool::new(false)`）。

shutdown_now（:330-333）改写 + 邻位新件：

```rust
/// C4：等待重启在飞窗口收口（毫秒级）。见位自旋（2ms 步进）至护栏清位；
/// 超上限按无窗口处置（防御性——早退路径由 RestartGuard RAII 清位，正常不触顶）。
fn wait_restart_window(restarting: &AtomicBool, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while restarting.load(Ordering::Acquire) {
        if std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// C4：重启在飞护栏 RAII——置位在构造（调用方 store(true) 后包一层）、
/// 清位在 drop：start_and_wait 的全部早退路径（Resolve 失败 / 超时 / spawn
/// 失败）不靠逐 return 记忆。
struct RestartGuard<'a>(&'a AtomicBool);

impl Drop for RestartGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// C4：护栏等待上限（覆盖最慢 start_and_wait 收口；与 READY_TIMEOUT 同量级，
/// 独立常量避免语义耦合——护栏超时是防御性保险，不是就绪等待）。
const RESTART_WINDOW_TIMEOUT: Duration = Duration::from_secs(15);

/// 信号退出语义体（2-7；C4 护栏）：先等重启在飞窗口收口再 kill+exit——
/// 「旧 child 已出槽（start_and_wait kill_server）、新 child 未入槽（:194 放回）」
/// 的毫秒级窗口内收到 SIGTERM 时，新 sidecar 由本函数在窗口收口（槽位放回）
/// 后统一回收，不再孤儿化。双检：kill 前后各查一次护栏，信号恰在重启开场
/// 置位前后到达时复查见位即回到等待。残余窗口（知情接受）：复查通过至
/// exit(0) 之间重启线程恰好开场的纳秒级交错——原缺陷窗口毫秒级且后果可控
/// （孤儿 sidecar 存活至机器重启，--port 0 无端口冲突），线性化需第二标志位
/// + 重启 bail-out，复杂度不成比例。
fn shutdown_now(state: &ServerState) {
    wait_restart_window(&state.restarting, RESTART_WINDOW_TIMEOUT);
    kill_server(state);
    if state.restarting.load(Ordering::Acquire) {
        wait_restart_window(&state.restarting, RESTART_WINDOW_TIMEOUT);
    }
    std::process::exit(0);
}
```

start_and_wait（:152 起）置位：

```rust
fn start_and_wait(app: &AppHandle) -> Result<u16, LaunchFailure> {
    let state = app.state::<ServerState>();
    // C4：先竖护栏再出槽——孤儿窗口（kill 旧 child 至新 child 入槽）全程有
    // 护栏覆盖；RAII 清位覆盖全部早退路径
    state.restarting.store(true, Ordering::Release);
    let _restart_guard = RestartGuard(&state.restarting);
    // 重启形态：先回收旧子进程；代际 +1 使旧存活监视线程退场
    kill_server(&state);
    // …（后续原样不动）
```

（置位点必须先于 kill_server；guard 绑定保证 :194 槽位放回后与一切早退路径清位。）

- [ ] **Step 3: 跑测试与 clippy**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 全绿零告警。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "fix(desktop): SIGTERM×重启毫秒级孤儿窄窗——restarting 护栏关窗

start_and_wait 在旧 child 出槽至新 child 入槽之间收 SIGTERM 时，新
sidecar 无人回收成孤儿。ServerState 增 restarting AtomicBool：开场置位
（先于出槽）、RAII guard 覆盖全部早退清位；shutdown_now 双检等待——窗口
收口（槽位放回）后统一 kill。纳秒级残余交错知情接受（原窗口毫秒级+后果
可控，线性化复杂度不成比例，注记在案）。终审新增候选 C4。"
```

---

### Task 5: C5 workerd CL:0 探针脚本 + workflow 挂点

**Files:**
- Create: `server/worker/scripts/probe-content-length-zero.sh`（可执行位）
- Modify: `.github/workflows/deploy-worker.yml`（构建门禁之后挂探针 step）

**Interfaces:**
- Consumes: `server/worker/wrangler.toml`（`.dev.vars` 机制在案、`[build]` worker-build、Assets 指向 apps/web/build）；worker mounts_register 的 400 消息原文 `invalid mount config: {e}`（dispatch.rs:247——json_error 形态 `{"error": "..."}`）。
- Produces: 无代码接口；digest 回写引用本脚本路径。

- [ ] **Step 1: 写探针脚本**

`server/worker/scripts/probe-content-length-zero.sh`（写完 `chmod +x`）：

```bash
#!/usr/bin/env bash
# C5：workerd 对 Content-Length: 0 POST 的 body() 形态实证（spec 2026-10-22 §3 C5）。
# 挂 deploy-worker workflow（CI workerd 环境）执行；本地不跑（实机窗口等待口径）。
# 断言：合法 token + 无 body 的 POST /api/mounts → 400 invalid mount config（非 5xx）
# ——workerd body() 返回 null 或空流两分支的终态已收敛一致（空缓冲 → serde 400），
# 本探针实证该收敛在真实 workerd 上成立。
# 前置（workflow 内由前置 step 保证）：node 依赖已装（wrangler 经 npx 解析）、
# apps/web/build 已构建（Assets binding 目标）、wasm32 target 已装（[build] 触发
# worker-build）。
set -euo pipefail
cd "$(dirname "$0")/.." # server/worker

PORT=${PROBE_PORT:-8791}
TOKEN=probe-token-cl0
BODY_FILE=$(mktemp)

cleanup() {
  if [ -n "${WRANGLER_PID:-}" ]; then kill "$WRANGLER_PID" 2>/dev/null || true; fi
  rm -f .dev.vars "$BODY_FILE"
}
trap cleanup EXIT

# .dev.vars gitignore 不入库：探针自备自清（wrangler.toml 注释的本地 dev 机制）
cat > .dev.vars <<EOF
VV_TOKEN=${TOKEN}
EOF

npx wrangler dev --port "${PORT}" &
WRANGLER_PID=$!

# 就绪等待（health 免鉴权）
ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "probe: FAIL——worker dev 60s 未就绪"
  exit 1
fi

# Content-Length: 0 形态：-X POST 无 -d（无 body），显式零长头
code=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Length: 0" \
  "http://127.0.0.1:${PORT}/api/mounts")

echo "probe: POST /api/mounts (Content-Length: 0) -> HTTP ${code}"
echo "probe: body: $(cat "$BODY_FILE")"

if [ "$code" != "400" ]; then
  echo "probe: FAIL——预期 400（invalid mount config），实得 ${code}（5xx = workerd CL:0 形态未收敛，立缺陷）"
  exit 1
fi
if ! grep -q "invalid mount config" "$BODY_FILE"; then
  echo "probe: FAIL——400 但错误体不含 invalid mount config（分支终态漂移）"
  exit 1
fi
echo "probe: PASS——无 body POST 收敛为 400 invalid mount config（非 5xx），实证补齐完成"
```

实施注记：Step 1 前先 `rg -n "invalid mount config" server/worker/src/dispatch.rs server/core/src/mounts.rs` 核对 400 消息原文——若 `mounts_register` 在 serde 解析前的空 body 分支走的是别的消息（如 body 为空时的不同错误体），以实际消息改 grep 串；断言主体（400 非 5xx）不动。

- [ ] **Step 2: workflow 挂点**

`.github/workflows/deploy-worker.yml`：「体积门禁（wasm+js 产物 <5MB）」step 之后、「部署前置检查」之前插入：

```yaml
      - name: Content-Length: 0 形态探针（workerd 实证，非门禁）
        id: probe-cl0
        continue-on-error: true # 实证补齐：失败揭示 workerd 行为分歧（立缺陷），不阻断部署；结果回写 digest
        run: bash server/worker/scripts/probe-content-length-zero.sh
```

- [ ] **Step 3: 静态审读验证（本批不实跑）**

Run: `bash -n server/worker/scripts/probe-content-length-zero.sh && git check-ignore -v server/worker/.dev.vars; actionlint .github/workflows/deploy-worker.yml 2>/dev/null || true`
Expected: `bash -n` 语法零输出；`.dev.vars` 确认被 gitignore 覆盖（wrangler.toml 注释在案）；actionlint 若本机缺席则跳过（CI 侧已有校准）。

再核对脚本的 shellcheck 面与 workflow 缩进一致性（yaml 两空格层级照既有 step）。

- [ ] **Step 4: Commit**

```bash
git add server/worker/scripts/probe-content-length-zero.sh .github/workflows/deploy-worker.yml
git commit -m "test(worker): workerd Content-Length:0 POST 形态探针落库挂 CI

阶段三 T5 的 mounts POST Content-Length 预检+流式累计闸对 workerd CL:0
形态（body() null vs 空流）未实证——两分支终态已收敛一致（空缓冲→serde
400），属实证补齐非缺陷。探针走 wrangler dev 起 workerd 断言 400 非 5xx，
挂 deploy-worker workflow 首跑执行（continue-on-error：揭示分歧不阻断部
署），结果回写 digest。终审新增候选 C5。"
```

---

### Task 6: digest 五条终态回写 + 全量门禁

**Files:**
- Modify: `docs/report/sdd-deferred-minors-2026-10-21.md:168-174`（新增挂账候选节改清偿表）

**Interfaces:**
- Consumes: Task 1–5 的 commit hash（回写「闭合处」列）。
- Produces: digest 五条终态（批事实源收口）。

- [ ] **Step 1: digest 回写**

「### 阶段一终审新增挂账候选（2026-10-22 终审，均小项）」节的 5 条 bullet 改写为清偿表（风格随阶段二/三清偿表）：

```markdown
### 终审新增挂账候选清偿（2026-10-22 批，5 项，commit <T1>..<T5>）

| 项 | 闭合处 |
| --- | --- |
| 占位 tab snapshot 无过滤缺陷（restore 恒再落占位） | <T1-hash>：restore 查表/dirSnap/exists 四处剥 `placeholder:` 前缀，来源重建即复活（文件+目录条目）；WSX-13 RED→GREEN + WSX-14 单层前缀幂等锚。维持现状注记：断连期真 id 目录条目仍丢弃（占位化不产出目录条目，pre-existing）；`TabSnapshot.kind` 对前缀误判无消费面 |
| worker 416 前置 parity | <T2-hash>：http.rs 拆分 syntax/resolve 对齐 native 拆分 + dispatch locate 前置语法闸（should_pre_reject_range 纯判定可锚）；416 unbounded `bytes */*` |
| config 五面手工 Debug 字段数锚测 | <T3-hash>：字段全集字面量（编译期）+清单长度+Debug 输出逐字段名三道防线（config.rs 三面 + mounts.rs 两面） |
| desktop SIGTERM×重启孤儿窄窗 | <T4-hash>：restarting AtomicBool 护栏（RAII 清位）+ shutdown_now 双检等待；纳秒级残余交错知情注记在案 |
| workerd Content-Length: 0 POST 实证 | <T5-hash>：探针脚本落库挂 deploy-worker workflow 首跑（continue-on-error 非门禁）——**实证结果待 CI 窗口，回写于此** |
```

- [ ] **Step 2: 全量门禁**

依次（长门禁用 run_in_background）：

```bash
pnpm typecheck                                   # 0E
pnpm -w vitest run                               # 仓库根，基线 1766+1（唯一败=tools/grammar-builder 本机产物过期，勿修）
cargo test --workspace                           # 全绿
cargo clippy --workspace --all-targets -- -D warnings   # 零
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features
pnpm --filter web build:e2e && node tools/diagram-budget.mjs   # ci.yml:38-42 同款脚本（本批用 build:e2e 产物，防 CDN 注入冲掉）
cd apps/web && npx playwright test               # 默认目标 660（658+2）
cd apps/web && npx playwright test -c playwright.server.config.ts   # 91 不翻转
```

Expected: 全绿；playwright 基线零翻转（计数 ±新增用例数）。

- [ ] **Step 3: Commit**

```bash
git add docs/report/sdd-deferred-minors-2026-10-21.md
git commit -m "docs(report): 终审新增挂账候选五条终态回写——C1-C5 清账

digest 唯一幸存递延事实源收口：五条改清偿表（C1-C4 闭合 hash、C5 落库
挂 CI 首跑窗口口径）。全量门禁通过记录见批终审。"
```
