import type { IChannel, IServerChannel } from "@zcode/rpc";

/** 把上游 ChannelClient 的 channel 透明转发为下游 ChannelServer 的 channel。 */
export function proxyChannel(channel: IChannel): IServerChannel {
  return {
    call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
      return channel.call<T>(command, arg);
    },
    listen<T>(_ctx: string, event: string, arg?: unknown) {
      return channel.listen<T>(event, arg);
    },
  };
}
