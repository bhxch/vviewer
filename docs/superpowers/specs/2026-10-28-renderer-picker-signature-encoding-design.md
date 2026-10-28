# 渲染器自选「更多」展开 × magic 签名表扩容 × 编码探测升级 设计

- 日期：2026-10-28
- 状态：已批准（brainstorming 三议题合流）
- 上游：`2026-10-11-format-coverage-open-with-design.md`（候选集定义）、`2026-10-23-renderer-lang-override-markpad-alignment-design.md`（候选集扩容先例与三入口单机制）、`2026-10-12-io-streaming-design.md`（redetectWithFull 精判链）

## 1. 背景与动机

三议题同源于「文件内容与扩展名/识别结果不符」一类场景：

1. **渲染器自选受限**：候选集 = 自动 + 当前渲染器 ∪ 扩展名注册渲染器 ∪ code/markdown/hex 兜底。内容与扩展名不符且目标渲染器不在候选时（如 `.log` 实为 PDF），用户无通道选到 pdf/archive 等渲染器。
2. **签名覆盖缺口**：`sniffSignature` 仅 7 种签名（zip/ole/png/jpeg/gif/pdf/mpegts），无扩展名或改名的 mp4/webm/gz 等落 hex，手动切换可救但自动识别缺位。
3. **编码判定粗粒度**：`detectEncoding` 四级链（BOM×3 → 严格 UTF-8 → gb18030 兜底）把一切非 UTF-8 文本判为 gb18030——Shift-JIS/Big5/windows-1252 等全出乱码；UTF-32 BOM 不识别。

三议题彼此独立可独立交付，但共享「探测→改派→消费」链路，一次设计分节实现。

## 2. 议题一：渲染器自选「更多」就地展开

### 2.1 数据面

- `openWithOf`（`apps/web/src/lib/openWith.ts:13-36`）受限候选逻辑**一字不动**。
- `FileOpenWith`（`apps/web/src/lib/metaStore.svelte.ts:7-13`）新增字段 `all: { id: string; label: string }[]`：= `registry.all()` 全量（12 渲染器：code/markdown/html/image/av/pdf/docx/xlsx/pptx/hex/archive/jsonl；error 未注册天然不在）。与 `options` 同点算出，同序（registry 注册序）。
- 「更多渲染器…」「收起附加候选」两项是 UI 语义项（id 哨兵 `__more__`/`__less__`），不进 `FileOpenWith` 数据——由三壳各自渲染。

### 2.2 交互面

三入口尾部各加「更多渲染器…」项，激活后在**原控件内就地展开**为「自动 + 全量渲染器」列表（附「收起附加候选」回受限视图）。选就地展开的理由：MetaPanel 用原生 `<select>` 无子菜单能力，就地展开是三壳（下拉/状态栏浮层/Tab 右键）可统一复用的唯一形态，零新组件。

- 展开态为各壳 UI 局部状态，**不持久化**（会话快照只存 override 本身，零新增）。
- 选择任意渲染器（含展开项）= 既有 `setRendererOverride`（`tabsModel.svelte.ts:457`）同语义：per-tab、跳过探测链、（手动）徽标、进会话快照。**零新机制**。
- e2e 锚更新：OWX 系候选项数变化逐锚更新（2026-10-23 spec 先例），涉及 `t-open-with.spec.ts`、`b-error-card-open-as.spec.ts` 等。

### 2.3 触达面

`openWith.ts` + `RendererPickerMenu.ts`（数据面）、`MetaPanel.svelte` / `ViewerPane.svelte` / `TabBar.svelte`（三壳交互）、`openWith.test.ts` / `rendererPickerMenu.test.ts`（单测：all 字段、哨兵不进数据）、OWX 系 e2e。

## 3. 议题二：magic 签名表扩容

### 3.1 前提核实结论

- `libarchive.js@2.0.2` 实际支持 **zip/tar/tar.gz/tgz/tbz2/xz/7z/rar**（`libarchiveStore.ts` 错误文案与实现一致）→ gz/7z/rar 签名可补。
- av 渲染器扩展名含 mp4/mov/webm/ogg/mp3/wav/flac/m4a/aac/oga/opus（`av.ts:356`）；image 含 webp/avif/bmp/ico/svg（`image.ts:99`）。

### 3.2 新签名总表

原则：**签名 → 有渲染器真消费才收**；弱签名必须有强化校验（mpegts 三重对齐先例）。

| 签名 | 字节（head 偏移） | 改派目标（det.ext 纠偏） | 强度说明 |
|---|---|---|---|
| mp4 系列 | `[4..7]=ftyp` + 品牌表（isom/mp42/msi→av('mp4')；m4a→av('m4a')；avif/avis→image('avif')） | 见品牌列 | ftyp box 强；品牌字节收窄分派；**未列品牌不命中**（保守落探测链） |
| webm/mkv | `1A 45 DF A3` | av('webm') | 4 字节强 |
| webp | `RIFF` + `[8..11]=WEBP` | image('webp') | 8 字节强 |
| wav | `RIFF` + `[8..11]=WAVE` | av('wav') | 8 字节强 |
| ico | `00 00 01 00` | image('ico') | NUL 开头，文本性探测必拒，无误伤 |
| gz | `1F 8B` | archive('gz') | 2 字节但首字节 0x1F 控制符概率极低，追加第三字节压缩方法 ∈ {08} 收窄 |
| 7z | `37 7A BC AF 27 1C` | archive('7z') | 6 字节强 |
| rar | `52 61 72 21 1A 07` | archive('rar') | 6 字节强（v4/v5 共前缀，不分派差异） |
| flac | `66 4C 61 43`（fLaC） | av('flac') | 4 字节 ASCII 强 |
| ogg | `4F 67 67 53`（OggS） | av('ogg') | 4 字节强 |
| bmp | `42 4D` + `[2..5]=size` + `[6..9]=00000000` | image('bmp') | 2 字节弱 → 以保留字段全零强校验为 10 字节有效签名；不满足整表即不命中（文本 "BM…" 无 NUL，天然排除） |

mp3 **不收**：帧同步字节 `FF Ex` 无稳定前缀，弱签名误伤面大，无扩展名 mp3 维持 hex。

### 3.3 接线与不变式

- `sniffSignature`（`packages/core/src/detect/magic.ts:7`）扩表 + `SIGNATURE_ROUTES`（`dispatcher.ts:79`）同步扩列；路由的 `ext` 字段供渲染器内部分派（av 按形态/loader、archive 按 zip/libarchive 双路），须与渲染器实际消费对齐。
- **维持不动**：「二进制扩展名 + 签名不符」不参与改派（`dispatcher.ts:94-97` 裁决，防误伤）；ole 无渲染器维持 hex；BUG-13 文本类预检机制不变（表扩自动受益）。
- e2e：samples 增无扩展名/改名样本（mp4、webp、gz、7z），锚 = 自动选路直达对应渲染器 + MetaPanel「类型」行。

## 4. 议题三：编码探测升级

### 4.1 包选型（已核实）

**`chardet`**（npm v2.2.0）：MIT、零依赖、解包 179KB、官方 `browser` 字段（Node fs 适配器映射浏览器版）、同步 API `detect(Uint8Array) → { encoding, lang, confidence } | null`。备选 `jschardet`（0BSD 但 7.5MB 全模型）弃。`THIRD_PARTY_NOTICES.md` 补条目。

### 4.2 BOM 扩充与解码侧收口

- `detectEncoding`（`encoding.ts:31`）BOM 段加 **UTF-32LE（`FF FE 00 00`）** 与 **UTF-32BE（`00 00 FE FF`）**；**UTF-32LE 判定必须在 UTF-16LE 之前**（前缀包含）。
- WHATWG `TextDecoder` 不支持 UTF-32 → `Encoding` 联合（`core/types.ts:67`）增 `'utf-32le' | 'utf-32be'` 后，解码侧收口为共享 helper `decodeText(bytes, encoding): string`（render-text 单源）：UTF-32 走自带 ~20 行定长解码器，其余走 `new TextDecoder(DECODERS[...], { fatal: false })`。现有 5 处直构 TextDecoder 的解码点（`markdownRenderer.ts:510`、`html.ts:114`、`jsonl/index.ts:623` 等）机械替换。
- `DECODERS: Record<Encoding, string>`（`code/strategy.ts:116`）编译期强制补表——utf-32 两键值填 `'utf-8'` 占位仅满足 Record（不可达：decodeText 分流），注释注明。

### 4.3 chardet 精判分层（快路径零成本）

- **门控**：`det.encoding === 'gb18030'`（严格 UTF-8 已失败）**且** `looksTextual(bytes)` 才触发——UTF 系文本与二进制零成本，与议题二互不干扰。binary 判定不受影响（门控保证只处理文本路径）。
- **懒加载**：`await import('chardet')` 单例缓存（pdf.js/libarchive 先例）；首载前并发触发时共享同一 promise。
- **采纳规则**：`confidence ≥ 0.90` 且 detector 编码名命中映射白名单才改写 `det.encoding`；`null`/低置信/映射外一律维持 gb18030——**永不比今天更差**。
- **映射白名单**（detector 名 → TextDecoder 标签）：`SHIFT_JIS→shift_jis`、`EUC-JP→euc-jp`、`ISO-2022-JP→iso-2022-jp`、`EUC-KR→euc-kr`、`Big5→big5`、`windows-125x→同名`、`KOI8-R→koi8-r`、`IBM866→ibm866`、`ISO-8859-x→同名标签`（WHATWG 将 iso-8859-1 映 windows-1252，标签合法即可）、`MacCyrillic→x-mac-cyrillic`、`ASCII/UTF-8/UTF-16*/GB18030→不可达或 no-op`。
- **服务端 X-VV-Encoding 头仍最优先**：code 渲染器 `meta?.encoding ?? det.encoding`（`code/index.ts:76`）取序不变，精判只影响 `det`。

### 4.4 接线点（全异步上下文）

- `redetectWithFull`（`dispatcher.ts:60-69`）改 async 并内联精判（redetect 后仍 gb18030 才触发），签名改 `Promise<void>`——**6 处调用点机械 await 替换**：dispatcher×2（`dispatcher.ts:358,375`）、code×2（`code/index.ts:107,129` 附近 onEncodingBroken 与守卫补拉）、jsonl×2（`jsonl/index.ts` 两处同型）。
- dispatch 初始 `detect` 后追加一次精判（bytes = `full ?? probe`，覆盖 buffer 直传 >1MB 与 streaming-capable 永不补拉全量两路径）；head-only→补拉全量路径存在双重精判（head 一次、full 一次），由 gb18030 门控天然抑制第二次，chardet 8KB 级毫秒成本可接受。
- `detect()` 本体保持同步纯函数，既有单测面零破坏。

### 4.5 类型涟漪与有意不修

- 涟漪收口：`Encoding` 扩列 → `DECODERS` 编译错驱动补表（单源意图）；web 侧 `metaStore.encoding` 为宽松 string、MetaPanel 直接显示（`MetaPanel.svelte:221`）；会话快照不存 encoding——三处零涟漪。
- **有意不修**：`.dat` 等二进制扩展名的 Shift-JIS 文件先被 binary 判定拦下（encoding undefined），精判门控不触发，维持 hex（保守现状）；不做编码手动 override UI（YAGNI）；mp3 无强签名不收（同议题二）。

## 5. 测试与验收锚

- **单测**（core）：BOM 扩充序（UTF-32LE 优先于 UTF-16LE）；chardet 精判 fixtures（check-in 小字节样本：shift_jis/big5/windows-1252/koi8-r/utf-32le/be 各一，Node 端全 ICU TextDecoder 作解码断言基准）；低置信/映射外维持 gb18030；`decodeText` 全 Encoding 键；bmp 强校验正反例；SIGNATURE_ROUTES 全表改派断言。
- **单测**（web）：openWith `all` 字段与受限 `options` 同点算出；哨兵不进数据。
- **e2e**：三入口「更多」展开/收起/全量选择 → override 生效 + （手动）徽标 + 会话恢复；无扩展名 mp4/webp/gz 直达对应渲染器；samples 增编码样本（MetaPanel 编码行显示 shift_jis 等 + 内容无乱码断言）。OWX 系锚更新。
- **合规**：`THIRD_PARTY_NOTICES.md` 补 chardet（MIT）。

## 6. 实现顺序与 commit 划分

1. 议题一（web 候选面，独立无耦合）→ `feat(web): 打开方式三入口「更多渲染器」就地展开`
2. 议题二（core 签名表）→ `feat(core): magic 签名表扩容——内容识别覆盖 av/image/archive 强签名族`
3. 议题三（core 编码链，依赖 chardet 依赖引入）→ `feat(core): 编码探测升级——UTF-32 BOM 与 chardet 精判分层`
4. 文档/合规收尾随各自 commit 走，不攒批。
