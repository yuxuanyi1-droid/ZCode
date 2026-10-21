import type { GitHubAppClient } from "../adapters/github/githubApp.js";
import type { RunAttachment } from "../adapters/tunnel/server.js";
import type { RunRecord, TaskRecord } from "../domain/types.js";
import { execCollect, resolveCloneUrl, type GitHubRunMeta } from "./githubPublish.js";

/** clone 一次；暂停恢复后工作区已存在则跳过。 */
export async function checkoutWorkspace(input: {
  attachment: RunAttachment;
  task: TaskRecord;
  run: RunRecord;
  project: { repoUrl: string; defaultBranch: string };
  gitHub: GitHubAppClient | null | undefined;
  onGitHubMeta: (meta: GitHubRunMeta) => void;
}): Promise<void> {
  const { attachment, task, run, project } = input;
  const already = await execCollect(attachment, [
    "/bin/sh",
    "-c",
    `test -d '${run.checkoutPath}/.git' && echo yes`,
  ]).catch(() => "");
  if (already.trim() === "yes") {
    return;
  }
  const clone = await resolveCloneUrl({
    gitHub: input.gitHub,
    repoUrl: project.repoUrl,
    task,
    run,
  });
  if (clone.meta) {
    input.onGitHubMeta(clone.meta);
  }
  const duplex = await attachment.openStream("exec", [
    "git",
    // HTTP/2 在部分出口代理/沙箱网络上会以 framing 错误中断 clone；固定 HTTP/1.1 更稳。
    "-c",
    "http.version=HTTP/1.1",
    "clone",
    // 非 GitHub 的 dumb HTTP/静态仓库不支持浅克隆；只在 GitHub 上使用 --depth 1。
    ...(clone.url.includes("github.com") ? ["--depth", "1"] : []),
    "--branch",
    task.baseBranch ?? project.defaultBranch,
    clone.url,
    run.checkoutPath,
  ]);
  let output = "";
  duplex.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > 20_000) {
      output = output.slice(-20_000);
    }
  });
  await new Promise<void>((resolve, reject) => {
    duplex.once("end", () => resolve());
    duplex.once("error", (error) => reject(error));
  }).catch((error: unknown) => {
    throw new Error(
      `checkout failed: ${error instanceof Error ? error.message : String(error)} ${output}`,
    );
  });
}
