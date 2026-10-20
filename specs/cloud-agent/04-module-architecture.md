# 04 — 模块架构与解耦边界

> 状态：目标设计（已按实现校准）。父文档：[00-overview.md](./00-overview.md)。

## 1. 模块布局

```text
packages/
  cloud-protocol/          @zcode/cloud-protocol      线协议与共享常量（zod）
  cloud-bridge/            @zcode/cloud-bridge        沙箱侧 bridge（可构建为单文件）
  cloud-control-plane/     @zcode/cloud-control-plane 控制面服务
```

Web 客户端**不新增包**：控制面直接托管仓库既有的 `packages/web` 构建产物
（`packages/web/dist`）。浏览器加载的是原始 ZCode Web，控制面只做鉴权门、任务选择与传输代理。

```text
cloud-control-plane/src/
  domain/           Task / Run / Input 记录类型
  app/              端口 + 用例（供给、输入投递、投影轮询、生命周期）+ DTO
  adapters/
    storage/        SQLite（node:sqlite）+ attach token 加密
    providers/      进程型沙箱驱动（local / fake）与替身 daemon
    tunnel/         反向通道服务端、TunnelDuplex、duplex HTTP/WS 客户端
    zcode/          daemon 客户端（server-info、ChannelClient、本机 daemon）
  channels/         通用 channel 代理
  http/             原始 Web 托管、登录门、任务选择、/ws 与 /api 代理、云 API
  entry/            进程装配
```

```text
cloud-bridge/src/
  config.ts         bootstrap 配置加载与 daemon 参数
  daemon.ts         daemon 启停、ready 判定、token 读取、健康检查
  tunnel.ts         出站 WSS、帧、流多路复用、心跳、重连
  main.ts           --config 入口
```

## 2. 依赖账本

| 包                    | 允许的 `@zcode/*` 依赖                                           | 第三方      | 禁止                                                                                 |
| --------------------- | ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `cloud-protocol`      | 无                                                               | `zod`       | 全部其他 `@zcode/*`                                                                  |
| `cloud-bridge`        | `cloud-protocol`                                                 | `ws`        | `@zcode/shared`、`@zcode/client`、`@zcode/rpc` 及其他业务包                          |
| `cloud-control-plane` | `cloud-protocol`、`@zcode/shared`、`@zcode/client`、`@zcode/rpc` | `ws`、`zod` | `@zcode/server`、`@zcode/services`、`@zcode/desktop`、`@zcode/web`、`apps/zcode-cli` |

补充规则：

- 任何现有 package **不得反向依赖** cloud 包。
- bridge 只依赖 `cloud-protocol` 与 `ws`；它不导入业务包，也不包含任何任务语义。
- 控制面不导入 `@zcode/server/source-server`：该适配器假设客户端主动传输，这里的传输是出站隧道。

## 3. 唯一集成面

| 类别     | 集成点                                                                                                                                                                                                        | 用途                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 发行产物 | `zcode-server` release（stable launcher + runtime）                                                                                                                                                           | 沙箱 daemon           |
| 发行产物 | `packages/web/dist`（未修改）                                                                                                                                                                                 | 浏览器 UI             |
| 环境变量 | `ZCODE_DATA_BASE_DIR`、`ZCODE_SERVER_WORKSPACE`、`ZCODE_SERVER_SKIP_SERVICE_REGISTRATION`                                                                                                                     | daemon 启动           |
| HTTP     | `GET /api/server-info`、`GET /api/rpc-host-capability`                                                                                                                                                        | 握手与初始 workspace  |
| WS       | `/ws`、`/ws/host`                                                                                                                                                                                             | 原始 Web 的 RPC 通道  |
| 认证     | ingress token（`run/ingress-token`）                                                                                                                                                                          | daemon 请求鉴权       |
| RPC 通道 | `zcode-agent`、`zcode-session`、`zcode-task`、`file`、`file-watcher`、`git`、`git-checkpoint`、`terminal`、`system`、`media-preview`、`prompt-attachment-transfer`、`project`、`provider-provisioning-target` | 执行域与 provisioning |
| 包       | `@zcode/shared`（`serverRemoteInfoSchema`、identity 工具）                                                                                                                                                    | 线协议校验与身份构造  |
| 包       | `@zcode/client`（`connectViaWebSocket`、`RemoteServiceAccess`）、`@zcode/rpc`（`SocketProtocol`、`ChannelClient`、`ChannelServer`、`Emitter`、`VSBuffer`）                                                    | RPC 客户端与服务端    |

## 4. 主仓改动预算

| 文件                       | 改动                                                                                    | 说明                                   |
| -------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `pnpm-workspace.yaml`      | 无                                                                                      | `packages/*` 已覆盖新包                |
| `package.json`             | 新增 `dev:cloud`、`dev:cloud:web`、`build:cloud`、`test:cloud`；`typecheck` 追加 3 个包 | 仅追加                                 |
| `architecture-policy.yaml` | 新增 3 个 managed 模块（单层 `app: "."`）                                               | 仅追加                                 |
| 现有源码                   | 无修改                                                                                  | 浏览器 UI 直接复用 `packages/web` 构建 |

## 5. 边界执行

`packages/cloud-control-plane/test/boundary.test.ts`：

1. 断言三个包的 `dependencies` 只包含允许项。
2. 扫描 `src/**/*.ts` 的 import，禁止 `@zcode/server|services|desktop|web|zcode-cli|zcode-server-cli`。
3. 断言 bridge 不导入 `cloud-protocol` 以外的 `@zcode/*`。

该测试进入 `pnpm test:cloud`。

## 6. 构建与部署

| 产物          | 构建                                                        | 说明                   |
| ------------- | ----------------------------------------------------------- | ---------------------- |
| control plane | `tsc` / `tsx`（开发）                                       | Node 24                |
| bridge        | `pnpm --filter @zcode/cloud-bridge build`（esbuild bundle） | 注入沙箱模板           |
| web           | `pnpm --filter @zcode/web build`                            | 原构建，未修改         |
| 沙箱模板      | 云侧镜像构建（release + bridge + git）                      | 每个 provider 各自构建 |

控制面环境变量：

```text
CLOUD_DATA_DIR              # SQLite、附件、密钥
CLOUD_ACCESS_TOKEN          # 浏览器部署级 token（/login 使用）
CLOUD_PUBLIC_URL            # bridge attach 公网地址
CLOUD_WEB_DIST_DIR          # 默认 packages/web/dist
CLOUD_PROVIDERS             # fake | local
CLOUD_DEFAULT_PROVIDER
ZCODE_SERVER_BIN            # local provider 的 server-cli 入口
```

## 7. 拆仓提取路径

满足以下条件后可整体迁移到独立仓库：

1. `@zcode/shared`、`@zcode/client`、`@zcode/rpc` 可发布或厂商化；
2. `zcode-server` release 与 `packages/web` 构建产物有稳定分发；
3. 控制面不再依赖 workspace 级 TS 路径（当前已是：只依赖公开入口）。

## 8. 验收

1. 边界测试通过（禁止依赖为零）。
2. `pnpm typecheck` 覆盖三个新包。
3. `pnpm lint` 新包零 error。
4. `pnpm architecture:check --changed` 零新增违规。
