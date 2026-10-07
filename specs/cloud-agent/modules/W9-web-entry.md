# W9 — web-entry（Web 入口与平台适配）

状态：目标设计。归属：`packages/web/src/cloud`、`packages/web/src/webPlatform.ts`、`packages/web/src/main.tsx`（模式分派）。
前置：[W5](./W5-cloud-entry.md)、[W7](./W7-client-sdk.md)。

## 1. 范围

做：Web 客户端的模式解析（显式 cloud/local）、origin 与 token 取得、cloud boot 流程与启动错误呈现、OAuth/分享回调路由、把 host accessor 与 cloud providers 组合进原 `Root`、`IPlatformService` 的 Web 适配。
不做：UI 组件与 hooks（[W8](./W8-ui-cloud.md)）；服务端静态托管（[W5](./W5-cloud-entry.md)）；账号域实现。

## 2. 冻结依赖

- [04 §1/§2/§4/§6/§8](../04-web-client.md)（基线、产品入口与模式、服务落点、API 映射、阶段与回退）
- [12 §4/§5](../12-account-domain.md)（host `/ws` 为 base accessor，`?token=` 放行）
- [03 §7.1](../03-control-plane.md)（两通道分面）
- `packages/shared/src/platform.ts`（`IPlatformService` 契约，不得绕过）

## 3. 交付物

```text
packages/web/src/cloud/
  cloudBoot.ts                 mode/origin/token 解析、启动错误分类
  cloudApp.tsx                 host accessor + CloudServices/CloudWorkspace providers + 原 Root 挂载
  CloudTokenGate.tsx           需要 token/认证时的门与提示
  CloudBootstrapErrorScreen.tsx 启动失败的可操作错误面
packages/web/src/webPlatform.ts   IPlatformService 的 Web 实现（无桌面能力时显式不可用）
packages/web/src/main.tsx         模式分派：cloud 走 cloudApp，local/remote 保持原路径
```

## 4. 对外接口

- 入口契约：URL/环境决定 mode；**缺 remote 参数、网络失败、identity 解析失败都不得自动回退本机**（[04 §2](../04-web-client.md)）
- 平台契约：所有原生能力经 `IPlatformService`；不得直接调 `window.zcode`

## 5. 边界与禁止

- 不导入 server 实现；不在入口层写业务规则。
- 云模式的 `/ws` 就是 host 本体服务通道（同源、lite-token），不得回落开发机 / 本机 workspace bootstrap。
- 不把 token 放进 URL query 之外的位置（按 host lite-token 既有约定），不落盘。
- 启动错误必须可操作（区分未配置、认证失效、origin 不符、bundle 版本不兼容），不用白屏或通用报错。

## 6. 验收

- 覆盖率门场景：无 token、错 token、origin 不符、bundle/协议不兼容、后端不可达 → 各自明确错误面与恢复动作。
- 模式隔离：`?remote=` 原语义不变；cloud 不出现本机 workspace 入口。
- 组合验证：cloudApp 下原 `Root` 正常渲染，账号域调用打到 host `/ws`，执行域调用打到当前 Run attachment（与 [W8](./W8-ui-cloud.md) 联测）。
- 移动视口与桌面视口各跑一遍启动路径。
- 真实命令：`pnpm --filter @zcode/web build`（cloud env）、`pnpm typecheck`、`pnpm lint`、浏览器 E2E。

## 7. 前置与并行

被 W5、W7 阻塞；与 W6、W8 尾部并行。阻塞 W10 的端到端验收。

## 8. 风险与 spike

- 需要先确认 Web 构建的 cloud env 注入方式（`VITE_*` 与运行时 origin 的关系）并写进配置契约，否则会出现"构建期 origin 与运行时 origin 不一致"这类只在预览环境暴露的问题。
