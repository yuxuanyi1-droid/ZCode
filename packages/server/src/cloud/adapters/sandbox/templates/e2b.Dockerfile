# ZCode 云沙箱镜像（E2B 模板；specs/cloud-agent/01 §6.1/§6.2、07 §2.7）。
#
# 镜像只装运行所需：Node 24（mise.toml 口径）、git、CA 证书，以及自举产物
# （supervisor bundle / runtime stub / zcode-server / Agent CLI）。**不含** repo、
# 用户设置、App key、模型凭据、MCP token 或登录缓存（01 §6.1）。
#
# 运行期布局：start-supervisor.sh 把产物幂等物化成 SSH 同构部署布局
# （remote/deployShared.ts 的 REMOTE_BASE = ~/.zcode/server）：
#   $HOME/.zcode/server/node                   ← 镜像 node（部署根内的 node）
#   $HOME/.zcode/server/zcode-server.cjs       ← packages/server build:remote 单文件 bundle
#   $HOME/.zcode/server/agents/glm/zcode.cjs   ← Agent CLI bundle
#   $HOME/.zcode/server/agents/glm/zcode-agent ← wrapper（与 buildRemoteAgentBundleWrapper 同文）
# supervisor 以 `<root>/node <root>/zcode-server.cjs` + ZCODE_SERVER_RUNTIME_ROOT 启动
# runtime，与 SSH 启动命令同形（interactive 同构，07 §2.7）。
#
# 自举：CMD 只是常驻占位——start_cmd 是构建期启动、随快照恢复的进程，拿不到运行时
# env（01 §6.2 实测结论）。真实 supervisor 由控制面经 E2B envd 命令通道拉起
# /opt/zcode/start-supervisor.sh，自举要素（ZCODE_CLOUD_PUBLIC_ORIGIN / RUN_ID /
# RUN_GENERATION / BOOTSTRAP_TICKET / OPERATION_KEY）只经 env 注入。
#
# 构建（仓库根；详见 templates/README.md）：
#   pnpm --filter @zcode/server build:sandbox-assets     # 产出 bundle + manifest.json
#   pnpm --filter @zcode/server build:remote             # 产出 dist/remote/zcode-server.cjs
#   pnpm --dir apps/zcode-cli/packages/cli build         # 产出 dist/zcode.cjs
#   把上述产物复制到构建上下文后再执行 E2B CLI 的 template build（见 e2b.toml）。
FROM node:24-slim

# ca-certificates：出站 WSS（回连控制面）与模型 API 调用必须；git：仓库操作必须。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# 自举产物 staging（构建上下文由 templates/README.md 的步骤组装；dist/ 不入库）。
COPY start.sh /opt/zcode/start.sh
COPY start-supervisor.sh /opt/zcode/start-supervisor.sh
COPY supervisor.bundle.mjs /opt/zcode/supervisor.bundle.mjs
COPY runtimeStub.bundle.mjs /opt/zcode/runtimeStub.bundle.mjs
COPY zcode-server.cjs /opt/zcode/zcode-server.cjs
COPY zcode-cli.cjs /opt/zcode/zcode-cli.cjs
COPY provider/zcode-builtin.json /opt/zcode/provider/zcode-builtin.json

# 运行期目录：模板启动入口必须可执行；沙箱内运行用户非 root，workspace 需可写
# （缺写权限会在建 workspace 时 EACCES 直接 bootstrap 失败）。supervisor 的**运行状态
# 目录由它自建**（`~/.zcode/run`，在 HOME 下、0700），模板不再预建 /run 下的目录。
RUN chmod 0755 /opt/zcode/start.sh /opt/zcode/start-supervisor.sh \
  && mkdir -p /workspace \
  && chmod 0777 /workspace

# CMD（非 ENTRYPOINT）：不覆盖 provider 的 init 进程；start_supervisor.sh 由控制面
# 经命令通道另行拉起，本进程只负责让沙箱保持存活到 create timeout。
CMD ["/opt/zcode/start.sh"]
