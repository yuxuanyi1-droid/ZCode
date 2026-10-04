# @zcode/sandbox-provisioner

A standalone HTTP service that creates cloud sandboxes and returns an SSH attach handle for them.
It is the counterpart to the client-side `SandboxProvisionerClient` in `@zcode/server`.

## Why this exists

ZCode attaches to sandboxes; it never owns them. Creating a sandbox requires cloud credentials that
must not live on the end user's machine, and destroying one must not happen because a ZCode process
crashed, reconnected, or the user switched workspaces. So the lifecycle lives here instead:

- **Create only.** The service exposes exactly one mutating operation, `POST /sandboxes`. There is no
  delete endpoint — expiry is the provider's job (see `timeoutSeconds` below).
- **Stateless.** No database, no per-sandbox state. Everything needed to attach is in the response.
- **Bring your own credentials.** A provider with no credentials configured is reported as
  unconfigured by `/healthz` and answers `503` when requested.

## Endpoints

| Method | Path         | Purpose                                                               |
| ------ | ------------ | --------------------------------------------------------------------- |
| `GET`  | `/healthz`   | `{ ok, providers: [{ provider, configured }] }`. Never authenticated. |
| `POST` | `/sandboxes` | Create a sandbox. Returns `201` with a `SandboxProvisionResult`.      |

`POST /sandboxes` takes a `SandboxProvisionRequest` (`@zcode/shared`):

```jsonc
{
  "provider": "modal", // modal | e2b | daytona
  "repository": { "owner": "group/subgroup", "name": "repo" },
  "branch": "main",
  "ref": "v1.2.3", // optional; checked out detached
  "workspacePath": "/workspace/repo", // optional; must stay under /workspace
  "timeoutSeconds": 7200, // optional; clamped to the provider limit
}
```

and returns a `SandboxProvisionResult` whose `ssh` block is ready to pass to the client's
`SandboxSSHAttach`. **`ssh.privateKey` is an inline, one-off ed25519 key generated per request** — the
service can't write a file on the caller's machine, so the key is delivered inline and never
persisted or logged. The matching public key is written into the sandbox's `authorized_keys`.

Requested paths are validated against `SANDBOX_WORKSPACE_ROOT` (`/workspace`); requested timeouts are
clamped to a per-provider maximum. Both rules live in `@zcode/shared` so the client can reason about
the same values.

## Providers

All three run the same in-sandbox bootstrap (`src/sandboxBootstrap.ts`): install `git` and
`openssh-server` if missing, generate host keys, write `authorized_keys`, start `sshd`, optionally
start a WebSocket relay, then shallow-clone the repository.

| Provider  | Attach transport  | Notes                                                            |
| --------- | ----------------- | ---------------------------------------------------------------- |
| `modal`   | TCP (`tcpSocket`) | sshd inside the sandbox, exposed via `unencryptedPorts: [22]`.   |
| `daytona` | TCP               | Daytona's SSH gateway; the access token is the SSH **username**. |
| `e2b`     | **WebSocket**     | E2B exposes ports only over HTTPS/WSS — see below.               |

### E2B needs a template and a relay

E2B has no bare-TCP ingress, so the sandbox cannot simply listen on port 22. Instead:

1. The bootstrap downloads [`websocat`](https://github.com/vi/websocat) and starts
   `websocat --binary ws-l:0.0.0.0:<relayPort> tcp:127.0.0.1:22`, bridging WebSocket → local sshd.
2. The service returns a `{ kind: "websocket", url: "wss://<sandbox-host>" }` transport, and the
   client speaks SSH over that WebSocket.

`E2B_TEMPLATE` must name a template whose image can run the bootstrap (a Debian/Ubuntu base works).
Setting `SANDBOX_PACKAGES_PREINSTALLED=1` skips the `apt-get` step entirely — use it with a template
that already ships `git`, `openssh-server`, `curl`, and `websocat` to cut cold-start time and remove
the dependency on apt reachability. `E2B_WEBSOCAT_VERSION` pins the relay binary.

The WebSocket-only transport is why `createOpenInEditorRemoteTarget` returns `null` for E2B — an
editor's Remote-SSH needs a `host:port`, which E2B does not expose.

## Configuration

All configuration is environment variables; there are no config files.

| Variable                                                 | Default              | Purpose                                                  |
| -------------------------------------------------------- | -------------------- | -------------------------------------------------------- |
| `SANDBOX_PROVISIONER_HOST`                               | `127.0.0.1`          | Listen address.                                          |
| `SANDBOX_PROVISIONER_PORT`                               | `8788`               | Listen port.                                             |
| `ZCODE_SANDBOX_PROVISIONER_TOKEN`                        | _(unset)_            | Shared bearer token. **Same variable the client reads.** |
| `SANDBOX_GIT_BASE_URL`                                   | `https://github.com` | Base for clone URLs (`owner/name` is appended).          |
| `SANDBOX_PACKAGES_PREINSTALLED`                          | `false`              | Skip the bootstrap's package install step.               |
| `MODAL_APP_NAME`                                         | `zcode-sandboxes`    | Modal app the sandboxes belong to.                       |
| `MODAL_BASE_IMAGE`                                       | `debian:12`          | Image for the generated Modal image.                     |
| `DAYTONA_API_KEY` / `DAYTONA_API_URL` / `DAYTONA_TARGET` | _(unset)_            | Daytona credentials; absent ⇒ `daytona` is unconfigured. |
| `DAYTONA_IMAGE`                                          | `debian:12`          | Snapshot/image name.                                     |
| `DAYTONA_SSH_HOST`                                       | `ssh.app.daytona.io` | Daytona SSH gateway host.                                |
| `E2B_TEMPLATE`                                           | `base`               | E2B template to create from.                             |
| `E2B_RELAY_PORT`                                         | `8081`               | Sandbox port for the WebSocket relay.                    |
| `E2B_WEBSOCAT_VERSION`                                   | `1.13.0`             | Pinned websocat release.                                 |

E2B and Modal read credentials from the SDK's own environment (`E2B_API_KEY`, `MODAL_TOKEN_ID` /
`MODAL_TOKEN_SECRET`); Daytona's are listed above because the driver constructs its client directly.

**Security.** Without `ZCODE_SANDBOX_PROVISIONER_TOKEN`, the service performs no authentication —
anyone who can reach it can create sandboxes on your cloud accounts. The default bind is loopback,
and startup logs a warning if you expose it without a token.

## Running

```bash
# from the repository root
pnpm --filter @zcode/sandbox-provisioner exec tsx src/main.ts

# tests
pnpm exec tsx --test packages/sandbox-provisioner/test/*.test.ts
```

The provider SDKs (`modal`, `@daytonaio/sdk`, `e2b`) are **optional dependencies**: a deployment that
only uses one provider does not need the other two installed. A missing SDK is reported as an
unconfigured provider, not a crash.
