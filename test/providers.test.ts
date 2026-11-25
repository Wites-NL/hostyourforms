import { describe, expect, it } from "vitest";
import type { Mail } from "../src/mail.js";
import { emailitProvider } from "../src/providers/emailit.js";
import { buildMime, encodeAddress } from "../src/providers/mime.js";
import { postmarkProvider } from "../src/providers/postmark.js";
import { sesProvider } from "../src/providers/ses.js";
import { signV4 } from "../src/providers/sigv4.js";
import { parseAddress, simpleMailServiceProvider } from "../src/providers/simplemailservice.js";

const mail: Mail = {
  from: "Website <forms@example.com>",
  to: ["info@example.com"],
  replyTo: "bezoeker@example.org",
  subject: "Nieuw bericht – café",
  text: "Hallo",
  html: "<p>Hallo</p>",
  attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array([1, 2, 3]) }],
};

function captureFetch(response: Response = new Response("{}", { status: 200 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("sigv4", () => {
  it("matches the AWS get-vanilla test vector", async () => {
    const headers = await signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      date: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("mime", () => {
  it("encodes non-ASCII headers and leaves Bcc out", () => {
    const mime = buildMime({ ...mail, bcc: ["secret@example.com"] }, { date: new Date(0), boundary: () => "B" });
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).not.toContain("secret@example.com");
    expect(mime).toContain('Content-Disposition: attachment; filename="a.pdf"');
    expect(mime).toContain("Reply-To: bezoeker@example.org");
    expect(mime.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });

  it("quotes or encodes display names", () => {
    expect(encodeAddress("Jansen, Piet <p@example.com>")).toBe('"Jansen, Piet" <p@example.com>');
    expect(encodeAddress("Zoë <z@example.com>")).toMatch(/^=\?UTF-8\?B\?.+\?= <z@example.com>$/);
    expect(encodeAddress("plain@example.com")).toBe("plain@example.com");
  });
});

describe("providers", () => {
  it("postmark sends the expected payload", async () => {
    const { fn, calls } = captureFetch(new Response(JSON.stringify({ ErrorCode: 0 })));
    await postmarkProvider({ token: "tok", messageStream: "outbound", fetch: fn }).send(mail);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.postmarkapp.com/email");
    expect((call.init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("tok");
    const body = JSON.parse(call.init.body as string);
    expect(body).toMatchObject({ From: mail.from, To: "info@example.com", ReplyTo: mail.replyTo, MessageStream: "outbound" });
    expect(body.Attachments[0]).toEqual({ Name: "a.pdf", Content: "AQID", ContentType: "application/pdf" });
  });

  it("postmark surfaces API errors", async () => {
    const { fn } = captureFetch(new Response(JSON.stringify({ ErrorCode: 300, Message: "Invalid email" }), { status: 422 }));
    await expect(postmarkProvider({ token: "t", fetch: fn }).send(mail)).rejects.toThrow(/422/);
  });

  it("emailit sends the expected payload", async () => {
    const { fn, calls } = captureFetch();
    await emailitProvider({ apiKey: "key", fetch: fn }).send(mail);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.emailit.com/v2/emails");
    expect((call.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer key");
    const body = JSON.parse(call.init.body as string);
    expect(body).toMatchObject({ from: mail.from, to: mail.to, reply_to: mail.replyTo, subject: mail.subject });
    expect(body.attachments[0]).toEqual({ filename: "a.pdf", content: "AQID", content_type: "application/pdf" });
  });

  it("simplemailservice sends the expected payload", async () => {
    const { fn, calls } = captureFetch(
      new Response(JSON.stringify({ object: "list", data: [{ object: "message", status: "queued" }] }), { status: 202 }),
    );
    await simpleMailServiceProvider({ apiKey: "smseu-sk-x", accountId: "acc-1", fetch: fn }).send({
      ...mail,
      to: ["Info <info@example.com>"],
      cc: ["info@example.com", "sales@example.com"],
    });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.simplemailservice.eu/v2/accounts/acc-1/messages");
    expect((call.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer smseu-sk-x");
    const body = JSON.parse(call.init.body as string);
    expect(body).toMatchObject({
      from: { email: "forms@example.com", name: "Website" },
      recipients: [{ email: "info@example.com", name: "Info" }, { email: "sales@example.com" }],
      reply_to: { email: "bezoeker@example.org" },
      subject: mail.subject,
      text_content: "Hallo",
      html_content: "<p>Hallo</p>",
      tracking: { open: false, click: false },
    });
    expect(body.attachments[0]).toEqual({ file_name: "a.pdf", content_type: "application/pdf", data: "AQID", base64: true });
  });

  it("simplemailservice fails on per-recipient errors and HTTP errors", async () => {
    const partial = captureFetch(
      new Response(JSON.stringify({ data: [{ status: "error", error: "suppressed", recipient: { email: "info@example.com" } }] }), { status: 202 }),
    );
    await expect(simpleMailServiceProvider({ apiKey: "k", accountId: "a", fetch: partial.fn }).send(mail)).rejects.toThrow(/suppressed/);
    const denied = captureFetch(new Response(JSON.stringify({ message: "invalid API key" }), { status: 401 }));
    await expect(simpleMailServiceProvider({ apiKey: "k", accountId: "a", fetch: denied.fn }).send(mail)).rejects.toThrow(/401/);
  });

  it("parses display-name addresses", () => {
    expect(parseAddress("Website <forms@example.com>")).toEqual({ name: "Website", email: "forms@example.com" });
    expect(parseAddress('"Bakker, Jan" <jan@example.com>')).toEqual({ name: "Bakker, Jan", email: "jan@example.com" });
    expect(parseAddress("info@example.com")).toEqual({ email: "info@example.com" });
  });

  it("ses signs a raw SendEmail request", async () => {
    const { fn, calls } = captureFetch();
    await sesProvider({ region: "eu-west-1", accessKeyId: "AK", secretAccessKey: "SK", fetch: fn }).send(mail);
    const call = calls[0]!;
    expect(call.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/eu-west-1\/ses\/aws4_request/);
    expect(headers["host"]).toBeUndefined();
    const body = JSON.parse(call.init.body as string);
    expect(body.Destination.ToAddresses).toEqual(["info@example.com"]);
    const raw = new TextDecoder().decode(Uint8Array.from(atob(body.Content.Raw.Data), (ch) => ch.charCodeAt(0)));
    expect(raw).toContain("MIME-Version: 1.0");
  });
});
