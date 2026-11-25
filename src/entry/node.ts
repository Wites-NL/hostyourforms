import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { buildProviders, httpProviders } from "../providers/index.js";
import { smtpProvider } from "../providers/smtp.js";

function readRawConfig(): unknown {
  const inline = process.env.HYF_CONFIG;
  const text = inline ?? readFileSync(process.env.HYF_CONFIG_FILE ?? "forms.json", "utf8");
  return JSON.parse(text);
}

try {
  const config = loadConfig(readRawConfig(), process.env);
  const providers = buildProviders(config, { ...httpProviders, smtp: (c) => smtpProvider(c) });
  const app = createApp(config, {
    providers,
    connectionIp: (c) => getConnInfo(c).remote.address,
  });

  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "0.0.0.0";
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(
      `HostYourForms listening on http://${info.address}:${info.port} ` +
        `(forms: ${Object.keys(config.forms).join(", ")})`,
    );
  });
} catch (err) {
  console.error(err instanceof ConfigError || err instanceof SyntaxError ? `Config error: ${err.message}` : err);
  process.exit(1);
}
