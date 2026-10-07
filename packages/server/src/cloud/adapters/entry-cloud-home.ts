/**
 * 云入口 HOME 隔离（03 §8、12 §1.2）。
 *
 * **为什么必须在加载服务图之前做**：`packages/services/src/paths.ts` 在**模块加载时**就把
 * `process.env.HOME` 固化成默认数据目录；`settingService` 之外的 skills / hooks / commands /
 * subagents / plugin-sync / settings-sync 等一大批服务也各自直接读 `HOME`（只有 `settingService`
 * 额外认 `ZCODE_DESKTOP_HOME_DIR`）。所以"创建服务之后再 `setDataBaseDir()`"改不了这些路径。
 *
 * 实测（2026-10-07）：未隔离时云服务端把 settings 写进了运维者的真实
 * `~/.zcode/v2/setting.json`——`ZCODE_CLOUD_DATA_DIR` 形同虚设，且会污染本机既有账号态。
 *
 * 这是**进程级**隔离：把宿主 home 指向云数据目录后，host 本体落 `<dataDir>/.zcode/v2/`，
 * cloud 持久库落 `<dataDir>/cloud/`（`resolveCloudStoragePaths`），运维者真实 home 不再被读写。
 */
export function applyCloudHomeIsolation(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  env.ZCODE_DESKTOP_HOME_DIR = dataDir;
  env.HOME = dataDir;
  // USERPROFILE 只在 Windows 上存在；不存在时不要凭空造一个（避免影响其他平台的分支判断）。
  if (env.USERPROFILE !== undefined) {
    env.USERPROFILE = dataDir;
  }
  return dataDir;
}
