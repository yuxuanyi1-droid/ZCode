import type { GitHubAppClient } from "../adapters/github/githubApp.js";
import type { CloudStore } from "../adapters/storage/db.js";
import type { RunAttachment } from "../adapters/tunnel/server.js";
import type { RunRecord, TaskRecord } from "../domain/types.js";
import { parseGitHubRepo } from "./support.js";

export interface GitHubRunMeta {
  owner: string;
  name: string;
  installationId: number;
  baseBranch: string;
  taskBranch: string;
}

export async function execCollect(attachment: RunAttachment, argv: string[]): Promise<string> {
  const duplex = await attachment.openStream("exec", argv);
  let output = "";
  duplex.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > 200_000) {
      output = output.slice(-200_000);
    }
  });
  await new Promise<void>((resolve, reject) => {
    duplex.once("end", () => resolve());
    duplex.once("error", (error) => reject(error));
  });
  return output;
}

export async function resolveCloneUrl(input: {
  gitHub: GitHubAppClient | null | undefined;
  repoUrl: string;
  task: TaskRecord;
  run: RunRecord;
}): Promise<{ url: string; meta: GitHubRunMeta | null }> {
  const parsed = parseGitHubRepo(input.repoUrl);
  const gitHub = input.gitHub;
  if (!parsed || !gitHub) {
    return { url: input.repoUrl, meta: null };
  }
  const installationId = gitHub.allowedInstallationIds[0];
  if (!installationId) {
    return { url: input.repoUrl, meta: null };
  }
  const token = await gitHub.installationToken(installationId, {
    repositories: [parsed.name],
    permissions: { contents: "read", metadata: "read" },
  });
  return {
    url: `https://x-access-token:${token}@github.com/${parsed.owner}/${parsed.name}.git`,
    meta: {
      owner: parsed.owner,
      name: parsed.name,
      installationId,
      baseBranch: input.task.baseBranch ?? "main",
      taskBranch: input.task.taskBranch ?? `zcode/${input.task.taskStableId}`,
    },
  };
}

/** 停止前把沙箱内改动发布为分支/PR；失败只标记 dataAtRisk，不阻断停止。 */
export async function publishArtifact(input: {
  gitHub: GitHubAppClient;
  meta: GitHubRunMeta;
  attachment: RunAttachment;
  run: RunRecord;
  task: TaskRecord;
  store: CloudStore;
}): Promise<void> {
  const { gitHub, meta, attachment, run, task, store } = input;
  const status = await execCollect(attachment, [
    "git",
    "-C",
    run.checkoutPath,
    "status",
    "--porcelain",
  ]).catch(() => "");
  if (!status.trim()) {
    store.setArtifact({ taskId: task.id, kind: "noChanges" });
    return;
  }
  const token = await gitHub.installationToken(meta.installationId, {
    repositories: [meta.name],
    permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  });
  const remote = `https://x-access-token:${token}@github.com/${meta.owner}/${meta.name}.git`;
  await execCollect(attachment, [
    "git",
    "-C",
    run.checkoutPath,
    "config",
    "user.email",
    "cloud@zcode.dev",
  ]);
  await execCollect(attachment, [
    "git",
    "-C",
    run.checkoutPath,
    "config",
    "user.name",
    "ZCode Cloud",
  ]);
  await execCollect(attachment, ["git", "-C", run.checkoutPath, "add", "-A"]);
  await execCollect(attachment, [
    "git",
    "-C",
    run.checkoutPath,
    "commit",
    "-m",
    `zcode: ${task.title}`,
  ]);
  const sha = (
    await execCollect(attachment, ["git", "-C", run.checkoutPath, "rev-parse", "HEAD"])
  ).trim();
  await execCollect(attachment, [
    "git",
    "-C",
    run.checkoutPath,
    "push",
    remote,
    `HEAD:refs/heads/${meta.taskBranch}`,
  ]);
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  if (meta.taskBranch !== meta.baseBranch) {
    try {
      const pr = await gitHub.createPullRequest(
        {
          owner: meta.owner,
          name: meta.name,
          head: meta.taskBranch,
          base: meta.baseBranch,
          title: task.title,
          body: `Cloud task ${task.taskStableId}`,
        },
        token,
      );
      prNumber = pr.number;
      prUrl = pr.url;
    } catch {
      // 已存在同名 PR 时保留 artifact 但 prStatus=missing，由用户处理。
    }
  }
  store.setArtifact({
    taskId: task.id,
    kind: "code",
    taskBranch: meta.taskBranch,
    prNumber,
    prUrl,
    prStatus: prNumber ? "open" : "missing",
    publishedSha: sha,
  });
}
