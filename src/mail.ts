export interface Attachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface Mail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
}

export interface MailProvider {
  readonly type: string;
  send(mail: Mail): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${provider} responded with ${status}: ${detail}`);
    this.name = "ProviderError";
  }
}

/** Base64-encode bytes without relying on Node's Buffer (runs on edge runtimes too). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function utf8Base64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Conservative check for a bare address coming from untrusted input. */
export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** Remove characters that could break out of a single header line. */
export function sanitizeHeader(value: string, maxLength = 250): string {
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength);
}

export async function readErrorDetail(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return body.slice(0, 500) || res.statusText;
}
