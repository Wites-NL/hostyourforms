import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import type { Mail, MailProvider } from "../src/mail.js";
import { NewsletterError, newsletterSchema, subscribe, subscriberFrom } from "../src/newsletter.js";

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(...responses: Response[]) {
  const calls: Call[] = [];
  const doFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: String(init.body ?? ""),
    });
    return responses.shift() ?? Response.json({}, { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

const sub = { email: "ada@example.org", name: "Ada", fields: {}, ip: "203.0.113.9", sourceUrl: "https://example.com/" };

describe("newsletter services", () => {
  it("emailit: adds a subscriber to the audience", async () => {
    const { calls, doFetch } = recorder(Response.json({ object: "subscriber" }, { status: 201 }));
    const cfg = newsletterSchema.parse({ type: "emailit", apiKey: "secret_x", audienceId: "aud_1" });
    expect(await subscribe(cfg, { ...sub, fields: { company: "AE" } }, doFetch)).toBe("subscribed");
    expect(calls[0]!.url).toBe("https://api.emailit.com/v2/audiences/aud_1/subscribers");
    expect(calls[0]!.headers.authorization).toBe("Bearer secret_x");
    expect(JSON.parse(calls[0]!.body)).toEqual({ email: "ada@example.org", first_name: "Ada", custom_fields: { company: "AE" } });
  });

  it("emailit: already subscribed and double opt-in are not errors", async () => {
    const cfg = newsletterSchema.parse({ type: "emailit", apiKey: "k", audienceId: "aud_1", doubleOptIn: true });
    const dup = recorder(Response.json({ error: "Contact is already subscribed" }, { status: 409 }));
    expect(await subscribe(cfg, sub, dup.doFetch)).toBe("exists");
    const doi = recorder(Response.json({ status: "pending" }, { status: 202 }));
    expect(await subscribe(cfg, sub, doi.doFetch)).toBe("pending");
    expect(JSON.parse(doi.calls[0]!.body).double_opt_in).toBe(true);
  });

  it("laposta: form-encoded upsert with basic auth", async () => {
    const { calls, doFetch } = recorder(Response.json({ member: { state: "active" } }));
    const cfg = newsletterSchema.parse({ type: "laposta", apiKey: "lk", listId: "abc", fields: { naam: "voornaam" } });
    expect(await subscribe(cfg, { ...sub, name: undefined, fields: { voornaam: "Ada" } }, doFetch)).toBe("subscribed");
    expect(calls[0]!.url).toBe("https://api.laposta.nl/v2/member");
    expect(calls[0]!.headers.authorization).toBe(`Basic ${btoa("lk:")}`);
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("list_id")).toBe("abc");
    expect(body.get("ip")).toBe("203.0.113.9");
    expect(body.get("options[upsert]")).toBe("true");
    expect(body.get("custom_fields[voornaam]")).toBe("Ada");
  });

  it("laposta: unconfirmed member means double opt-in is pending", async () => {
    const { doFetch } = recorder(Response.json({ member: { state: "unconfirmed" } }));
    const cfg = newsletterSchema.parse({ type: "laposta", apiKey: "lk", listId: "abc" });
    expect(await subscribe(cfg, sub, doFetch)).toBe("pending");
  });

  it("plunk: upserts a subscribed contact", async () => {
    const { calls, doFetch } = recorder(Response.json({ id: "cnt_1" }));
    const cfg = newsletterSchema.parse({ type: "plunk", apiKey: "sk_1" });
    await subscribe(cfg, sub, doFetch);
    expect(calls[0]!.url).toBe("https://next-api.useplunk.com/contacts");
    expect(JSON.parse(calls[0]!.body)).toEqual({ email: "ada@example.org", subscribed: true, data: { firstName: "Ada" } });
  });

  it("brevo: creates or updates the contact on the list", async () => {
    const { calls, doFetch } = recorder(new Response(null, { status: 204 }));
    const cfg = newsletterSchema.parse({ type: "brevo", apiKey: "xkeysib", listId: "7" });
    expect(await subscribe(cfg, sub, doFetch)).toBe("exists");
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/contacts");
    expect(calls[0]!.headers["api-key"]).toBe("xkeysib");
    expect(JSON.parse(calls[0]!.body)).toEqual({ email: "ada@example.org", attributes: { FIRSTNAME: "Ada" }, listIds: [7], updateEnabled: true });
  });

  it("brevo: double opt-in uses the confirmation endpoint", async () => {
    const { calls, doFetch } = recorder(Response.json({}, { status: 201 }));
    const cfg = newsletterSchema.parse({
      type: "brevo",
      apiKey: "k",
      listId: 7,
      doubleOptIn: { templateId: 3, redirectUrl: "https://example.com/bevestigd" },
    });
    expect(await subscribe(cfg, sub, doFetch)).toBe("pending");
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/contacts/doubleOptinConfirmation");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ includeListIds: [7], templateId: 3, redirectionUrl: "https://example.com/bevestigd" });
  });

  it("mailchimp: uses the datacenter from the key and treats Member Exists as success", async () => {
    const { calls, doFetch } = recorder(Response.json({ title: "Member Exists", status: 400 }, { status: 400 }));
    const cfg = newsletterSchema.parse({ type: "mailchimp", apiKey: "abc123-us21", listId: "L1", doubleOptIn: true });
    expect(await subscribe(cfg, sub, doFetch)).toBe("exists");
    expect(calls[0]!.url).toBe("https://us21.api.mailchimp.com/3.0/lists/L1/members");
    expect(JSON.parse(calls[0]!.body)).toEqual({ email_address: "ada@example.org", status: "pending", merge_fields: { FNAME: "Ada" } });
  });

  it("mailchimp: rejects keys without a datacenter", () => {
    expect(newsletterSchema.safeParse({ type: "mailchimp", apiKey: "abc", listId: "L1" }).success).toBe(false);
  });

  it("activecampaign: syncs the contact, then adds it to the list", async () => {
    const { calls, doFetch } = recorder(Response.json({ contact: { id: "42" } }), Response.json({ contactList: {} }, { status: 201 }));
    const cfg = newsletterSchema.parse({ type: "activecampaign", apiUrl: "https://acme.api-us1.com/", apiKey: "t", listId: "2" });
    expect(await subscribe(cfg, sub, doFetch)).toBe("subscribed");
    expect(calls.map((c) => c.url)).toEqual(["https://acme.api-us1.com/api/3/contact/sync", "https://acme.api-us1.com/api/3/contactLists"]);
    expect(calls[0]!.headers["api-token"]).toBe("t");
    expect(JSON.parse(calls[1]!.body)).toEqual({ contactList: { list: 2, contact: "42", status: 1 } });
  });

  it("mailerlite: adds to the group", async () => {
    const { calls, doFetch } = recorder(Response.json({ data: { status: "active" } }, { status: 201 }));
    const cfg = newsletterSchema.parse({ type: "mailerlite", apiKey: "ml", groupId: "g1" });
    expect(await subscribe(cfg, sub, doFetch)).toBe("subscribed");
    expect(JSON.parse(calls[0]!.body)).toEqual({ email: "ada@example.org", fields: { name: "Ada" }, groups: ["g1"], ip_address: "203.0.113.9" });
  });

  it("throws a NewsletterError on other failures", async () => {
    const { doFetch } = recorder(new Response("unauthorized", { status: 401 }));
    const cfg = newsletterSchema.parse({ type: "plunk", apiKey: "bad" });
    await expect(subscribe(cfg, sub, doFetch)).rejects.toBeInstanceOf(NewsletterError);
  });

  it("subscriberFrom respects the consent field and maps fields", () => {
    const cfg = newsletterSchema.parse({ type: "plunk", apiKey: "k", nameField: "naam", consentField: "nieuwsbrief", fields: { bedrijf: "company" } });
    expect(subscriberFrom(cfg, { email: "a@b.nl" })).toBeUndefined();
    expect(subscriberFrom(cfg, { email: " a@b.nl ", naam: "Ada", bedrijf: "AE", nieuwsbrief: "ja" })).toEqual({
      email: "a@b.nl",
      name: "Ada",
      fields: { company: "AE" },
    });
  });
});

function setup(form: Record<string, unknown>, ...responses: Response[]) {
  const sent: Mail[] = [];
  const provider: MailProvider = { type: "fake", send: async (m) => void sent.push(m) };
  const config = loadConfig(
    {
      providers: { main: { type: "postmark", token: "x" } },
      forms: { nieuwsbrief: { provider: "main", from: "Site <forms@example.com>", allowedOrigins: ["https://example.com"], ...form } },
    },
    {},
  );
  const { calls, doFetch } = recorder(...responses);
  const app = createApp(config, { providers: { main: provider }, fetch: doFetch, log: () => {} });
  const post = (fields: Record<string, string>, json = true) =>
    app.request("/f/nieuwsbrief", {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { origin: "https://example.com", ...(json ? { accept: "application/json" } : {}) },
    });
  return { post, sent, calls };
}

const emailit = { type: "emailit", apiKey: "k", audienceId: "aud_1" };

describe("newsletter forms", () => {
  it("a newsletter-only form subscribes without a notification mail", async () => {
    const { post, sent, calls } = setup({ newsletter: emailit, requiredFields: ["email"] });
    const res = await post({ email: "ada@example.org" });
    expect(await res.json()).toEqual({ ok: true, newsletter: "subscribed" });
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("shows a confirm-your-email page for double opt-in", async () => {
    const { post } = setup({ newsletter: { ...emailit, doubleOptIn: true } }, Response.json({}, { status: 202 }));
    const res = await post({ email: "ada@example.org" }, false);
    expect(await res.text()).toContain("bevestig je inschrijving");
  });

  it("with consentField, a contact form only subscribes when ticked", async () => {
    const { post, sent, calls } = setup({ to: "info@example.com", newsletter: { ...emailit, consentField: "nieuwsbrief" } });
    await post({ email: "ada@example.org", message: "hoi" });
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    await post({ email: "ada@example.org", message: "hoi", nieuwsbrief: "ja" });
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("rejects an invalid address before calling the service", async () => {
    const { post, calls } = setup({ newsletter: emailit });
    const res = await post({ email: "geen-adres" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_email");
    expect(calls).toHaveLength(0);
  });

  it("a failing service returns 502 and sends no notification", async () => {
    const { post, sent } = setup({ to: "info@example.com", newsletter: emailit }, new Response("down", { status: 500 }));
    const res = await post({ email: "ada@example.org" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("subscribe_failed");
    expect(sent).toHaveLength(0);
  });

  it("config needs to, newsletter, or both", () => {
    expect(() => setup({})).toThrow(ConfigError);
  });

  it("laposta must map the name via fields", () => {
    expect(() => setup({ newsletter: { type: "laposta", apiKey: "k", listId: "l", nameField: "naam" } })).toThrow(/fields/);
  });
});
