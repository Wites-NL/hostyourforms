import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Mail, MailProvider } from "../src/mail.js";

function setup(formOverrides: Record<string, unknown> = {}, opts: { turnstileOk?: boolean } = {}) {
  const sent: Mail[] = [];
  const provider: MailProvider = { type: "fake", send: async (m) => void sent.push(m) };
  const config = loadConfig(
    {
      providers: { main: { type: "postmark", token: "${TOKEN}" } },
      forms: {
        contact: {
          provider: "main",
          from: "Website <forms@example.com>",
          to: "info@example.com",
          subject: "Bericht van {{name}}",
          allowedOrigins: ["https://example.com"],
          requiredFields: ["name", "email"],
          ...formOverrides,
        },
      },
    },
    { TOKEN: "x" },
  );
  const fakeFetch = (async () => Response.json({ success: opts.turnstileOk ?? true })) as unknown as typeof fetch;
  const app = createApp(config, { providers: { main: provider }, fetch: fakeFetch, log: () => {} });
  return { app, sent };
}

function post(app: ReturnType<typeof setup>["app"], body: BodyInit, headers: Record<string, string> = {}) {
  return app.request("/f/contact", {
    method: "POST",
    body,
    headers: { origin: "https://example.com", ...headers },
  });
}

function formBody(fields: Record<string, string>) {
  return new URLSearchParams(fields);
}

describe("form submissions", () => {
  it("sends a notification and returns JSON when asked", async () => {
    const { app, sent } = setup();
    const res = await post(app, formBody({ name: "Piet", email: "piet@example.org", message: "Hoi" }), {
      accept: "application/json",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["info@example.com"], replyTo: "piet@example.org", subject: "Bericht van Piet" });
    expect(sent[0]!.text).toContain("Hoi");
  });

  it("redirects to the configured thank-you page", async () => {
    const { app } = setup({ redirect: "https://example.com/bedankt" });
    const res = await post(app, formBody({ name: "Piet", email: "piet@example.org" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://example.com/bedankt");
  });

  it("only follows _redirect to allowed origins", async () => {
    const { app } = setup({ redirect: "https://example.com/bedankt" });
    const evil = await post(app, formBody({ name: "a", email: "a@b.nl", _redirect: "https://evil.test/" }));
    expect(evil.headers.get("location")).toBe("https://example.com/bedankt");
    const good = await post(app, formBody({ name: "a", email: "a@b.nl", _redirect: "https://example.com/ok" }));
    expect(good.headers.get("location")).toBe("https://example.com/ok");
  });

  it("rejects other origins", async () => {
    const { app, sent } = setup();
    const res = await post(app, formBody({ name: "a", email: "a@b.nl" }), { origin: "https://evil.test", accept: "application/json" });
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("silently drops honeypot submissions", async () => {
    const { app, sent } = setup();
    const res = await post(app, formBody({ name: "a", email: "a@b.nl", _gotcha: "bot" }), { accept: "application/json" });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("reports missing required fields", async () => {
    const { app } = setup();
    const res = await post(app, formBody({ name: "a" }), { accept: "application/json" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "missing_fields", details: { missing: ["email"] } });
  });

  it("strips newlines from subject and ignores invalid reply-to", async () => {
    const { app, sent } = setup();
    await post(app, formBody({ name: "x\r\nBcc: victim@example.com", email: "not an email\r\n" }));
    expect(sent[0]!.subject).not.toMatch(/[\r\n]/);
    expect(sent[0]!.replyTo).toBeUndefined();
  });

  it("rate limits per client", async () => {
    const { app } = setup({ rateLimit: { max: 2, windowSeconds: 60 } });
    const send = () => post(app, formBody({ name: "a", email: "a@b.nl" }), { accept: "application/json" });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
  });

  it("accepts JSON bodies", async () => {
    const { app, sent } = setup();
    const res = await post(app, JSON.stringify({ name: "Json", email: "j@example.org", tags: ["a", "b"] }), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(sent[0]!.text).toContain("a, b");
  });

  it("verifies turnstile when configured", async () => {
    const { app, sent } = setup({ turnstile: { secret: "s" } }, { turnstileOk: false });
    const res = await post(app, formBody({ name: "a", email: "a@b.nl", "cf-turnstile-response": "t" }), { accept: "application/json" });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("sends an autoresponse when configured", async () => {
    const { app, sent } = setup({
      turnstile: { secret: "s" },
      autoresponse: { subject: "Bedankt {{name}}", text: "We hebben je bericht ontvangen." },
    });
    await post(app, formBody({ name: "Piet", email: "piet@example.org", "cf-turnstile-response": "t" }));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ to: ["piet@example.org"], subject: "Bedankt Piet" });
  });

  it("handles attachments according to the rules", async () => {
    const { app, sent } = setup({ attachments: { allowedTypes: ["application/pdf"] } });
    const fd = new FormData();
    fd.set("name", "a");
    fd.set("email", "a@b.nl");
    fd.set("file", new File([new Uint8Array([1, 2, 3])], "cv.pdf", { type: "application/pdf" }));
    expect((await post(app, fd)).status).toBe(200);
    expect(sent[0]!.attachments?.[0]?.filename).toBe("cv.pdf");

    const bad = new FormData();
    bad.set("name", "a");
    bad.set("email", "a@b.nl");
    bad.set("file", new File(["x"], "evil.exe", { type: "application/x-msdownload" }));
    const res = await post(app, bad, { accept: "application/json" });
    expect(res.status).toBe(422);
  });

  it("rejects files when the form has no attachment rules", async () => {
    const { app } = setup();
    const fd = new FormData();
    fd.set("name", "a");
    fd.set("email", "a@b.nl");
    fd.set("file", new File(["x"], "a.pdf", { type: "application/pdf" }));
    expect((await post(app, fd, { accept: "application/json" })).status).toBe(422);
  });

  it("returns 404 for unknown forms", async () => {
    const { app } = setup();
    const res = await app.request("/f/nope", { method: "POST", body: formBody({}), headers: { accept: "application/json" } });
    expect(res.status).toBe(404);
  });
});

describe("config", () => {
  it("reports missing env vars", () => {
    expect(() => loadConfig({ providers: { p: { type: "postmark", token: "${NOPE}" } }, forms: {} }, {})).toThrow(/NOPE/);
  });

  it("requires turnstile for autoresponses", () => {
    expect(() =>
      loadConfig(
        {
          providers: { p: { type: "postmark", token: "t" } },
          forms: { f: { provider: "p", from: "a@b.nl", to: "c@d.nl", autoresponse: { subject: "s", text: "t" } } },
        },
        {},
      ),
    ).toThrow(/captcha/);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      loadConfig({ providers: {}, forms: { f: { provider: "x", from: "a@b.nl", to: "c@d.nl" } } }, {}),
    ).toThrow(/unknown provider/);
  });
});

describe("createFormsApp", () => {
  async function build() {
    const { createFormsApp } = await import("../src/app.js");
    const { formSchema } = await import("../src/config.js");
    const sent: Mail[] = [];
    const events: unknown[] = [];
    const provider: MailProvider = { type: "fake", send: async (m) => void sent.push(m) };
    const form = formSchema.parse({
      provider: "db",
      from: "forms@example.com",
      to: "info@example.com",
      allowedOrigins: ["https://example.com"],
      requiredFields: ["email"],
    });
    const app = createFormsApp({
      resolve: async (id) => (id === "abc123" ? { form, provider } : undefined),
      maxBodySize: 1024 * 1024,
      log: () => {},
      onResult: (e) => void events.push(e),
    });
    const send = (id: string, fields: Record<string, string>) =>
      app.request(`/f/${id}`, {
        method: "POST",
        body: new URLSearchParams(fields),
        headers: { origin: "https://example.com", accept: "application/json" },
      });
    return { send, sent, events };
  }

  it("resolves forms per request and reports each outcome without field values", async () => {
    const { send, sent, events } = await build();
    expect((await send("abc123", { email: "a@example.org", message: "hoi" })).status).toBe(200);
    expect((await send("abc123", { message: "geen email" })).status).toBe(422);
    expect((await send("abc123", { email: "a@example.org", _gotcha: "bot" })).status).toBe(200);
    expect((await send("onbekend", { email: "a@example.org" })).status).toBe(404);
    expect(sent).toHaveLength(1);
    expect(events).toEqual([
      { formId: "abc123", status: "delivered", attachments: 0 },
      { formId: "abc123", status: "rejected", code: "missing_fields" },
      { formId: "abc123", status: "spam", code: "honeypot" },
    ]);
  });

  it("keeps answering when the onResult hook throws", async () => {
    const { createFormsApp } = await import("../src/app.js");
    const { formSchema } = await import("../src/config.js");
    const form = formSchema.parse({ provider: "db", from: "f@example.com", to: "i@example.com" });
    const app = createFormsApp({
      resolve: () => ({ form, provider: { type: "fake", send: async () => {} } }),
      maxBodySize: 1024,
      log: () => {},
      onResult: () => {
        throw new Error("db down");
      },
    });
    const res = await app.request("/f/x", { method: "POST", body: new URLSearchParams({ a: "b" }), headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
  });
});
