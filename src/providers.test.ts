import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { openExternalUrl, setHostCtx } from "./host";
import {
  STATUS_PROVIDERS,
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

  it("treats a non-200 response as unreachable", async () => {
    stubHost(() => json({ status: { indicator: "none" } }, 503));
    const claude = STATUS_PROVIDERS.find((p) => p.id === "claude")!;
    await expect(probeProvider(claude)).resolves.toEqual({ indicator: "unknown", description: "", updatedAt: null });
  });

  it("treats a bridge rejection as unreachable", async () => {
    stubHost(() => Promise.reject(new Error("network down")) as never);
    const github = STATUS_PROVIDERS.find((p) => p.id === "github")!;
    await expect(probeProvider(github)).resolves.toEqual({ indicator: "unknown", description: "", updatedAt: null });
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

  it("marks every provider unreachable on unexpected payloads", async () => {
    stubHost(() => json({ totally: "unexpected" }));
    const results = await probeAll();
    for (const provider of STATUS_PROVIDERS) {
      expect(results[provider.id].indicator).toBe("unknown");
    }
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
