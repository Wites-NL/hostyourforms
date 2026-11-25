// Node.js only: serverless/edge runtimes generally cannot open raw SMTP connections.
import nodemailer from "nodemailer";
import type { Mail, MailProvider } from "../mail.js";

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export function smtpProvider(opts: SmtpOptions): MailProvider {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: opts.user ? { user: opts.user, pass: opts.pass ?? "" } : undefined,
  });
  return {
    type: "smtp",
    async send(mail: Mail) {
      await transport.sendMail({
        from: mail.from,
        to: mail.to,
        cc: mail.cc,
        bcc: mail.bcc,
        replyTo: mail.replyTo,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: mail.attachments?.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: Buffer.from(a.content),
        })),
      });
    },
  };
}
