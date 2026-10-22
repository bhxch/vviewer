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
  if [ -n "${WRANGLER_PID:-}" ]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    # npx→wrangler→workerd 链：kill 父不保证子回收，补进程树 TERM 防残留占口
    pkill -TERM -P "$WRANGLER_PID" 2>/dev/null || true
  fi
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
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "probe: FAIL——worker dev 60s 未就绪"
  exit 1
fi

# Content-Length: 0 形态：-X POST 无 -d（无 body），显式零长头
code=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X POST \
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
