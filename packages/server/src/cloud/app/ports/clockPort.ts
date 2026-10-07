/**
 * 时钟端口（W1 §3 app 层经端口取时间）。
 *
 * domain 的判定一律接收显式 `now`；app 通过本端口取当前时间，测试注入受控时钟
 * （10 §5 层级表：domain 单测注入 clock、无 IO、不用真实 sleep 等状态同步）。
 */
export interface ClockPort {
  /** epoch 毫秒（与 zcode-protocol-v4 Timestamp、shared cloud 契约一致）。 */
  now(): number;
}
