#!/bin/sh
# 模板 start_cmd 占位（specs/cloud-agent/01 §6.2 实施决议「方案 A」）：
# start_cmd 是**构建期启动、随快照恢复**的进程，拿不到运行时注入的 provider env；
# 真实 supervisor 由控制面在 create 成功后经 provider 原生命令会话拉起
# /opt/zcode/start-supervisor.sh（带自举 env）。这里只保留一个常驻占位进程，
# 使模板通过构建校验并让沙箱生命周期由 create timeout 界定。
exec sleep infinity
