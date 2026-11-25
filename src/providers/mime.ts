import { type Mail, toBase64, utf8Base64 } from "../mail.js";

const CRLF = "\r\n";

// eslint-disable-next-line no-control-regex
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

/** RFC 2047 encoded-word for header values that contain non-ASCII text. */
export function encodeHeaderValue(value: string): string {
  return isAscii(value) ? value : `=?UTF-8?B?${utf8Base64(value)}?=`;
}

/** Encode the display-name part of "Name <addr>" when needed; bare addresses pass through. */
export function encodeAddress(address: string): string {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(address);
  if (!match) return address.trim();
  const [, rawName = "", addr] = match;
  const name = rawName.replace(/^"(.*)"$/, "$1");
  if (!name) return `<${addr}>`;
  if (!isAscii(name)) return `${encodeHeaderValue(name)} <${addr}>`;
  return /[()<>[\]:;@\\,."]/.test(name)
    ? `"${name.replace(/(["\\])/g, "\\$1")}" <${addr}>`
    : `${name} <${addr}>`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, (line) => line + CRLF);
}

function quoteParam(value: string): string {
  return value.replace(/[\r\n"\\]/g, "_");
}

function textPart(contentType: string, body: string): string {
  return (
    `Content-Type: ${contentType}; charset=UTF-8${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrap76(utf8Base64(body))
  );
}

function multipart(subtype: string, boundary: string, parts: string[]): string {
  return (
    `Content-Type: multipart/${subtype}; boundary="${boundary}"${CRLF}${CRLF}` +
    parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) +
    `${CRLF}--${boundary}--${CRLF}`
  );
}

function randomBoundary(): string {
  return `=_hyf_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Build an RFC 5322 message. Bcc is intentionally left out of the headers. */
export function buildMime(mail: Mail, opts: { date?: Date; boundary?: () => string } = {}): string {
  const boundary = opts.boundary ?? randomBoundary;
  const headers = [
    `From: ${encodeAddress(mail.from)}`,
    `To: ${mail.to.map(encodeAddress).join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.map(encodeAddress).join(", ")}`] : []),
    ...(mail.replyTo ? [`Reply-To: ${encodeAddress(mail.replyTo)}`] : []),
    `Subject: ${encodeHeaderValue(mail.subject)}`,
    `Date: ${(opts.date ?? new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
  ];

  let body = mail.html
    ? multipart("alternative", boundary(), [
        textPart("text/plain", mail.text),
        textPart("text/html", mail.html),
      ])
    : textPart("text/plain", mail.text);

  if (mail.attachments?.length) {
    const files = mail.attachments.map((a) => {
      const name = quoteParam(a.filename);
      const encodedName = isAscii(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(a.filename)}`;
      return (
        `Content-Type: ${a.contentType}; name="${isAscii(name) ? name : encodeHeaderValue(name)}"${CRLF}` +
        `Content-Disposition: attachment; ${encodedName}${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
        wrap76(toBase64(a.content))
      );
    });
    body = multipart("mixed", boundary(), [body, ...files]);
  }

  return headers.join(CRLF) + CRLF + body;
}
