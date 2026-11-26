// Public API for using HostYourForms as a library (e.g. in a hosted service).
export { createApp, createFormsApp } from "./app.js";
export type { AppDeps, FormsAppOptions, ResolvedForm, SubmissionEvent } from "./app.js";
export { ConfigError, configSchema, formSchema, loadConfig, providerSchema } from "./config.js";
export type { Config, FormConfig, ProviderConfig } from "./config.js";
export { isValidEmail, ProviderError, sanitizeHeader } from "./mail.js";
export type { Attachment, Mail, MailProvider } from "./mail.js";
export { buildProvider, buildProviders, httpProviders } from "./providers/index.js";
export type { ProviderFactories } from "./providers/index.js";
export { renderNotification, renderSubject } from "./render.js";
export type { Submission } from "./submission.js";
