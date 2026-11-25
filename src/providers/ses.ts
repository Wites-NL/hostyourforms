import { type Mail, type MailProvider, ProviderError, readErrorDetail, utf8Base64 } from "../mail.js";
import { buildMime } from "./mime.js";
import { signV4 } from "./sigv4.js";

export interface SesOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  configurationSet?: string;
  fetch?: typeof fetch;
}

/**
 * Amazon SES v2 SendEmail with raw MIME content, so attachments work the same
 * way as plain messages. The IAM user only needs ses:SendEmail.
 */
export function sesProvider(opts: SesOptions): MailProvider {
  const doFetch = opts.fetch ?? fetch;
  const url = `https://email.${opts.region}.amazonaws.com/v2/email/outbound-emails`;
  return {
    type: "ses",
    async send(mail: Mail) {
      const body = JSON.stringify({
        FromEmailAddress: mail.from,
        Destination: {
          ToAddresses: mail.to,
          CcAddresses: mail.cc ?? [],
          BccAddresses: mail.bcc ?? [],
        },
        ReplyToAddresses: mail.replyTo ? [mail.replyTo] : [],
        Content: { Raw: { Data: utf8Base64(buildMime(mail)) } },
        ConfigurationSetName: opts.configurationSet,
      });
      const headers = await signV4({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        body,
        region: opts.region,
        service: "ses",
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      });
      // `host` is set by fetch itself and may not be overridden.
      delete headers["host"];
      const res = await doFetch(url, { method: "POST", headers, body });
      if (!res.ok) throw new ProviderError("ses", res.status, await readErrorDetail(res));
    },
  };
}
