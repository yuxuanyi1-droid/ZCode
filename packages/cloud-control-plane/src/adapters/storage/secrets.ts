import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PREFIX = "enc:v1:";

/** 凭据信封与 attach token 的静态加密；密钥落在数据目录，权限 0600。 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  public static async fromDataDir(dataDir: string): Promise<SecretBox> {
    await mkdir(dataDir, { recursive: true });
    const path = join(dataDir, "secret.key");
    let key: Buffer;
    try {
      key = await readFile(path);
    } catch {
      key = randomBytes(32);
      await writeFile(path, key, { mode: 0o600 });
      await chmod(path, 0o600);
    }
    if (key.length !== 32) {
      throw new Error("invalid cloud secret key length");
    }
    return new SecretBox(key);
  }

  public encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
  }

  public decrypt(value: string): string {
    if (!value.startsWith(PREFIX)) {
      throw new Error("unsupported secret envelope");
    }
    const [ivPart, tagPart, cipherPart] = value.slice(PREFIX.length).split(":");
    if (!ivPart || !tagPart || !cipherPart) {
      throw new Error("malformed secret envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
