// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { setHostCtx } from "./host";
import StatusPage from "./StatusPage";
import { STATUS_PROVIDERS } from "./providers";

function statusBody(indicator: string, description: string) {
  return {
    page: { updated_at: "2026-07-26T08:00:00.000Z" },
    status: { indicator, description },
  };
}

const isGoogleFeed = (url: string) => url.includes("appsstatus");
const isInstatusFeed = (url: string) => url.endsWith("summary.json");

interface StubOptions {
  google?: unknown[];
  instatus?: () => unknown;
  statuspage?: (url: string) => unknown;
  fail?: (url: string) => boolean;
  /** 所有源都回一个形状不对的载荷（解析失败的兜底路径）。 */
  unexpected?: boolean;
}

/** 按 feed 形状路由的宿主桥：Google → incidents 数组，Instatus → summary，其余 → Statuspage JSON。 */
function stubHost(options: StubOptions = {}) {
  const {
    google = [] as unknown[],
    instatus = () => ({ page: { status: "UP" }, activeIncidents: [] as unknown[] }),
    statuspage = () => statusBody("none", "All Systems Operational"),
    fail = () => false,
    unexpected = false,
  } = options;

  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "plugin_exec_spawn") return null;
    const url = String(args?.url);
    if (fail(url)) throw new Error("network down");
    const body = unexpected
      ? { totally: "unexpected" }
      : isGoogleFeed(url)
        ? google
        : isInstatusFeed(url)
          ? instatus()
          : statuspage(url);
    return { status: 200, body: JSON.stringify(body) };
  });
  setHostCtx({
    pluginId: "service-status",
    version: "1.0.0",
    host: { locale: "zh-CN" },
    bridge: { invoke },
  } as unknown as PluginContext);
  return invoke;
}

afterEach(() => {
  cleanup();
  setHostCtx(null);
});

describe("StatusPage", () => {
  it("renders one card per provider with its probed state", async () => {
    stubHost();

    render(<StatusPage />);

    for (const provider of STATUS_PROVIDERS) {
      expect(await screen.findByText(provider.name)).toBeTruthy();
    }
    await waitFor(() => {
      expect(screen.getAllByText("运行正常")).toHaveLength(STATUS_PROVIDERS.length);
    });
  });

  it("surfaces an incident description on the affected card only", async () => {
    stubHost({
      statuspage: (url) =>
        url.includes("status.claude.com")
          ? statusBody("major", "Elevated errors on Claude models")
          : statusBody("none", "All Systems Operational"),
    });

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("重大事故")).toHaveLength(1);
    });
    expect(screen.getAllByText("Elevated errors on Claude models")).toHaveLength(1);
    expect(screen.getAllByText("运行正常")).toHaveLength(STATUS_PROVIDERS.length - 1);
  });

  it("maps open incidents of the shared Google feed onto the Gemini card", async () => {
    stubHost({
      google: [
        { service_name: "Gemini", severity: "high", end: "2026-07-01T00:00:00Z", external_desc: "old" },
        { service_name: "Gemini", severity: "medium", external_desc: "Gemini API elevated latency" },
        { service_name: "Gmail", severity: "high", external_desc: "unrelated" },
      ],
    });

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("重大事故")).toHaveLength(1);
    });
    expect(screen.getAllByText("Gemini API elevated latency")).toHaveLength(1);
    expect(screen.queryByText("unrelated")).toBeNull();
  });

  it("maps an Instatus HASISSUES summary onto the Zed card", async () => {
    stubHost({
      instatus: () => ({
        page: { status: "HASISSUES" },
        activeIncidents: [{ name: "Collab server degraded", impact: "PARTIALOUTAGE" }],
      }),
    });

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("重大事故")).toHaveLength(1);
    });
    expect(screen.getAllByText("Collab server degraded")).toHaveLength(1);
  });

  it("marks a failing probe unreachable without breaking the others", async () => {
    stubHost({ fail: (url) => url.includes("githubstatus") });

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("无法访问")).toHaveLength(1);
    });
    expect(screen.getAllByText("运行正常")).toHaveLength(STATUS_PROVIDERS.length - 1);
  });

  it("treats unexpected payloads as unreachable instead of crashing", async () => {
    stubHost({ unexpected: true });

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("无法访问")).toHaveLength(STATUS_PROVIDERS.length);
    });
  });

  it("opens the provider status page through the platform opener", async () => {
    const invoke = stubHost();

    render(<StatusPage />);
    await waitFor(() => {
      expect(screen.getAllByText("运行正常")).toHaveLength(STATUS_PROVIDERS.length);
    });

    screen.getByLabelText("在浏览器中打开 Claude 状态页").click();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "plugin_exec_spawn",
        expect.objectContaining({ lifecycle: "detached" }),
      );
    });
  });
});
