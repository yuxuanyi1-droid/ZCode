/**
 * 沙箱内 runtime stub 入口（W3 资产构建的第二默认入口；镜像内 `/opt/zcode/runtimeStub.bundle.mjs`）。
 *
 * 定位说明（不夸大能力）：本入口**不是** Agent runtime 本体——真实 runtime 是
 * `~/.zcode/server/zcode-server.cjs`（既有 `build:remote` 产物，由 zcode-server-cli 部署到
 * 镜像）。本 bundle 的作用是「runtime 通路自检」：在沙箱内按 SSH 同构布局启动 runtime、
 * 完成一次 stdio 握手与一次有界 RPC 调用，然后退出，供模板/运维验证
 * 「布局物化 + 握手 + 通道可达」这三件事实（07 §2.7 交互同构的冒烟面）。
 *
 * 输出：stdout 一行有界 JSON（`{"type":"zcode-runtime-stub",...}`），不含任何凭据、
 * prompt 或路径以外的内部信息；失败以非 0 退出并打印脱敏原因。
 */
import process from "node:process";
import { ServiceChannels } from "@zcode/shared";
import { createExecutionLogger } from "../adapters/executionSupport.js";
import { createLocalRpcOwner } from "../adapters/localRpcOwner.js";
import { createRuntimeOwner, resolveRuntimeRoot } from "../adapters/runtimeOwner.js";

const logger = createExecutionLogger("cloud-execution-stub", process.pid);

async function main(): Promise<number> {
  const root = resolveRuntimeRoot(process.env.ZCODE_SERVER_RUNTIME_ROOT);
  const runtime = createRuntimeOwner({ logger, root });
  const localRpc = createLocalRpcOwner({ logger, clientId: `runtime-stub-${process.pid}` });
  try {
    const started = await runtime.start();
    const handshake = await localRpc.connect(started.stream);
    // 一次有界只读调用：证明白名单通道在本地可达（不读任何业务数据）。
    const channel = localRpc.channel(ServiceChannels.System);
    const reachable = channel !== null;
    process.stdout.write(
      `${JSON.stringify({
        type: "zcode-runtime-stub",
        ok: true,
        pid: started.pid,
        runtimeVersion: handshake.runtimeVersion,
        channelRegistered: reachable,
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `runtime stub failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    // stub 的退出路径就是显式停止路径：这里释放 stdio 属于停止语义，不是网络断开。
    localRpc.dispose();
    await runtime.stop("runtime-stub-exit").catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `runtime stub crashed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
