/**
 * 通用 cursor 分页形状（03 §6 分页信封的服务端读面）。独立文件避免各 repository 端口
 * 与 StoragePort 之间出现类型环。
 */
export interface CursorPage<Item> {
  items: Item[];
  nextCursor?: string;
}
