/**
 * 状态探针：Statuspage.io / Instatus / Google incidents 三源适配，另加无公开
 * 状态页厂商的 HTTP 连通性探测（kind "http"）。
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
  /** 探针类型；缺省 = Statuspage.io `/api/v2/status.json`；"http" = 无状态页厂商的连通性探测。 */
  kind?: "statuspage" | "instatus" | "google" | "http";
  /** Google 共享一份 incidents feed，按服务名过滤。 */
  serviceName?: string;
  /**
   * 指示器非 none 时，再查一次 `/api/v2/incidents/unresolved.json` 复核：
   * 上游偶尔把事故全部 resolved 却忘了把 indicator 复位，此时应按「运行正常」显示。
   * 同域名，不额外申请 network 授权。
   */
  verifyUnresolved?: boolean;
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
    // status.cursor.com 301 到 status.x.ai（Cursor 状态页已并入 xAI 状态基建），
    // 直接打规范主机：宿主按「每一跳」校验 network 授权，跟着 301 走会越权失败。
    apiUrl: "https://status.x.ai/api/compat/status.json",
    pageUrl: "https://status.x.ai",
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
    // 2026-11-01 实测：事故全部 resolved 后 status.json 仍返回 minor，故加未关闭事故复核。
    verifyUnresolved: true,
    apiUrl: "https://status.moonshot.cn/api/v2/status.json",
    pageUrl: "https://status.moonshot.cn",
  },
  {
    id: "minimax",
    name: "MiniMax",
    // MiniMax 无公开状态页（status.minimaxi.com 域名未注册，公网 NXDOMAIN），
    // 退化为对官方平台域名的 HTTP 连通性探测：拿到任意响应即「运行正常」。
    // platform.minimaxi.com 302 到 platform.minimax.cn，直接探落地域名，少一跳也少一次跨域授权。
    kind: "http",
    apiUrl: "https://platform.minimax.cn/",
    pageUrl: "https://platform.minimax.cn",
  },
  {
    id: "zed",
    name: "Zed",
    kind: "instatus",
    apiUrl: "https://status.zed.dev/summary.json",
    pageUrl: "https://status.zed.dev",
  },
];

/**
 * 单次探针 12s（上游原为 8s），页面每分钟自动刷新。
 * 实测走代理时 status 页 3~5s 才回，10s 软超时余量偏薄，会把慢回当成「无法访问」。
 */
export const PROBE_TIMEOUT_MS = 12_000;
export const REFRESH_INTERVAL_MS = 60_000;
/** 一次刷新内失败重试：瞬时抖动不该直接表现为「无法访问」。 */
const PROBE_ATTEMPTS = 2;
const PROBE_RETRY_DELAY_MS = 350;
/** 失败原因写进 description 供排查，太长会撑破卡片。 */
const MAX_REASON_LENGTH = 160;

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
 * 宿主侧错误信息的可读化：去掉内部标签前缀并截断。
 * 典型值：`redirect to status.x.ai:443 is not covered by a network grant`、
 * `request failed: error sending request`、`timeout after 14000ms`。
 */
export function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw
    .replace(/^service-status:\s*/i, "")
    .replace(/^status (?:probe|incidents) [a-z0-9-]+:\s*/i, "")
    .trim();
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

/**
 * 指示器非 none 时的复核：`/api/v2/incidents/unresolved.json` 一条未关闭事故都没有，
 * 说明 indicator 是上游忘记复位的残留，按正常处理。查询失败一律按「有事故」兜底，
 * 宁可显示上游状态也不掩盖真实故障。
 */
async function hasNoUnresolvedIncident(provider: Provider): Promise<boolean> {
  try {
    const url = new URL("/api/v2/incidents/unresolved.json", provider.apiUrl).href;
    const res = await withTimeout(httpGet(url), PROBE_TIMEOUT_MS + 2_000, `status incidents ${provider.id}`);
    if (res.status !== 200) return false;
    const body: unknown = JSON.parse(res.body);
    const incidents = (body as { incidents?: unknown })?.incidents;
    return Array.isArray(incidents) && incidents.length === 0;
  } catch {
    return false;
  }
}

/**
 * 探测一家提供商的状态。永不抛错：HTTP 失败 / 超时 / 载荷不合法一律落
 * `unknown`（状态页本身挂掉也是一个信号，但不冒充任何一种事故等级），
 * 失败原因写进 description，避免「无法访问」四个字把域名迁移、断网、越权全糊在一起。
 */
export async function probeProvider(provider: Provider): Promise<ProbeResult> {
  let reason = "";
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    try {
      const res = await withTimeout(
        httpGet(provider.apiUrl),
        PROBE_TIMEOUT_MS + 2_000,
        `status probe ${provider.id}`,
      );
      if (provider.kind === "http") {
        // 无状态页厂商：任意 HTTP 响应（含 3xx/4xx）都证明服务可达；5xx 记降级。
        if (res.status >= 500) return { indicator: "minor", description: `HTTP ${res.status}`, updatedAt: null };
        if (res.status > 0) return { indicator: "none", description: "", updatedAt: null };
        throw new Error(`HTTP ${res.status}`);
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body: unknown = JSON.parse(res.body);
      const result =
        provider.kind === "google"
          ? parseGoogleIncidents(body, provider.serviceName ?? "")
          : provider.kind === "instatus"
            ? parseInstatusSummary(body)
            : parseStatuspage(body);
      if (provider.verifyUnresolved && result.indicator !== "none" && (await hasNoUnresolvedIncident(provider))) {
        return { indicator: "none", description: "", updatedAt: result.updatedAt };
      }
      return result;
    } catch (error) {
      reason = describeFailure(error);
      if (attempt < PROBE_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
    }
  }
  return { indicator: "unknown", description: reason, updatedAt: null };
}

/** 并行探测全部提供商，保持表内顺序。 */
export async function probeAll(providers: Provider[] = STATUS_PROVIDERS): Promise<Record<string, ProbeResult>> {
  const entries = await Promise.all(
    providers.map(async (provider): Promise<[string, ProbeResult]> => [provider.id, await probeProvider(provider)]),
  );
  return Object.fromEntries(entries);
}
