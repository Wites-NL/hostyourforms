import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFormsApp } from "../src/app.js";
import { type CaptchaConfig, checkCaptcha, createAltchaChallenge, ReplayGuard, verifyCaptcha } from "../src/captcha.js";
import { formSchema, loadConfig } from "../src/config.js";

function fakeFetch(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("siteverify providers", () => {
  const cases: [CaptchaConfig, string, string][] = [
    [{ provider: "turnstile", secret: "s" }, "cf-turnstile-response", "https://challenges.cloudflare.com/turnstile/v0/siteverify"],
    [{ provider: "hcaptcha", secret: "s", siteKey: "site" }, "h-captcha-response", "https://api.hcaptcha.com/siteverify"],
    [{ provider: "recaptcha", secret: "s" }, "g-recaptcha-response", "https://www.google.com/recaptcha/api/siteverify"],
  ];
  for (const [cfg, field, url] of cases) {
    it(`${cfg.provider}: posts the token and follows "success"`, async () => {
      const ok = fakeFetch({ success: true });
      expect(await verifyCaptcha(cfg, { [field]: "tok" }, { ip: "1.2.3.4", fetch: ok.fn })).toBe(true);
      expect(ok.calls[0]!.url).toBe(url);
      const body = new URLSearchParams(String(ok.calls[0]!.init.body));
      expect(body.get("secret")).toBe("s");
      expect(body.get("response")).toBe("tok");
      expect(body.get("remoteip")).toBe("1.2.3.4");
      expect(await verifyCaptcha(cfg, { [field]: "tok" }, { fetch: fakeFetch({ success: false }).fn })).toBe(false);
      expect(await verifyCaptcha(cfg, {}, { fetch: ok.fn })).toBe(false);
    });
  }

  it("reports the provider's error codes as the reason", async () => {
    const cfg: CaptchaConfig = { provider: "hcaptcha", secret: "s", siteKey: "site" };
    const f = fakeFetch({ success: false, "error-codes": ["invalid-input-secret", "sitekey-secret-mismatch"] });
    expect(await checkCaptcha(cfg, { "h-captcha-response": "t" }, { fetch: f.fn })).toEqual({ ok: false, reason: "invalid-input-secret, sitekey-secret-mismatch" });
    expect((await checkCaptcha(cfg, {}, { fetch: f.fn })).reason).toMatch(/h-captcha-response/);
  });

  it("shows the reason in the onResult event, not to the visitor", async () => {
    const form = formSchema.parse({ provider: "p", from: "f@example.com", to: "i@example.com", captcha: { provider: "hcaptcha", secret: "s" } });
    const events: { status: string; code?: string; error?: string }[] = [];
    const app = createFormsApp({
      resolve: () => ({ form, provider: { type: "x", send: async () => {} } }),
      fetch: fakeFetch({ success: false, "error-codes": ["invalid-or-already-seen-response"] }).fn,
      onResult: (e) => void events.push(e),
      maxBodySize: 10_000,
      log: () => {},
    });
    const res = await app.request("/f/c", { method: "POST", body: new URLSearchParams({ email: "a@b.test", "h-captcha-response": "t" }), headers: { accept: "application/json" } });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("already-seen");
    expect(events).toMatchObject([{ status: "rejected", code: "captcha_failed", error: "invalid-or-already-seen-response" }]);
  });

  it("hcaptcha sends the sitekey", async () => {
    const f = fakeFetch({ success: true });
    await verifyCaptcha({ provider: "hcaptcha", secret: "s", siteKey: "site" }, { "h-captcha-response": "t" }, { fetch: f.fn });
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get("sitekey")).toBe("site");
  });

  it("recaptcha v3 checks score and action", async () => {
    const cfg: CaptchaConfig = { provider: "recaptcha", secret: "s", minScore: 0.7, action: "contact" };
    const f = { "g-recaptcha-response": "t" };
    expect(await verifyCaptcha(cfg, f, { fetch: fakeFetch({ success: true, score: 0.9, action: "contact" }).fn })).toBe(true);
    expect(await verifyCaptcha(cfg, f, { fetch: fakeFetch({ success: true, score: 0.3, action: "contact" }).fn })).toBe(false);
    expect(await verifyCaptcha(cfg, f, { fetch: fakeFetch({ success: true, score: 0.9, action: "login" }).fn })).toBe(false);
  });

  it("fails closed when the provider cannot be reached", async () => {
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await verifyCaptcha({ provider: "turnstile", secret: "s" }, { "cf-turnstile-response": "t" }, { fetch: broken })).toBe(false);
  });
});

describe("friendly captcha", () => {
  const cfg: CaptchaConfig = { provider: "friendlycaptcha", apiKey: "A1key", siteKey: "site" };
  const fields = { "frc-captcha-response": "tok" };

  it("sends JSON with the API key header", async () => {
    const f = fakeFetch({ success: true });
    expect(await verifyCaptcha(cfg, fields, { fetch: f.fn })).toBe(true);
    expect(f.calls[0]!.url).toBe("https://global.frcapi.com/api/v2/captcha/siteverify");
    expect((f.calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("A1key");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ response: "tok", sitekey: "site" });
  });

  it("rejects invalid answers and configuration errors, accepts during their outage", async () => {
    expect(await verifyCaptcha(cfg, fields, { fetch: fakeFetch({ success: false, error: { error_code: "response_invalid" } }).fn })).toBe(false);
    expect(await verifyCaptcha(cfg, fields, { fetch: fakeFetch({ success: false, error: { error_code: "auth_invalid" } }, 401).fn })).toBe(false);
    expect(await verifyCaptcha(cfg, fields, { fetch: fakeFetch({}, 503).fn })).toBe(true);
  });
});

/** Solve an ALTCHA challenge the way the widget does. */
function solve(ch: { challenge: string; salt: string; maxnumber: number; signature: string }) {
  for (let n = 0; n <= ch.maxnumber; n++) {
    if (createHash("sha256").update(ch.salt + n).digest("hex") === ch.challenge) {
      return btoa(JSON.stringify({ algorithm: "SHA-256", challenge: ch.challenge, number: n, salt: ch.salt, signature: ch.signature, took: 1 }));
    }
  }
  throw new Error("unsolvable");
}

describe("altcha", () => {
  const cfg: CaptchaConfig = { provider: "altcha", hmacKey: "test-hmac-key-0123456789", maxNumber: 2000 };

  it("accepts a solved challenge once", async () => {
    const replay = new ReplayGuard();
    const payload = solve(await createAltchaChallenge(cfg));
    expect(await verifyCaptcha(cfg, { altcha: payload }, { replay })).toBe(true);
    expect(await verifyCaptcha(cfg, { altcha: payload }, { replay })).toBe(false);
  });

  it("rejects expired, tampered or foreign challenges", async () => {
    let t = Date.now();
    const ch = await createAltchaChallenge({ ...cfg, expiresSeconds: 60 }, () => t);
    const payload = solve(ch);
    t += 61_000;
    expect(await verifyCaptcha(cfg, { altcha: payload }, { now: () => t })).toBe(false);

    const p = JSON.parse(atob(solve(await createAltchaChallenge(cfg))));
    expect(await verifyCaptcha(cfg, { altcha: btoa(JSON.stringify({ ...p, number: p.number + 1 })) })).toBe(false);
    expect(await verifyCaptcha(cfg, { altcha: btoa(JSON.stringify({ ...p, salt: p.salt.replace(/expires=\d+/, "expires=9999999999") })) })).toBe(false);
    expect(await verifyCaptcha({ ...cfg, hmacKey: "another-key-0123456789" }, { altcha: btoa(JSON.stringify(p)) })).toBe(false);
    expect(await verifyCaptcha(cfg, { altcha: "not-base64-json" })).toBe(false);
  });

  it("serves challenges and verifies them through the form endpoint", async () => {
    const form = formSchema.parse({ provider: "p", from: "f@example.com", to: "i@example.com", allowedOrigins: ["https://site.test"], captcha: cfg });
    const sent: unknown[] = [];
    const app = createFormsApp({ resolve: () => ({ form, provider: { type: "x", send: async (m) => void sent.push(m) } }), maxBodySize: 100_000, log: () => {} });
    const res = await app.request("/f/c/altcha", { headers: { origin: "https://site.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://site.test");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const payload = solve(await res.json());
    const post = (fields: Record<string, string>) =>
      app.request("/f/c", { method: "POST", body: new URLSearchParams(fields), headers: { origin: "https://site.test", accept: "application/json" } });
    expect((await post({ email: "a@b.test" })).status).toBe(400);
    expect((await post({ email: "a@b.test", altcha: payload })).status).toBe(200);
    expect((await post({ email: "a@b.test", altcha: payload })).status).toBe(400);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(payload);
  });

  it("has no challenge route for forms without altcha", async () => {
    const form = formSchema.parse({ provider: "p", from: "f@example.com", to: "i@example.com" });
    const app = createFormsApp({ resolve: () => ({ form, provider: { type: "x", send: async () => {} } }), maxBodySize: 1000, log: () => {} });
    expect((await app.request("/f/c/altcha")).status).toBe(404);
  });
});

describe("config", () => {
  it("maps the old turnstile shorthand and requires a captcha for autoresponses", () => {
    const form = formSchema.parse({ provider: "p", from: "f@example.com", to: "i@example.com", turnstile: { secret: "s" } });
    expect(form.captcha).toEqual({ provider: "turnstile", secret: "s" });
    const base = { providers: { p: { type: "postmark", token: "t" } } };
    const auto = { subject: "Bedankt", text: "Hoi" };
    expect(() => loadConfig({ ...base, forms: { c: { provider: "p", from: "f@x.test", to: "i@x.test", autoresponse: auto } } }, {})).toThrow(/captcha/);
    expect(() =>
      loadConfig({ ...base, forms: { c: { provider: "p", from: "f@x.test", to: "i@x.test", autoresponse: auto, captcha: { provider: "altcha", hmacKey: "0123456789abcdef0123" } } } }, {}),
    ).not.toThrow();
  });
});
