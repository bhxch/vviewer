# hex/结构树与压缩包（M4） — e2e 场景

> 转写自：`docs/report/e2e/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`，2026-10-08）。
> 本文将该报告「hex/结构树与压缩包（binary-hex-archive，M4）」域的黑盒测试内容转写为可独立执行的场景文档；只收录报告中有依据的内容，不补充报告之外的 spec 行为。各场景括注报告原始结果（pass / partial / fail）。

## 1. 域描述与覆盖范围

以下均摘自报告 §1.1、§2.4、§4 矩阵与 §8.7 附录。

- **覆盖与评级**：10 个测试点全部实跑——8 pass / 1 partial / 1 fail，0 受阻，域评级 **基本完整**（报告 §1.1 六个「基本完整」域之一）。failed=BIN-10，partial=BIN-08。
- **通过面**（报告 §4 矩阵备注）：hex 三列 dump、1MB 分页精确翻页、PNG/ELF 结构树（与 readelf/python 解析吻合）、zip/tar 条目树与递归预览、4 层嵌套超限拒绝全部通过。
- **缺陷面**（报告 §4 矩阵备注 + §5，两条均 medium · verified，报告涉及域均为本域）：加密 zip 整包拒绝（**BUG-12**，加密语义正确但明文条目连带不可预览）与 magic 预检缺失（**BUG-13**，重定向从未发生）。
- **跨域关联缺陷**：**BUG-16**（1MB .bin 的 hex 首屏超预算 3~9 倍）在报告中归属 pwa-mobile-performance（测试点 PWA-08），但缺陷对象是本域 hex 视图的首屏性能；本档第 3 节单列一节作跨域回归验收，本域矩阵行不计该缺陷。
- **架构前提**（报告 §2.4 偏差 #7，已裁决不计缺陷）：服务端解包已裁决移 P2，压缩包一律前端 jszip/libarchive 本地解包——本域全部压缩包场景均基于前端本地解包路径。

## 2. 场景清单表

编号沿用报告测试点编号（BIN-01~10，报告 §8.7），无续编号。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| BIN-01（pass） | vviewer 服务已启动（8391 主实例，`--compute`，启动命令见 4.1），浏览器经 TopBar「连接服务器」接入并加载文件树；树中有 samples/m4/sample.bin（4129 字节，PNG 签名开头） | ① 在文件树点击 sample.bin；② 观察 hex 视图的列结构；③ 核对首行字节与末行偏移 | ① 进入 hex 视图，呈经典三列（偏移 / 十六进制字节 / ASCII）dump；② 首行 hex 对应 PNG 文件签名（89 50 4E 47 0D 0A 1A 0A）；③ 末偏移与文件实际 4129 字节吻合；全程无错误卡片（报告证据 BIN-01-hexdump.png） | — |
| BIN-02（pass） | 已连接服务器；树中有 >1MB 的 .bin（报告用域样例 3MB 随机 .bin） | ① 点击该 .bin 打开 hex 视图；② 滚动到底（原「加载更多」翻页按钮已随 BUG-16 虚拟滚动移除，滚动续读语义）；③ 记录末偏移；④ 回滚再滚动确认行内容稳定无白屏 | ① hex 视图即时呈现（1MB 首屏不再全量渲染 6.5 万行）；② 滚动到底即达数据末尾，无续读步骤；③ 末行偏移与总大小吻合（3MB 时末行起始 0x2ffff0，1MB 时 0xffff0，行内覆盖至末字节）；④ 滚动过程无白屏（BUG-16 修复后口径，报告证据 BIN-02-load-more-3mb.png 为修复前翻页语义存档） | BUG-16 |
| BIN-03（pass） | 已连接服务器；备好 PNG 文件（IHDR width=32、height=8），将其扩展名改为 .bin 放入数据树 | ① 树中点击该改名文件；② 观察进入的渲染器（应为结构树而非仅按 .bin 出 hex）；③ 以 python struct 解析该 PNG 的 IHDR 字段对照 | ① 渲染器按内容 magic 识别为 PNG 并展示结构树（识别不依赖扩展名）；② 结构树 IHDR 的 width=32、height=8 与 python struct 解析一致（报告证据 BIN-03-png-struct-tree-visible.png） | — |
| BIN-04（pass） | 已连接服务器；树中有合法 ELF 二进制（域样例，file(1) 验证） | ① 树中点击 ELF 文件；② 观察页面是否白屏、结构树字段；③ 终端执行 `readelf -h <文件>` 对照 | ① 页面不白屏；② 结构树展示 magic / class / endian / type / machine / entry 等字段，且与 readelf -h 输出全部吻合（报告证据 BIN-04-elf-struct-tree.png） | — |
| BIN-05（pass） | 已连接服务器；树中有 samples/m4/sample.zip；终端可执行 `unzip -l samples/m4/sample.zip` 取对照基准 | ① 树中点击 sample.zip；② 观察压缩包渲染器的条目树；③ 与 unzip -l 输出逐项对照条目名称与目录层级 | 进入压缩包渲染器并展示包内条目树，条目名称与层级和 unzip -l 逐项一致（报告证据 BIN-05-zip-entry-tree.png） | — |
| BIN-06（pass） | 承接 BIN-05：sample.zip 条目树已打开；包内含 hello.txt 与 inner.txt 两个文本条目 | ① 点击条目树中的 hello.txt；② 再点击 inner.txt；③ 检查各条目打开后的 tab 与内容 | 每个包内文本条目点击后均打开独立 code tab，内容正确渲染（报告证据 BIN-06-inner-txt-code.png；hello.txt 内容含「hello vviewer」，BUG-13 复核的字节片段「hello.txthello vviewer」可佐证） | — |
| BIN-07（pass） | 已连接服务器；树中有 nested-4-levels.zip（4 层嵌套 zip，构造时已程序化逐层验证合法） | ① 点击打开第 1 层 zip；② 逐层点击进入内层 zip 直至第 3 层；③ 尝试打开第 4 层 zip | ①② 前 3 层均可正常进入条目树；③ 第 4 层被拒绝并报「嵌套层数超限：递归预览最多 3 层」，页面不崩溃（报告证据 BIN-07-depth-limit.png、BIN-07-l3-opened.png） | — |
| BIN-08（partial） | 已连接服务器；树中有 ZipCrypto 混合包 encrypted-entries.zip（plain/open.txt 明文 + secret/locked.txt 加密；两阶段构造与验证方法见 4.2/4.3，单命令 `zip -P` 会加密全部条目）；另备无加密对照 nested-5-levels.zip | ① 树中点击 encrypted-entries.zip；② 观察 tab 内容与包内条目树（plain/、secret/ 是否出现）；③ 终端 `curl -I /api/file?path=…/encrypted-entries.zip` 对照服务端响应；④ 对照打开 nested-5-levels.zip | 期望（spec L206、M4 计划 L38，即修复后验收判据）：展示包内条目树（plain/ 与 secret/ 均出现）；加密条目有明确标记（锁形图标/标注）；点击加密条目时报「加密不支持」；明文条目 plain/open.txt 可正常预览。实测现状：zip 在打开阶段整包拒绝——错误卡片「无法预览此文件 / Encrypted zip are not supported / encrypted-entries.zip」，条目树不渲染，明文条目连带无法预览；curl /api/file 返回 200 application/zip，整包拒绝发生在前端解析阶段（报告证据 BIN-08-encrypted-tree.png、复核 BIN-08-verify-encrypted-card.png） | BUG-12 |
| BIN-09（pass） | 已连接服务器；树中有 sample.tar（数据集归档件；另有 sample.tar.gz 含 src/a.txt、src/b.txt）；终端可执行 `tar -tvf` 取对照基准 | ① 树中点击 sample.tar；② 观察条目树并与 tar -tvf 对照；③ 点击包内文本条目 hello.txt | ① 条目树与 tar -tvf 输出一致；② 包内文本条目以 code 渲染器正确渲染内容；③ 走前端 libarchive 本地解包路径（偏差 #7，报告证据 BIN-09-tar-preview.png） | — |
| BIN-10（fail） | 已连接服务器；执行 `cp samples/m4/sample.zip zip-as-txt.txt` 造改名样例（file(1) 鉴定仍为 Zip archive data、md5 与原 zip 一致、头部 504b0304）；另备正常命名对照组 nested-5-levels.zip | ① 树中点击 zip-as-txt.txt 打开（入口一）；② 经 TopBar「文件 URL」入口打开同一文件（入口二）；③ 分别观察渲染器类型、显示内容与网络请求；④ 对照打开 nested-5-levels.zip | 期望（报告期望，即修复后验收判据）：magic 预检识别 ZIP 签名（504b0304）后重定向到压缩包渲染器并展示包内条目树；签名不符时只重定向一次（该口径因重定向从未发生，本轮无从验证，修复后需按实现明确）。实测现状：两入口均未发生任何 magic 探测/重定向——树点击后以 code 渲染器带行号显示 zip 原始字节乱码（可见「PK\u0003\u0004」「hello.txthello vviewer」等明文片段），网络层仅 4 次 GET /api/file、无探测类请求；URL 入口复核实测为名为「file」的标签报「不支持的扩展名 "."」（报告原文记为 code 乱码，属报告对第二入口的描述偏差，不影响缺陷核心）；对照组 nested-5-levels.zip 正常进入压缩包渲染器；curl 显示服务端以 text/plain + x-vv-encoding: gb18030 返回 zip 字节（报告证据 BIN-10-zip-as-txt.png、复核 BIN-10-tree-click-tab.png、BIN-10-zip-as-txt.png） | BUG-13 |

## 3. 关联缺陷的验收行为

每条：缺陷现状（引用报告证据）→ 修复后应有行为（作为回归验收依据）。

### BUG-12【medium · verified】含加密条目的 zip 在打开阶段整包拒绝，无包内条目树与逐条加密标记

- **涉及测试点**：BIN-08（partial），报告涉及域 binary-hex-archive。复核独立从零复现，截图 `.temp/e2e-artifacts/binary-hex-archive/BIN-08-encrypted-tree.png` 与复核 `BIN-08-verify-encrypted-card.png`。
- **缺陷现状**（报告 §5 BUG-12）：构造 ZipCrypto 混合包（plain/open.txt 明文 + secret/locked.txt 加密，zipinfo -v 与 `unzip -t -P` 验证）后从树中点击：zip 打开阶段即整包拒绝，错误卡片「无法预览此文件 / Encrypted zip are not supported / encrypted-entries.zip」；条目树不渲染（plain/、secret/ 均不出现）；明文条目 plain/open.txt 一并无法预览。curl /api/file 返回 200 application/zip，整包拒绝发生在前端解析阶段。复核以两阶段构造出真正的混合包（zipinfo 证实 plain=not encrypted、secret=encrypted）后缺陷依旧；对照组无加密的 nested-5-levels.zip 正常渲染条目树，排除环境解析问题；M4 计划文档 L38 设计为逐条标记 + read 抛错，`docs/spec-deviations.md` 无整包拒绝裁决记录。仲裁备注：报告原称单条 `zip -P` 可造混合包有误（该命令会加密全部条目），复核改用两阶段构造后结论反而加强；severity medium——确不解密、错误语义清晰，可本地解压后单独预览明文条目绕过。
- **修复后应有行为**（回归验收）：
  1. 打开含加密条目的 zip 不再整包拒绝，渲染完整包内条目树，plain/ 与 secret/ 均出现；
  2. 加密条目在树中有明确标记（锁形图标或文字标注，对齐 spec L206 / M4 计划 L38 的逐条标记设计）；
  3. 点击加密条目报「加密不支持」（对应 M4 计划 L38 的 read 抛错路径），错误只作用于该条目；
  4. 同包明文条目 plain/open.txt 可正常预览（独立 code tab、内容正确，参照 BIN-06 口径）；
  5. 对照回归：无加密的 zip（nested-5-levels.zip）打开行为不受影响，仍正常渲染条目树；
  6. 判定仍在前端解析阶段：服务端 /api/file 契约不变（200 application/zip，偏差 #7 前端本地解包架构不变）。

### BUG-13【medium · verified】zip 改名为 .txt 后无 magic 预检重定向，树点击与文件 URL 两入口均以 code 渲染器显示二进制乱码

- **涉及测试点**：BIN-10（fail），报告涉及域 binary-hex-archive。复核独立复现树点击入口与报告逐字吻合，截图 `BIN-10-tree-click-tab.png`、`BIN-10-zip-as-txt.png`。
- **缺陷现状**（报告 §5 BUG-13）：`cp samples/m4/sample.zip zip-as-txt.txt`（file(1) 鉴定仍为 Zip archive data、md5 一致、头部 504b0304）后：树点击与「文件 URL」两入口均未发生任何 magic 探测/重定向——树点击后以 code 渲染器带行号显示 zip 原始字节乱码（可见「PK\u0003\u0004」「hello.txthello vviewer」等明文片段），网络层仅 4 次 GET /api/file、无探测类请求；「签名不符时只重定向一次」因重定向从未发生无从验证。复核补充：URL 入口症状与报告不同——复核打开的是名为「file」的标签报「不支持的扩展名 "."」，报告记为 code 乱码，属报告对第二入口的描述偏差，不影响缺陷核心；对照组正常命名的 nested-5-levels.zip 正常进入压缩包渲染器；curl 显示服务端以 text/plain + x-vv-encoding: gb18030 返回 zip 字节。仲裁备注：severity medium（可改回 .zip 绕过，压缩包渲染器本身正常，缺陷限于改名文件的 magic 预检缺失）；与 BUG-07 相关但不同根因——BUG-07 是无扩展名被拒，本条是有扩展名但内容不符时不做内容嗅探，note 互见。
- **修复后应有行为**（回归验收）：
  1. 打开扩展名为 .txt（或其他非归档扩展名）但头部为 ZIP 签名（504b0304）的文件时，前端 magic 预检识别后重定向到压缩包渲染器，展示包内条目树（可继续 BIN-06 式递归预览）；
  2. 签名不符时只重定向一次，不出现循环重定向——报告注明该口径本轮因重定向从未发生而未能验证，修复后需以实际行为补充明确；
  3. 正常命名的 .zip 行为不回归（仍直接进入压缩包渲染器）；
  4. 判定必须基于内容嗅探而非扩展名/Content-Type：服务端按扩展名下发 content-type（改名文件得 text/plain + x-vv-encoding: gb18030，curl 证据），前端不能依赖 content-type 派发渲染器；
  5. 树点击与「文件 URL」两入口行为一致，回归时两入口都要验证（现状描述在报告与复核间存在差异，勿只按报告文字断言单一症状）。

### BUG-16【medium · verified · 跨域】1MB .bin 的 hex 首屏超预算 3~9 倍

- **报告归属**：涉及域 pwa-mobile-performance（测试点 PWA-08，partial）；缺陷对象是本域 hex 视图的首屏性能，故在本档单列作跨域回归验收，本域矩阵行不计该缺陷。
- **缺陷现状**（报告 §5 BUG-16）：先点参照文件重置 pane，再以 performance.now() 为起点点击树内 perf-1mb.bin（1,048,576B），以 MutationObserver 检测 hex 内容首现、双 rAF 后为绘制终点：桌面 paintMs 1404~1781ms（复核 4 轮，与报告 1570/1781/1601ms 同量级），移动 1523~1738ms；即使取最宽松的 hex 头 DOM 首现口径（351~472ms）仍超桌面预算 1.8~2.4 倍；对照 long-3mb.txt 文本首帧中位 192~208ms 达标。hex pane textContent 约 505 万字符的全量 hex 渲染，内容正确。仲裁备注：medium——hex 最终渲染成功且内容正确、功能可用，属明显性能不达标而非功能损坏；本地 upload 路径首帧未测（报告 §7.1 未覆盖项 7）。
- **修复后应有行为**（回归验收，报告 §5 BUG-16 期望）：
  1. 1MB .bin 的 hex 首屏 <200ms（移动 <500ms）；
  2. ≤10MB 文件点击到首帧 <300ms（移动 <800ms）；
  3. 优化不得牺牲正确性：hex 内容仍须完整正确（对照现报告 505 万字符全量正确渲染的基准）；
  4. 测量口径沿用报告：先点参照文件重置 pane → performance.now() 起点点击 → MutationObserver hex 内容首现 + 双 rAF 为绘制终点；注意报告 §7.1 未覆盖项 9 提示 hex 性能数字含 headless 容器噪声，回归时需多轮采样。

## 4. 测试数据与边界

### 4.1 运行形态（报告 §2.1、§2.2、§3.1）

- 主服务：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；`/api/health` 返回 `capabilities=["file-server","compute"]`。
- 执行方式：黑盒 GUI（agent-browser 独立浏览器会话逐测试点执行，DOM 断言 + 网络观测 + 截图存证于 `.temp/e2e-artifacts/binary-hex-archive/`，复核截图在 `.temp/e2e-artifacts/verify/`），辅以 curl 接口断言。
- 数据根 `.temp/e2e-data/`（总量约 24MB、54 项清单）；域测试另造样例存于 `.temp/e2e-data/domain-<域名>/`。

### 4.2 本域输入数据清单

| 数据 | 用于场景 | 构造/来源（均出自报告） |
| --- | --- | --- |
| samples/m4/sample.bin（4129B，PNG 签名开头） | BIN-01 | 基础数据集 m4「9 件 office/二进制/归档」之一（报告 §2.3）；报告实测「首行 PNG 签名 hex、末偏移与 4129 字节吻合」 |
| 3MB 随机 .bin | BIN-02 | 域测试另造样例（报告 §2.3 汇总列表「3MB 随机 .bin」），经独立验证为合法格式；实测翻页末偏移 0x2ffff0 |
| PNG（IHDR width=32、height=8）改名 .bin | BIN-03 | 报告仅记录「PNG 改名 .bin」口径与 IHDR 值，未记录构造命令；PNG 头可按签名 + IHDR 结构程序化构造，IHDR 字段以 python struct 解析对照 |
| ELF 二进制 | BIN-04 | 域另造样例（报告 §2.3「ELF 二进制」），file(1) 验证；以 readelf -h 逐字段对照 |
| samples/m4/sample.zip | BIN-05、BIN-06、BIN-10（改名源） | m4 自带归档件；包内含 hello.txt、inner.txt（BIN-06 证据；BUG-13 字节片段「hello.txthello vviewer」佐证 hello.txt 内容为 hello vviewer） |
| nested-4-levels.zip（4 层嵌套 zip） | BIN-07 | 基础数据集归档件（报告 §2.3），构造时程序化逐层验证 4 层嵌套合法 |
| encrypted-entries.zip（ZipCrypto 混合包） | BIN-08 | 两阶段构造：先建含明文条目 plain/open.txt 的包，再向该包追加加密条目 secret/locked.txt（加密用 `zip -P`）；注意单命令 `zip -P` 会加密全部条目、不能一步造出混合包（复核纠正）；用 zipinfo -v 确认 plain=not encrypted、secret=encrypted，`unzip -t -P <密码>` 验证加密条目可解 |
| nested-5-levels.zip（5 层嵌套 zip，无加密） | BIN-08、BIN-10 对照组 | 域另造样例（报告 §2.3「5 层嵌套 zip」）；BUG-12/13 复核中作为无加密/正常命名对照组，均正常渲染 |
| sample.tar（另备 sample.tar.gz：含 src/a.txt、src/b.txt） | BIN-09 | 基础数据集归档件（报告 §2.3「归档 3 件」）；以 tar -tvf 对照条目 |
| zip-as-txt.txt | BIN-10 | `cp samples/m4/sample.zip zip-as-txt.txt`；file(1) 鉴定仍为 Zip archive data、md5 与原 zip 一致、头部 504b0304 |
| truncated.zip（243→121B 半截断） | （本轮未设点） | 基础数据集归档件：unzip -t 确认 EOCD 缺失，与仓库近期 EOCD 修复相关（报告 §2.3）；报告 BIN-01~10 未针对该文件设测试点，本轮无任何断言结论，如实记录，回归补测时可作边界输入 |
| perf-1mb.bin（1,048,576B） | BUG-16 回归 | PWA-08 造样（报告 §5 BUG-16 复现步骤）；1MB 整即末偏移与分页口径的基准件 |

### 4.3 边界与环境限制（报告 §2.4、§3.1、§5、§7.1）

1. **偏差 #7 是全部压缩包场景的架构前提**：服务端解包已裁决移 P2，压缩包一律前端 jszip/libarchive 本地解包（BIN-09 明确标注 libarchive 路径）；因此压缩包行为缺陷（BUG-12/13）的判定与修复均落在前端，服务端 /api/file 契约（200 application/zip 等）不因修复改变。
2. **嵌套深度限 3 层**：第 4 层报「嵌套层数超限：递归预览最多 3 层」（BIN-07）；5 层样例仅作对照，不应能逐层进入超过 3 层。
3. **hex 分页口径（BUG-16 修复后）**：hex 改行虚拟滚动，「加载更多」翻页按钮移除、滚动到底即达数据末尾；末偏移按 16 字节/行的行首值显示（3MB 时末行 0x2ffff0，1MB 时 0xffff0，行内覆盖至末字节，BIN-02）；加密/压缩与 hex 互不干扰——改名的 PNG（BIN-03）说明结构树识别以内容 magic 为准。
4. **加密支持边界**：ZipCrypto 加密条目确不解密（BUG-12 仲裁：错误语义清晰）；spec 期望仅为逐条加密标记 + 点击报「加密不支持」 + 明文条目可预览，不含解密能力，验收时勿把「能解密」当判据。
5. **混合包构造方法**：必须两阶段构造（先建明文包、再向已有包追加 `zip -P` 加密条目）；报告原称的单条 `zip -P` 会把全部条目加密（复核纠正，BUG-12 仲裁备注）；构造结果用 zipinfo -v 与 `unzip -t -P` 双重验证。
6. **BIN-10 双入口现状差异**：URL 入口的实测症状报告（code 乱码）与复核（「file」标签报「不支持的扩展名 "."」）不一致，属报告对第二入口的描述偏差；回归执行时两入口均要验证并分别记录（报告 §3.1 复核纠正、§5 BUG-13 证据）。
7. **BUG-16 是跨域缺陷**：归属 pwa-mobile-performance（PWA-08），本域矩阵未计；hex 性能数字含 headless 容器噪声（报告 §7.1 未覆盖项 9），回归时多轮采样、勿以单轮定论。
8. **未覆盖与本档边界**：报告 §7.1 未覆盖清单中没有本域专属条目；数据集中的 truncated.zip（EOCD 缺失）未被任何 BIN 测试点覆盖（见 4.2），本档对其不做任何行为断言。

---

*本文档由报告 `docs/report/e2e/e2e-test-report-2026-10-08.md` 第 4 节矩阵、第 5 节 BUG-12/13/16、第 8.7 节逐点明细转写；所有期望判据、实测症状与证据文件名均转录自该报告，未补充报告之外的行为。*
