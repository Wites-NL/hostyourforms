/**
 * Captcha verification for Turnstile, hCaptcha, reCAPTCHA, Friendly Captcha
 * and ALTCHA. Only WebCrypto and fetch, so it runs on Node and on the edge.
 */

export type CaptchaConfig =
  | { provider: "turnstile"; secret: string; siteKey?: string }
  | { provider: "hcaptcha"; secret: string; siteKey?: string }
  | { provider: "recaptcha"; secret: string; siteKey?: string; minScore?: number; action?: string }
  | { provider: "friendlycaptcha"; apiKey: string; siteKey?: string; endpoint?: string }
  | { provider: "altcha"; hmacKey: string; maxNumber?: number; expiresSeconds?: number };

/** Form field each widget adds to the submitted form. */
export const captchaFields: Record<CaptchaConfig["provider"], string> = {
  turnstile: "cf-turnstile-response",
  hcaptcha: "h-captcha-response",
  recaptcha: "g-recaptcha-response",
  friendlycaptcha: "frc-captcha-response",
  altcha: "altcha",
};

export const allCaptchaFields = new Set(Object.values(captchaFields));

export interface CaptchaContext {
  ip?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Remembers used ALTCHA solutions so each one works once. */
  replay?: ReplayGuard;
  log?: (level: "warn", msg: string, data?: Record<string, unknown>) => void;
}

export async function verifyCaptcha(cfg: CaptchaConfig, fields: Record<string, string | undefined>, ctx: CaptchaContext = {}): Promise<boolean> {
  const token = fields[captchaFields[cfg.provider]]?.trim();
  if (!token) return false;
  const doFetch = ctx.fetch ?? fetch;
  try {
    switch (cfg.provider) {
      case "turnstile":
        return (await siteverify(doFetch, "https://challenges.cloudflare.com/turnstile/v0/siteverify", cfg.secret, token, ctx.ip)).success === true;
      case "hcaptcha":
        return (await siteverify(doFetch, "https://api.hcaptcha.com/siteverify", cfg.secret, token, ctx.ip, cfg.siteKey)).success === true;
      case "recaptcha": {
        const r = await siteverify(doFetch, "https://www.google.com/recaptcha/api/siteverify", cfg.secret, token, ctx.ip);
        if (r.success !== true) return false;
        // v3 returns a score; v2 does not.
        if (typeof r.score === "number" && r.score < (cfg.minScore ?? 0.5)) return false;
        if (cfg.action && r.action !== cfg.action) return false;
        return true;
      }
      case "friendlycaptcha":
        return await verifyFriendly(doFetch, cfg, token, ctx);
      case "altcha":
        return await verifyAltcha(cfg, token, ctx.now ?? Date.now, ctx.replay);
    }
  } catch {
    return false;
  }
}

async function siteverify(doFetch: typeof fetch, url: string, secret: string, token: string, ip?: string, siteKey?: string) {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  if (siteKey) body.set("sitekey", siteKey);
  const res = await doFetch(url, { method: "POST", body });
  return (await res.json()) as { success?: boolean; score?: number; action?: string };
}

/**
 * Friendly Captcha v2. Their docs advise accepting the submission when their API
 * itself is unreachable (network error or 5xx), so an outage does not block forms.
 * Configuration errors (4xx) and invalid answers are always rejected.
 */
async function verifyFriendly(doFetch: typeof fetch, cfg: Extract<CaptchaConfig, { provider: "friendlycaptcha" }>, token: string, ctx: CaptchaContext) {
  let res: Response;
  try {
    res = await doFetch(cfg.endpoint ?? "https://global.frcapi.com/api/v2/captcha/siteverify", {
      method: "POST",
      headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(cfg.siteKey ? { response: token, sitekey: cfg.siteKey } : { response: token }),
    });
  } catch (err) {
    ctx.log?.("warn", "friendly captcha unreachable, accepting submission", { error: String(err) });
    return true;
  }
  if (res.status >= 500) {
    ctx.log?.("warn", "friendly captcha server error, accepting submission", { status: res.status });
    return true;
  }
  const data = (await res.json()) as { success?: boolean };
  return res.ok && data.success === true;
}

// ---------- ALTCHA (self-hosted proof of work, challenge format v1) ----------

const enc = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function randomInt(max: number): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0]! % (max + 1);
}

export interface AltchaChallenge {
  algorithm: "SHA-256";
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

/**
 * Creates a challenge: the browser must find `number` so that
 * sha256(salt + number) equals `challenge`. The signature proves we issued it,
 * the expiry sits in the salt (so it is signed too).
 */
export async function createAltchaChallenge(cfg: Extract<CaptchaConfig, { provider: "altcha" }>, now: () => number = Date.now): Promise<AltchaChallenge> {
  const maxnumber = cfg.maxNumber ?? 100_000;
  const expires = Math.floor(now() / 1000) + (cfg.expiresSeconds ?? 600);
  // Trailing "&" stops anyone from moving digits between salt and number.
  const salt = `${randomHex(12)}?expires=${expires}&`;
  const challenge = await sha256Hex(salt + randomInt(maxnumber));
  return { algorithm: "SHA-256", challenge, maxnumber, salt, signature: await hmacHex(cfg.hmacKey, challenge) };
}

async function verifyAltcha(cfg: Extract<CaptchaConfig, { provider: "altcha" }>, token: string, now: () => number, replay?: ReplayGuard): Promise<boolean> {
  let p: { algorithm?: unknown; challenge?: unknown; number?: unknown; salt?: unknown; signature?: unknown };
  try {
    p = JSON.parse(atob(token));
  } catch {
    return false;
  }
  if (p.algorithm !== "SHA-256" || typeof p.challenge !== "string" || typeof p.salt !== "string" || typeof p.signature !== "string") return false;
  if (!Number.isInteger(p.number) || (p.number as number) < 0) return false;
  if (!p.salt.endsWith("&")) return false;
  const expires = Number(new URLSearchParams(p.salt.split("?")[1] ?? "").get("expires"));
  if (!Number.isFinite(expires) || expires <= 0 || expires * 1000 < now()) return false;
  if ((await sha256Hex(p.salt + String(p.number))) !== p.challenge) return false;
  if ((await hmacHex(cfg.hmacKey, p.challenge)) !== p.signature) return false;
  if (replay && !replay.use(p.signature, expires * 1000)) return false;
  return true;
}

/** In-memory set of used one-time values, cleaned up after they expire. */
export class ReplayGuard {
  private used = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  /** Returns false when the value was already used. */
  use(value: string, expiresAt: number): boolean {
    const t = this.now();
    if (this.used.size > 1000) for (const [k, exp] of this.used) if (exp < t) this.used.delete(k);
    if (this.used.has(value)) return false;
    this.used.set(value, expiresAt);
    return true;
  }
}

/** HTML for the widget, for documentation and the dashboard. */
export function captchaSnippet(cfg: { provider: CaptchaConfig["provider"]; siteKey?: string }, challengeUrl?: string): { head: string; widget: string } {
  const key = cfg.siteKey || "JOUW_SITEKEY";
  switch (cfg.provider) {
    case "turnstile":
      return { head: `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`, widget: `<div class="cf-turnstile" data-sitekey="${key}"></div>` };
    case "hcaptcha":
      return { head: `<script src="https://js.hcaptcha.com/1/api.js" async defer></script>`, widget: `<div class="h-captcha" data-sitekey="${key}"></div>` };
    case "recaptcha":
      return { head: `<script src="https://www.google.com/recaptcha/api.js" async defer></script>`, widget: `<div class="g-recaptcha" data-sitekey="${key}"></div>` };
    case "friendlycaptcha":
      return {
        head: `<script type="module" src="https://cdn.jsdelivr.net/npm/@friendlycaptcha/sdk@1.1.5/site.min.js" async defer></script>`,
        widget: `<div class="frc-captcha" data-sitekey="${key}"></div>`,
      };
    case "altcha":
      return {
        head: `<script type="module" src="https://cdn.jsdelivr.net/npm/altcha@3.7.0/dist/main/altcha.min.js" async defer></script>`,
        widget: `<altcha-widget challenge="${challengeUrl ?? "https://forms.jouwdomein.nl/f/contact/altcha"}"></altcha-widget>`,
      };
  }
}
