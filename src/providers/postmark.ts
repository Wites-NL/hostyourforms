import { type Mail, type MailProvider, ProviderError, readErrorDetail, toBase64 } from "../mail.js";

export interface PostmarkOptions {
  token: string;
  messageStream?: string;
  fetch?: typeof fetch;
}

/** https://postmarkapp.com/developer/api/email-api */
export function postmarkProvider(opts: PostmarkOptions): MailProvider {
  const doFetch = opts.fetch ?? fetch;
  return {
    type: "postmark",
    async send(mail: Mail) {
      const res = await doFetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": opts.token,
        },
        body: JSON.stringify({
          From: mail.from,
          To: mail.to.join(", "),
          Cc: mail.cc?.join(", "),
          Bcc: mail.bcc?.join(", "),
          ReplyTo: mail.replyTo,
          Subject: mail.subject,
          TextBody: mail.text,
          HtmlBody: mail.html,
          MessageStream: opts.messageStream,
          Attachments: mail.attachments?.map((a) => ({
            Name: a.filename,
            Content: toBase64(a.content),
            ContentType: a.contentType,
          })),
        }),
      });
      if (!res.ok) throw new ProviderError("postmark", res.status, await readErrorDetail(res));
      // Postmark can answer 200 with a non-zero ErrorCode.
      const data = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
      if (data.ErrorCode) throw new ProviderError("postmark", res.status, data.Message ?? `ErrorCode ${data.ErrorCode}`);
    },
  };
}
