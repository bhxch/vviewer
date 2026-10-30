//! 装配链 lib 面冒烟（装配可测化新增，只加不改）：config 解析合并 → assembly
//! 启动校验 → AppState/build_router 装配的快路径集成锚——不起进程、不 bind，
//! 经 lib 面直达 serve() 消费的同一批装配入口（bin 内嵌单测外移后的补充层，
//! 与 e2e-server 真二进制面互补）。

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use vviewer::assembly::{self, ServeArgs};
use vviewer::config::{FileConfig, resolve_config};
use vviewer::state::AppState;

/// CLI 侧全缺省形态（文件补默认值的合并先例面）。
fn cli_args(root: std::path::PathBuf) -> ServeArgs {
    ServeArgs {
        root: vec![root],
        web_dist: None,
        port: None,
        emit_ready_line: false,
        token: None,
        token_gen: false,
        allow_lan: false,
        hidden: false,
        cors_origin: None,
        compute: false,
        log_file: None,
        kroki_host: None,
    }
}

async fn oneshot(app: axum::Router, req: Request<Body>) -> StatusCode {
    app.oneshot(req).await.unwrap().status()
}

/// token 部署经装配链落 Bearer 门：文件 token 补 CLI 缺省（resolve_config）→
/// 合并产物过启动校验（assembly::validate_startup）→ serve() 同款 builder 面
/// 装配 Router——保护面无凭证 401/带 Bearer 200，豁免面（health）免认证。
#[tokio::test]
async fn token_deployment_assembles_auth_gate_via_lib_face() {
    let dir = tempfile::tempdir().unwrap();
    let file = FileConfig { token: Some("sekret".into()), ..Default::default() };
    let resolved = resolve_config(cli_args(dir.path().to_path_buf()), Some(file)).unwrap();
    assert_eq!(resolved.token.as_deref(), Some("sekret"), "文件 token 补 CLI 缺省");

    // serve() 同链：合并产物 → ServeArgs → 启动校验（root 已是真实目录，应过）
    let args: ServeArgs = resolved.into();
    let token = args.token.clone();
    assembly::validate_startup(&args, token.as_deref()).expect("token 部署应过启动校验");

    // serve() 同款装配：AppState::new + with_roots + build_router
    let state = AppState::new(
        args.root[0].clone(),
        args.web_dist.clone(),
        token,
        args.hidden,
        args.cors_origin.clone(),
    )
    .with_roots(args.root.clone())
    .with_compute(args.compute);
    let app = vviewer::build_router(state);

    // 豁免面：health 免认证
    assert_eq!(
        oneshot(app.clone(), Request::builder().uri("/api/health").body(Body::empty()).unwrap())
            .await,
        StatusCode::OK
    );
    // 保护面：无凭证 401；Bearer 通过
    assert_eq!(
        oneshot(app.clone(), Request::builder().uri("/api/tree").body(Body::empty()).unwrap())
            .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        oneshot(
            app,
            Request::builder()
                .uri("/api/tree")
                .header("authorization", "Bearer sekret")
                .body(Body::empty())
                .unwrap()
        )
        .await,
        StatusCode::OK
    );
}

/// --compute 旗标经装配链决定 compute 路由挂载与 health 能力宣告：未启用
/// 路径不存在（统一 JSON 404）；启用后 /api/compute/* 可达且 capabilities
/// 追加 "compute"（native 门控与 tests/health.rs 先例同款——裁剪形态编译期
/// 不存在，双形态门禁由 cargo check --no-default-features 锚）。
#[cfg(feature = "native")]
#[tokio::test]
async fn compute_flag_assembles_compute_routes_and_capability() {
    let dir = tempfile::tempdir().unwrap();
    let state = |compute| {
        AppState::new(dir.path().to_path_buf(), None, None, false, None).with_compute(compute)
    };

    // 未启用：路径不存在（统一 JSON 404）
    let plain = vviewer::build_router(state(false));
    assert_eq!(
        oneshot(
            plain,
            Request::builder()
                .method("POST")
                .uri("/api/compute/markdown")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"*hi*"}"#))
                .unwrap()
        )
        .await,
        StatusCode::NOT_FOUND
    );

    // 启用：路由挂载（200）+ health capabilities 追加 "compute"
    let compute_on = vviewer::build_router(state(true));
    assert_eq!(
        oneshot(
            compute_on.clone(),
            Request::builder()
                .method("POST")
                .uri("/api/compute/markdown")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"*hi*"}"#))
                .unwrap()
        )
        .await,
        StatusCode::OK
    );
    let res = compute_on
        .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let caps = json["capabilities"].as_array().unwrap();
    assert!(caps.iter().any(|c| c == "compute"), "caps={caps:?}");
}
