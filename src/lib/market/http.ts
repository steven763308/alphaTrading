import { MarketDataError } from "./provider";

/**
 * Serial, rate-limited HTTP fetcher with retry/backoff — providers like Dukascopy
 * throttle hard (HTTP 429) and drop TLS handshakes under load.
 */
export class RateLimitedFetcher {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly opts: {
      minIntervalMs: number;
      maxAttempts: number;
      timeoutMs: number;
      /** Base wait after HTTP 429 (multiplied by the attempt number). */
      backoff429Ms: number;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private sleep(ms: number) {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  /** Queue a request; resolves with the Response (404 is returned, not thrown). */
  fetch(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const run = async (): Promise<Response> => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
        if (signal?.aborted) throw new MarketDataError("Download cancelled");
        const wait = this.last + this.opts.minIntervalMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        this.last = Date.now();
        try {
          const res = await (this.opts.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs), cache: "no-store" });
          if (res.status === 429 || res.status === 418 || res.status >= 500) {
            lastErr = new MarketDataError(`HTTP ${res.status} from ${new URL(url).host}`);
            const retryAfter = Number(res.headers.get("retry-after"));
            await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.opts.backoff429Ms * attempt);
            continue;
          }
          return res;
        } catch (err) {
          lastErr = err;
          await this.sleep(Math.min(1000 * 2 ** attempt, 15_000));
        }
      }
      throw new MarketDataError(`Request failed after ${this.opts.maxAttempts} attempts: ${url}`, lastErr);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
