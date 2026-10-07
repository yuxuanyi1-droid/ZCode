#!/usr/bin/env python3
"""ZCode Modal 沙箱控制面桥（specs/cloud-agent/01 §4.2/§6.2）。

职责：控制面（Node/TypeScript）与官方 Modal Python SDK 之间唯一的受控调用面。
控制面把一个 JSON 请求写到本进程 stdin，本进程用官方 `modal` 包完成操作，把
**一行**带哨兵前缀的 JSON 响应写到 stdout，然后退出。一次调用一个操作，
操作完成后进程即退出（沙箱留在 provider 侧，见下）；不需要常驻连接。

官方能力依据（2026-10-06 核实，modal 1.6.1，非推测）：
- `modal.Sandbox.create(*args, image=..., app=..., timeout=..., workdir=..., env=...,
  tags=..., cpu=..., memory=...)`：从容器外创建需传 `app`（docstring：
  「app: Associate the sandbox with an app. Required unless creating from a
  container.」，示例 `app = modal.App.lookup('sandbox-hello-world',
  create_if_missing=True)`）。
- `modal.Image.from_dockerfile(path, *, context_dir=...)`：Modal 端构建（不在本机
  跑 docker），支持指定构建上下文目录。
- `sb.exec(*args, env=..., workdir=..., stdout=StreamType.DEVNULL, stderr=DEVNULL)`：
  返回 `ContainerProcess`；环境变量按 exec 调用注入（实测 `marker=at-exec`）。
- 后台长驻：以 DEVNULL 流启动后调用 `sb.detach()`（官方 docstring：
  「Disconnecting your client from the sandbox ... Detaching doesn't terminate or
  otherwise affect the remote Sandbox; it only cleans up client-side resources.」）。
  实测（2026-10-06 真实账号）：detach 并退出客户端进程后，后台进程继续运行，
  `Sandbox.from_id(id).poll()` 仍返回 None（running）。
- `sb.poll()`：None = 仍在运行，int = 退出码；`sb.terminate()` 发送 SIGKILL
  （实测 poll 返回 137）；`Sandbox.from_id(id)` 对不存在的 id 抛 NotFoundError。
- `Sandbox.list(app_id=..., tags=...)`：按 tag 服务端过滤，但固定
  `include_finished=False`（只返回仍在运行者）——对账语义见 modalSdkBridge.ts。

凭据边界：`MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` 只经**子进程环境变量**传入
（控制面构造的最小 env），不进 argv、不进日志、不打印；本脚本禁止回显请求体
（请求里含 bootstrap ticket 与 provisioning envelope，绝不能出现在 stdout/stderr）。
请求体经 stdin 传入，不落盘。

错误语义：捕获到异常时输出 `ok: false` 的错误信封；`definite` 表示「能否判定
provider 侧未生效」——只有 create 之前的阶段（请求校验/import/镜像/App 查询）
与 provider 明确拒绝类异常（Invalid/Auth/Permission/Quota/NotImplemented）才为
true；网络/服务类异常必须为 false，交给控制面按「结果未知」对账（01 §4.1、§5.3）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import sys
import time
import traceback

PROTOCOL = 1
# 响应哨兵：stdout 里最后一行以它开头；其余 stdout 输出（SDK 进度/警告）被忽略，
# 因此 SDK 往 stdout 打印任何东西都不会破坏协议。
RESPONSE_SENTINEL = "##ZCODE-BRIDGE-RESPONSE##"
MAX_DETAIL_CHARS = 200
MAX_LIST_RESULTS = 200
MAX_CAPTURE_BYTES = 64 * 1024
# 即时失败探测前的等待：给 start-supervisor.sh 一个「立刻崩溃」的窗口（与 Daytona 同语义）。
IMMEDIATE_FAILURE_PROBE_SECONDS = 1.0
# 单次 exec/poll 的内部等待上限，避免桥进程被控制面之外的因素无限挂住。
EXEC_POLL_TIMEOUT_SECONDS = 15.0

# 归一错误码（@zcode/shared CLOUD_ERROR_CODES 子集）与固定 reason 词表。
# reason 是机器可读短语，不透传 provider 原文；detail 才是有界的诊断摘要。
_EXCEPTION_CODES = (
    ("InvalidError", "validation_failed", "rejected-request"),
    ("VersionError", "validation_failed", "rejected-request"),
    ("RequestSizeError", "validation_failed", "rejected-request"),
    ("SerializationError", "validation_failed", "rejected-request"),
    ("DeserializationError", "validation_failed", "rejected-request"),
    ("AuthError", "unauthenticated", "auth-rejected"),
    ("PermissionDeniedError", "permission_revoked", "permission-denied"),
    ("ResourceExhaustedError", "quota_exceeded", "quota-exhausted"),
    ("UnimplementedError", "resource_unsupported", "unimplemented"),
    ("ImageBuildError", "unsupported_template", "image-build-failed"),
    ("NotFoundError", "not_found", "not-found"),
)
_UNREACHABLE_EXCEPTIONS = (
    "TimeoutError",
    "ConnectionError",
    "InternalError",
    "ServiceError",
    "ClientClosed",
    "RemoteError",
    "WorkspaceManagementError",
    "SandboxTerminatedError",
    "ExecutionError",
)
# 明确拒绝类（provider 未生效）——仅这些异常在 create 阶段可判定为 definite。
_DEFINITE_OUTCOMES = frozenset({"validation_failed", "unauthenticated", "permission_revoked"})
_DEFINITE_OUTCOMES |= {"quota_exceeded", "resource_unsupported", "unsupported_template", "not_found"}


class BridgeError(Exception):
    """带归一码与 definite 标记的桥内错误。"""

    def __init__(self, code: str, reason: str, detail: str, definite: bool, stage: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.detail = _bounded(detail)
        self.definite = definite
        self.stage = stage


def _bounded(text: str) -> str:
    single_line = " ".join(str(text).split())
    return single_line[:MAX_DETAIL_CHARS]


def _classify(exc: BaseException) -> tuple[str, str]:
    """异常类名 → (cloud code, reason)；未知异常按不可达处理（不猜测）。"""
    name = type(exc).__name__
    for cls, code, reason in _EXCEPTION_CODES:
        if name == cls:
            return code, reason
    if name in _UNREACHABLE_EXCEPTIONS:
        return "provider_unreachable", "unreachable"
    # grpc 层的 GRPCError（如 UNAUTHENTICATED）与未知异常：仍按不可达，definite=false。
    status = getattr(exc, "_grpc_status", None)
    if status is not None and getattr(status, "name", "") in ("UNAUTHENTICATED", "PERMISSION_DENIED"):
        return (
            "unauthenticated" if status.name == "UNAUTHENTICATED" else "permission_revoked",
            "auth-rejected" if status.name == "UNAUTHENTICATED" else "permission-denied",
        )
    return "provider_unreachable", "unreachable"


def _fail(stage: str, exc: BaseException, *, definite_override: bool | None = None) -> BridgeError:
    code, reason = _classify(exc)
    # 阶段先决：请求校验/依赖/镜像/App 查询阶段不可能已创建沙箱 → definite。
    stage_definite = stage in ("request", "import", "image", "app_lookup")
    exception_definite = code in _DEFINITE_OUTCOMES
    definite = stage_definite or exception_definite
    if definite_override is not None:
        definite = definite_override
    detail = f"{type(exc).__name__}: {exc}"
    return BridgeError(code, reason, detail, definite, stage)


def _load_modal():
    """延迟导入：缺 modal 包时能输出结构化错误而不是解析前崩溃。"""
    try:
        import modal  # noqa: PLC0415
    except Exception as exc:  # ImportError 及其依赖缺失
        raise BridgeError(
            "resource_unsupported",
            "dependency-missing",
            _bounded(f"modal SDK import failed: {type(exc).__name__}: {exc}"),
            True,
            "import",
        ) from exc
    return modal


def _dockerfile_sha256(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _sandbox_id(sandbox) -> str:
    sandbox_id = getattr(sandbox, "object_id", None)
    if not sandbox_id:
        raise BridgeError(
            "provider_unreachable", "unreachable", "sandbox handle has no object_id", False, "create"
        )
    return str(sandbox_id)


async def _op_probe(_modal, request: dict) -> dict:
    del request
    modal = _load_modal()
    return {
        "modalVersion": getattr(modal, "__version__", "unknown"),
        "pythonVersion": platform.python_version(),
        "protocol": PROTOCOL,
    }


async def _op_create(modal, request: dict) -> dict:
    spec = request.get("image") or {}
    dockerfile = str(spec.get("dockerfile") or "").strip()
    if not dockerfile:
        raise BridgeError(
            "validation_failed", "invalid-request", "image.dockerfile is required", True, "request"
        )
    if not os.path.isabs(dockerfile):
        raise BridgeError(
            "validation_failed", "invalid-request", "image.dockerfile must be absolute", True, "request"
        )
    stage = "image"
    try:
        dockerfile_sha = _dockerfile_sha256(dockerfile)
        context_dir = str(spec.get("contextDir") or os.path.dirname(dockerfile))
        app_name = str(request.get("appName") or "").strip()
        if not app_name:
            raise BridgeError(
                "validation_failed", "invalid-request", "appName is required", True, "request"
            )
        app = await modal.App.lookup.aio(app_name, create_if_missing=True)
        image = modal.Image.from_dockerfile(dockerfile, context_dir=context_dir)
    except BridgeError:
        raise
    except BaseException as exc:  # noqa: BLE001 - 归一后交控制面
        raise _fail(stage, exc) from exc

    stage = "sandbox_create"
    create_kwargs: dict = {
        "image": image,
        "app": app,
        "timeout": int(request.get("timeoutSeconds") or 0) or 300,
        "workdir": str(request.get("workdir") or "/workspace"),
        "tags": {str(k): str(v) for k, v in (request.get("tags") or {}).items()},
    }
    # 资源请求：Modal 以请求值调度与计费；非法值由 provider 以 InvalidError 拒绝。
    if isinstance(request.get("cpu"), (int, float)):
        create_kwargs["cpu"] = float(request["cpu"])
    if isinstance(request.get("memoryMiB"), int):
        create_kwargs["memory"] = int(request["memoryMiB"])
    try:
        sandbox = await modal.Sandbox.create.aio(**create_kwargs)
    except BaseException as exc:  # noqa: BLE001
        raise _fail(stage, exc) from exc
    sandbox_id = _sandbox_id(sandbox)
    # 客户端句柄随进程退出释放；显式 detach 只清理本侧资源，不影响远端沙箱。
    await _best_effort(sandbox.detach.aio())
    return {"sandboxId": sandbox_id, "dockerfileSha256": dockerfile_sha}


async def _op_exec(modal, request: dict) -> dict:
    sandbox_id = str(request.get("sandboxId") or "").strip()
    command = request.get("command")
    if not sandbox_id or not isinstance(command, list) or not command:
        raise BridgeError(
            "validation_failed", "invalid-request", "sandboxId and command are required", True, "request"
        )
    mode = str(request.get("mode") or "background")
    env = {str(k): str(v) for k, v in (request.get("env") or {}).items()} or None
    workdir = request.get("workdir") or None
    stage = "exec"
    try:
        sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
        if mode == "capture":
            return await _exec_capture(modal, sandbox, command, env, workdir, request)
        # 后台模式：DEVNULL 避免无人读取的管道背压拖死 supervisor；detach 后本进程退出，
        # 远端进程继续运行（证据见文件头注释）。
        process = await sandbox.exec.aio(
            *[str(part) for part in command],
            env=env,
            workdir=workdir,
            stdout=modal.stream_type.StreamType.DEVNULL,
            stderr=modal.stream_type.StreamType.DEVNULL,
        )
        await asyncio.sleep(IMMEDIATE_FAILURE_PROBE_SECONDS)
        exit_code = None
        try:
            exit_code = await asyncio.wait_for(
                process.poll.aio(), timeout=EXEC_POLL_TIMEOUT_SECONDS
            )
        except BaseException:  # noqa: BLE001 - 探测失败不改变「已发起」事实
            exit_code = None
        await _best_effort(sandbox.detach.aio())
        return {"exitCode": exit_code, "detached": True}
    except BridgeError:
        raise
    except BaseException as exc:  # noqa: BLE001
        raise _fail(stage, exc) from exc


async def _exec_capture(modal, sandbox, command, env, workdir, request) -> dict:
    """有界捕获模式（诊断/冒烟用）：收集 stdout/stderr 与退出码，输出截断。"""
    timeout_seconds = float(request.get("captureTimeoutSeconds") or 60.0)
    process = await sandbox.exec.aio(
        *[str(part) for part in command],
        env=env,
        workdir=workdir,
        stdout=modal.stream_type.StreamType.PIPE,
        stderr=modal.stream_type.StreamType.PIPE,
    )

    async def collect() -> tuple[str, str]:
        out, err = await asyncio.gather(
            process.stdout.read.aio(), process.stderr.read.aio(), return_exceptions=True
        )
        return (
            out if isinstance(out, str) else "",
            err if isinstance(err, str) else "",
        )

    try:
        stdout, stderr = await asyncio.wait_for(collect(), timeout=timeout_seconds)
    except asyncio.TimeoutError as exc:
        raise BridgeError(
            "provider_unreachable",
            "exec-timeout",
            f"capture exec exceeded {timeout_seconds:.0f}s",
            False,
            "exec",
        ) from exc
    exit_code = None
    try:
        exit_code = await asyncio.wait_for(process.poll.aio(), timeout=EXEC_POLL_TIMEOUT_SECONDS)
    except BaseException:  # noqa: BLE001
        exit_code = None
    await _best_effort(sandbox.detach.aio())
    return {
        "exitCode": exit_code,
        "stdout": stdout[:MAX_CAPTURE_BYTES],
        "stderr": stderr[:MAX_CAPTURE_BYTES],
        "truncated": len(stdout) > MAX_CAPTURE_BYTES or len(stderr) > MAX_CAPTURE_BYTES,
    }


async def _op_terminate(modal, request: dict) -> dict:
    sandbox_id = str(request.get("sandboxId") or "").strip()
    if not sandbox_id:
        raise BridgeError(
            "validation_failed", "invalid-request", "sandboxId is required", True, "request"
        )
    stage = "terminate"
    try:
        sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
    except BaseException as exc:  # noqa: BLE001
        failure = _fail(stage, exc)
        # 资源不存在 = provider 确认已无该资源：属于终止已确认，不是未知。
        if failure.code == "not_found":
            return {"terminated": True, "notFound": True}
        raise failure from exc
    try:
        exit_code = await asyncio.wait_for(sandbox.poll.aio(), timeout=EXEC_POLL_TIMEOUT_SECONDS)
        if exit_code is None:
            await sandbox.terminate.aio()
            try:
                exit_code = await asyncio.wait_for(
                    sandbox.poll.aio(), timeout=EXEC_POLL_TIMEOUT_SECONDS
                )
            except BaseException:  # noqa: BLE001
                exit_code = None
        return {"terminated": True, "exitCode": exit_code}
    except BridgeError:
        raise
    except BaseException as exc:  # noqa: BLE001
        raise _fail(stage, exc) from exc


async def _op_inspect(modal, request: dict) -> dict:
    sandbox_id = str(request.get("sandboxId") or "").strip()
    if not sandbox_id:
        raise BridgeError(
            "validation_failed", "invalid-request", "sandboxId is required", True, "request"
        )
    stage = "inspect"
    try:
        sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
    except BaseException as exc:  # noqa: BLE001
        failure = _fail(stage, exc)
        if failure.code == "not_found":
            return {"status": "not_found", "evidence": "modal from_id -> not-found"}
        raise failure from exc
    try:
        exit_code = await asyncio.wait_for(sandbox.poll.aio(), timeout=EXEC_POLL_TIMEOUT_SECONDS)
    except BaseException as exc:  # noqa: BLE001
        raise _fail(stage, exc) from exc
    if exit_code is None:
        return {"status": "running", "evidence": "modal poll -> running"}
    return {"status": "stopped", "evidence": f"modal poll -> exit {exit_code}", "exitCode": exit_code}


async def _op_list(modal, request: dict) -> dict:
    app_name = str(request.get("appName") or "").strip()
    tags = {str(k): str(v) for k, v in (request.get("tags") or {}).items()}
    stage = "list"
    try:
        app = await modal.App.lookup.aio(app_name, create_if_missing=False)
    except BaseException as exc:  # noqa: BLE001
        failure = _fail(stage, exc)
        # App 不存在 → 该 app 下不可能有沙箱（create 用 create_if_missing=True 建 app）。
        if failure.code == "not_found":
            return {"sandboxes": []}
        raise failure from exc
    sandbox_ids: list[str] = []
    try:
        async for sandbox in modal.Sandbox.list.aio(app_id=app.app_id, tags=tags):
            sandbox_ids.append(str(sandbox.object_id))
            if len(sandbox_ids) >= MAX_LIST_RESULTS:
                break
    except BaseException as exc:  # noqa: BLE001
        raise _fail(stage, exc) from exc
    return {"sandboxes": sandbox_ids}


async def _best_effort(awaitable) -> None:
    try:
        await awaitable
    except BaseException:  # noqa: BLE001 - detach 失败不影响已完成的远端事实
        pass


_OPS = {
    "probe": _op_probe,
    "create": _op_create,
    "exec": _op_exec,
    "terminate": _op_terminate,
    "inspect": _op_inspect,
    "list": _op_list,
}


def _emit(payload: dict) -> None:
    sys.stdout.write(RESPONSE_SENTINEL + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _error_envelope(failure: BridgeError) -> dict:
    envelope = {
        "protocol": PROTOCOL,
        "ok": False,
        "error": {
            "code": failure.code,
            "reason": failure.reason,
            "detail": failure.detail,
            "definite": failure.definite,
            "stage": failure.stage,
        },
    }
    return envelope


async def _dispatch(request: dict) -> dict:
    op = str(request.get("op") or "")
    if op not in _OPS:
        raise BridgeError("validation_failed", "invalid-request", f"unknown op: {op}", True, "request")
    modal = _load_modal()
    started = time.monotonic()
    result = await _OPS[op](modal, request)
    result["elapsedMs"] = int((time.monotonic() - started) * 1000)
    return {"protocol": PROTOCOL, "ok": True, "result": result}


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - 请求体不可解析：明确失败，无从发起 provider 调用
        _emit(
            _error_envelope(
                BridgeError(
                    "validation_failed",
                    "invalid-request",
                    f"{type(exc).__name__}: {exc}",
                    True,
                    "request",
                )
            )
        )
        return 0
    try:
        if not isinstance(request, dict) or int(request.get("protocol") or 0) != PROTOCOL:
            raise BridgeError(
                "validation_failed", "invalid-request", "protocol mismatch", True, "request"
            )
    except BridgeError as failure:
        _emit(_error_envelope(failure))
        return 0
    except Exception as exc:  # noqa: BLE001
        _emit(_error_envelope(_fail("request", exc)))
        return 0
    try:
        payload = asyncio.run(_dispatch(request))
    except BridgeError as failure:
        _emit(_error_envelope(failure))
        return 0
    except Exception as exc:  # noqa: BLE001 - 兜底，仍给出结构化错误
        _emit(_error_envelope(_fail("internal", exc, definite_override=False)))
        traceback.print_exc(file=sys.stderr)
        return 0
    _emit(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
