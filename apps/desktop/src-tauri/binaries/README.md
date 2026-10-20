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

Windows（PowerShell；externalBin 在 Windows 要求文件名为 `<name>-<triple>.exe`
带后缀形态，缺 .exe 打包与 dev 解析均失败）：

```powershell
cp server/target/release/vviewer.exe `
   apps/desktop/src-tauri/binaries/vviewer-server-$(rustc --print host-tuple).exe
```

该目录内容已 gitignore（构建产物不入库）；CI（Task 3 desktop matrix）在打包前
执行同样的「构建 server → 复制为 triple 命名」步骤（Windows 同带 .exe 后缀）。

## 运行期解析（壳侧 main.rs）

壳不用 tauri-plugin-shell，直接 `std::process::Command` spawn，按序探测
（Windows 全形态追加 `.exe`）：

1. `<主程序所在目录>/vviewer-server`——手动布局兜底（bundler 对 externalBin
   实际保留 triple 命名 + 平台扩展名，即候选②；本裸名 bundler 不产出，仅为
   手动拷贝形态容错）；
2. `<主程序所在目录>/vviewer-server-<triple>`——release 打包形态（externalBin
   落盘保留 triple 命名与平台扩展名，置于主程序同目录，deb/AppImage/NSIS/dmg
   一致；Windows 为 `vviewer-server-<triple>.exe`）；
3. `<CARGO_MANIFEST_DIR>/binaries/vviewer-server-<triple>`——dev 形态
   （`pnpm tauri dev` / `cargo run`；Windows 带 .exe）。

全部落空 → 原生错误窗（含「重启服务」按钮）。
