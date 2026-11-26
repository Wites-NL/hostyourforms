import { z } from "zod";
import { newsletterSchema } from "./newsletter.js";

const emailList = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

const postmarkSchema = z.object({
  type: z.literal("postmark"),
  token: z.string().min(1),
  messageStream: z.string().optional(),
});

const sesSchema = z.object({
  type: z.literal("ses"),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
  configurationSet: z.string().optional(),
});

const emailitSchema = z.object({
  type: z.literal("emailit"),
  apiKey: z.string().min(1),
  baseUrl: z.url().optional(),
});

const simpleMailServiceSchema = z.object({
  type: z.literal("simplemailservice"),
  apiKey: z.string().min(1),
  accountId: z.string().min(1),
  baseUrl: z.url().optional(),
  tracking: z.boolean().default(false),
  retention: z
    .object({
      metadata: z.number().int().min(1).max(30).optional(),
      data: z.number().int().min(0).max(30).optional(),
    })
    .optional(),
});

const smtpSchema = z.object({
  type: z.literal("smtp"),
  host: z.string().min(1),
  port: z.number().int().positive().default(587),
  /** true for implicit TLS (port 465); false uses STARTTLS when offered. */
  secure: z.boolean().default(false),
  user: z.string().optional(),
  pass: z.string().optional(),
});

export const providerSchema = z.discriminatedUnion("type", [
  postmarkSchema,
  sesSchema,
  emailitSchema,
  simpleMailServiceSchema,
  smtpSchema,
]);

const MB = 1024 * 1024;

const attachmentsSchema = z.object({
  maxFiles: z.number().int().positive().default(3),
  maxFileSize: z.number().int().positive().default(5 * MB),
  maxTotalSize: z.number().int().positive().default(10 * MB),
  /** MIME types; a trailing "/*" matches a whole family, e.g. "image/*". */
  allowedTypes: z.array(z.string()).default(["image/*", "application/pdf"]),
});

const captchaSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("turnstile"), secret: z.string().min(1), siteKey: z.string().optional() }),
  z.object({ provider: z.literal("hcaptcha"), secret: z.string().min(1), siteKey: z.string().optional() }),
  z.object({
    provider: z.literal("recaptcha"),
    secret: z.string().min(1),
    siteKey: z.string().optional(),
    /** reCAPTCHA v3: minimum score (0.0 = bot, 1.0 = human). Default 0.5. */
    minScore: z.number().min(0).max(1).optional(),
    action: z.string().optional(),
  }),
  z.object({
    provider: z.literal("friendlycaptcha"),
    apiKey: z.string().min(1),
    siteKey: z.string().optional(),
    endpoint: z.url().optional(),
  }),
  z.object({
    provider: z.literal("altcha"),
    /** Secret for signing challenges. Long and random, e.g. 32+ characters. */
    hmacKey: z.string().min(16),
    maxNumber: z.number().int().min(1000).max(10_000_000).optional(),
    expiresSeconds: z.number().int().min(30).max(3600).optional(),
  }),
]);

const formObject = z.object({
  provider: z.string().min(1),
  from: z.string().min(1),
  /** Who gets the notification mail. Optional for newsletter forms. */
  to: emailList.optional(),
  cc: emailList.optional(),
  bcc: emailList.optional(),
  /** Supports {{field}} placeholders, e.g. "Nieuw bericht van {{name}}". */
  subject: z.string().default("Nieuw bericht via formulier {{_form}}"),
  /** Form field whose value becomes Reply-To (only when it is a valid address). */
  replyToField: z.string().default("email"),
  /** Origins allowed to post, e.g. "https://example.com". Empty allows every origin. */
  allowedOrigins: z.array(z.string()).default([]),
  redirect: z.url().optional(),
  errorRedirect: z.url().optional(),
  requiredFields: z.array(z.string()).default([]),
  honeypotField: z.string().default("_gotcha"),
  maxFieldLength: z.number().int().positive().default(10_000),
  captcha: captchaSchema.optional(),
  /** Older shorthand for { captcha: { provider: "turnstile", secret } }. */
  turnstile: z.object({ secret: z.string().min(1) }).optional(),
  rateLimit: z
    .object({
      max: z.number().int().positive(),
      windowSeconds: z.number().int().positive(),
    })
    .default({ max: 5, windowSeconds: 600 }),
  attachments: attachmentsSchema.optional(),
  /** Add the submitter to a newsletter list (Emailit, Laposta, Plunk, Brevo, Mailchimp, …). */
  newsletter: newsletterSchema.optional(),
  autoresponse: z
    .object({
      from: z.string().optional(),
      subject: z.string().min(1),
      text: z.string().min(1),
      html: z.string().optional(),
    })
    .optional(),
});

export const formSchema = formObject.transform((f) =>
  f.captcha || !f.turnstile ? f : { ...f, captcha: { provider: "turnstile" as const, secret: f.turnstile.secret } },
);

export const configSchema = z
  .object({
    /**
     * Header that carries the client IP when running behind a proxy/CDN,
     * e.g. "x-forwarded-for" (Enhance / nginx) or "cf-connecting-ip".
     * For comma-separated values the last entry (added by your proxy) is used.
     */
    clientIpHeader: z.string().optional(),
    maxBodySize: z.number().int().positive().default(15 * MB),
    providers: z.record(z.string(), providerSchema),
    forms: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/, "form ids may only use letters, digits, - and _"), formSchema),
  })
  .superRefine((cfg, ctx) => {
    for (const [id, form] of Object.entries(cfg.forms)) {
      if (!(form.provider in cfg.providers)) {
        ctx.addIssue({
          code: "custom",
          path: ["forms", id, "provider"],
          message: `unknown provider "${form.provider}"`,
        });
      }
      if (!form.to?.length && !form.newsletter) {
        ctx.addIssue({ code: "custom", path: ["forms", id, "to"], message: "set \"to\" (notification mail), \"newsletter\", or both" });
      }
      if (form.newsletter?.type === "laposta" && form.newsletter.nameField) {
        ctx.addIssue({
          code: "custom",
          path: ["forms", id, "newsletter", "nameField"],
          message: 'Laposta has no built-in name field; map it via "fields", e.g. { "name": "voornaam" }',
        });
      }
      // An autoresponse mails whatever address a visitor types in. Without a
      // captcha that turns the form into a way to spam strangers from your domain.
      if (form.autoresponse && !form.captcha) {
        ctx.addIssue({
          code: "custom",
          path: ["forms", id, "autoresponse"],
          message: "autoresponse requires a captcha (turnstile, hcaptcha, recaptcha, friendlycaptcha or altcha)",
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;
export type FormConfig = Config["forms"][string];
export type ProviderConfig = z.infer<typeof providerSchema>;

type Env = Record<string, string | undefined>;

/** Replace ${VAR} in every string value with the matching environment variable. */
export function interpolateEnv(value: unknown, env: Env, missing: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = env[name];
      if (v === undefined) {
        missing.add(name);
        return "";
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env, missing)]),
    );
  }
  return value;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(raw: unknown, env: Env): Config {
  const missing = new Set<string>();
  const interpolated = interpolateEnv(raw, env, missing);
  if (missing.size > 0) {
    throw new ConfigError(`missing environment variables: ${[...missing].join(", ")}`);
  }
  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
