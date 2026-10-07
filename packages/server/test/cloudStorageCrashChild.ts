/**
 * 崩溃注入子进程（W2 §6「提交前后 crash」、03 §4 崩溃恢复承诺）。
 *
 * 由 cloudStorageCrash.test.ts 以真实子进程启动，故意用 `process.exit()` 退出——
 * 不执行 ROLLBACK、不 close 数据库，等于控制面在写入中途被 kill。父进程随后重新
 * 打开同一个库，断言：
 *   - 未提交事务被回滚（没有半截事实）；
 *   - 已提交事务在进程非正常退出后仍然存在（synchronous=FULL 的承诺）。
 */
import {
  openStorageDatabase,
  withWriteTransaction,
} from "../src/cloud/adapters/storage/sqlite/database.js";
import { runCloudMigrations } from "../src/cloud/adapters/storage/sqlite/migrations.js";
import { createCloudStorage } from "../src/cloud/adapters/storage/cloudStorageClient.js";
import type { AcceptInputRequest } from "../src/cloud/app/ports/storagePort.js";

const CRASH_EXIT_CODE = 2;

function crash(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(CRASH_EXIT_CODE);
  throw new Error("unreachable");
}

async function acceptInputThenCrash(payloadJson: string): Promise<never> {
  const payload = JSON.parse(payloadJson) as {
    root: string;
    request: AcceptInputRequest;
  };
  const storage = await createCloudStorage({
    dataDir: `${payload.root}/data`,
    attachmentsDir: `${payload.root}/attachments`,
    transportMode: "in-process",
  });
  const result = await storage.storage.acceptInput(payload.request);
  // 提交已经返回（DB 成功）才可能走到这里：此刻崩溃模拟「DB 已提交、HTTP 回包丢失」。
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(CRASH_EXIT_CODE);
}

function rawTransactionCrash(databasePath: string, mode: string): never {
  const context = openStorageDatabase({ path: databasePath, synchronous: "FULL" });
  runCloudMigrations(context, { now: 1_760_000_000_000 });
  const write = (): void => {
    context.db
      .prepare(
        "INSERT INTO principals (principal_id, disabled, created_at, updated_at) VALUES ('crash-principal', 0, 1, 1)",
      )
      .run();
    context.db
      .prepare(
        "INSERT INTO principals (principal_id, disabled, created_at, updated_at) VALUES ('crash-principal-2', 0, 1, 1)",
      )
      .run();
  };
  if (mode === "raw-before-commit") {
    context.db.exec("BEGIN IMMEDIATE");
    write();
    // 不 COMMIT、不 ROLLBACK、不 close：进程直接消失。
    process.exit(CRASH_EXIT_CODE);
  }
  if (mode === "raw-after-commit") {
    withWriteTransaction(context, write);
    process.exit(CRASH_EXIT_CODE);
  }
  crash(`未知崩溃模式 ${mode}`);
}

const [, , mode, argument] = process.argv;
if (mode === "accept-input") {
  await acceptInputThenCrash(argument as string);
} else {
  rawTransactionCrash(argument as string, mode as string);
}
