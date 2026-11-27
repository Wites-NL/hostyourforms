import { allCaptchaFields } from "./captcha.js";
import type { FormConfig } from "./config.js";
import type { Attachment } from "./mail.js";

export interface Submission {
  fields: Record<string, string>;
  files: File[];
}

export class SubmissionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
    /** Extra reason for logs and the dashboard; never sent to the visitor. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

function addField(fields: Record<string, string>, key: string, value: string) {
  fields[key] = key in fields ? `${fields[key]}, ${value}` : value;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export async function parseSubmission(req: Request): Promise<Submission> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const fields: Record<string, string> = {};
  const files: File[] = [];

  if (type.includes("application/json")) {
    let data: unknown;
    try {
      data = await req.json();
    } catch {
      throw new SubmissionError("invalid_body", 400, "Request body is not valid JSON");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new SubmissionError("invalid_body", 400, "JSON body must be an object");
    }
    for (const [k, v] of Object.entries(data)) fields[k] = stringify(v);
    return { fields, files };
  }

  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new SubmissionError("invalid_body", 400, "Could not read form data");
    }
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") addField(fields, key, value);
      else if (value.size > 0) files.push(value);
    }
    return { fields, files };
  }

  throw new SubmissionError(
    "unsupported_content_type",
    415,
    "Send the form as multipart/form-data, application/x-www-form-urlencoded or application/json",
  );
}

/** Fields the form uses internally and that should not end up in the email. */
export function isInternalField(name: string, form: FormConfig): boolean {
  return (
    name.startsWith("_") ||
    name === form.honeypotField ||
    allCaptchaFields.has(name) ||
    name === "frc-captcha-solution"
  );
}

export function validateFields(sub: Submission, form: FormConfig): void {
  const missing = form.requiredFields.filter((f) => !sub.fields[f]?.trim());
  if (missing.length > 0) {
    throw new SubmissionError("missing_fields", 422, `Missing required fields: ${missing.join(", ")}`, { missing });
  }
  const tooLong = Object.entries(sub.fields)
    .filter(([, v]) => v.length > form.maxFieldLength)
    .map(([k]) => k);
  if (tooLong.length > 0) {
    throw new SubmissionError("field_too_long", 422, `Fields too long: ${tooLong.join(", ")}`, { fields: tooLong });
  }
}

function typeAllowed(type: string, allowed: string[]): boolean {
  const t = type.toLowerCase();
  return allowed.some((a) => {
    const p = a.toLowerCase();
    return p.endsWith("/*") ? t.startsWith(p.slice(0, -1)) : t === p;
  });
}

export async function collectAttachments(files: File[], form: FormConfig): Promise<Attachment[]> {
  if (files.length === 0) return [];
  const rules = form.attachments;
  if (!rules) throw new SubmissionError("attachments_not_allowed", 422, "This form does not accept files");
  if (files.length > rules.maxFiles) {
    throw new SubmissionError("too_many_files", 422, `At most ${rules.maxFiles} files are allowed`);
  }
  let total = 0;
  const out: Attachment[] = [];
  for (const file of files) {
    const contentType = file.type || "application/octet-stream";
    if (!typeAllowed(contentType, rules.allowedTypes)) {
      throw new SubmissionError("file_type_not_allowed", 422, `File type not allowed: ${contentType}`);
    }
    if (file.size > rules.maxFileSize) {
      throw new SubmissionError("file_too_large", 413, `File too large: ${file.name}`);
    }
    total += file.size;
    if (total > rules.maxTotalSize) {
      throw new SubmissionError("files_too_large", 413, "Files are too large together");
    }
    out.push({
      filename: file.name.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "bijlage",
      contentType,
      content: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return out;
}
