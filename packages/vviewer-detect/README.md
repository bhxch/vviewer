# @bhxch/vviewer-detect

文件级判别纯函数层：扩展名提取、magic 签名嗅探、文本性判定、shebang 语言识别、
BOM+编码检测链与 chardet 精判。纯函数、零 DOM 依赖，唯一第三方依赖为
[chardet](https://www.npmjs.com/package/chardet)，浏览器 / Node 双形态可用。
vviewer 格式派发器（`@bhxch/vviewer-core`）的判别底座，亦可独立用于任何需要
「这个文件是什么」判定的场景。

## 安装

```bash
npm install @bhxch/vviewer-detect
```

## 使用

```ts
import { detect, refineEncoding } from '@bhxch/vviewer-detect';

const head = bytes.slice(0, 4096);                  // 头部窗口（签名/编码链判定面）
const det = detect({ name: 'sample.bin', head });   // → BaseDetection
await refineEncoding(bytes, det);                   // 可选：chardet 精判，就地改写 det.encoding
```

`BaseDetection` 字段：`ext`（小写无点扩展名，签名纠偏后为规范扩展名）、`lang?`
（helix 名，无扩展名时回退链写入 shebang 语言）、`encoding?`（BOM/编码链结果）、
`binary?`（magic 或编码检测判定）、`signature?`（20 值 magic 枚举：zip/png/jpeg/
mp4/webp/gz/7z/rar/flac/ogg/bmp 等，null=无命中）。

## 导出面

- 总入口：`detect({ name, head, full? })`
- 分件（总入口各阶段皆可单独使用）：
  - `extractExtension(name)` —— 扩展名提取（小写无点）
  - `sniffSignature(head)` —— magic 签名嗅探（20 值枚举）
  - `looksTextual(head)` —— 文本性判定
  - `shebangLangOf(text)` —— shebang → 语言（helix 名）
  - `detectEncoding(bytes)` / `isStrictUtf8(b)` —— BOM+编码检测链
  - `refineEncoding(bytes, det)` —— chardet 精判（置信度+白名单双闸，仅收窄
    严格 UTF-8 失败的文本，映射外维持 gb18030）
- 类型与运行时值：`Encoding`（28 值联合类型，由运行时常量 `ENCODING_VALUES`
  单源派生——「全量编码值清单」消费方直接 import 该数组，扩列不再漏跟）、
  `BaseDetection`

## 仓库与许可

- 仓库：[bhxch/vviewer](https://github.com/bhxch/vviewer)，源码位于 `packages/vviewer-detect/`
- 许可：Apache-2.0；第三方依赖（chardet）许可见仓库 `THIRD_PARTY_NOTICES.md`
