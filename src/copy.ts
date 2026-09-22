/**
 * 插件自带文案（zh-CN / en），按宿主语言即时切换。
 * 上游 TokenTracker 的 zh 文案见 dashboard/src/content/i18n/zh/{core,dashboard}.json。
 */
export interface Copy {
  title: string;
  subtitle: string;
  commandTitle: string;
  commandKeywords: string[];
  checking: string;
  state: Record<"none" | "minor" | "major" | "critical" | "unknown", string>;
  refresh: string;
  refreshHint: string;
  lastChecked: (time: string) => string;
  sourceNote: string;
  openPage: (provider: string) => string;
  openFailed: string;
}

const ZH: Copy = {
  title: "服务状态",
  subtitle: "来自各 AI 提供商官方状态页的实时事故状态。",
  commandTitle: "打开服务状态",
  commandKeywords: ["status", "服务状态", "事故", "状态页"],
  checking: "检查中…",
  state: {
    none: "运行正常",
    minor: "轻微事故",
    major: "重大事故",
    critical: "严重故障",
    unknown: "无法访问",
  },
  refresh: "刷新",
  refreshHint: "立即重新探测全部提供商",
  lastChecked: (time) => `检查于 ${time}`,
  sourceNote: "经宿主网络白名单读取各提供商公开状态页，每分钟自动刷新。",
  openPage: (provider) => `在浏览器中打开 ${provider} 状态页`,
  openFailed: "打开状态页失败：系统打开器不可用（检查插件权限）。",
};

const EN: Copy = {
  title: "Service Status",
  subtitle: "Live incident state from each AI provider's official status page.",
  commandTitle: "Open service status",
  commandKeywords: ["status", "service status", "incident", "status page"],
  checking: "Checking…",
  state: {
    none: "All systems operational",
    minor: "Minor incident",
    major: "Major incident",
    critical: "Critical outage",
    unknown: "Unreachable",
  },
  refresh: "Refresh",
  refreshHint: "Re-probe every provider now",
  lastChecked: (time) => `Checked at ${time}`,
  sourceNote: "Reads public status pages through the host's network allowlist; refreshes every minute.",
  openPage: (provider) => `Open the ${provider} status page in the browser`,
  openFailed: "Could not open the status page: no system opener available (check plugin permissions).",
};

export function copy(locale: string): Copy {
  return locale.startsWith("zh") ? ZH : EN;
}
