/**
 * 标识符生成端口（03 §4：taskId/runId/operationId/commandId 均由服务端生成、
 * 不可拼读，shared 的 `cloudUuidSchema` 固定其形态）。
 *
 * app 不直接调用 `crypto.randomUUID`，测试可注入确定性序列以复现并发场景
 * （11 §10 CT-10「同毫秒反序 UUID」一类用例需要可控 id）。
 */
export interface IdGeneratorPort {
  /** 返回符合 shared `cloudUuidSchema` 的字符串。 */
  newId(): string;
  /** 生成绑定 run 的短效自举票据（01 §6.2：无 App/provider key，单次、run-scoped）。 */
  newSecret(): string;
}
