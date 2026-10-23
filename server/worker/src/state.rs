//! isolate 级状态装配：env（vars/secrets）→ VV_MOUNTS JSON → 静态挂载根 →
//! [`CoreState::mounts_only`]（无 fs 根不变式）+ 注入 wasm transport。
//!
//! 装配时机：首个请求惰性 init（Workers isolate 无启动钩子语义——#[event]
//! start 需要额外接线，惰性装配同样满足「每 isolate 一次」：env 在 isolate
//! 生命周期内不变，并发首请求各自构建后 OnceLock 单胜者，配置纯函数确定性
//! 重复构建等价）。运行时挂载容器/ticket 等可变态随 CoreState 常驻 isolate。

use std::sync::{Arc, OnceLock};

use worker::Env;

use vviewer_core::mounts::{build_mount, MountConfig};
use vviewer_core::state::{CoreState, RootSpec};
use vviewer_storage::transport::HttpTransport;

use crate::mounts::parse_mounts_json;
use crate::transport::FetchTransport;

/// worker 适配层状态：业务核 + base-path 装配。
pub struct WorkerState {
    pub core: CoreState,
    /// VV_BASE_PATH env（如 `/docs`；空串 = 不裁剪）。dispatch 入口先剥
    /// 前缀再路由（base-path 部署的 /<base>/api/* 请求归位）。
    pub base_path: String,
    /// kroki 转发域状态（spec 2026-10-23 §8.2）：host 来自 VV_KROKI_HOST
    /// （部署侧配置——SSRF 防线，缺省 `DEFAULT_KROKI_HOST`，显式无效值装配期
    /// 失败关闭），http 接缝为 binding fetch 实现（`FetchKrokiHttp`）。
    pub kroki: vviewer_core::kroki::KrokiState,
}

static STATE: OnceLock<WorkerState> = OnceLock::new();

/// env 读取：var 优先，secret 兜底——**凭据走 Wrangler Secrets 纪律**
/// （plan Global Constraints）：`VV_MOUNTS`/`VV_TOKEN` 整体含凭据时按
/// Secret 配置即可，读取通道对装配面透明。
fn env_string(env: &Env, name: &str) -> worker::Result<Option<String>> {
    if let Ok(v) = env.var(name) {
        return Ok(Some(v.to_string()));
    }
    if let Ok(s) = env.secret(name) {
        return Ok(Some(s.to_string()));
    }
    Ok(None)
}

/// isolate 单例取用（首请求惰性装配；配置错误 → Err——对外响应由 entry
/// 通用化为 500（M-3），Err 消息仅进 console，字段级字面不出访客可见面）。
pub fn init(env: &Env) -> Result<&'static WorkerState, String> {
    if let Some(state) = STATE.get() {
        return Ok(state);
    }
    let built = build_from_env(env)?;
    let _ = STATE.set(built);
    Ok(STATE.get().expect("state just set"))
}

fn build_from_env(env: &Env) -> Result<WorkerState, String> {
    let env_str = |name: &str| {
        env_string(env, name).map_err(|e| format!("{name}: {e}"))
    };

    // wasm transport 注入（终审 I-1 的消费面）：裁剪形态无 reqwest，运行时
    // 挂载注册与静态装配共用同一 transport
    let transport: Arc<dyn HttpTransport> = Arc::new(FetchTransport);

    // VV_MOUNTS → 静态挂载根（装配序 = rootIndex 序，从 0 起——无 fs 根）
    let mounts_json = env_str("VV_MOUNTS")?.unwrap_or_default();
    let configs: Vec<MountConfig> = parse_mounts_json(&mounts_json)?;
    let mut roots = Vec::with_capacity(configs.len());
    for cfg in &configs {
        let root = build_mount(cfg, transport.clone())
            .map_err(|msg| format!("VV_MOUNTS: {msg}"))?;
        roots.push(RootSpec::mount(root.meta, root.backend));
    }

    // VV_TOKEN fail-closed（终审 I-1）：Workers 公网可达，无 token ≈ 误配置
    // ——装配期拒绝而非 authorize 静默全放行（决策面 crate::env::require_token，
    // 错误消息指引 `wrangler secret put VV_TOKEN`）
    let token = crate::env::require_token(env_str("VV_TOKEN")?)?;
    let mut core = CoreState::mounts_only(roots, Some(token))
        // 运行时注册（POST /api/mounts）的 transport 注入（终审 I-1 的
        // with_transport 消费面——裁剪形态无 reqwest 懒构造，不注入即配置
        // 错误；静态装配与运行时注册共享同一 FetchTransport）
        .with_transport(transport);
    // health.version 宣告随适配层 crate（native 形态注入主 crate 版本的
    // 同一缝，见 native AppState::new）
    core.version = env!("CARGO_PKG_VERSION");

    let base_path = env_str("VV_BASE_PATH")?.unwrap_or_default();

    // VV_KROKI_HOST（spec 2026-10-23 §8.2）：上游 host 只来自部署侧配置——
    // 缺省 `DEFAULT_KROKI_HOST`，显式无效值（空白/非 http(s)://）装配期失败
    // 关闭（crate::env::resolve_kroki_host，fail-closed 先例 = VV_TOKEN I-1）；
    // http 接缝为 binding fetch 实现（native ReqwestKrokiHttp 的对应物）
    let kroki = vviewer_core::kroki::KrokiState {
        host: crate::env::resolve_kroki_host(env_str("VV_KROKI_HOST")?)?,
        http: Arc::new(crate::kroki::FetchKrokiHttp),
    };
    Ok(WorkerState { core, base_path, kroki })
}
