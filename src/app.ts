import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config, FormConfig } from "./config.js";
import { isValidEmail, type Mail, type MailProvider, sanitizeHeader } from "./mail.js";
import { escapeHtml, interpolate, renderNotification, renderSubject } from "./render.js";
import { originAllowed, RateLimiter, requestOrigin, verifyTurnstile } from "./spam.js";
import { collectAttachments, parseSubmission, SubmissionError, validateFields } from "./submission.js";

type LogFn = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;

export interface AppDeps {
  providers: Record<string, MailProvider>;
  /** Client IP from the socket, used when no clientIpHeader is configured. */
  connectionIp?: (c: Context) => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  log?: LogFn;
  onResult?: (event: SubmissionEvent) => void | Promise<void>;
}

/** A form ready to receive submissions: its settings plus the provider that sends for it. */
export interface ResolvedForm {
  form: FormConfig;
  provider: MailProvider;
}

/** Outcome of one submission, e.g. for a submission log. Contains no field values. */
export interface SubmissionEvent {
  formId: string;
  status: "delivered" | "spam" | "rejected" | "failed";
  /** Error code for rejected/failed submissions, e.g. "rate_limited" or "send_failed". */
  code?: string;
  /** Provider error detail for failed submissions. */
  error?: string;
  attachments?: number;
}

export interface FormsAppOptions {
  /** Look up a form by its public id. Return undefined for unknown forms. */
  resolve: (formId: string) => ResolvedForm | undefined | Promise<ResolvedForm | undefined>;
  clientIpHeader?: string;
  maxBodySize: number;
  connectionIp?: (c: Context) => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  log?: LogFn;
  /** Called after every submission. Errors thrown here are logged, never shown to the visitor. */
  onResult?: (event: SubmissionEvent) => void | Promise<void>;
}

const defaultLog: NonNullable<AppDeps["log"]> = (level, msg, data) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

function wantsJson(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  const type = req.headers.get("content-type") ?? "";
  return accept.includes("application/json") || type.includes("application/json");
}

function page(title: string, message: string, backUrl?: string): string {
  const back = backUrl ? `<p><a href="${escapeHtml(backUrl)}">← Terug naar de website</a></p>` : "";
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1a1a1a;background:#fff;line-height:1.5}a{color:#2456d6}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}a{color:#8fb0ff}}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${back}</body></html>`;
}

/** Self-hosted app: forms and providers come from a config file. */
export function createApp(config: Config, deps: AppDeps) {
  return createFormsApp({
    resolve: (formId) => {
      const form = Object.hasOwn(config.forms, formId) ? config.forms[formId] : undefined;
      if (!form) return undefined;
      const provider = deps.providers[form.provider];
      if (!provider) throw new Error(`provider ${form.provider} not initialised`);
      return { form, provider };
    },
    clientIpHeader: config.clientIpHeader,
    maxBodySize: config.maxBodySize,
    connectionIp: deps.connectionIp,
    fetch: deps.fetch,
    now: deps.now,
    log: deps.log,
    onResult: deps.onResult,
  });
}

/** Form endpoint where forms are looked up per request, e.g. from a database. */
export function createFormsApp(opts: FormsAppOptions) {
  const app = new Hono();
  const limiter = new RateLimiter(opts.now);
  const log = opts.log ?? defaultLog;
  const doFetch = opts.fetch ?? fetch;

  const report = async (event: SubmissionEvent) => {
    if (!opts.onResult) return;
    try {
      await opts.onResult(event);
    } catch (err) {
      log("warn", "onResult hook failed", { form: event.formId, error: String(err) });
    }
  };

  const clientIp = (c: Context): string | undefined => {
    if (opts.clientIpHeader) {
      const raw = c.req.header(opts.clientIpHeader);
      const last = raw?.split(",").at(-1)?.trim();
      if (last) return last;
    }
    return opts.connectionIp?.(c);
  };

  const corsHeaders = (c: Context, form: FormConfig) => {
    const origin = c.req.header("origin");
    if (origin && originAllowed(origin, form.allowedOrigins)) {
      c.header("Access-Control-Allow-Origin", form.allowedOrigins.length ? origin : "*");
      c.header("Vary", "Origin");
    }
  };

  /** Only follow a `_redirect` field when it points at a site that may use the form. */
  const redirectTarget = (form: FormConfig, requested: string | undefined, origin: string | undefined) => {
    if (requested) {
      try {
        const target = new URL(requested);
        const ok = form.allowedOrigins.length
          ? originAllowed(target.origin, form.allowedOrigins)
          : target.origin === origin;
        if (ok && (target.protocol === "https:" || target.protocol === "http:")) return target.toString();
      } catch {
        /* ignore invalid URL */
      }
    }
    return form.redirect;
  };

  const fail = (c: Context, form: FormConfig | undefined, err: SubmissionError) => {
    if (wantsJson(c.req.raw)) {
      return c.json({ ok: false, error: err.code, message: err.message, details: err.details }, err.status as 400);
    }
    if (form?.errorRedirect) {
      const url = new URL(form.errorRedirect);
      url.searchParams.set("error", err.code);
      return c.redirect(url.toString(), 303);
    }
    return c.html(page("Er ging iets mis", err.message, c.req.header("referer")), err.status as 400);
  };

  app.get("/health", (c) => c.json({ ok: true }));

  app.options("/f/:formId", async (c) => {
    const resolved = await opts.resolve(c.req.param("formId"));
    if (!resolved) return c.body(null, 404);
    corsHeaders(c, resolved.form);
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Accept");
    c.header("Access-Control-Max-Age", "86400");
    return c.body(null, 204);
  });

  app.get("/f/:formId", (c) =>
    c.text("Dit endpoint accepteert alleen POST-verzoeken vanuit een formulier.", 405, { Allow: "POST" }),
  );

  app.post(
    "/f/:formId",
    bodyLimit({
      maxSize: opts.maxBodySize,
      onError: async (c) => {
        const resolved = await opts.resolve(c.req.param("formId") ?? "");
        if (resolved) await report({ formId: c.req.param("formId") ?? "", status: "rejected", code: "body_too_large" });
        return fail(c, resolved?.form, new SubmissionError("body_too_large", 413, "Inzending is te groot"));
      },
    }),
    async (c) => {
      const formId = c.req.param("formId");
      const resolved = await opts.resolve(formId);
      if (!resolved) return fail(c, undefined, new SubmissionError("unknown_form", 404, "Onbekend formulier"));
      const { form, provider } = resolved;
      corsHeaders(c, form);

      const origin = requestOrigin(c.req.raw.headers);
      const ip = clientIp(c);

      try {
        if (!originAllowed(origin, form.allowedOrigins)) {
          throw new SubmissionError("origin_not_allowed", 403, "Dit formulier mag niet vanaf deze website worden verstuurd");
        }

        const retryAfter = limiter.hit(`${formId}:${ip ?? "unknown"}`, form.rateLimit.max, form.rateLimit.windowSeconds);
        if (retryAfter > 0) {
          c.header("Retry-After", String(retryAfter));
          throw new SubmissionError("rate_limited", 429, "Te veel inzendingen, probeer het later opnieuw");
        }

        const sub = await parseSubmission(c.req.raw);
        const redirect = redirectTarget(form, sub.fields["_redirect"], origin);
        const succeed = () => {
          if (wantsJson(c.req.raw)) return c.json({ ok: true });
          if (redirect) return c.redirect(redirect, 303);
          return c.html(page("Bedankt!", "Je bericht is verstuurd.", c.req.header("referer")));
        };

        if (sub.fields[form.honeypotField]?.trim()) {
          // Look successful so bots learn nothing.
          log("info", "honeypot triggered, submission dropped", { form: formId, ip });
          await report({ formId, status: "spam", code: "honeypot" });
          return succeed();
        }

        if (form.turnstile) {
          const ok = await verifyTurnstile(form.turnstile.secret, sub.fields["cf-turnstile-response"], ip, doFetch);
          if (!ok) throw new SubmissionError("captcha_failed", 400, "Captcha-controle mislukt, probeer het opnieuw");
        }

        validateFields(sub, form);
        const attachments = await collectAttachments(sub.files, form);

        const submitter = sub.fields[form.replyToField]?.trim();
        const replyTo = submitter && isValidEmail(submitter) ? submitter : undefined;

        const body = renderNotification(form, formId, sub, { origin, receivedAt: new Date(opts.now?.() ?? Date.now()) });
        const mail: Mail = {
          from: form.from,
          to: form.to,
          cc: form.cc,
          bcc: form.bcc,
          replyTo,
          subject: renderSubject(form, formId, sub),
          text: body.text,
          html: body.html,
          attachments,
        };

        try {
          await provider.send(mail);
        } catch (err) {
          log("error", "sending notification failed", { form: formId, provider: provider.type, error: String(err) });
          await report({ formId, status: "failed", code: "send_failed", error: String(err).slice(0, 500) });
          throw new SubmissionError("send_failed", 502, "Het bericht kon niet worden verstuurd, probeer het later opnieuw");
        }
        log("info", "submission delivered", { form: formId, provider: provider.type, attachments: attachments.length });
        await report({ formId, status: "delivered", attachments: attachments.length });

        if (form.autoresponse && replyTo) {
          const vars = { ...sub.fields, _form: formId };
          const ar = form.autoresponse;
          // Awaited on purpose: edge runtimes may stop work once the response is sent.
          await provider
            .send({
              from: ar.from ?? form.from,
              to: [replyTo],
              subject: sanitizeHeader(interpolate(ar.subject, vars), 200),
              text: interpolate(ar.text, vars),
              html: ar.html ? interpolate(ar.html, escapeVars(vars)) : undefined,
            })
            .catch((err) => log("warn", "autoresponse failed", { form: formId, error: String(err) }));
        }

        return succeed();
      } catch (err) {
        if (err instanceof SubmissionError) {
          if (err.status < 500) {
            log("info", "submission rejected", { form: formId, code: err.code, ip });
            await report({ formId, status: "rejected", code: err.code });
          }
          return fail(c, form, err);
        }
        log("error", "unexpected error", { form: formId, error: String(err) });
        await report({ formId, status: "failed", code: "internal_error", error: String(err).slice(0, 500) });
        return fail(c, form, new SubmissionError("internal_error", 500, "Er ging iets mis aan onze kant"));
      }
    },
  );

  app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));

  return app;
}

function escapeVars(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeHtml(v)]));
}
