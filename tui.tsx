/** @jsxImportSource @opentui/solid */
// OpenCode 2 TUI plugin: live quota bars in the session sidebar.
// The OpenCode 1.x equivalent is quota-sidebar.tsx (TuiPluginModule / slots.register).
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup, onMount } from "solid-js";

import { MONITORED_PROVIDERS, readAccountsWeekly, quotaCachePath } from "./lib/quota.js";
import { resolveConfig, windowForProvider } from "./lib/config.js";
import { formatReset } from "./lib/reset.js";
import { isPostponeActive, DEFAULT_POSTPONE_MINUTES } from "./lib/postpone.js";

const PLUGIN_ID = "opencode-hard-limit.quota-sidebar";
const DEFAULT_POLL_INTERVAL_MS = 120_000;
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.OPENCODE_QUOTA_SIDEBAR_POLL_MS;
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
})();
const READ_TIMEOUT_MS = 10_000;
const BAR_WIDTH = 14;
const SAFE_HEADROOM_BAND = 30;
const STALE_ANNOTATION_MIN_AGE_MS = 5 * 60 * 1000;

type Color = any;
type Palette = { text: Color; muted: Color; border: Color; success: Color; warning: Color; error: Color };

type WeeklyQuotaResult = {
  ok: boolean;
  status: "ok" | "error";
  remaining: number | null;
  resetAt: string | number | null;
  unlimited: boolean;
  window?: string;
  error?: string;
  stale?: boolean;
  receivedAt?: number;
};
type AccountQuotaResult = WeeklyQuotaResult & { accountId: string; accountLabel: string; isActive: boolean };
type QuotaSnapshot = WeeklyQuotaResult & { receivedAt: number; accountLabel: string; isActive: boolean };
type QuotaMap = Record<string, QuotaSnapshot | undefined>;

const rowKey = (providerId: string, accountId: string) => `${providerId}:${accountId}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// @opentui/core is resolved lazily so a missing module only costs the colour
// gradient (falls back to the three feedback colours), never the whole sidebar.
let RGBAClass: any;

function toRGBA(color: Color): any {
  if (!RGBAClass || color == null) return null;
  if (typeof color === "string") {
    try {
      return RGBAClass.fromHex(color);
    } catch {
      return null;
    }
  }
  return typeof color.r === "number" ? color : null;
}

function mix(from: Color, to: Color, t: number): Color {
  const a = toRGBA(from);
  const b = toRGBA(to);
  if (!a || !b) return t < 0.5 ? from : to;
  return RGBAClass.fromValues(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t), lerp(a.a, b.a, t));
}

function gradientTone(palette: Palette, remaining: number, minRemaining: number): Color {
  if (remaining <= minRemaining) return palette.error;
  const headroom = remaining - minRemaining;
  const proximity = clamp(1 - headroom / SAFE_HEADROOM_BAND, 0, 1);
  if (proximity < 0.5) return mix(palette.success, palette.warning, proximity * 2);
  return mix(palette.warning, palette.error, (proximity - 0.5) * 2);
}

// Semantic tokens follow @tarquinen/opencode-dcp's V2 panel theme: surface("dialog")
// exposes text/muted/feedback/border; fall back to the flat `theme.text.base` shape.
function paletteFrom(theme: any): Palette {
  try {
    const s = theme.surface("dialog");
    return {
      text: s.text.base,
      muted: s.text.muted,
      border: s.border.base,
      success: s.text.feedback.success.base,
      warning: s.text.feedback.warning.base,
      error: s.text.feedback.error.base,
    };
  } catch {
    const t = theme?.text ?? {};
    const f = t.feedback ?? {};
    return {
      text: t.base,
      muted: t.muted ?? t.base,
      border: theme?.border?.base ?? t.muted,
      success: f.success?.base ?? t.base,
      warning: f.warning?.base ?? t.base,
      error: f.error?.base ?? t.base,
    };
  }
}

function safeMinRemaining(projectDir: string): number {
  try {
    const cfg = resolveConfig({ projectDir }).values;
    const value = typeof cfg.minRemaining === "number" && Number.isFinite(cfg.minRemaining) ? cfg.minRemaining : 30;
    return clamp(value, 0, 100);
  } catch {
    return 30;
  }
}

function safeWindowFor(projectDir: string, providerId: string): string {
  try {
    const cfg = resolveConfig({ projectDir }).values;
    return String(windowForProvider(cfg, providerId) ?? "Weekly") === "5h" ? "5h" : "Weekly";
  } catch {
    return "Weekly";
  }
}

function normalizeResult(result: AccountQuotaResult): QuotaSnapshot {
  return { ...result, receivedAt: typeof result.receivedAt === "number" ? result.receivedAt : Date.now() };
}

function errorSnapshot(result: AccountQuotaResult, message?: string): QuotaSnapshot {
  return normalizeResult({ ...result, ok: false, status: "error", remaining: null, resetAt: null, unlimited: false, error: message });
}

function formatStaleAge(receivedAt: number): string {
  const minutes = Math.max(1, Math.round(Math.max(0, Date.now() - receivedAt) / 60_000));
  return `Last read ${minutes}m ago`;
}

function buildBar(remaining: number, minRemaining: number) {
  const filledCells = clamp(Math.round((remaining / 100) * BAR_WIDTH), 0, BAR_WIDTH);
  const markerIndex = clamp(Math.round((minRemaining / 100) * BAR_WIDTH), 0, BAR_WIDTH - 1);
  return {
    filled: "█".repeat(filledCells),
    empty: "░".repeat(BAR_WIDTH - filledCells),
    marker: `${" ".repeat(markerIndex)}^${" ".repeat(BAR_WIDTH - markerIndex - 1)}`,
  };
}

function hasResetAt(value: QuotaSnapshot | undefined): value is QuotaSnapshot & { resetAt: string | number } {
  return Boolean(value && value.resetAt !== null && value.resetAt !== undefined && value.resetAt !== "");
}

function SidebarContentView(props: { palette: () => Palette; projectDir: string }) {
  const projectDir = props.projectDir;
  const cfg = resolveConfig({ projectDir }).values;
  const minRemaining = safeMinRemaining(projectDir);
  const windows: Record<string, string> = {};
  for (const provider of MONITORED_PROVIDERS) windows[provider.id] = safeWindowFor(projectDir, provider.id);
  const [snapshot, setSnapshot] = createSignal<QuotaMap>({});

  let disposed = false;
  let inFlight = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const refresh = async () => {
    if (inFlight || disposed) return;
    inFlight = true;
    try {
      await Promise.all(
        MONITORED_PROVIDERS.map(async (provider) => {
          let results: AccountQuotaResult[];
          try {
            results = (await readAccountsWeekly({
              provider: provider.id,
              window: windows[provider.id],
              timeoutMs: READ_TIMEOUT_MS,
              cacheTtlMs: cfg.cacheTtlMs,
              minRefreshIntervalMs: cfg.minRefreshIntervalMs,
              rateLimitBackoffMs: cfg.rateLimitBackoffMs,
              maxRateLimitBackoffMs: cfg.maxRateLimitBackoffMs,
              noBaselineRateLimitBackoffMs: cfg.noBaselineRateLimitBackoffMs,
              cacheFile: quotaCachePath(),
              anthropicProfileDirs: cfg.anthropicProfileDirs,
              openaiAccountsFile: cfg.openaiAccountsFile,
            })) as AccountQuotaResult[];
          } catch (error) {
            results = [
              {
                ok: false,
                status: "error",
                remaining: null,
                resetAt: null,
                unlimited: false,
                error: error instanceof Error ? error.message : "quota unavailable",
                accountId: "default",
                accountLabel: provider.label,
                isActive: true,
              },
            ];
          }
          if (disposed) return;
          setSnapshot((current) => {
            const next = { ...current };
            for (const result of results) {
              const key = rowKey(provider.id, result.accountId);
              const normalized =
                result.status === "ok" ? normalizeResult(result) : errorSnapshot(result, result.error ?? "quota unavailable");
              const previous = next[key];
              if (normalized.status === "error" && previous?.status === "ok") {
                next[key] = { ...previous, stale: true };
                continue;
              }
              const carriedResetAt =
                normalized.status === "ok" &&
                (normalized.resetAt === null || normalized.resetAt === undefined) &&
                hasResetAt(previous) &&
                previous.window === normalized.window
                  ? previous.resetAt
                  : normalized.resetAt;
              next[key] = { ...normalized, resetAt: carriedResetAt };
            }
            return next;
          });
        }),
      );
    } catch {
      // keep the polling cadence intact even if one refresh fails unexpectedly
    } finally {
      inFlight = false;
    }
  };

  onMount(() => {
    void refresh().catch(() => {});
    interval = setInterval(() => {
      void refresh().catch(() => {});
    }, POLL_INTERVAL_MS);
  });

  onCleanup(() => {
    disposed = true;
    if (interval) clearInterval(interval);
  });

  const rows = () => {
    const map = snapshot();
    const providerOrder = MONITORED_PROVIDERS.map((p) => p.id);
    return Object.keys(map)
      .filter((key) => Boolean(map[key]))
      .sort((a, b) => {
        const oa = providerOrder.indexOf(a.slice(0, a.indexOf(":")));
        const ob = providerOrder.indexOf(b.slice(0, b.indexOf(":")));
        if (oa !== ob) return oa - ob;
        return a.localeCompare(b);
      })
      .map((key) => ({ key, providerId: key.slice(0, key.indexOf(":")), state: map[key]! }));
  };

  const providerRowCounts = () => {
    const counts: Record<string, number> = {};
    for (const { providerId } of rows()) counts[providerId] = (counts[providerId] ?? 0) + 1;
    return counts;
  };

  const isRowBlocked = (state: QuotaSnapshot | undefined) => {
    if (!state || state.unlimited === true) return false;
    const remainingValue = typeof state.remaining === "number" ? clamp(state.remaining, 0, 100) : null;
    return typeof remainingValue === "number" && remainingValue <= minRemaining;
  };
  const showPostponeHint = () =>
    cfg.allowPostpone === true && !isPostponeActive() && rows().some(({ state }) => isRowBlocked(state));

  return (
    <box gap={1} flexDirection="column">
      <box flexDirection="row">
        <text fg={props.palette().text} wrapMode="none">
          <b>Quota</b>
        </text>
      </box>

      <box gap={1} flexDirection="column">
        {rows().length === 0 ? (
          <text fg={props.palette().muted} wrapMode="none">
            checking...
          </text>
        ) : (
          (() => {
            const p = props.palette();
            const counts = providerRowCounts();
            return rows().map(({ providerId, state }) => {
              const unlimited = state?.unlimited === true;
              const showActiveTag = state.isActive && (counts[providerId] ?? 0) > 1;
              const label = showActiveTag ? `${state.accountLabel} (active)` : state.accountLabel;

              if (state?.status === "error" && !unlimited) {
                const reason = typeof state?.error === "string" && state.error.trim() ? state.error : "unavailable";
                return (
                  <box flexDirection="column">
                    <text fg={p.text} wrapMode="none">
                      <b>{label}</b>
                    </text>
                    <text fg={p.warning ?? p.error} wrapMode="wrap">
                      {`unavailable (${reason})`}
                    </text>
                  </box>
                );
              }
              const remainingValue = typeof state?.remaining === "number" ? clamp(state.remaining, 0, 100) : null;
              const blocked = typeof remainingValue === "number" && remainingValue <= minRemaining;
              const tone = unlimited
                ? p.success
                : remainingValue === null
                  ? p.muted
                  : gradientTone(p, remainingValue, minRemaining);
              const stateText = unlimited
                ? "unlimited"
                : typeof remainingValue === "number"
                  ? `${Math.round(remainingValue)}% left, limit ${Math.round(minRemaining)}%`
                  : "quota unavailable";
              const bar = typeof remainingValue === "number" ? buildBar(remainingValue, minRemaining) : null;
              const markerTone = blocked ? p.error : p.border;
              const effectiveWindow = state?.window ?? windows[providerId];
              const resetText = formatReset(state?.resetAt, effectiveWindow);
              const staleText =
                state?.stale && Number.isFinite(state.receivedAt) && Date.now() - state.receivedAt > STALE_ANNOTATION_MIN_AGE_MS
                  ? `· ${formatStaleAge(state.receivedAt)}`
                  : null;

              return (
                <box gap={0} flexDirection="column">
                  <box flexDirection="row">
                    <text fg={p.text} wrapMode="none">
                      <b>{label}</b>
                    </text>
                    <text fg={p.muted} wrapMode="none">
                      {` ${effectiveWindow}`}
                    </text>
                    <text fg={tone} wrapMode="none">
                      {` ${stateText}`}
                    </text>
                  </box>
                  {bar ? (
                    <box gap={0} flexDirection="column">
                      <box flexDirection="row">
                        <text fg={tone} wrapMode="none">
                          {bar.filled}
                        </text>
                        <text fg={p.muted} wrapMode="none">
                          {bar.empty}
                        </text>
                      </box>
                      <box flexDirection="row">
                        <text fg={markerTone} wrapMode="none">
                          {bar.marker}
                        </text>
                      </box>
                    </box>
                  ) : null}
                  {resetText ? (
                    <text fg={p.muted} wrapMode="none">
                      {resetText}
                    </text>
                  ) : null}
                  {staleText ? (
                    <text fg={p.muted} wrapMode="none">
                      {staleText}
                    </text>
                  ) : null}
                </box>
              );
            });
          })()
        )}
      </box>

      {showPostponeHint() ? (
        <box gap={0} flexDirection="column">
          <text fg={props.palette().error} wrapMode="wrap">
            {`To postpone the blockage for ${DEFAULT_POSTPONE_MINUTES} min: `}
          </text>
          <text fg={props.palette().error} wrapMode="wrap">
            {`type !, then paste: `}
          </text>
          <text fg={props.palette().error} wrapMode="wrap">
            {`opencode-hard-limit postpone ${DEFAULT_POSTPONE_MINUTES}`}
          </text>
        </box>
      ) : null}
    </box>
  );
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(context) {
    try {
      RGBAClass = (await import("@opentui/core")).RGBA;
    } catch {
      RGBAClass = undefined;
    }
    const location: any = context.location ?? context.data.location.default();
    const projectDir: string = location?.directory ?? process.cwd();

    return context.ui.slot({
      append: "sidebar.content",
      render: () => <SidebarContentView palette={() => paletteFrom(context.theme)} projectDir={projectDir} />,
    });
  },
});
