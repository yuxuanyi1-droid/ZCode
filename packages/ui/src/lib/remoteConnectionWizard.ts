import type {
  RemoteAssetInstallMode,
  RemoteTarget,
  SandboxProvisionRequest,
  SandboxProvider,
} from "@zcode/shared";
import { isValidWslUser, normalizeRemoteResourcePackageSelection } from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

type WizardIntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

/**
 * 向导里可供用户选择的连接类型，含 sandbox：沙箱也在同一个选择页里挑，
 * 只是它不填 host/port，而是提交后由外部 provisioner 返回 attach 信息。
 */
export type WizardRemoteKind = RemoteTarget["kind"];

/**
 * buildRemoteTarget 能同步构造出 target 的类型。
 * sandbox 的 target 要先请求 provisioner 才知道，因此排除在外，单独走 buildSandboxProvisionRequest。
 */
export type FormRemoteKind = Exclude<WizardRemoteKind, "sandbox">;

interface RemoteConnectionFormSnapshot {
  kind: FormRemoteKind;
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode?: RemoteAssetInstallMode;
  selectedSshConfigAlias?: string | null;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  dockerContainer: string;
  manualDockerContainer?: string;
}

export function getRemoteWizardStepCopy(
  intl: WizardIntlLike,
  step: RemoteWizardStep,
  kind: WizardRemoteKind,
) {
  switch (step) {
    case "kind":
      return {
        title: intl.formatMessage({ id: "remote.kindStepTitle" }),
        description: intl.formatMessage({ id: "remote.kindStepDescription" }),
      };
    case "settings":
      return {
        title: intl.formatMessage({ id: "remote.settingsStepTitle" }),
        description: intl.formatMessage(
          { id: "remote.settingsStepDescription" },
          {
            method: intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
    case "connecting":
      return {
        title: intl.formatMessage({ id: "remote.connectingStepTitle" }),
        description: intl.formatMessage(
          { id: "remote.connectingStepDescription" },
          {
            method: intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
    case "directory":
      return {
        title: intl.formatMessage({ id: "remote.selectDirectoryTitle" }),
        description: intl.formatMessage({ id: "remote.selectDirectoryDescription" }),
      };
  }
}

export function buildRemoteTarget(
  intl: WizardIntlLike,
  snapshot: RemoteConnectionFormSnapshot,
): { target?: RemoteTarget; errorMessage?: string } {
  switch (snapshot.kind) {
    case "ssh":
      if (!snapshot.host || !snapshot.username) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.required" }),
        };
      }

      if (snapshot.sshAuthMethod === "password" && !snapshot.password) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.passwordRequired" }),
        };
      }

      if (snapshot.sshAuthMethod === "privateKey" && !snapshot.privateKeyPath) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.privateKeyRequired" }),
        };
      }

      const sshConfigAlias = snapshot.selectedSshConfigAlias?.trim();

      return {
        target: {
          kind: "ssh",
          host: snapshot.host,
          port: snapshot.port ? Number(snapshot.port) : undefined,
          username: snapshot.username,
          ...(sshConfigAlias ? { sshConfigAlias } : {}),
          assetInstallMode: snapshot.assetInstallMode,
          ...(snapshot.sshAuthMethod === "password" && snapshot.password
            ? { password: snapshot.password }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPath
            ? { privateKeyPath: snapshot.privateKeyPath }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPassphrase
            ? { privateKeyPassphrase: snapshot.privateKeyPassphrase }
            : {}),
        },
      };
    case "docker":
      // Docker 运行中列表可能因为探测失败或刷新延迟不完整。
      // 手动输入必须独立于下拉选择，提交时优先使用手动输入，空值再回落到下拉选择。
      const dockerContainer =
        snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim();

      if (!dockerContainer) {
        return {
          errorMessage: intl.formatMessage({ id: "docker.validation.required" }),
        };
      }

      return {
        target: {
          kind: "docker",
          container: dockerContainer,
        },
      };
    case "wsl": {
      const wslUser = snapshot.wslUser?.trim();
      if (wslUser && !isValidWslUser(wslUser)) {
        return {
          errorMessage: intl.formatMessage({ id: "wsl.validation.invalidUser" }),
        };
      }
      return {
        target: {
          kind: "wsl",
          distro: snapshot.wslDistro || undefined,
          ...(wslUser ? { user: wslUser } : {}),
        },
      };
    }
  }
}

interface SandboxConnectionFormSnapshot {
  sandboxProvider: SandboxProvider;
  sandboxRepoOwner: string;
  sandboxRepoName: string;
  sandboxBranch: string;
}

/**
 * 沙箱表单只收集「在哪建、建哪个仓库的哪个分支」。
 * attach 信息（sandboxId / ssh）由 provisioner 决定，不在客户端凭空拼出来。
 */
export function buildSandboxProvisionRequest(
  intl: WizardIntlLike,
  snapshot: SandboxConnectionFormSnapshot,
): { request?: SandboxProvisionRequest; errorMessage?: string } {
  const owner = snapshot.sandboxRepoOwner.trim();
  const name = snapshot.sandboxRepoName.trim();
  const branch = snapshot.sandboxBranch.trim();

  if (!owner || !name || !branch) {
    return {
      errorMessage: intl.formatMessage({ id: "sandbox.validation.required" }),
    };
  }

  // repo_name 是 /workspace 下的单段目录名；带分隔符会让 clone 目标逃出预期目录。
  // owner 允许含 "/"（GitLab 子组），所以这里只校验 name。
  if (name.includes("/") || name.includes(":")) {
    return {
      errorMessage: intl.formatMessage({ id: "sandbox.validation.repoNameInvalid" }),
    };
  }

  return {
    request: {
      provider: snapshot.sandboxProvider,
      repository: { owner, name },
      branch,
    },
  };
}

export function withDefaultRemoteResourcePackages(target: RemoteTarget): RemoteTarget {
  if (target.kind !== "ssh") {
    return target;
  }

  return {
    ...target,
    resourcePackages: {
      // 当前分支只保留一个 ZCode Agent，SSH 向导再让用户手动挑资源包会产生无意义分叉。
      // 这里统一走默认 active 资源集，历史重连传入的旧选择不再影响部署范围。
      selectedPackageIds: normalizeRemoteResourcePackageSelection(),
    },
  };
}
