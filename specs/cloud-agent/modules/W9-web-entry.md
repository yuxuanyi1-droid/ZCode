# W9 — web-entry（Web 入口与平台适配）

状态：目标设计。归属：`packages/web/src/cloud`、`packages/web/src/webPlatform.ts`、`packages/web/src/main.tsx`（模式分派）。
前置：[W5](./W5-cloud-entry.md)、[W7](./W7-client-sdk.md)。

## 1. 范围

做：Web 客户端的**模式探测**（启动时问服务端，不再由客户端显式声明，见 [04 §2.1](../04-web-client.md)）、同源 origin 与 token 通道、cloud boot 流程与启动错误呈现、OAuth/分享回调路由、把 host accessor 与 cloud providers 组合进原 `Root`、`IPlatformService` 的 Web 适配。
不做：UI 组件与 hooks（[W8](./W8-ui-cloud.md)）；服务端静态托管（[W5](./W5-cloud-entry.md)）；账号域实现。

## 2. 冻结依赖

- [04 §1/§2/§4/§6/§8](../04-web-client.md)（基线、产品入口与模式、服务落点、API 映射、阶段与回退）
- [12 §4/§5](../12-account-domain.md)（host `/ws` 为 base accessor，`?token=` 放行）
- [03 §7.1](../03-control-plane.md)（两通道分面）
- `packages/shared/src/platform.ts`（`IPlatformService` 契约，不得绕过）

## 3. 交付物

```text
packages/web/src/cloud/
  cloudBoot.ts                 GET /api/cloud/capabilities 同源探测（不带凭据）、模式计划与启动错误分类
  cloudApp.tsx                 host accessor + CloudServices/CloudWorkspace providers + 原 Root 挂载
  CloudTokenGate.tsx           探测被 401/403 拒绝时的凭据门（?token= 作为传入通道）
  CloudBootstrapErrorScreen.tsx 启动失败的可操作错误面（探测不确定一律停在这里）
packages/web/src/webPlatform.ts   IPlatformService 的 Web 实现（无桌面能力时显式不可用）
packages/web/src/main.tsx         模式分派：探测得 cloud → cloudApp；local → 原路径（含 ?remote=）
```

## 4. 对外接口

- 入口契约（2026-10-07 修订，[04 §2.1](../04-web-client.md)）：mode 由**服务端**回答——启动时 `GET /api/cloud/capabilities`（同源、不带 `token`）；`200 mode=cloud` → 云壳，`401/403` → 云壳 + 凭据门，`200 mode=local` → 原本地 Web 路径（`?remote=` 语义不变），其余（404/5xx/网络失败/非法响应体）→ 错误屏且**不得回落本机**。
- 作废：`?mode=`、`VITE_ZCODE_CLOUD_MODE`/`VITE_ZCODE_SERVER_MODE`、`VITE_ZCODE_CLOUD_ORIGIN` 与 origin 一致性校验；同源地址一律在运行时由 `window.location.origin` 拼装。
- `?task=` 深链仍校验为合法 cloud task id；`?token=` 仍是部署链接的凭据通道（只在探测被拒后的门里发起一次同源握手，不进 URL 之外的位置、不落盘）。
- 平台契约：所有原生能力经 `IPlatformService`；不得直接调 `window.zcode`

## 5. 边界与禁止

- 不导入 server 实现；不在入口层写业务规则。
- 云模式的 `/ws` 就是 host 本体服务通道（同源、lite-token），不得回落开发机 / 本机 workspace bootstrap。
- 不把 token 放进 URL query 之外的位置（按 host lite-token 既有约定），不落盘。
- 启动错误必须可操作（区分未配置/探测端点不存在、认证失效、协议不兼容、后端不可达），不用白屏或通用报错。

## 6. 验收

- 覆盖率门场景：探测 401/403（凭据门）、协议不兼容、探测 404（地址不是入口）、后端不可达 → 各自明确错误面与恢复动作，且**都不进入本地工作区**。
- 模式隔离：`?remote=` 原语义不变（仅在探测结果为 local 时生效；云端点下按 `remote-unsupported` 明确失败）；cloud 不出现本机 workspace 入口。
- 探测语义：同一份 Web 产物在 `mode=cloud` 服务端与 `mode=local` 服务端上分别进入云壳与本地路径，不需要重新构建，也不需要 `?mode=`。
- 组合验证：cloudApp 下原 `Root` 正常渲染，账号域调用打到 host `/ws`，执行域调用打到当前 Run attachment（与 [W8](./W8-ui-cloud.md) 联测）。
- 移动视口与桌面视口各跑一遍启动路径。
- 真实命令：`pnpm --filter @zcode/web test`、`pnpm --filter @zcode/web build`、`pnpm typecheck`、`pnpm lint`、浏览器 E2E。

## 7. 前置与并行

被 W5、W7 阻塞；与 W6、W8 尾部并行。阻塞 W10 的端到端验收。

## 8. 风险与 spike

- ~~需要先确认 Web 构建的 cloud env 注入方式（`VITE_*` 与运行时 origin 的关系）~~ **已关闭（2026-10-07，[04 §2.1](../04-web-client.md)）**：不再有构建期 cloud env，模式由服务端在启动时回答，构建期 origin 与运行时 origin 不一致的问题随之消失；不支持的协议版本仍由 capabilities 的 `protocolVersion` fail-closed 拒绝。
