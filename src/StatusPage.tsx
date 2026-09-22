import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { copy } from "./copy";
import { openExternalUrl } from "./host";
import {
  REFRESH_INTERVAL_MS,
  STATUS_PROVIDERS,
  probeAll,
  type Indicator,
  type ProbeResult,
  type Provider,
} from "./providers";
import { useHostLocale } from "./use-host-locale";

/** 刷新反馈：进行中 0.6s/圈的转圈（见 docs/ui-ux-spec.zh-CN.md §4.1），成功后 900ms 对号。 */
const REFRESH_DONE_MS = 900;

function IndicatorDot({ indicator }: { indicator: Indicator }) {
  return (
    <span className={`ss-dot ss-dot--${indicator}`} aria-hidden>
      {indicator !== "none" && indicator !== "unknown" ? <span className={`ss-ping ss-ping--${indicator}`} /> : null}
      <span className="ss-dot-core" />
    </span>
  );
}

function StatusCard({ provider, result }: { provider: Provider; result: ProbeResult | null }) {
  const locale = useHostLocale();
  const t = copy(locale);
  const loading = result == null;
  const indicator: Indicator = result?.indicator ?? "unknown";
  const [openError, setOpenError] = useState(false);
  const host = useMemo(() => {
    try {
      return new URL(provider.pageUrl).host;
    } catch {
      return provider.pageUrl;
    }
  }, [provider.pageUrl]);

  const open = useCallback(() => {
    setOpenError(false);
    void openExternalUrl(provider.pageUrl).catch(() => setOpenError(true));
  }, [provider.pageUrl]);

  return (
    <article className="ss-card">
      <button
        type="button"
        className="ss-card-hit"
        onClick={open}
        aria-label={t.openPage(provider.name)}
        title={t.openPage(provider.name)}
      >
        <span className="ss-card-head">
          <span className="ss-logo" data-provider={provider.id} aria-hidden>
            {provider.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="ss-name">{provider.name}</span>
          <ExternalLinkIcon />
        </span>
        <span className="ss-state">
          {loading ? <span className="ss-dot ss-dot--pending" aria-hidden /> : <IndicatorDot indicator={indicator} />}
          <span className={loading ? "ss-state-label ss-state-label--pending" : `ss-state-label ss-state-label--${indicator}`}>
            {loading ? t.checking : t.state[indicator]}
          </span>
        </span>
        {result && result.description && indicator !== "none" ? (
          <span className="ss-desc">{result.description}</span>
        ) : null}
        <span className="ss-host">{host}</span>
      </button>
      {openError ? <p className="ss-error">{t.openFailed}</p> : null}
    </article>
  );
}

export default function StatusPage() {
  const locale = useHostLocale();
  const t = copy(locale);
  const [results, setResults] = useState<Record<string, ProbeResult> | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const aliveRef = useRef(true);
  const doneTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const next = await probeAll();
    if (!aliveRef.current) return;
    setResults(next);
    setCheckedAt(new Date());
    setRefreshing(false);
    setJustRefreshed(true);
    if (doneTimerRef.current !== null) window.clearTimeout(doneTimerRef.current);
    doneTimerRef.current = window.setTimeout(() => {
      doneTimerRef.current = null;
      if (aliveRef.current) setJustRefreshed(false);
    }, REFRESH_DONE_MS);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      if (doneTimerRef.current !== null) {
        window.clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
    };
  }, [refresh]);

  const checkedLabel = useMemo(
    () => (checkedAt ? t.lastChecked(checkedAt.toLocaleTimeString()) : null),
    [checkedAt, t],
  );

  return (
    <div className="ss-root">
      <div className="ss-inner">
        <header className="ss-head">
          <div className="ss-head-text">
            <h1 className="ss-title">{t.title}</h1>
            <p className="ss-subtitle">{t.subtitle}</p>
          </div>
          <div className="ss-head-actions">
            {checkedLabel ? <span className="ss-checked">{checkedLabel}</span> : null}
            <button
              type="button"
              className="ss-refresh"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label={t.refresh}
              title={t.refreshHint}
            >
              {refreshing ? (
                <span className="ss-spin" aria-hidden>
                  <RefreshIcon />
                </span>
              ) : justRefreshed ? (
                <CheckIcon />
              ) : (
                <RefreshIcon />
              )}
            </button>
          </div>
        </header>

        <div className="ss-grid">
          {STATUS_PROVIDERS.map((provider) => (
            <StatusCard key={provider.id} provider={provider} result={results?.[provider.id] ?? null} />
          ))}
        </div>

        <p className="ss-note">{t.sourceNote}</p>
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="ss-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
