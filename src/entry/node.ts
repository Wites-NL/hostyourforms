import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { buildProviders, httpProviders } from "../providers/index.js";
import { smtpProvider } from "../providers/smtp.js";

/**
 * Where to look for .env and forms.json, in order. The folder in the home
 * directory survives redeploys that replace the app folder (e.g. Enhance).
 */
function configDirs(): string[] {
  const dirs = [process.env.HYF_CONFIG_DIR, process.cwd(), join(homedir(), "hostyourforms-config")];
  return [...new Set(dirs.filter((d): d is string => Boolean(d)).map((d) => resolve(d)))];
}

function findFile(names: string[]): string | undefined {
  for (const dir of configDirs()) {
    for (const name of names) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

function loadEnvFile(): void {
  const path = process.env.HYF_ENV_FILE ?? findFile([".env", "hyf.env"]);
  if (!path) return;
  // Variables that are already set (e.g. by Docker or the panel) take precedence.
  process.loadEnvFile(path);
  console.log(`Loaded environment from ${path}`);
}

function readRawConfig(): unknown {
  if (process.env.HYF_CONFIG) return JSON.parse(process.env.HYF_CONFIG);
  const path = process.env.HYF_CONFIG_FILE ?? findFile(["forms.json"]);
  if (!path) {
    throw new ConfigError(`forms.json not found. Looked in: ${configDirs().join(", ")}`);
  }
  console.log(`Using config ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// Log right away, so an empty log means the process never got here.
console.log(`Starting HostYourForms (node ${process.version}, cwd ${process.cwd()})`);

try {
  loadEnvFile();
  const config = loadConfig(readRawConfig(), process.env);
  const providers = buildProviders(config, { ...httpProviders, smtp: (c) => smtpProvider(c) });
  const app = createApp(config, {
    providers,
    connectionIp: (c) => getConnInfo(c).remote.address,
  });

  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "0.0.0.0";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(
      `HostYourForms listening on http://${info.address}:${info.port} ` +
        `(forms: ${Object.keys(config.forms).join(", ")})`,
    );
  });
  server.on("error", (err) => {
    console.error(`Could not listen on ${hostname}:${port}: ${err.message}`);
    process.exitCode = 1;
  });
} catch (err) {
  console.error(err instanceof ConfigError || err instanceof SyntaxError ? `Config error: ${err.message}` : err);
  // No process.exit(): it can drop output that is still being written to a pipe.
  // Nothing keeps the event loop alive here, so the process ends by itself.
  process.exitCode = 1;
}
