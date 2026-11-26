import type { Config, ProviderConfig } from "../config.js";
import { ConfigError } from "../config.js";
import type { MailProvider } from "../mail.js";
import { emailitProvider } from "./emailit.js";
import { postmarkProvider } from "./postmark.js";
import { sesProvider } from "./ses.js";
import { simpleMailServiceProvider } from "./simplemailservice.js";

type Factory<T extends ProviderConfig["type"]> = (cfg: Extract<ProviderConfig, { type: T }>) => MailProvider;
export type ProviderFactories = { [T in ProviderConfig["type"]]?: Factory<T> };

/** HTTP-API providers that run on any runtime with fetch + WebCrypto. */
export const httpProviders: ProviderFactories = {
  postmark: (c) => postmarkProvider(c),
  emailit: (c) => emailitProvider(c),
  ses: (c) => sesProvider(c),
  simplemailservice: (c) => simpleMailServiceProvider(c),
};

/** Build one provider from its config, e.g. credentials loaded from a database. */
export function buildProvider(cfg: ProviderConfig, factories: ProviderFactories = httpProviders): MailProvider {
  const factory = factories[cfg.type] as Factory<typeof cfg.type> | undefined;
  if (!factory) throw new ConfigError(`provider type "${cfg.type}" is not supported on this runtime`);
  return factory(cfg as never);
}

export function buildProviders(config: Config, factories: ProviderFactories): Record<string, MailProvider> {
  const out: Record<string, MailProvider> = {};
  for (const [name, cfg] of Object.entries(config.providers)) {
    const factory = factories[cfg.type] as Factory<typeof cfg.type> | undefined;
    if (!factory) {
      throw new ConfigError(`provider "${name}": type "${cfg.type}" is not supported on this runtime`);
    }
    out[name] = factory(cfg as never);
  }
  return out;
}
