// Tauri 构建钩子：编译期校验 tauri.conf.json、注入窗口图标等资源。
// 顺带把 TARGET triple 烧进编译期环境——sidecar 文件名遵循 externalBin 的
// `vviewer-server-<target-triple>` 约定，运行期 env! 取用拼接候选路径。
fn main() {
    tauri_build::build();
    println!(
        "cargo::rustc-env=VV_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("cargo 必为 build script 提供 TARGET")
    );
}
