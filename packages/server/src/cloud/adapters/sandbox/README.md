# cloud-sandbox adapters（W3）

specs/cloud-agent/01 §4–§6 的 provider 适配层：三家 driver 实现 `SandboxDriverPort`
（`cloud/app/ports/sandboxDriverPort.ts`，W0 冻结），外加能力门控、创建结果对账、
自举通道、模板与资产清单。

## 文件

| 文件                                                   | 职责                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `adapterError.ts`                                      | 归一错误（`CloudAdapterError`）与注入型 logger 契约                          |
| `sandboxRest.ts`                                       | provider 无关 REST 传输：超时/取消、有限重试、明确失败 vs 结果未知的归一骨架 |
| `capabilities.ts`                                      | 三家能力声明（差异不抹平）+ 可选性门控（未实测解禁前不显示可选）             |
| `reconcile.ts`                                         | 标签对账键、清单匹配、create 对账结论、补偿终止分类                          |
| `sandboxSupervisorStart.ts`                            | 自举共用契约：env 名映射、有界重试、`startSupervisorOrTerminate`             |
| `e2bDriver/e2bRest/e2bBootstrap`                       | E2B（REST 生命周期 + 官方 `e2b` SDK envd 命令通道）                          |
| `daytonaDriver/daytonaRest/daytonaBootstrap`           | Daytona（REST 生命周期 + toolbox 会话通道）                                  |
| `modalDriver/modalSdkBridge/modalBridgeProcess/modal/` | Modal（官方 Python SDK 子进程桥）                                            |
| `modalBootstrap.ts`                                    | Modal 自举通道选择（SDK exec / 无通道时的确定性门禁）                        |
| `providers.ts`                                         | 装配：driver 绑定表（provider/契约版本/必需秘密名/惰性 createDriver）        |
| `fakeSandboxDriver.ts`                                 | 内存 fake（故障注入：丢响应/挂起/终止未确认），供控制面测试                  |
| `assets/`                                              | bundle 构建入口（`buildAssets.mjs`）、版本/摘要清单、分发目录读取            |
| `templates/`                                           | 模板镜像与 `start-supervisor.sh`（flock 单例、0755），见其 README            |

## 对外接口

- **对 W1（控制面）**：`SandboxDriverPort` 全量 + `describeCapabilities()`。控制面只依赖端口
  类型；`unknown` 结论必须进入对账，不得写成失败或直接重发 create/terminate。
- **对 W5（入口）**：`createSandboxDriverBindings(configs)` → 绑定表（每条含 `provider`、
  `contractVersion`、`requiredSecretNames`、`createDriver(context)`），入口负责配置读取、
  契约版本比对与门控（`resolveProviderGate`）；**秘密名到 driver 的映射在本模块**，
  缺配置的 provider 不产生绑定（不是抛错、不造空 driver）。`SANDBOX_ADAPTER_CONTRACT_VERSION`
  是适配器声明的契约版本，入口持有的期望值必须与它一致。资产分发用 `loadSandboxAssetCatalog()` +
  `readAsset(assetId)`（每次按清单 sha256 校验，失败不回退未校验旧包）。
- **对 W6（执行节点）**：自举 env 名映射与启动命令（`SUPERVISOR_START_ENV_NAMES`、
  `SUPERVISOR_START_CMD = /opt/zcode/start-supervisor.sh`）。契约：

  | env 名                         | 来源                                        |
  | ------------------------------ | ------------------------------------------- |
  | `ZCODE_CLOUD_PUBLIC_ORIGIN`    | `SandboxCreateInput.publicControlPlaneUrl`  |
  | `ZCODE_CLOUD_RUN_ID`           | `runId`                                     |
  | `ZCODE_CLOUD_RUN_GENERATION`   | `runGeneration`（十进制字符串）             |
  | `ZCODE_CLOUD_BOOTSTRAP_TICKET` | `bootstrapTicket`（短效单次，只经命令 env） |
  | `ZCODE_CLOUD_OPERATION_KEY`    | `operationKey`                              |
  | `ZCODE_CLOUD_TASK_ID`          | `bootstrapAddress.taskId`（非秘密）         |
  | `ZCODE_CLOUD_WORKSPACE_PATH`   | `bootstrapAddress.workspacePath`（非秘密）  |

  `TASK_ID` / `WORKSPACE_PATH` 是 supervisor **连接之前**就要用的 run 地址事实
  （`bridge.hello.address` 的 taskId 与 checkout 路径）：身份 `cloud-task:<taskId>` 由沙箱侧
  冻结 helper 派生，**不单独传 workspaceIdentity**；路径由控制面按 01 §6.2 步骤 2 计算
  （唯一计算点 `domain/workspacePath.ts`）并持久化到 `run.workspacePath`。

  两项都取自 `SandboxCreateInput.bootstrapAddress`（W0 冻结的显式字段，不用标签运输），
  校验在 create 之前完成：
  任务 id 必须过冻结 schema、路径必须绝对且非空，否则 `validation_failed`、不发起 provider
  请求、不占 quota，**不编造占位身份**（编造的 taskId 会污染 attachment 地址与投影去重键）。
  地址要素只进自举 env，**不写进 provider labels/metadata/tags**（provider 可见面最小化，
  对账关联仍只需 operationKey/runId/runGeneration）。

  三家通道差异（语义相同）：E2B `commands.run(background, envs)`；Daytona `POST /env`
  - 固定会话 `runAsync`；Modal `sb.exec(..., env=…)` + detach。**就绪探测**只到「命令被
    接受且进程没有立刻非 0 退出」；真正的 ready 由控制面按 bridge 握手裁决（02 §5.3）。

  **provider 命令通道只送自举要素与非秘密 run 地址**（上面 7 个 env，全部非秘密，来源为
  create 输入的字段）。
  **凭据仍只走 bridge 认证通道的 `bootstrap.config` 帧**（02 §4、01 §6.2、12 §6）：运行时配置、
  clone 事实与 provisioning envelope 都在那里；provider env 与 provider 元数据对 provider API
  可见，不得承载任何秘密。

## supervisor 启动探测与失败原因（01 §5.1/§6.2）

启动由 `SandboxDriverPort.startSupervisor(handle, input)` 承担，**由控制面在 `persistHandle()`
成功之后调用**（01 §5.1 第 3 条顺序：create 成功先持久 handle/deadline，再等 bridge）：
create 只建资源，不碰命令通道——否则首发握手会因 `workspace-path-mismatch` 被 1008 拒绝。
正常路径与 `findCreateResult` 对账恢复路径**都要调**（恢复路径漏调 = 沙箱活着没人回连）。
三家都在通道内做
**有界即时失败探测**，把「沙箱内启动失败」从不可见超时变成确定失败 + 可读原因：

| provider | 通道                             | 探测方式                                                                                                                |
| -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| E2B      | `commands.run(background, envs)` | 3s 窗口内每 250ms 查 `handle.exitCode`（SDK 的 `CommandHandle` 构造即消费事件流，无需回调，`stdout`/`stderr` 也会累积） |
| Daytona  | toolbox 固定会话 `runAsync`      | 拉起后立即查命令 `exitCode`                                                                                             |
| Modal    | SDK exec + 1s `poll()`           | 同                                                                                                                      |

- **非 0 退出 = 确定失败**：立即补偿终止并抛 `bootstrap_failed`，消息里带**退出码 + 输出片段**
  （单行、≤200 字符、**抹掉自举 ticket**，口径同 `readProviderRejectionMessage`）。
  E2B 这条**不重试**（沙箱内确定性失败重试无意义，必须尽快补偿）；其余通道抖动仍走有界重试。
- 退出码 0（脚本 flock 幂等分支：已有实例在跑）与仍在运行都视为已拉起。
- 补偿错误的 message 带 `[reason: …]`，并把原错误的 `exitCode`/`stdout`/`stderr` 有界片段透传进
  `safeContext`——控制面 `last_error` 因此可读（例：`runtime-ready: EACCES: permission denied,
mkdir '/root/.zcode/run'`），不再出现「卡两分钟、last_error 为空」。
- supervisor 启动失败时会往 stdout 打一行
  `{"type":"zcode-supervisor-failed","stage":…,"message":…}` 并非 0 退出；探测**优先消费它**
  （原因变成 `stage: message`，信息量比裸输出大），解析容错、**不当作协议帧**（它是命令通道的
  普通输出），没有该行时退回脱敏后的输出片段。
- **可见性边界（不声称全时段可见）**：探测只在有界窗口内观测——**窗口内**的沙箱内失败按确定
  失败补偿并带原因；**晚于窗口**才发生的失败（例如 supervisor 起来几十秒后才崩）这里看不见，
  仍由控制面的 readiness 看门狗兜底（表现为超时 + 终止，而不是带原因的确定性失败）。
- 探测是**有界启动信号，不是 readiness**：真正 ready 由控制面按 bridge 握手裁决（02 §5.3）。

## 创建结果对账（01 §4.1、03 §5）

`findCreateResult(operationKey)` 结论只有三种：`created` / `notFound` / `unknown`。

- provider 清单命中 `operationKey` 标签 → `created`（迟到 handle 也走这条）。
- 查询失败/不可达 → `unknown`：保留 operation 与 quota，绝不自动第二次 create。
- 未命中且能证明 create 尝试已超出对账窗口 → `notFound`（重试安全）。
- **没有时间锚点**（跨进程且调用方未提供）→ 保守 `unknown`，等运营确认。

锚点优先级：`findCreateResult(operationKey, { operationAttemptedAtMs })` 的**控制面持久
尝试时间**优先（跨重启可用，W1 从 operation 记录传入）；驱动进程内记录的尝试时间只是同一
实例内的兜底。对账窗口默认 300s，可用 `createReconciliationWindowMs` 覆盖。

`inspect` 的观测带 ≤160 字符的**有界证据**（`ProviderObservation.evidence`：端点、provider
状态原文要点、退出码、错误类别）供运营核对；证据串不含凭据、prompt、用户内容、私有代码或
请求/响应原文。`TerminationObservation` 目前没有 evidence 字段，终止证据按同一口径写进
结构化日志的 `evidence` 字段（**过渡形态**：W0 已裁决加可选有界 `evidence?: string`，随下一次
契约冻结落地；落地后改为返回值携带并删除日志侧那处）。

## 补偿终止分类（01 §5.1、§9）

`create` 成功但 supervisor 起不来时**必须**补偿终止，不留静默孤儿：

| provider 事实             | 错误码                         | 控制面行为                     |
| ------------------------- | ------------------------------ | ------------------------------ |
| 2xx / 404（确认已无资源） | `bootstrap_failed`             | 可释放槽位                     |
| 网络/5xx/权限丢失         | `provider_termination_unknown` | 保留计费槽与 cleanup operation |

## provider 解禁（能力门控）

`capabilities.ts` 的门控表当前三家均为 **未实测**（`verifiedAt: null`）：默认不出现在可选列表。
解禁流程（每家一次，记录真实资源与费用证据）：

1. 用测试账号跑通 create → 自举 → 出站 bridge → runtime ready → terminate；
2. 记录能力四项证据：`describeCapabilities()` 与真实行为一致、期限语义（到期/续期）、
   停止语义（是否真释放）、启动开销；
3. 在该 provider 的 `SANDBOX_PROVIDER_GATES` 条目写入 `verifiedAt`（日期）与证据引用，
   清空对应 `unverified` 项；
4. 跑 `packages/server/test/cloudSandboxLive.test.ts`（凭据门控，见下）并把结果附在 PR 里。

部署若要带着未验证证据临时启用，必须在入口显式传 `allowUnverified: ["e2b"]`（缺省空）：
可选性打开但留 warn 日志；**能力声明不变**，未验证的能力仍按声明拒绝，不伪造成功。

## 模板引用（部署配置 `ZCODE_CLOUD_SANDBOX_TEMPLATE_REF`）

部署用**一个键**声明各 provider 的默认模板：形式 `provider:ref`，多家用逗号分隔
（如 `e2b:zcode-sandbox-template,daytona:zcode-sandbox-template`）。解析后的 ref 经控制面
进 `SandboxCreateInput.imageRef`（frozen port 字段名；语义是 **provider 侧的模板引用**——
E2B 里就是 templateID，不是镜像 digest），driver 再按各家模板语义使用（E2B templateID /
Daytona snapshot / Modal 是 Dockerfile，其 ref 只作展示与对账）。

- 解析 fail-closed：缺 `:`、provider 未知、ref 为空、`latest`、同 provider 重复
  → `sandbox_template_invalid`；driver 侧另有一道本地校验（`latest` 一律拒绝）。
- **客户端不能自选镜像**：resolver 只在**部署配置命中**时返回；请求里的
  `start.templateRef` 与部署固定值不一致时**拒绝**（warn + 返回 null），不回落部署值。
- **未配置该键不是错误**，只表示「不提供默认模板」；此时请求又没带 ref，会在**接纳期**
  拒绝（`unsupported_template` / `template-unresolved`），不是等到 provisioning 阶段才失败。
- 接纳期把 ref 冻结进 Run recipe（`imageDigest` + `templateVersion`）；此后部署默认值变化
  只影响新任务，在跑的 Run 不换模板。

## 寿命上限（部署配置 `provider:seconds`）

provider 账号的生命周期上限必须**实测后**由部署声明（形如 `e2b:3600`，多家逗号分隔），
入口经绑定上下文 `maxLifetimeSeconds` 传入：

- 有值 → driver 用 `Math.min` 收敛请求寿命（E2B `timeout` 秒 / Daytona `ttlMinutes` 分钟
  / Modal `timeout` 秒），并在 `describeCapabilities()` 里**如实上报** `maxLifetimeSeconds`；
- 缺省 → 未核实，**不虚构上限**，请求原样放行（`maxLifetimeSeconds` 不出现在能力声明里）；
- 上限只收敛可用期，**不改变 `deadlineSource`**（E2B/Daytona 仍是 `provider`，Modal 仍是
  `estimated`）。两个字段量的是不同东西，不是不一致：`deadlineSource` 回答「provider **是否
  给出真实期限时间戳**」（E2B `setTimeout` / Daytona `autoDestroyAt` 给，Modal 没有任何
  期限时间戳、只能估计），`maxLifetimeSeconds` 回答「**可用期上限**是多少」。核实上限只是
  把可用期收敛得更准，不产生期限时间戳，所以 Modal 核实上限后依旧 `estimated`。
- 首个实测证据（2026-10-07，真实账号）：请求 4h（`timeout=14400`）被 E2B 400 拒绝，
  原文「Timeout cannot be greater than 1 hours」→ 该账号上限 **3600 秒**。
- 已实测上限小于 run 的硬期限时，由 W1 侧按 01 §4.3 收敛并提示；driver 只负责不发超限请求。

provider 的 4xx 拒绝会**带上 provider 原话**（有界 ≤200 字符、压成单行、只取 JSON 的
`message`/`error.message`，不透传响应体/header/token）进归一错误与日志——没有它无法定位
账号上限这类差异（上面的 3600 秒就是这么抓到的）。

## 真实账号联调（凭据门控）

`test/cloudSandboxLive.test.ts` 默认为 skip。设置对应 provider 凭据后才会执行：

```bash
# E2B
E2B_API_KEY=… pnpm --filter @zcode/server test -- --test-name-pattern "live"

# Daytona
DAYTONA_API_KEY=… …

# Modal（需要 Python 解释器 + modal 包；建议 venv）
MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… ZCODE_CLOUD_MODAL_PYTHON=/path/to/venv/bin/python …

# 沙箱模板（可选；缺省用账号默认模板，只验证 provider 语义）
ZCODE_CLOUD_SANDBOX_TEMPLATE_REF=e2b:zcode-sandbox-template,daytona:zcode-sandbox-template
```

联调用例自建资源并**在 finally 里终止**；失败时打印 sandboxId 供人工清理（provider 计费以
真实账单为准，控制面估算不算事实）。

## 秘密边界（01 §4.1/§6.2/§7.1）

- API key / TokenPair 只经注入函数读取，只进请求头或子进程 env；不进 URL、argv、日志、
  labels/tags、metadata。
- bootstrap ticket 只经命令 env（E2B/Daytona/Modal 同）；Modal 侧 ticket 与请求体只经 stdin。
- provider 标签只含 `operationKey` / `runId` / `runGeneration` 与调用方非敏感标签。
- 日志用 `createServiceLogger("cloud-sandbox-<provider>")`：`info` 记资源生命周期，
  `warn` 记可恢复异常与未知结果，`debug` 记调用级细节（生产不落盘）。
