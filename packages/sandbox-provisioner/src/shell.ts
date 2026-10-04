/**
 * 单引号包裹一段 shell 字面量。
 *
 * 所有插进脚本的**外部输入**都必须过这里。单引号是唯一在 POSIX shell 里完全字面的
 * 引用方式：内部单引号用 `'\''` 逃出再进。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 把一段文本变成"写文件"的 shell 片段。
 *
 * 走 base64 而不是 heredoc：authorized_keys / 私钥这类内容含换行和任意字节，
 * heredoc 的终止符匹配和 `<<-` 缩进都会成为隐患。`printf '%s'` 不带换行，
 * 解出来与原文逐字节一致。
 */
export function shellWriteFile(path: string, contents: string, mode = "600"): string {
  const encoded = Buffer.from(contents, "utf8").toString("base64");
  return [
    `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
    `chmod ${mode} ${shellQuote(path)}`,
  ].join("\n");
}
