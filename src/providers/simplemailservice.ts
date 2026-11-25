import { type Mail, type MailProvider, ProviderError, readErrorDetail, toBase64 } from "../mail.js";

export interface SimpleMailServiceOptions {
  apiKey: string;
  accountId: string;
  baseUrl?: string;
  /** Open- and click-tracking. Off by default: tracking rewrites links in form content. */
  tracking?: boolean;
  /** Days the provider keeps message metadata and content (overrides account defaults). */
  retention?: { metadata?: number; data?: number };
  fetch?: typeof fetch;
}

interface Address {
  email: string;
  name?: string;
}

/** "Website <forms@example.com>" -> { name: "Website", email: "forms@example.com" } */
export function parseAddress(value: string): Address {
  const match = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  const name = match[1]!.trim();
  return name ? { email: match[2]!.trim(), name } : { email: match[2]!.trim() };
}

interface SendResult {
  data?: { status?: string; error?: string | null; recipient?: { email?: string } }[];
}

/**
 * Simple Mail Service (Cyso), API v2.
 * https://api.simplemailservice.eu/api-docs-v2/
 *
 * The API has no cc/bcc: every recipient gets a separate message. to, cc and
 * bcc are therefore all sent as individual recipients.
 */
export function simpleMailServiceProvider(opts: SimpleMailServiceOptions): MailProvider {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? "https://api.simplemailservice.eu").replace(/\/+$/, "");
  const url = `${base}/v2/accounts/${encodeURIComponent(opts.accountId)}/messages`;

  return {
    type: "simplemailservice",
    async send(mail: Mail) {
      const seen = new Set<string>();
      const recipients = [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])]
        .map(parseAddress)
        .filter((r) => {
          const key = r.email.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      const res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          from: parseAddress(mail.from),
          recipients,
          reply_to: mail.replyTo ? parseAddress(mail.replyTo) : undefined,
          subject: mail.subject,
          text_content: mail.text,
          html_content: mail.html,
          attachments: mail.attachments?.map((a) => ({
            file_name: a.filename,
            content_type: a.contentType,
            data: toBase64(a.content),
            base64: true,
          })),
          tracking: { open: opts.tracking ?? false, click: opts.tracking ?? false },
          retention: opts.retention,
        }),
      });
      if (!res.ok) throw new ProviderError("simplemailservice", res.status, await readErrorDetail(res));

      // 202 can still contain per-recipient errors.
      const result = (await res.json().catch(() => ({}))) as SendResult;
      const failed = (result.data ?? []).filter((d) => d.status === "error");
      if (failed.length > 0) {
        const detail = failed.map((d) => `${d.recipient?.email ?? "?"}: ${d.error ?? "error"}`).join("; ");
        throw new ProviderError("simplemailservice", res.status, detail);
      }
    },
  };
}
