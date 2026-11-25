import { type Mail, type MailProvider, ProviderError, readErrorDetail, toBase64 } from "../mail.js";

export interface EmailitOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** https://emailit.com/docs/api-reference/emails/send (API v2) */
export function emailitProvider(opts: EmailitOptions): MailProvider {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? "https://api.emailit.com/v2").replace(/\/+$/, "");
  return {
    type: "emailit",
    async send(mail: Mail) {
      const res = await doFetch(`${base}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          from: mail.from,
          to: mail.to,
          cc: mail.cc,
          bcc: mail.bcc,
          reply_to: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          attachments: mail.attachments?.map((a) => ({
            filename: a.filename,
            content: toBase64(a.content),
            content_type: a.contentType,
          })),
        }),
      });
      if (!res.ok) throw new ProviderError("emailit", res.status, await readErrorDetail(res));
    },
  };
}
