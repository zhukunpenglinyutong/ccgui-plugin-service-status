import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { openExternalUrl, setHostCtx } from "./host";
import {
  STATUS_PROVIDERS,
  describeFailure,
  parseGoogleIncidents,
  parseInstatusSummary,
  parseStatuspage,
  probeAll,
  probeProvider,
} from "./providers";

const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"),
) as { permissions: string[] };

type Handler = (url: string) => { status: number; body: string } | Promise<never>;

/** 假宿主：实现被测代码用到的 bridge 命令（http 请求 + exec spawn）。 */
function stubHost(handler: Handler): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "plugin_exec_spawn") return null;
    if (command !== "plugin_http_request") throw new Error(`unexpected command ${command}`);
    return handler(String(args?.url));
  });
  setHostCtx({ bridge: { invoke } } as unknown as PluginContext);
  return invoke;
}

function json(body: unknown, status = 200) {
  return { status, body: JSON.stringify(body) };
}

const isGoogleFeed = (url: string) => url.includes("appsstatus");
const isInstatusFeed = (url: string) => url.endsWith("summary.json");

afterEach(() => setHostCtx(null));

describe("probe parsers", () => {
  it("reads a Statuspage payload", () => {
    expect(
      parseStatuspage({
        page: { updated_at: "2026-07-26T08:00:00.000Z" },
        status: { indicator: "major", description: "Elevated errors" },
      }),
    ).toEqual({ indicator: "major", description: "Elevated errors", updatedAt: "2026-07-26T08:00:00.000Z" });
  });

  it("rejects an unknown indicator instead of guessing", () => {
    expect(() => parseStatuspage({ status: { indicator: "meh" } })).toThrow();
    expect(() => parseStatuspage({ totally: "unexpected" })).toThrow();
  });

  it("maps Instatus UP / HASISSUES summaries", () => {
    expect(parseInstatusSummary({ page: { status: "UP" } }).indicator).toBe("none");
    expect(
      parseInstatusSummary({
        page: { status: "HASISSUES" },
        activeIncidents: [{ name: "Collab server degraded", impact: "PARTIALOUTAGE" }],
      }),
    ).toEqual({ indicator: "major", description: "Collab server degraded", updatedAt: null });
    // HASISSUES without incident detail still means "something is wrong".
    expect(parseInstatusSummary({ page: { status: "HASISSUES" } }).indicator).toBe("minor");
    expect(() => parseInstatusSummary({ page: {} })).toThrow();
  });

  it("filters the shared Google feed to open incidents of the requested service", () => {
    const feed = [
      { service_name: "Gemini", severity: "high", end: "2026-07-01T00:00:00Z", external_desc: "old" },
      { service_name: "Gemini", severity: "medium", external_desc: "Gemini API elevated latency" },
      { service_name: "Gmail", severity: "high", external_desc: "unrelated" },
    ];
    expect(parseGoogleIncidents(feed, "Gemini")).toEqual({
      indicator: "major",
      description: "Gemini API elevated latency",
      updatedAt: null,
    });
    expect(parseGoogleIncidents([], "Gemini").indicator).toBe("none");
    expect(() => parseGoogleIncidents({ nope: true }, "Gemini")).toThrow();
  });

  it("matches products nested under affected_products", () => {
    const feed = [{ severity: "low", affected_products: [{ title: "Gemini" }], external_desc: "slow" }];
    expect(parseGoogleIncidents(feed, "Gemini").indicator).toBe("minor");
  });
});

describe("probeProvider", () => {
  it("maps a Statuspage provider", async () => {
    stubHost((url) => {
      if (isGoogleFeed(url)) return json([]);
      if (isInstatusFeed(url)) return json({ page: { status: "UP" } });
      return json({ page: { updated_at: "2026-07-26T08:00:00.000Z" }, status: { indicator: "none", description: "All Systems Operational" } });
    });

    const claude = STATUS_PROVIDERS.find((p) => p.id === "claude")!;
    await expect(probeProvider(claude)).resolves.toEqual({
      indicator: "none",
      description: "All Systems Operational",
      updatedAt: "2026-07-26T08:00:00.000Z",
    });
  });

  it("treats a non-200 response as unreachable and keeps the reason", async () => {
    stubHost(() => json({ status: { indicator: "none" } }, 503));
    const claude = STATUS_PROVIDERS.find((p) => p.id === "claude")!;
    await expect(probeProvider(claude)).resolves.toEqual({
      indicator: "unknown",
      description: "HTTP 503",
      updatedAt: null,
    });
  });

  it("treats a bridge rejection as unreachable and keeps the reason", async () => {
    stubHost(() => Promise.reject(new Error("network down")) as never);
    const github = STATUS_PROVIDERS.find((p) => p.id === "github")!;
    await expect(probeProvider(github)).resolves.toEqual({
      indicator: "unknown",
      description: "network down",
      updatedAt: null,
    });
  });

  it("retries a transient failure once instead of reporting it", async () => {
    let calls = 0;
    stubHost(() => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return json({ page: { updated_at: null }, status: { indicator: "none", description: "All Systems Operational" } });
    });
    const claude = STATUS_PROVIDERS.find((p) => p.id === "claude")!;
    await expect(probeProvider(claude)).resolves.toEqual({
      indicator: "none",
      description: "All Systems Operational",
      updatedAt: null,
    });
    expect(calls).toBe(2);
  });

  it("strips the internal label from a redirect-grant failure", () => {
    expect(
      describeFailure(
        new Error("service-status: redirect to status.x.ai:443 is not covered by a network grant"),
      ),
    ).toBe("redirect to status.x.ai:443 is not covered by a network grant");
    expect(describeFailure(new Error("status probe cursor: timeout after 14000ms"))).toBe("timeout after 14000ms");
    expect(describeFailure(new Error("x".repeat(400)))).toHaveLength(160);
  });

  it("keeps other providers working when one probe fails", async () => {
    stubHost((url) => {
      if (url.includes("githubstatus")) throw new Error("network down");
      if (isGoogleFeed(url)) return json([]);
      if (isInstatusFeed(url)) return json({ page: { status: "UP" } });
      return json({ status: { indicator: "none", description: "All Systems Operational" } });
    });

    const results = await probeAll();
    expect(results.github.indicator).toBe("unknown");
    expect(results.claude.indicator).toBe("none");
    expect(Object.keys(results)).toHaveLength(STATUS_PROVIDERS.length);
  });

  it("marks every status-feed provider unreachable on unexpected payloads", async () => {
    stubHost(() => json({ totally: "unexpected" }));
    const results = await probeAll();
    for (const provider of STATUS_PROVIDERS) {
      if (provider.kind === "http") continue; // 连通性探测不解析载荷，见下方 http kind 测试
      expect(results[provider.id].indicator).toBe("unknown");
    }
  });
});

describe("probeProvider http kind", () => {
  const minimax = () => STATUS_PROVIDERS.find((p) => p.id === "minimax")!;

  it("treats any HTTP response as reachable, including redirects and 404s", async () => {
    stubHost(() => ({ status: 302, body: "" }));
    await expect(probeProvider(minimax())).resolves.toEqual({ indicator: "none", description: "", updatedAt: null });
    stubHost(() => ({ status: 404, body: "" }));
    await expect(probeProvider(minimax())).resolves.toEqual({ indicator: "none", description: "", updatedAt: null });
  });

  it("maps 5xx to minor instead of faking an outage", async () => {
    stubHost(() => ({ status: 503, body: "" }));
    await expect(probeProvider(minimax())).resolves.toEqual({ indicator: "minor", description: "HTTP 503", updatedAt: null });
  });

  it("treats a bridge rejection as unreachable", async () => {
    stubHost(() => Promise.reject(new Error("network down")) as never);
    await expect(probeProvider(minimax())).resolves.toEqual({
      indicator: "unknown",
      description: "network down",
      updatedAt: null,
    });
  });
});

describe("indicator cross-check", () => {
  const kimi = () => STATUS_PROVIDERS.find((p) => p.id === "kimi")!;
  const isIncidents = (url: string) => url.endsWith("/api/v2/incidents/unresolved.json");

  it("downgrades a stale indicator when nothing is unresolved", async () => {
    stubHost((url) =>
      isIncidents(url)
        ? json({ incidents: [] })
        : json({
            page: { updated_at: "2026-11-01T21:33:03+08:00" },
            status: { indicator: "minor", description: "Minor Service Outage" },
          }),
    );

    await expect(probeProvider(kimi())).resolves.toEqual({
      indicator: "none",
      description: "",
      updatedAt: "2026-11-01T21:33:03+08:00",
    });
  });

  it("keeps the upstream indicator while an incident is still open", async () => {
    stubHost((url) =>
      isIncidents(url)
        ? json({ incidents: [{ name: "Kimi Code K3 TTFT 响应延迟升高", status: "investigating" }] })
        : json({
            page: { updated_at: "2026-11-01T22:15:41+08:00" },
            status: { indicator: "major", description: "Partial System Outage" },
          }),
    );

    await expect(probeProvider(kimi())).resolves.toEqual({
      indicator: "major",
      description: "Partial System Outage",
      updatedAt: "2026-11-01T22:15:41+08:00",
    });
  });

  it("never downgrades when the cross-check itself fails", async () => {
    stubHost((url) => {
      if (isIncidents(url)) throw new Error("network down");
      return json({ status: { indicator: "major", description: "Partial System Outage" } });
    });

    await expect(probeProvider(kimi())).resolves.toEqual({
      indicator: "major",
      description: "Partial System Outage",
      updatedAt: null,
    });
  });
});

describe("manifest ↔ code contract", () => {
  it("declares a network grant for every probed host", async () => {
    const granted = new Set(
      MANIFEST.permissions
        .filter((permission) => permission.startsWith("network:"))
        .map((permission) => permission.slice("network:".length)),
    );
    for (const provider of STATUS_PROVIDERS) {
      expect(granted.has(new URL(provider.apiUrl).host)).toBe(true);
      // 复核请求与 status.json 同域，但换了路径；显式断言，避免将来挪到别的域时漏授权。
      if (provider.verifyUnresolved) {
        const incidents = new URL("/api/v2/incidents/unresolved.json", provider.apiUrl);
        expect(granted.has(incidents.host)).toBe(true);
      }
    }
  });
});

describe("openExternalUrl", () => {
  it("spawns the platform opener for an https url", async () => {
    const invoke = stubHost(() => json({}));
    await openExternalUrl("https://status.claude.com");
    expect(invoke).toHaveBeenCalledWith("plugin_exec_spawn", expect.objectContaining({ bin: expect.any(String) }));
  });

  it("refuses non-https urls before touching the exec bridge", async () => {
    const invoke = stubHost(() => json({}));
    await expect(openExternalUrl("http://status.claude.com")).rejects.toThrow();
    await expect(openExternalUrl("file:///etc/passwd")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
