#!/bin/sh
# supervisor 启动入口（specs/cloud-agent/01 §6.2 实施决议；三家 provider 共用同一脚本）。
#
# 由控制面在 create 成功后经 provider 原生命令会话通道调用（E2B envd 命令 / Daytona
# toolbox 会话 / Modal SDK exec），自举要素经 env 下发，绝不进命令行参数。
#
# 1) flock 单例：控制面重试/重启会重复调用本脚本，重复执行必须无副作用（幂等）。
#    先取锁再校验环境：已有实例在跑时直接成功返回，绝不因为重试参数不全而把健康沙箱
#    判成失败（那会触发控制面的补偿终止）。
# 2) 物化 **SSH 同构部署布局**（07 §2.7；remote/deployShared.ts 的 REMOTE_BASE =
#    ~/.zcode/server）：与 SSH 远端 deploy 之后的布局完全一致，runtime 启动命令同形。
#    已存在则跳过；缺产物 fail-closed（不以残缺布局启动）。
# 3) exec 常驻 supervisor bundle（自举 env 原样继承）。
set -eu

exec 9>/tmp/zcode-supervisor.lock
flock -n 9 || {
  # 已有实例持有锁：本次调用是重试/重复下发，视为成功（01 §6.2 flock 幂等）。
  echo "zcode supervisor already running; nothing to do" >&2
  exit 0
}

# 自举要素（env 名与 sandboxSupervisorStart.ts 的 SUPERVISOR_START_ENV_NAMES 一致）。
: "${ZCODE_CLOUD_PUBLIC_ORIGIN:?bootstrap env missing: ZCODE_CLOUD_PUBLIC_ORIGIN}"
: "${ZCODE_CLOUD_RUN_ID:?bootstrap env missing: ZCODE_CLOUD_RUN_ID}"
: "${ZCODE_CLOUD_RUN_GENERATION:?bootstrap env missing: ZCODE_CLOUD_RUN_GENERATION}"
: "${ZCODE_CLOUD_BOOTSTRAP_TICKET:?bootstrap env missing: ZCODE_CLOUD_BOOTSTRAP_TICKET}"

layout_root="${HOME:?HOME is not set}/.zcode/server"
if [ ! -f "$layout_root/zcode-server.cjs" ] || [ ! -x "$layout_root/agents/glm/zcode-agent" ]; then
  mkdir -p "$layout_root/agents/glm"
  # node：复用镜像内 node（部署根内的 node），与 SSH 布局一致。
  ln -sf "$(command -v node)" "$layout_root/node"
  cp -f /opt/zcode/zcode-server.cjs "$layout_root/zcode-server.cjs"
  cp -f /opt/zcode/zcode-cli.cjs "$layout_root/agents/glm/zcode.cjs"
  # wrapper 文本与 packages/server/src/remote/zcodeAgentBundleWrapper.ts 保持一致
  # （buildRemoteAgentBundleWrapper("glm")）。
  cat > "$layout_root/agents/glm/zcode-agent" <<'ZCODE_AGENT_WRAPPER'
#!/bin/sh
set -eu
runtime_root="${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}"
exec "$runtime_root/node" "$HOME/.zcode/server/agents/glm/zcode.cjs" "$@"
ZCODE_AGENT_WRAPPER
  chmod 0755 "$layout_root/agents/glm/zcode-agent"
fi

exec node /opt/zcode/supervisor.bundle.mjs
