/**
 * Bunny Edge Scripting entry (standalone script). Build with `npm run build:bunny`
 * and deploy dist/bunny.js. Configuration comes from the HYF_CONFIG variable
 * (the JSON config); put API keys in Bunny secrets and reference them as ${NAME}.
 */
import * as BunnySDK from "@bunny.net/edgescript-sdk";
import process from "node:process";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { buildProviders, httpProviders } from "../providers/index.js";

let handler: (req: Request) => Response | Promise<Response>;

try {
  const raw = process.env.HYF_CONFIG;
  if (!raw) throw new Error("HYF_CONFIG is not set");
  const config = loadConfig(JSON.parse(raw), process.env);
  // SMTP needs raw TCP sockets, which edge scripts do not offer: HTTP providers only.
  const app = createApp(config, { providers: buildProviders(config, httpProviders) });
  handler = (req) => app.fetch(req);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`HostYourForms config error: ${message}`);
  handler = () => new Response("HostYourForms is not configured correctly. See the script logs.", { status: 500 });
}

BunnySDK.net.http.serve((req) => handler(req));
