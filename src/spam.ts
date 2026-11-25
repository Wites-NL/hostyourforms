/** Fixed-window, in-memory rate limiter. Good enough for a single process. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(private now: () => number = Date.now) {}

  /** Returns seconds until retry when the limit is exceeded, otherwise 0. */
  hit(key: string, max: number, windowSeconds: number): number {
    const now = this.now();
    this.sweep(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return 0;
    }
    entry.count += 1;
    return entry.count > max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

export async function verifyTurnstile(
  secret: string,
  token: string | undefined,
  ip: string | undefined,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  try {
    const res = await doFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/** Extract the origin from the Origin header, falling back to Referer. */
export function requestOrigin(headers: Headers): string | undefined {
  const origin = headers.get("origin");
  if (origin && origin !== "null") return origin;
  const referer = headers.get("referer");
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!origin) return false;
  return allowed.some((a) => a.replace(/\/+$/, "").toLowerCase() === origin.toLowerCase());
}
