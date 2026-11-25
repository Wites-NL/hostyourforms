import type { FormConfig } from "./config.js";
import { sanitizeHeader } from "./mail.js";
import { isInternalField, type Submission } from "./submission.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Replace {{name}} with field values. `{{_form}}` is the form id. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function renderSubject(form: FormConfig, formId: string, sub: Submission): string {
  return sanitizeHeader(interpolate(form.subject, { ...sub.fields, _form: formId }), 200) || `Formulier ${formId}`;
}

function visibleFields(form: FormConfig, sub: Submission): [string, string][] {
  return Object.entries(sub.fields).filter(([k]) => !isInternalField(k, form));
}

export function renderNotification(
  form: FormConfig,
  formId: string,
  sub: Submission,
  meta: { origin?: string; receivedAt: Date },
): { text: string; html: string } {
  const fields = visibleFields(form, sub);
  const files = sub.files.map((f) => f.name);
  const when = meta.receivedAt.toISOString();

  const text = [
    `Nieuw bericht via formulier "${formId}"`,
    "",
    ...fields.map(([k, v]) => `${k}:\n${v}\n`),
    ...(files.length ? [`Bijlagen: ${files.join(", ")}`, ""] : []),
    "--",
    `Ontvangen: ${when}`,
    ...(meta.origin ? [`Website: ${meta.origin}`] : []),
  ].join("\n");

  const rows = fields
    .map(
      ([k, v]) =>
        `<tr><th style="text-align:left;vertical-align:top;padding:8px 12px;background:#f5f5f5;border-bottom:1px solid #e5e5e5;white-space:nowrap">${escapeHtml(k)}</th>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`,
    )
    .join("");

  const html =
    `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;font-size:14px">` +
    `<p style="font-size:16px"><strong>Nieuw bericht via formulier “${escapeHtml(formId)}”</strong></p>` +
    `<table style="border-collapse:collapse;width:100%;max-width:640px">${rows}</table>` +
    (files.length ? `<p>Bijlagen: ${files.map(escapeHtml).join(", ")}</p>` : "") +
    `<p style="color:#777;font-size:12px">Ontvangen: ${escapeHtml(when)}` +
    (meta.origin ? ` · ${escapeHtml(meta.origin)}` : "") +
    `</p></body></html>`;

  return { text, html };
}
