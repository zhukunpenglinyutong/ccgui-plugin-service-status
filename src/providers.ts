/**
 * 状态探针：三源适配（Statuspage.io / Instatus / Google incidents）。
 *
 * 移植自 TokenTracker `dashboard/src/pages/ServiceStatusPage.jsx`（MIT，见仓库
 * 根 THIRD_PARTY_NOTICES.md），差异只在传输层：上游用浏览器 `fetch`，本插件
 * 一律走宿主 `plugin_http_request` 代理（CSP 禁止 webview 直接出网，且域名必须
 * 在 manifest 里逐个声明）。解析逻辑与指标语义保持一致。
 */
import { httpGet, withTimeout } from "./host";

export type Indicator = "none" | "minor" | "major" | "critical" | "unknown";

export interface Provider {
  id: string;
  name: string;
  /** 状态页地址；也是「在浏览器中打开」的目标。 */
  pageUrl: string;
  apiUrl: string;
  /** 探针类型；缺省 = Statuspage.io `/api/v2/status.json`。 */
  kind?: "statuspage" | "instatus" | "google";
  /** Google 共享一份 incidents feed，按服务名过滤。 */
  serviceName?: string;
}

export interface ProbeResult {
  indicator: Indicator;
  description: string;
  updatedAt: string | null;
}

const VALID_INDICATORS = new Set(["none", "minor", "major", "critical"]);

/** 与上游一致的 8 家；Grok / DeepSeek 等被 bot 校验挡住，z.ai / Kiro / Qoder 无公开 API，故不在表内。 */
export const STATUS_PROVIDERS: Provider[] = [
  {
    id: "claude",
    name: "Claude",
    // status.anthropic.com 302 到 status.claude.com，直接用规范主机。
    apiUrl: "https://status.claude.com/api/v2/status.json",
    pageUrl: "https://status.claude.com",
  },
  {
    id: "openai",
    name: "OpenAI / Codex",
    apiUrl: "https://status.openai.com/api/v2/status.json",
    pageUrl: "https://status.openai.com",
  },
  {
    id: "cursor",
    name: "Cursor",
    apiUrl: "https://status.cursor.com/api/v2/status.json",
    pageUrl: "https://status.cursor.com",
  },
  {
    id: "github",
    name: "GitHub / Copilot",
    apiUrl: "https://www.githubstatus.com/api/v2/status.json",
    pageUrl: "https://www.githubstatus.com",
  },
  {
    id: "gemini",
    name: "Gemini",
    kind: "google",
    serviceName: "Gemini",
    apiUrl: "https://www.google.com/appsstatus/dashboard/incidents.json",
    pageUrl: "https://www.google.com/appsstatus/dashboard",
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot",
    apiUrl: "https://status.moonshot.cn/api/v2/status.json",
    pageUrl: "https://status.moonshot.cn",
  },
  {
    id: "minimax",
    name: "MiniMax",
    apiUrl: "https://status.minimaxi.com/api/v2/status.json",
    pageUrl: "https://status.minimaxi.com",
  },
  {
    id: "zed",
    name: "Zed",
    kind: "instatus",
    apiUrl: "https://status.zed.dev/summary.json",
    pageUrl: "https://status.zed.dev",
  },
];

/** 上游同值：单次探针 8s，页面每分钟自动刷新。 */
export const PROBE_TIMEOUT_MS = 8_000;
export const REFRESH_INTERVAL_MS = 60_000;

/** Google incidents feed severity → Statuspage 风格 indicator。 */
const GOOGLE_SEVERITY_TO_INDICATOR: Record<string, Indicator> = {
  low: "minor",
  medium: "major",
  high: "critical",
};

/** Instatus activeIncident impact → Statuspage 风格 indicator。 */
const INSTATUS_IMPACT_TO_INDICATOR: Record<string, Indicator> = {
  MAJOROUTAGE: "critical",
  PARTIALOUTAGE: "major",
  DEGRADEDPERFORMANCE: "minor",
};

const RANK: Record<string, number> = { critical: 3, major: 2, minor: 1 };

function worstOf<T>(items: T[], toCandidate: (item: T) => { indicator: Indicator; description: string; updatedAt: string | null }) {
  let worst: { indicator: Indicator; description: string; updatedAt: string | null } | null = null;
  for (const item of items) {
    const candidate = toCandidate(item);
    if (!worst || (RANK[candidate.indicator] ?? 0) > (RANK[worst.indicator] ?? 0)) worst = candidate;
  }
  return worst;
}

/** Instatus `/summary.json`：page.status 只有 UP / HASISSUES，事故按 impact 取最严重。 */
export function parseInstatusSummary(body: unknown): ProbeResult {
  const pageStatus = (body as { page?: { status?: unknown } })?.page?.status;
  if (typeof pageStatus !== "string") throw new Error("Unexpected payload");
  if (pageStatus === "UP") return { indicator: "none", description: "", updatedAt: null };
  const incidents = Array.isArray((body as { activeIncidents?: unknown }).activeIncidents)
    ? ((body as { activeIncidents: unknown[] }).activeIncidents as Record<string, unknown>[])
    : [];
  const worst = worstOf(incidents, (incident) => ({
    indicator: INSTATUS_IMPACT_TO_INDICATOR[String(incident?.impact)] ?? "minor",
    description: typeof incident?.name === "string" ? incident.name : "",
    updatedAt: typeof incident?.updated === "string" ? incident.updated : null,
  }));
  // HASISSUES 但没给出事故明细，仍然意味着「有问题」。
  return worst ?? { indicator: "minor", description: "", updatedAt: null };
}

/** Google feed：未结束（无 `end`）的事故里，取该服务最严重的一条。 */
export function parseGoogleIncidents(body: unknown, serviceName: string): ProbeResult {
  if (!Array.isArray(body)) throw new Error("Unexpected payload");
  const open = (body as Record<string, unknown>[]).filter(
    (incident) =>
      incident &&
      !incident.end &&
      (incident.service_name === serviceName ||
        (Array.isArray(incident.affected_products) &&
          (incident.affected_products as Record<string, unknown>[]).some((product) => product?.title === serviceName))),
  );
  if (open.length === 0) return { indicator: "none", description: "", updatedAt: null };
  const worst = worstOf(open, (incident) => ({
    indicator: GOOGLE_SEVERITY_TO_INDICATOR[String(incident.severity)] ?? "minor",
    description: typeof incident.external_desc === "string" ? incident.external_desc : "",
    updatedAt: typeof incident.modified === "string" ? incident.modified : null,
  }));
  return worst ?? { indicator: "minor", description: "", updatedAt: null };
}

/** Statuspage.io `/api/v2/status.json`。 */
export function parseStatuspage(body: unknown): ProbeResult {
  const indicator = (body as { status?: { indicator?: unknown } })?.status?.indicator;
  if (typeof indicator !== "string" || !VALID_INDICATORS.has(indicator)) {
    throw new Error("Unexpected payload");
  }
  const description = (body as { status?: { description?: unknown } })?.status?.description;
  const updatedAt = (body as { page?: { updated_at?: unknown } })?.page?.updated_at;
  return {
    indicator: indicator as Indicator,
    description: typeof description === "string" ? description : "",
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
  };
}

/**
 * 探测一家提供商的状态。永不抛错：HTTP 失败 / 超时 / 载荷不合法一律落
 * `unknown`（状态页本身挂掉也是一个信号，但不冒充任何一种事故等级）。
 */
export async function probeProvider(provider: Provider): Promise<ProbeResult> {
  const failed: ProbeResult = { indicator: "unknown", description: "", updatedAt: null };
  try {
    const res = await withTimeout(
      httpGet(provider.apiUrl),
      PROBE_TIMEOUT_MS + 2_000,
      `status probe ${provider.id}`,
    );
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body: unknown = JSON.parse(res.body);
    if (provider.kind === "google") return parseGoogleIncidents(body, provider.serviceName ?? "");
    if (provider.kind === "instatus") return parseInstatusSummary(body);
    return parseStatuspage(body);
  } catch {
    return failed;
  }
}

/** 并行探测全部提供商，保持表内顺序。 */
export async function probeAll(providers: Provider[] = STATUS_PROVIDERS): Promise<Record<string, ProbeResult>> {
  const entries = await Promise.all(
    providers.map(async (provider): Promise<[string, ProbeResult]> => [provider.id, await probeProvider(provider)]),
  );
  return Object.fromEntries(entries);
}
