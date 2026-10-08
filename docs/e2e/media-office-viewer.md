# 图片、音视频、PDF 与 Office（M4） — e2e 场景

> 来源：`docs/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`）。本文将该报告 media-office-viewer 域的测试内容忠实转写为可复现场景，不引入报告之外的行为。引用格式：「报告 §n」指该报告章节，「BUG-xx」指该报告第 5 节缺陷清单条目。

## 1. 域描述与覆盖范围

以下摘自报告 §4 功能完成度矩阵 media-office-viewer 行与 §8.6 附录明细。

**总体情况**（报告 §4）：11 个测试点，通过 9，缺陷 2（1 fail / 1 partial），受阻 0，域级评级 **基本完整**。报告备注：图片缩放/双击复位、SVG 消毒、mp4 ArtPlayer（135ms 起播）、音频、EXIF 方向、PDF 懒渲染缩放、docx/xlsx/pptx 全过且远优于预算（媒体起播 40ms）；但 HLS 完全不可用（BUG-01，high，域内唯一 high）明显拉低实际体验，媒体损坏错误呈现不符（BUG-14）。样例均经 file/ffprobe/pdfinfo 独立验证为合法格式。

> 口径备注（报告 §8.6 标题括注）：附录逐点口径为「9 pass / 2 partial」（MEDIA-04、MEDIA-11 记 partial），域统计口径为「1 fail + 1 partial」（MEDIA-04 因 BUG-01 计 fail）。两处口径本文均如实注明。

**逐点结果**（报告 §8.6，11 点：9 pass / 2 partial；域统计 1 fail + 1 partial）：

| 编号 | 测试点 | 结果 | 简要证据（摘自报告） |
| --- | --- | --- | --- |
| MEDIA-01 | 图片滚轮缩放与双击复位 | pass | 1.1x 倍进、上限 10/下限 0.1、dblclick 复位 1 → media01-zoom-test-zoomed.png |
| MEDIA-02 | SVG 消毒 | pass | script 整段移除、onload 剥除、探针变量均 false → media02-svg-sanitized.png |
| MEDIA-03 | mp4 ArtPlayer 播放 | pass | readyState=4、135ms 出 video、播放推进 → media03-mp4-artplayer.png |
| MEDIA-04 | m3u8/flv/ts 按需加载与错误处理 | partial | flv ✓；m3u8 分片 blob: 死循环静默、ts 乱码（BUG-01，域统计计 fail）→ media04-flv-playing.png、media04-m3u8-stuck.png、media04-ts-as-typescript.png |
| MEDIA-05 | mp3/wav 原生音频控件 | pass | readyState=4、播放推进、暂停生效 → media05-mp3-audio.png |
| MEDIA-06 | EXIF Orientation 方向显示 | pass | Orientation=6 按 90° CW 应用（natural 200x400）→ media06-exif-rot90.png |
| MEDIA-07 | PDF 翻页缩放与懒渲染 | pass | 6 页、200%、canvas 懒渲染+回收、页码随动 → media07-pdf-multipage-success.png（URL 表单相对路径问题另记 low 观察） |
| MEDIA-08 | docx 正文 HTML 呈现 | pass | 4 个 p 与源 document.xml 4 个 w:t 一一对应 |
| MEDIA-09 | xlsx 多 sheet 页签与超 200 行截断 | pass | 2 sheet 切换正常；250 行仅显示前 200 行+提示 → media09-xlsx-sheet2.png、media09-xlsx-large-truncated.png |
| MEDIA-10 | pptx 文本提纲卡片 | pass | 2 张 slide 卡片、页码齐全、文本与源一致 → media10-pptx-outline-cards.png |
| MEDIA-11 | 损坏/截断媒体错误呈现 | partial | mp4 黑屏+瞬时 Reconnect、PDF 卡片无按钮；不阻塞其他 tab（BUG-14）→ media11-broken-mp4.png、media11-broken-mp4-reconnect.png |

**关联缺陷**（报告 §5，本域涉及的 2 条，均为 verified）：

- **BUG-01**（high · verified，全部 26 条缺陷中唯一 high）：HLS（m3u8）分片被解析为无效 blob: URL 永不起播且静默无提示，.ts 被按代码文本渲染为乱码。对应 MEDIA-04 单点。
- **BUG-14**（medium · verified）：媒体类损坏文件无统一错误卡片（仅黑屏+瞬时 Reconnect 计数），文档类错误卡片亦无重试/降级按钮。对应 MEDIA-11 单点。

**已裁决偏差**（报告 §2.4 偏差 #4，不计缺陷）：移动端图片双指捏合缩放未实现，仅有滚轮缩放+双击复位，后置裁决维持。MEDIA-01 场景因此不含捏合断言。

**边界交叉注记**（属其他域/套件，不列入本清单，补测时查阅对应文档）：PDF 内搜索为 FSEARCH-06（in-file-search 域，pass：计数与 pdftotext 吻合、3 页 PDF 跨页跳转到位）；移动视口 mp4 播放与全屏为 PWA-07、本地音视频起播时延为 PWA-09（pwa-mobile-performance 域，pass：mp4 40ms、mp3 36ms 起播）；markdown 内 .mp4/.mp3 链接内联渲染为 MD-13（markdown-html-docs 域，pass）；仓库 Playwright m4 套件（报告 §6）覆盖 tar/libarchive 条目树、office docx/xlsx/pptx、ArtPlayer mp4 就绪，均 pass。

## 2. 场景清单

所有场景的公共环境（构造方式见第 4 节）：测试服务器以 `vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute` 启动（报告 §2.2），浏览器经 agent-browser 独立会话连接首页，文件经文件树点击打开。场景编号沿用报告测试点编号 MEDIA-01~MEDIA-11（报告编号齐全，无续编点）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| MEDIA-01 | 连接服务器；数据集含任一图片文件（域内证据名为 zoom-test，报告未记录完整路径与扩展名，重建时任一 PNG/JPG 可替代） | ① 文件树打开图片，记录初始缩放倍率；② 滚轮向上逐步缩放，逐次记录倍率直至到达上限；③ 滚轮向下逐步缩小直至到达下限；④ 双击画布，读缩放倍率 | 滚轮缩放按 1.1× 步进；上限 10×、下限 0.1×；双击复位至 1× | —（移动端双指捏合缩放未实现属偏差 #4，经裁决维持，不计缺陷，本场景不做捏合断言） |
| MEDIA-02 | 连接服务器；数据集含带恶意内容的 SVG：内联 `<script>`（执行后设置全局探针变量）与 `onload` 类事件属性（报告未记录文件名，需自行构造，见第 4 节） | ① 文件树打开该 SVG；② 检查渲染 DOM 中是否存在 `script` 元素与 `onload` 属性；③ 页内 eval 读取脚本本应设置的全局探针变量 | SVG 正常渲染且完成消毒：`script` 整段被移除、`onload` 被剥除、探针变量均为 false（脚本未执行） | — |
| MEDIA-03 | 连接服务器；数据集含 3s mp4（域内另造，ffprobe 验证合法） | ① 文件树打开 mp4；② 确认挂载的是 ArtPlayer 播放器并计时 video 元素出现耗时；③ 读 video `readyState`；④ 观察 `currentTime` 是否推进 | ArtPlayer 挂载；video 元素约 135ms 内出现（域内实测值）；readyState=4；播放推进 | — |
| MEDIA-04 | 连接服务器；网络面板开启；数据集含 HLS 切片组（video-hls.m3u8 + seg0~seg2.ts 同目录）、缺失分片的 missing-seg.m3u8、video.ts、video.flv（文件名见 BUG-01 证据） | ① 打开 video-hls.m3u8，等待 10s 以上，读 video `readyState`，检查网络面板中分片请求的 URL 形态与重试次数；② 打开 missing-seg.m3u8，观察有无错误呈现；③ 打开 video.ts，观察渲染容器类型与内容；④ 打开 video.flv，读 `readyState` 并观察是否可播完；⑤ curl 直打 `/api/file` 对照服务端响应（m3u8、seg0.ts、不存在的分片） | m3u8 经 hls.js 起播：分片请求指向可达 URL、readyState≥3、播放推进；ts 经 mpegts.js 起播（不落入代码容器）；分片资源不可达时给出可理解的错误提示而非静默挂起；flv 正常起播可播完（现状已达：readyState=4）；curl 对照：服务端正常（现状实测 m3u8 200/166B、seg0.ts 200/41360B、不存在分片 404） | BUG-01（现状：m3u8 播放列表正常加载（duration=6 已解析）但分片全部指向无效 `blob:http://127.0.0.1:8391/seg0.ts` 并反复 XHR 重试（20s 内 7+ 次）、readyState 恒 0 永不起播、无任何错误卡片/alert，missing-seg.m3u8 静默挂起；video.ts 无播放路径（hasVideo=false），进入 vv-code 代码容器渲染 MPEG-TS 乱码（「G@…FFmpeg Service01…」）；flv ✓。附录记 partial，域统计计 fail） |
| MEDIA-05 | 连接服务器；数据集含 mp3 与 wav（域内另造） | ① 打开 mp3，确认渲染为原生音频控件；② 读 audio `readyState`；③ 观察播放推进；④ 执行暂停，验证暂停生效（currentTime 停止推进）；⑤ 打开 wav 重复①~④ | 原生音频控件渲染；readyState=4；播放推进；暂停生效 | — |
| MEDIA-06 | 连接服务器；数据集含写入 EXIF Orientation=6 的 jpg（域内另造 EXIF rot90 jpg） | ① 文件树打开该 jpg；② 读取图片 natural 尺寸与实际显示方向 | EXIF Orientation=6 按 90° 顺时针应用（域内实测 natural 200×400） | — |
| MEDIA-07 | 连接服务器；数据集含 6 页 PDF（域内另造，pdfinfo 验证；3 页 PDF 另用于 FSEARCH-06，见第 1 节交叉注记） | ① 打开 6 页 PDF；② 逐页向后翻至第 6 页，观察页码随动；③ 缩放至 200%，观察重绘；④ 检查 canvas 懒渲染与回收（canvas 按需渲染、页码随动，非全量常驻） | 6 页全部可翻、页码随动正确；200% 缩放可用；canvas 懒渲染+回收（域内全项 pass） | —（报告注：URL 表单相对路径问题另记 low 观察，报告无进一步细节，本文档不展开） |
| MEDIA-08 | 连接服务器；数据集含 docx（samples/m4 之 office 件，报告未记录文件名；已知源 word/document.xml 含 4 个 w:t 文本节点） | ① 文件树打开 docx；② 统计正文渲染出的 `p` 元素数量与文本内容；③ `unzip -p <file>.docx word/document.xml` 数 `w:t` 节点，与②对照 | 正文 HTML 呈现：`p` 元素数量与源 document.xml 的 `w:t` 一一对应（域内实测各 4 个），文本一致 | — |
| MEDIA-09 | 连接服务器；数据集含 ≥2 个 sheet 的 xlsx 与含 250 行数据的 xlsx（构造见第 4 节，报告未记录文件名） | ① 打开多 sheet xlsx，在 sheet 页签间切换，核对各 sheet 内容；② 打开 250 行 xlsx，统计实际渲染行数并查找截断提示 | 多 sheet 页签切换正常；250 行数据仅渲染前 200 行且出现截断提示（域内实测；报告未记录提示原文） | — |
| MEDIA-10 | 连接服务器；数据集含 2 张 slide 的 pptx（构造见第 4 节，报告未记录文件名） | ① 文件树打开 pptx；② 清点 slide 提纲卡片数与各卡片页码；③ 将卡片文本与源 pptx 内 slide XML 文本对照 | 文本提纲卡片呈现：2 张 slide 卡片、页码齐全、文本与源一致 | — |
| MEDIA-11 | 连接服务器；数据集含 `head -c 3000` 截断的真 mp4、`head -c 500` 截断的真 PDF，另备一份正常 mp4 作不阻塞对照（构造见第 4 节） | ① 打开截断 mp4，观察 main 区域错误呈现：有无错误卡片、video `error` code、有无「Reconnect: N」计数及其存续时长；② 打开截断 PDF，观察错误卡片文案与卡片内可交互元素（按钮）；③ 保持损坏文件 tab 打开，另开正常 mp4，验证其正常播放、currentTime 推进；④ curl 直打 `/api/file` 对照服务端对损坏文件的响应 | 两类损坏文件均出现统一错误卡片，含明确错误信息与重试/降级提示（卡片内含可交互按钮）；损坏 tab 不阻塞其他 tab（正常 mp4 播放推进） | BUG-14（现状 partial：截断 mp4 video error code=4（MEDIA_ELEMENT_ERROR: Format error）但无任何错误卡片，仅黑色播放器（00:00/00:00）+ 瞬时「Reconnect: N」计数数秒后消失，无明确文案、无重试/降级；截断 PDF 有统一错误卡片（「无法预览此文件 / Invalid PDF structure.」）但卡片内无任何按钮（interactive=[]）；「不阻塞其他 tab」一项现状已达成） |

## 3. 关联缺陷的验收行为

以下 2 条均为报告 §5 中 verified 状态的缺陷。「缺陷现状」为报告证据摘要；「修复后应有行为」作为回归验收依据，仅由报告的期望字段与实测通过部分推导。

### BUG-01 HLS（m3u8）分片被解析为无效 blob: URL 永不起播且静默无提示，.ts 被按代码文本渲染为乱码（MEDIA-04 单点；high · verified）

**缺陷现状**（报告 §5 BUG-01）：

- m3u8 播放列表经 /api/file 正常加载（200，duration=6 已解析），但分片请求全部指向无效 URL `blob:http://127.0.0.1:8391/seg0.ts` 并反复 XHR 重试（20s 内 7+ 次），video readyState 恒 0 永不起播，页面无任何错误卡片/alert；missing-seg.m3u8（分片缺失）同样静默挂起。
- video.ts 无任何视频播放路径（hasVideo=false），直接进入 vv-code 代码容器显示 MPEG-TS 二进制乱码（「G@…FFmpeg Service01…」）。
- 对照 video.flv 正常播放（readyState=4，可播完）。
- curl 证实服务端无问题：m3u8 200/166B、seg0.ts 200/41360B、不存在分片 404——缺陷纯在前端分片 URL 解析层。
- 复核会话 vv-verify-media-office-viewer-MEDIA-04 独立复现（截图 media04-m3u8-stuck.png、media04-ts-as-typescript.png、media04-flv-playing.png）。仲裁维持 high：HLS 这一声明媒体格式完全不可用且静默，ts 完全无播放路径输出乱码（错误结果），不满足可绕过条件。

**修复后应有行为**（回归验收，对应报告期望字段）：

1. video-hls.m3u8 经 hls.js 起播：分片请求指向可达 URL（不再出现指向不存在资源的 `blob:` 伪 URL），video readyState≥3、currentTime 推进、可播完。
2. video.ts 经 mpegts.js 起播，不再落入代码容器渲染二进制乱码。
3. missing-seg.m3u8 等分片不可达场景给出可理解的错误提示，不静默挂起、无死循环重试。
4. 回归护栏：video.flv 播放不回退（readyState=4、可播完）；服务端 `/api/file` 对 m3u8/ts/缺失分片的响应行为不变（200/200/404）。

### BUG-14 媒体类损坏文件无统一错误卡片（仅黑屏+瞬时 Reconnect 计数），文档类错误卡片亦无重试/降级按钮（MEDIA-11 单点；medium · verified）

**缺陷现状**（报告 §5 BUG-14）：

- 截断 mp4（`head -c 3000` 截断真 mp4）：video error code=4（MEDIA_ELEMENT_ERROR: Format error）但无任何错误卡片，仅黑色播放器（00:00/00:00）+ 瞬时「Reconnect: N」计数数秒后消失，无明确文案、无重试/降级。
- 截断 PDF（`head -c 500` 截断真 PDF）：有统一错误卡片（「无法预览此文件 / Invalid PDF structure.」）但卡片内无任何按钮（interactive=[]）。
- 「不阻塞其他 tab」已达成：损坏文件打开后，正常 mp4 打开播放、currentTime 推进。
- curl 证实服务端对损坏内容照常 200 完整返回（accept-ranges bytes），错误纯在浏览器解码层与呈现层。
- 复核自建截断文件（file 确认源为真 MP4/PDF）独立复现，截图 media11 系列 6 张。Reconnect 计数值随时机不同（报告约 4s 后为 5，复核采样 2s 时为 2），核心行为一致。仲裁 medium（正常文件播放可用、可关闭 tab 绕过）。

**修复后应有行为**（回归验收，对应报告期望字段）：

1. 截断/损坏 mp4 出现统一错误卡片（含明确错误信息），不再仅呈现黑屏播放器 + 瞬时 Reconnect 计数。
2. 统一错误卡片内含重试/降级提示（存在可交互按钮，interactive 非空）；截断 PDF 的卡片在保留明确错误信息（如「Invalid PDF structure.」）的基础上补齐该按钮。
3. 回归护栏：损坏文件不阻塞其他 tab（现状已达成，不得回退）。

## 4. 测试数据与边界

### 4.1 服务器启动形态（报告 §2.2）

`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；`/api/health` 返回 `capabilities=["file-server","compute"]`。证据根目录：`.temp/e2e-data/`（数据）、`.temp/e2e-artifacts/media-office-viewer/`（本域截图）、`.temp/e2e-artifacts/verify/`（复核截图，报告 §3.1 约定）。

### 4.2 数据清单

基础数据集位于 `.temp/e2e-data/`（报告 §2.3）；本域另造样例存于 `.temp/e2e-data/domain-<域名>/`（报告 §2.3 末段：「3/6 页 PDF、EXIF rot90 jpg、3s mp4、wav/mp3、HLS 切片、flv/ts、截断 mp4/pdf」等，均经 file(1)/ffprobe/pdfinfo/ghostscript 等独立验证为合法格式）。报告未记录全部文件的具体路径与生成命令，重建时按下列规格核对。

| 文件 | 规格（报告实测值） | 来源 | 用于场景 |
| --- | --- | --- | --- |
| 图片样本（证据名 zoom-test） | 报告未记录路径/扩展名；基础数据集 samples/m1 亦有 pixel.png 可作图片样本 | 域内（截图名 media01-zoom-test-zoomed.png）；pixel.png 见 §2.3 | MEDIA-01 |
| 恶意 SVG | 内联 `<script>`（设置全局探针变量）+ `onload` 事件属性；报告未记录文件名 | 域内 | MEDIA-02 |
| 3s mp4 | ffprobe 验证合法 | 域内另造（§2.3） | MEDIA-03 |
| video-hls.m3u8 + seg0~seg2.ts | 标准 HLS：m3u8 166B（duration=6 已解析）、seg0.ts 41360B，分片与 m3u8 同目录 | 域内另造（§2.3「HLS 切片」；文件名见 BUG-01 证据） | MEDIA-04 |
| missing-seg.m3u8 | 指向不存在分片的播放列表（服务端对不存在分片 404） | 域内另造 | MEDIA-04 |
| video.ts / video.flv | MPEG-TS 文件与 FLV 文件 | 域内另造（§2.3「flv/ts」） | MEDIA-04 |
| mp3 / wav | 音频样例 | 域内另造（§2.3） | MEDIA-05 |
| EXIF rot90 jpg | 写入 EXIF Orientation=6；打开后 natural 200×400（域内实测） | 域内另造（§2.3） | MEDIA-06 |
| 6 页 PDF（另备 3 页 PDF） | pdfinfo 验证合法；3 页 PDF 同时用于 FSEARCH-06（in-file-search 域） | 域内另造（§2.3） | MEDIA-07 |
| docx | samples/m4 之 office 件（§2.3：m4 含 9 件 office/二进制/归档）；源 document.xml 含 4 个 w:t；报告未记录文件名 | 基础数据集 | MEDIA-08 |
| xlsx×2 | ≥2 sheet 件 + 250 行数据件；报告未记录文件名 | 报告未注明路径 | MEDIA-09 |
| pptx | 2 张 slide；报告未记录文件名 | 报告未注明路径 | MEDIA-10 |
| 截断 mp4 | `head -c 3000` 截断真 mp4（源经 file 确认为真 MP4） | 域内另造（BUG-14 复现步骤） | MEDIA-11 |
| 截断 PDF | `head -c 500` 截断真 PDF（源经 file 确认为真 PDF） | 域内另造（BUG-14 复现步骤） | MEDIA-11 |
| 正常 mp4（对照） | 可正常起播推进的 mp4 | 域内另造（BUG-14 复现步骤「正常 mp4」） | MEDIA-11 |

### 4.3 构造与验证方式（报告有据部分转写，报告未记录处如实注明）

1. **截断文件**（BUG-14 步骤）：`head -c 3000 真.mp4 > broken.mp4`、`head -c 500 真.pdf > broken.pdf`；构造前后均以 file(1) 验证（复核确认源为真 MP4/PDF）。
2. **HLS 切片**：m3u8 播放列表与 seg0~seg2.ts 同目录放置（报告实测 duration=6）；missing-seg.m3u8 指向不存在分片，服务端应返回 404（BUG-01 证据）。生成工具报告未记录。
3. **EXIF 方向**：对横向原图写入 Orientation=6（写入工具报告未记录）；验收判据为打开后 natural 200×400。
4. **Office 三件**（docx/xlsx/pptx）：报告未记录生成工具与命令；验收判据以 §2 场景表的对照口径为准（docx 数 w:t、xlsx 数行数与 sheet、pptx 数 slide），重建后先按此自验再进入场景。
5. **通用验证**：全部媒体/PDF/Office 样例经 file(1)/ffprobe/pdfinfo 等独立验证为合法格式（报告 §4 域备注、§2.3）。

### 4.4 边界与注意事项（报告 §3.3 与仲裁备注，如实转写）

1. **偏差 #4（不计缺陷）**：移动端图片双指捏合缩放未实现，仅有滚轮缩放+双击复位，后置裁决维持——MEDIA-01 场景不含捏合断言，回归时也不得以捏合缺失计新缺陷。
2. **域统计口径差异**：MEDIA-04 附录记 partial、域统计计 fail（§8.6 标题括注）；引用本域结果时须注明所用口径。
3. **BUG-01 为全局唯一 high**（报告 §1.2），并列报告 §7.2 修复建议第 1 条（优先修复）；回归本域时以 MEDIA-04 为第一优先。
4. **Reconnect 计数不作断言**（BUG-14 仲裁备注）：计数值随时机不同（报告约 4s 后为 5，复核 2s 时为 2），复现 MEDIA-11 时以「有无错误卡片、有无按钮」为断言，不以具体计数值为断言。
5. **服务端对照排除法**：MEDIA-04/MEDIA-11 的缺陷均在前端层——curl 直打 `/api/file` 可证实服务端正常（HLS：m3u8 200/166B、seg0.ts 200/41360B、不存在分片 404；损坏文件：200 完整返回 + accept-ranges bytes）。复现时先做该对照，避免误判为服务端问题。
6. **MEDIA-07 附带观察**：URL 表单相对路径问题「另记 low 观察」（§8.6 括注），报告无进一步细节，本文档仅如实记录、不展开。
7. **交叉维度归属**：PDF 内搜索（FSEARCH-06）、移动 mp4/全屏（PWA-07）、起播时延（PWA-09）、markdown 媒体链接内联（MD-13）分属其他域场景文档，本域场景不重复覆盖（见第 1 节交叉注记）。
