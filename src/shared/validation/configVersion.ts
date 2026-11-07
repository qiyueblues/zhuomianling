export class UnsupportedConfigVersionError extends Error {
  readonly code = "CONFIG_VERSION_UNSUPPORTED";

  constructor() {
    super("配置由更新版本的软件创建，请使用新版桌面灵打开。原配置未被修改。");
    this.name = "UnsupportedConfigVersionError";
  }
}

/** Missing versions are accepted only by callers that validate a known legacy shape. */
export function assertSupportedConfigVersion(
  version: unknown,
  current: number,
  supportedLegacy: readonly number[] = []
): void {
  if (version === undefined) return;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("配置格式版本无效。");
  }
  if (version > current) throw new UnsupportedConfigVersionError();
  if (version !== current && !supportedLegacy.includes(version)) throw new Error("不支持的旧配置格式版本。");
}
