# binaries/ — server sidecar 落位目录

`tauri.conf.json > bundle > externalBin` 声明了 `binaries/vviewer-server`。
按 Tauri externalBin 约定，**打包与本地 `tauri dev` 都要求本目录存在带
target-triple 后缀的同名二进制**：

```
binaries/vviewer-server-<target-triple>
```

triple 查询：`rustc --print host-tuple`（Rust ≥ 1.84，旧版用 `rustc -Vv` 的 host 字段）。

## 本地开发（放入二进制）

```sh
# 1. 构建 server
cargo build --release --manifest-path server/Cargo.toml
# 2. 复制为 sidecar 命名（triple 以本机为准）
cp server/target/release/vviewer \
   apps/desktop/src-tauri/binaries/vviewer-server-$(rustc --print host-tuple)
```

该目录内容已 gitignore（构建产物不入库）；CI（Task 3 desktop matrix）在打包前
执行同样的「构建 server → 复制为 triple 命名」步骤。

## 运行期解析（壳侧 main.rs）

壳不用 tauri-plugin-shell，直接 `std::process::Command` spawn，按序探测：

1. `<主程序所在目录>/vviewer-server`——release 打包形态（bundler 去掉 triple
   后缀、置于主程序同目录，deb/AppImage/NSIS/dmg 一致）；
2. `<主程序所在目录>/vviewer-server-<triple>`；
3. `<CARGO_MANIFEST_DIR>/binaries/vviewer-server-<triple>`——dev 形态
   （`pnpm tauri dev` / `cargo run`）。

全部落空 → 原生错误窗（含「重启服务」按钮）。
