# 沙箱模板资产（W3）

specs/cloud-agent/01 §6.1/§6.2、07 §2.7 的模板资产：预装 Node 24、git、CA 证书、
supervisor/runtime bundle 与真实 zcode-server / Agent CLI 产物；不自带 repo、用户设置、
App key、模型凭据、MCP token 或登录缓存。

沙箱内运行期布局与 SSH 远端部署**同构**（`remote/deployShared.ts` 的
`REMOTE_BASE = ~/.zcode/server`），由 `start-supervisor.sh` 在启动时幂等物化：

```
$HOME/.zcode/server/
  node                  → 镜像 node（部署根内的 node）
  zcode-server.cjs      → packages/server build:remote 单文件 bundle（stdio RPC 服务端）
  agents/glm/zcode.cjs  → Agent CLI bundle（app-server --stdio）
  agents/glm/zcode-agent→ wrapper（与 remote/zcodeAgentBundleWrapper.ts 同文）
```

supervisor 以 `<root>/node <root>/zcode-server.cjs` + `ZCODE_SERVER_RUNTIME_ROOT`
启动 runtime，与 SSH 启动命令同形（交互同构）。模型配置经 Provider Provisioning 在
run 开始时安装（01 §7.1），不在镜像内。

## 文件

| 文件                    | 说明                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `start-supervisor.sh`   | flock 单例 + SSH 同构布局物化 + exec supervisor bundle（0755，三家共用） |
| `start.sh`              | 模板 `start_cmd` 常驻占位（构建期启动进程拿不到运行时 env）              |
| `e2b.Dockerfile`        | E2B 模板镜像（产物 staging 到 /opt/zcode）                               |
| `e2b.toml`              | E2B 模板定义（template_id / 资源 / start_cmd）                           |
| `modal.Dockerfile`      | Modal 镜像（Modal 端构建；CMD 必须常驻）                                 |
| `daytona.snapshot.json` | Daytona 快照定义（资源、create 载荷参考、语义边界）                      |

## 构建与发布（真实命令）

前置：仓库根执行构建，产物复制到构建上下文目录（`dist/` 与 bundle 产物不入库）。

```bash
# 1. supervisor / runtime stub bundle + 版本摘要清单（assets/dist/manifest.json）
#    默认入口由 cloud-execution（W6）提供：supervisorMain.ts / runtimeStub.ts。
pnpm --filter @zcode/server build:sandbox-assets

# 2. runtime 产物（既有构建，不在本模块重建）
pnpm --filter @zcode/server build:remote        # packages/server/dist/remote/zcode-server.cjs
pnpm --dir apps/zcode-cli/packages/cli build    # dist/zcode.cjs、dist/provider/zcode-builtin.json

# 3. 组装模板构建上下文（仓库外，避免产物被源码检查扫描）
BUILD_DIR=/tmp/zcode-template-build
rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR/provider"
cp packages/server/src/cloud/adapters/sandbox/templates/{e2b.Dockerfile,e2b.toml,start.sh,start-supervisor.sh} "$BUILD_DIR/"
cp packages/server/src/cloud/adapters/sandbox/assets/dist/*.mjs "$BUILD_DIR/"
cp packages/server/dist/remote/zcode-server.cjs "$BUILD_DIR/"
cp apps/zcode-cli/packages/cli/dist/zcode.cjs "$BUILD_DIR/zcode-cli.cjs"
cp apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json "$BUILD_DIR/provider/"

# 4a. E2B：在构建上下文目录执行模板构建（需要 E2B_API_KEY）。
#     实测 @e2b/cli v2 已无 `template build`：用 `template create <name>`，且 **必须同时**
#     给 --cmd 与 --ready-cmd（只给一个会报 "Both start and ready commands must be provided."）；
#     资源与 start_cmd 与 e2b.toml 保持一致（改名重跑即更新同名模板）。
cd "$BUILD_DIR" && npx @e2b/cli template create zcode-sandbox-template \
  --dockerfile e2b.Dockerfile \
  --cmd "/opt/zcode/start.sh" \
  --ready-cmd "echo ready" \
  --cpu-count 2 --memory-mb 4096

# 4b. Modal：把部署配置的 modalImageDockerfile 指向 templates/modal.Dockerfile，
#     桥在 create 时经官方 SDK 在 Modal 端构建（本机无需 docker）。

# 4c. Daytona：按 daytona.snapshot.json 建快照（dashboard/API），再把部署配置的
#     ZCODE_CLOUD_SANDBOX_TEMPLATE_REF 指向该快照（形如 daytona:zcode-sandbox-template）。
```

## 模板就绪检查

- supervisor 的**运行状态目录**是 `~/.zcode/run`（HOME 下，由 supervisor 启动时自建 0700）：
  镜像**不再预建** `/run/zcode-bridge`（旧路径已废弃），模板重建后生效。
- `assets/dist/manifest.json` 含 `supervisor.bundle.mjs` / `runtimeStub.bundle.mjs`
  的 sha256 与字节数（分发端点按它校验，失败不回退未校验旧包）。
- `start-supervisor.sh` 与 `/opt/zcode/start.sh` 在镜像内为 0755。
- 镜像 CMD 常驻（空转占位）；真实 supervisor 由控制面在 create 成功后经 provider
  命令通道拉起，自举要素与非秘密 run 地址只经 env（`ZCODE_CLOUD_PUBLIC_ORIGIN` /
  `ZCODE_CLOUD_RUN_ID` / `ZCODE_CLOUD_RUN_GENERATION` / `ZCODE_CLOUD_BOOTSTRAP_TICKET` /
  `ZCODE_CLOUD_OPERATION_KEY` / `ZCODE_CLOUD_TASK_ID` / `ZCODE_CLOUD_WORKSPACE_PATH`）；
  凭据不由 env 下发（只走 bridge 的 `bootstrap.config`，02 §4）。
- 上线后把部署配置的 `ZCODE_CLOUD_SANDBOX_TEMPLATE_REF`（`provider:ref`，多家逗号分隔）
  指向模板（保持版本固定，禁止 latest）。**接纳期会把该 ref 冻结进 Run recipe**
  （`imageDigest` + `templateVersion`），因此部署默认值变化只影响新任务，在跑的 Run 不换模板。
- 语义边界（与入口解析一致）：**未配置该键不是错误**，只表示不提供默认模板——请求又没带
  ref 时在**接纳期**拒绝（`unsupported_template` / `template-unresolved`）；客户端请求里的
  `start.templateRef` 与部署固定值**不一致会被拒绝**（warn + null），不能借它自选镜像绕过
  部署控制。
