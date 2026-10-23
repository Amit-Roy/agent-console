import { fileEnv } from "../server/providers/env.ts";

const configured = process.env.AGENT_CONSOLE_URL || fileEnv().AGENT_CONSOLE_URL;
if (configured) {
  let url: URL;
  try {
    url = new URL(configured);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid public origin");
    }
  } catch {
    console.error(
      "AGENT_CONSOLE_URL must be an HTTPS origin without credentials, path, query, or fragment.",
    );
    process.exit(1);
  }
  console.log(url.href);
} else {
  console.log((process.env.VSCODE_PROXY_URI || "").replace("{{port}}", process.env.PORT || "7070"));
}
