/**
 * Adds a form submitter to a newsletter list. Only fetch is used, so it runs on
 * Node and on the edge. Every service upserts or treats "already on the list" as
 * success, so a visitor who signs up twice never sees an error.
 */
import { z } from "zod";

const common = {
  /** Form field holding the subscriber's email address. */
  emailField: z.string().default("email"),
  /** Form field with the subscriber's (first) name, stored in the service's own name field. */
  nameField: z.string().optional(),
  /**
   * Only subscribe when this form field is filled in, e.g. a checkbox
   * "Ook inschrijven voor de nieuwsbrief" on a contact form.
   */
  consentField: z.string().optional(),
  /** Extra form fields to store, as { formField: serviceField }. */
  fields: z.record(z.string(), z.string()).default({}),
};

export const newsletterSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("emailit"),
    apiKey: z.string().min(1),
    /** Audience id (aud_…) or its name. */
    audienceId: z.string().min(1),
    doubleOptIn: z.boolean().default(false),
    ...common,
  }),
  z.object({
    type: z.literal("laposta"),
    apiKey: z.string().min(1),
    listId: z.string().min(1),
    ...common,
  }),
  z.object({
    type: z.literal("plunk"),
    apiKey: z.string().min(1),
    baseUrl: z.url().default("https://next-api.useplunk.com"),
    ...common,
  }),
  z.object({
    type: z.literal("brevo"),
    apiKey: z.string().min(1),
    listId: z.coerce.number().int().positive(),
    /** With double opt-in Brevo mails a confirmation using this template first. */
    doubleOptIn: z.object({ templateId: z.coerce.number().int().positive(), redirectUrl: z.url() }).optional(),
    ...common,
  }),
  z.object({
    type: z.literal("mailchimp"),
    /** API key including the datacenter suffix, e.g. "abc123-us21". */
    apiKey: z.string().regex(/-[a-z]+\d+$/, "Mailchimp API key must end with the datacenter, e.g. -us21"),
    /** Audience id ("list id"). */
    listId: z.string().min(1),
    doubleOptIn: z.boolean().default(false),
    ...common,
  }),
  z.object({
    type: z.literal("activecampaign"),
    /** Your API URL, e.g. https://jouwaccount.api-us1.com */
    apiUrl: z.url(),
    apiKey: z.string().min(1),
    listId: z.coerce.number().int().positive(),
    ...common,
  }),
  z.object({
    type: z.literal("mailerlite"),
    apiKey: z.string().min(1),
    groupId: z.string().optional(),
    ...common,
  }),
]);

export type NewsletterConfig = z.infer<typeof newsletterSchema>;

export interface Subscriber {
  email: string;
  name?: string;
  fields: Record<string, string>;
  ip?: string;
  sourceUrl?: string;
}

/** "pending" means the service mailed a confirmation link first (double opt-in). */
export type SubscribeResult = "subscribed" | "pending" | "exists";

export class NewsletterError extends Error {
  constructor(
    public service: string,
    public status: number,
    detail: string,
  ) {
    super(`${service} returned ${status}: ${detail.slice(0, 300)}`);
    this.name = "NewsletterError";
  }
}

/** Pick the subscriber's data out of a submission, or undefined when they did not opt in. */
export function subscriberFrom(cfg: NewsletterConfig, values: Record<string, string | undefined>): Omit<Subscriber, "ip" | "sourceUrl"> | undefined {
  if (cfg.consentField && !values[cfg.consentField]?.trim()) return undefined;
  const email = values[cfg.emailField]?.trim() ?? "";
  const name = cfg.nameField ? values[cfg.nameField]?.trim() || undefined : undefined;
  const fields: Record<string, string> = {};
  for (const [from, to] of Object.entries(cfg.fields)) {
    const v = values[from]?.trim();
    if (v) fields[to] = v;
  }
  return { email, name, fields };
}

export async function subscribe(cfg: NewsletterConfig, sub: Subscriber, doFetch: typeof fetch = fetch): Promise<SubscribeResult> {
  const json = (headers: Record<string, string>, body: unknown): RequestInit => ({
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  switch (cfg.type) {
    case "emailit": {
      const res = await doFetch(
        `https://api.emailit.com/v2/audiences/${encodeURIComponent(cfg.audienceId)}/subscribers`,
        json(
          { Authorization: `Bearer ${cfg.apiKey}` },
          {
            email: sub.email,
            ...(sub.name ? { first_name: sub.name } : {}),
            ...(Object.keys(sub.fields).length ? { custom_fields: sub.fields } : {}),
            ...(cfg.doubleOptIn ? { double_opt_in: true } : {}),
          },
        ),
      );
      if (res.status === 409) return "exists";
      if (res.status === 202) return "pending";
      return ok(res, "emailit", "subscribed");
    }

    case "laposta": {
      const body = new URLSearchParams({
        list_id: cfg.listId,
        ip: sub.ip ?? "127.0.0.1",
        email: sub.email,
        "options[upsert]": "true",
      });
      if (sub.sourceUrl) body.set("source_url", sub.sourceUrl);
      for (const [k, v] of Object.entries(sub.fields)) body.set(`custom_fields[${k}]`, v);
      const res = await doFetch("https://api.laposta.nl/v2/member", {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${cfg.apiKey}:`)}` },
        body,
      });
      // Double opt-in is a list setting in Laposta; the member then starts as "unconfirmed".
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { member?: { state?: string } };
        return data.member?.state === "unconfirmed" ? "pending" : "subscribed";
      }
      return ok(res, "laposta", "subscribed");
    }

    case "plunk": {
      const res = await doFetch(
        `${cfg.baseUrl.replace(/\/$/, "")}/contacts`,
        json(
          { Authorization: `Bearer ${cfg.apiKey}` },
          { email: sub.email, subscribed: true, data: { ...(sub.name ? { firstName: sub.name } : {}), ...sub.fields } },
        ),
      );
      return ok(res, "plunk", "subscribed");
    }

    case "brevo": {
      const attributes = { ...(sub.name ? { FIRSTNAME: sub.name } : {}), ...sub.fields };
      const headers = { "api-key": cfg.apiKey };
      if (cfg.doubleOptIn) {
        const res = await doFetch(
          "https://api.brevo.com/v3/contacts/doubleOptinConfirmation",
          json(headers, {
            email: sub.email,
            attributes,
            includeListIds: [cfg.listId],
            templateId: cfg.doubleOptIn.templateId,
            redirectionUrl: cfg.doubleOptIn.redirectUrl,
          }),
        );
        return ok(res, "brevo", "pending");
      }
      const res = await doFetch(
        "https://api.brevo.com/v3/contacts",
        json(headers, { email: sub.email, attributes, listIds: [cfg.listId], updateEnabled: true }),
      );
      // 201 = created, 204 = existing contact updated and added to the list.
      return ok(res, "brevo", res.status === 204 ? "exists" : "subscribed");
    }

    case "mailchimp": {
      const dc = cfg.apiKey.split("-").at(-1);
      const res = await doFetch(
        `https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(cfg.listId)}/members`,
        json(
          { Authorization: `Basic ${btoa(`hostyourforms:${cfg.apiKey}`)}` },
          {
            email_address: sub.email,
            status: cfg.doubleOptIn ? "pending" : "subscribed",
            merge_fields: { ...(sub.name ? { FNAME: sub.name } : {}), ...sub.fields },
          },
        ),
      );
      if (res.status === 400) {
        const text = await res.text();
        if (text.includes("Member Exists")) return "exists";
        throw new NewsletterError("mailchimp", 400, text);
      }
      return ok(res, "mailchimp", cfg.doubleOptIn ? "pending" : "subscribed");
    }

    case "activecampaign": {
      const base = `${cfg.apiUrl.replace(/\/$/, "")}/api/3`;
      const headers = { "Api-Token": cfg.apiKey };
      const contact: Record<string, unknown> = { email: sub.email };
      if (sub.name) contact.firstName = sub.name;
      const custom = Object.entries(sub.fields).map(([field, value]) => ({ field, value }));
      if (custom.length) contact.fieldValues = custom;
      const res = await doFetch(`${base}/contact/sync`, json(headers, { contact }));
      if (!res.ok) throw new NewsletterError("activecampaign", res.status, await res.text());
      const id = ((await res.json()) as { contact?: { id?: string | number } }).contact?.id;
      if (!id) throw new NewsletterError("activecampaign", res.status, "no contact id in response");
      const list = await doFetch(`${base}/contactLists`, json(headers, { contactList: { list: cfg.listId, contact: id, status: 1 } }));
      return ok(list, "activecampaign", "subscribed");
    }

    case "mailerlite": {
      const res = await doFetch(
        "https://connect.mailerlite.com/api/subscribers",
        json(
          { Authorization: `Bearer ${cfg.apiKey}` },
          {
            email: sub.email,
            fields: { ...(sub.name ? { name: sub.name } : {}), ...sub.fields },
            ...(cfg.groupId ? { groups: [cfg.groupId] } : {}),
            ...(sub.ip ? { ip_address: sub.ip } : {}),
          },
        ),
      );
      // 201 = new, 200 = existing subscriber updated. Double opt-in is an account setting.
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { data?: { status?: string } };
        if (data.data?.status === "unconfirmed") return "pending";
        return res.status === 200 ? "exists" : "subscribed";
      }
      return ok(res, "mailerlite", "subscribed");
    }
  }
}

async function ok(res: Response, service: string, result: SubscribeResult): Promise<SubscribeResult> {
  if (res.ok) return result;
  throw new NewsletterError(service, res.status, await res.text().catch(() => ""));
}
