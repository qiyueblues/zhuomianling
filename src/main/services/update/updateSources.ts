import type { AppUpdateSource } from "../../../shared/types/appUpdate";

export const ossUpdateUrl = "https://zhuomianling.oss-cn-beijing.aliyuncs.com/updates/windows/";

/** Only application-owned public locations; never accept a URL over IPC. */
export function updateFeed(source: AppUpdateSource, version?: string): {
  provider: "generic"; url: string; useMultipleRangeRequest: false;
} {
  if (source === "oss") return { provider: "generic", url: ossUpdateUrl, useMultipleRangeRequest: false };
  if (!version || !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(version)) throw new Error("invalid-update-version");
  return {
    provider: "generic", useMultipleRangeRequest: false,
    url: `https://github.com/qiyueblues/zhuomianling/releases/download/v${version}/`
  };
}
