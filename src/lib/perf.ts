/**
 * Live performance-profiling harness.
 *
 * The render loops (GuiDesktopApp, XWindowCanvas) and the boot path record
 * per-stage timings into a small fixed-size ring exposed on `window.__sc.perf`
 * so a live page.evaluate (browser-witness) can read REAL per-frame numbers --
 * displayPixels ms, blit ms, exec ms, total tick ms, fps, dropped frames --
 * rather than guessing. This is the prerequisite witness source for every
 * perf-optimization change: measure first, then prove each change moved a
 * number. No external services; pure in-page instrumentation.
 *
 * Zero-cost when unused: a channel only allocates its ring on first sample.
 */

const RING = 240; // ~4s at 60fps; enough for mean + p95 without unbounded growth.

interface Sample {
  /** Per-stage durations in ms; keys are channel-defined (e.g. displayPixels, blit, exec). */
  stages: Record<string, number>;
  /** Total tick duration in ms. */
  total: number;
  /** High-res timestamp (performance.now) at tick start. */
  t: number;
  /** True when this tick actually blitted (vs a skipped/idle frame). */
  painted: boolean;
}

interface ChannelStats {
  fps: number;
  frames: number;
  paints: number;
  meanTotal: number;
  p95Total: number;
  stageMean: Record<string, number>;
  stageP95: Record<string, number>;
  window: number;
}

class Channel {
  private ring: Sample[] = [];
  private head = 0;
  private count = 0;

  push(s: Sample) {
    this.ring[this.head] = s;
    this.head = (this.head + 1) % RING;
    if (this.count < RING) this.count++;
  }

  private samples(): Sample[] {
    if (this.count < RING) return this.ring.slice(0, this.count);
    return [...this.ring.slice(this.head), ...this.ring.slice(0, this.head)];
  }

  stats(): ChannelStats {
    const s = this.samples();
    const n = s.length;
    if (n === 0) {
      return { fps: 0, frames: 0, paints: 0, meanTotal: 0, p95Total: 0, stageMean: {}, stageP95: {}, window: 0 };
    }
    const totals = s.map((x) => x.total);
    const paints = s.filter((x) => x.painted).length;
    const span = s[n - 1].t - s[0].t;
    const fps = span > 0 ? ((n - 1) * 1000) / span : 0;

    const stageKeys = new Set<string>();
    for (const x of s) for (const k of Object.keys(x.stages)) stageKeys.add(k);
    const stageMean: Record<string, number> = {};
    const stageP95: Record<string, number> = {};
    for (const k of stageKeys) {
      const vals = s.map((x) => x.stages[k] ?? 0);
      stageMean[k] = mean(vals);
      stageP95[k] = p95(vals);
    }
    return {
      fps: round2(fps),
      frames: n,
      paints,
      meanTotal: round3(mean(totals)),
      p95Total: round3(p95(totals)),
      stageMean: mapRound(stageMean),
      stageP95: mapRound(stageP95),
      window: round1(span),
    };
  }

  reset() {
    this.ring = [];
    this.head = 0;
    this.count = 0;
  }
}

function mean(a: number[]): number {
  if (!a.length) return 0;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}
function p95(a: number[]): number {
  if (!a.length) return 0;
  const sorted = [...a].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}
function round1(n: number) { return Math.round(n * 10) / 10; }
function round2(n: number) { return Math.round(n * 100) / 100; }
function round3(n: number) { return Math.round(n * 1000) / 1000; }
function mapRound(m: Record<string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of Object.keys(m)) o[k] = round3(m[k]);
  return o;
}

interface PerfApi {
  channels: Record<string, Channel>;
  /** Begin a tick on a named channel; returns a recorder to time stages + finish. */
  begin: (channel: string) => TickRecorder;
  /** Snapshot of all channel stats (the page.evaluate read surface). */
  snapshot: () => Record<string, ChannelStats>;
  /** Clear all rings (used to mark a fresh before/after baseline window). */
  reset: (channel?: string) => void;
}

export interface TickRecorder {
  /** Time a synchronous stage. */
  stage: <T>(name: string, fn: () => T) => T;
  /** Time an async stage. */
  stageAsync: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Record a raw stage duration measured elsewhere. */
  mark: (name: string, ms: number) => void;
  /** Finish the tick; painted=true if a real blit happened. */
  end: (painted: boolean) => void;
}

function makeApi(): PerfApi {
  const channels: Record<string, Channel> = {};
  const get = (name: string) => (channels[name] ??= new Channel());
  return {
    channels,
    begin(channel: string): TickRecorder {
      const ch = get(channel);
      const t0 = now();
      const stages: Record<string, number> = {};
      return {
        stage(name, fn) {
          const s = now();
          try { return fn(); } finally { stages[name] = (stages[name] ?? 0) + (now() - s); }
        },
        async stageAsync(name, fn) {
          const s = now();
          try { return await fn(); } finally { stages[name] = (stages[name] ?? 0) + (now() - s); }
        },
        mark(name, ms) { stages[name] = (stages[name] ?? 0) + ms; },
        end(painted) { ch.push({ stages, total: now() - t0, t: t0, painted }); },
      };
    },
    snapshot() {
      const o: Record<string, ChannelStats> = {};
      for (const k of Object.keys(channels)) o[k] = channels[k].stats();
      return o;
    },
    reset(channel) {
      if (channel) channels[channel]?.reset();
      else for (const k of Object.keys(channels)) channels[k].reset();
    },
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * The single shared harness. Lazily attached to window.__sc.perf on first use
 * (module-level side effects get tree-shaken, so we attach from getPerf()).
 */
let api: PerfApi | null = null;

export function getPerf(): PerfApi {
  if (api) return api;
  api = makeApi();
  if (typeof window !== "undefined") {
    const w = window as unknown as { __sc?: Record<string, unknown> };
    w.__sc ??= {};
    w.__sc.perf = api;
  }
  return api;
}
