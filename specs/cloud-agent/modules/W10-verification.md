# W10 — verification（集成验收、故障注入与跨模块回归）

状态：目标设计。归属：跨模块验收与证据，owner = 集成阶段负责人。
前置：W1–W9 完成（可按矩阵分批启动）。

## 1. 范围

做：跨模块验收矩阵的执行与证据留存、故障注入、真实 provider/GitHub 联调、原路径回归（Desktop 本地/SSH、手机远控、local 模式）、Docker/WSL 退役（P14）与最终发布前检查；维护 [10 §10](../10-implementation-plan.md) 的验证记录。
不做：任何模块内部实现；不在验收阶段改契约（发现设计缺陷按 [13 §5](../13-module-map.md) 走修订流程）。

## 2. 冻结依赖

- [10 §5/§6/§8/§9](../10-implementation-plan.md)（测试分层、高风险矩阵、运行验收、必跑检查）
- 各文档验收表：[03 §10](../03-control-plane.md) `CP-*`、[02 §11](../02-bridge-protocol.md) `B-*`、[04 §9](../04-web-client.md) `W-*`、[07 §13](../07-connection-architecture.md) `C-*`、[12 §7](../12-account-domain.md) `A-*`、[11 §9](../11-project-task-creation.md) `CT-*`、[09](../09-github-integration.md) 权限矩阵
- [06](../06-removal-docker-wsl.md)（P14 退役验收）

## 3. 交付物

```text
packages/server/test/cloud*.test.ts        领域/存储/适配器/集成分层测试（各工作单已建，这里汇总跑）
packages/{shared,client,ui}/test           契约、SDK、UI 投影与决策用例
packages/web/test/                         fixture 服务 + 浏览器 E2E（原 UI 对照、移动视口）
验收报告：矩阵 ID → setup/action/assertion/evidence（截图、HTTP/WS 帧、DB receipt、runtime 日志、remote SHA、provider 观测）
10 §10 追加记录：本轮真实命令与结果（含未执行与环境受限项）
```

## 4. 对外接口

不新增对外接口；产出是**证据与记录**：每条断言必须能指到具体命令、日志片段或数据库行。

## 5. 边界与禁止

- 不得把未执行的检查写成通过；环境受限（无 JDK、无凭据、无浏览器）单列并说明。
- 不得用 mock 成功路径替代端到端证据（[10 §4](../10-implementation-plan.md)）。
- 故障注入不得对真实用户数据、真实凭据、生产账号执行；测试用隔离 repo/账号，且不把任何凭据写入仓库或报告。
- 不得用固定 sleep 作为时序断言（[04 §9](../04-web-client.md)）。

## 6. 验收（本工作单自身的验收）

- 四条必跑：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`pnpm knip`（涉及删除导出时 `pnpm dep:refs --list-exports`）；涉及 CLI 时加 `pnpm --dir apps/zcode-cli typecheck|lint`。
- 矩阵抽样必须包含：`B-02`（断网 PID 不变）、`B-04`（丢 welcome 恢复）、`CP-01`（绕过 UI 拒绝本机执行）、`CP-05`（关页仍执行）、`W-04`（202 后关页仍 admit 一次）、`W-17`（ready 后原组件可用）、`A-04`（沙箱内真实模型请求）、`C-12`（原 Desktop/手机路径回归）。
- 真实 provider 联调、真实 GitHub 测试仓库各至少一轮；记录资源与费用观测（估算不冒充账单）。
- 发布前：fail-closed 场景全绿；Docker/WSL 退役（P14）完成后跑类型消费者与宿主回归。

## 7. 前置与并行

按波次分批：Wave 1 完成即可开始契约/存储/适配器层验收；Wave 2 完成后跑端到端。阻塞「按 spec 宣布完成」。

## 8. 风险与 spike

- 验收矩阵很大，容易变成"跑绿清单"：每条证据必须能回指到 owner（谁写的状态、谁 ACK 的），否则视为无效验收。
