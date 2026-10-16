// Keep observability local. These are also inherited by helper CLIs and MCP servers.
export const privacyEnv = {
  DO_NOT_TRACK: "1", HEADROOM_BEACON: "off", HEADROOM_TELEMETRY: "off",
  RTK_TELEMETRY_DISABLED: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CODEX_ANALYTICS_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1",
  NO_UPDATE_NOTIFIER: "1", NPM_CONFIG_UPDATE_NOTIFIER: "false",
};
Object.assign(process.env, privacyEnv);
