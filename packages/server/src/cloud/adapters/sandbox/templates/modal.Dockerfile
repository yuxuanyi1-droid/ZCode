# ZCode 云沙箱镜像（Modal 通道；specs/cloud-agent/01 §6.2 实施决议）。
#
# 与 e2b.Dockerfile 同一份运行期布局（SSH 同构：~/.zcode/server），差异只在通道：
# Modal 端经官方 SDK `Image.from_dockerfile(path, context_dir=...)` **在 Modal 侧构建**
# （本机不需要 docker），因此本文件与 e2b.Dockerfile 内容等价但独立维护——
# provider 模板语言/构建行为不同，不做「一份文件两家共用」的隐式耦合。
#
# CMD 必须**常驻/阻塞**：Modal 沙箱生命周期 = entrypoint 进程 + create timeout，
# CMD 退出会导致沙箱立刻结束（与 E2B 的空转占位同语义，01 §6.2）。
#
# 构建：把 MODAL_IMAGE_DOCKERFILE 指向本文件（或把 templateDir 指向 templates/ 并
# 使用显式 dockerfile 配置），SDK 桥在 create 时以 Modal 端构建并缓存。
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY start.sh /opt/zcode/start.sh
COPY start-supervisor.sh /opt/zcode/start-supervisor.sh
COPY supervisor.bundle.mjs /opt/zcode/supervisor.bundle.mjs
COPY runtimeStub.bundle.mjs /opt/zcode/runtimeStub.bundle.mjs
COPY zcode-server.cjs /opt/zcode/zcode-server.cjs
COPY zcode-cli.cjs /opt/zcode/zcode-cli.cjs
COPY provider/zcode-builtin.json /opt/zcode/provider/zcode-builtin.json

RUN chmod 0755 /opt/zcode/start.sh /opt/zcode/start-supervisor.sh \
  && mkdir -p /workspace \
  && chmod 0777 /workspace

# 常驻占位：真实 supervisor 由控制面经 SDK exec 通道拉起
# /opt/zcode/start-supervisor.sh（env=自举要素，stdout/stderr=DEVNULL + detach）。
CMD ["/opt/zcode/start.sh"]
