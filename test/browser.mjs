import { chromium } from "playwright";

// Connected browsers disconnect on close; the runner owns the shared process.
// Each suite still creates and closes its own isolated browser contexts.
export function launchBrowser() {
  const endpoint = process.env.TEST_BROWSER_WS_ENDPOINT;
  return endpoint ? chromium.connect(endpoint) : chromium.launch();
}
