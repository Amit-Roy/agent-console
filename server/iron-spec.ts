// Spec for a new iron-proxy provider. Same rules as the VPS forced command (iron-vault-api): the VPS is
// the authority, this check keeps an invalid spec from ever reaching ssh.
export type IronRule = { host: string; paths: string[] };
export type IronSpec = {
  name: string;
  envVars: string[];
  rules: IronRule[];
  header: string;
  prefix: string;
  require?: boolean;
  allowAllPaths?: boolean;
};
export type IronPreset = { label: string; spec: IronSpec };

export class SpecError extends Error {}

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_CHARS = /^[A-Za-z0-9/_.*-]+$/;
const PREFIX = /^[a-z0-9_-]{0,16}$/;
export const HEADERS = ["Authorization", "X-Api-Key", "Api-Key", "X-Auth-Token"];
const MAX = { aliases: 4, rules: 3, paths: 16 };
const DENY_SUFFIX = ["internal", "ts.net", "nefro.dev", "duckdns.org"];

const preset = (
  label: string,
  name: string,
  envVars: string[],
  host: string,
  path: string,
  header: string,
  prefix: string,
): IronPreset => ({
  label,
  spec: { name, envVars, rules: [{ host, paths: [path] }], header, prefix },
});

export const presets = (): IronPreset[] => [
  preset(
    "Cloudflare",
    "CLOUDFLARE_API_TOKEN",
    ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_NEFRO_DEV"],
    "api.cloudflare.com",
    "/client/v4/*",
    "Authorization",
    "cf-px-",
  ),
  preset(
    "OpenAI",
    "OPENAI_API_KEY",
    ["OPENAI_API_KEY"],
    "api.openai.com",
    "/v1/*",
    "Authorization",
    "sk-px-",
  ),
  preset(
    "Anthropic",
    "ANTHROPIC_API_KEY",
    ["ANTHROPIC_API_KEY"],
    "api.anthropic.com",
    "/v1/*",
    "X-Api-Key",
    "sk-ant-px-",
  ),
  {
    label: "Custom",
    spec: {
      name: "",
      envVars: [],
      rules: [],
      header: "Authorization",
      prefix: "",
    },
  },
];

function checkHost(host: unknown): string {
  if (typeof host !== "string" || host.length > 253) throw new SpecError("Invalid host.");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)))
    throw new SpecError("Hosts are lowercase fully qualified names.");
  if (/^[0-9]+$/.test(labels[labels.length - 1]))
    throw new SpecError("IP addresses are not allowed.");
  const denied =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    DENY_SUFFIX.some((s) => host === s || host.endsWith(`.${s}`));
  if (denied) throw new SpecError(`Host ${host} is not allowed.`);
  return host;
}

function checkPaths(paths: unknown, allowAll: boolean): string[] {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX.paths)
    throw new SpecError("Each rule needs 1 to 16 paths.");
  for (const p of paths) {
    if (typeof p !== "string" || !p.startsWith("/") || !PATH_CHARS.test(p) || p.includes(".."))
      throw new SpecError("Invalid path.");
    if (p === "/*" && !allowAll) throw new SpecError("Path /* needs allowAllPaths.");
  }
  return paths;
}

function checkRules(rules: unknown, allowAll: boolean): IronRule[] {
  if (!Array.isArray(rules) || !rules.length || rules.length > MAX.rules)
    throw new SpecError("Use 1 to 3 host rules.");
  return rules.map((r) => ({
    host: checkHost(r?.host),
    paths: checkPaths(r?.paths, allowAll),
  }));
}

function checkNames(raw: any): { name: string; envVars: string[] } {
  const envVars: unknown = raw.envVars;
  if (typeof raw.name !== "string" || !ENV_NAME.test(raw.name))
    throw new SpecError("Invalid name.");
  if (!Array.isArray(envVars) || !envVars.length || envVars.length > MAX.aliases)
    throw new SpecError("Use 1 to 4 env var names.");
  if (!envVars.every((v) => typeof v === "string" && ENV_NAME.test(v)))
    throw new SpecError("Invalid env var name.");
  return { name: raw.name, envVars: [...new Set(envVars as string[])] };
}

/* managed: env var names iron already manages; a clash would take over an existing key */
export function validateSpec(raw: any, managed: Iterable<string>): IronSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SpecError("Invalid spec.");
  const { name, envVars } = checkNames(raw);
  const taken = new Set(managed);
  const all = new Set([name, ...envVars]);
  for (const n of all) if (taken.has(n)) throw new SpecError(`${n} is already managed.`);
  if (raw.allowAllPaths !== undefined && typeof raw.allowAllPaths !== "boolean")
    throw new SpecError("Invalid allowAllPaths.");
  if (raw.require !== undefined && typeof raw.require !== "boolean")
    throw new SpecError("Invalid require.");
  if (!HEADERS.includes(raw.header)) throw new SpecError("Invalid header.");
  if (typeof raw.prefix !== "string" || !PREFIX.test(raw.prefix))
    throw new SpecError("Invalid prefix.");
  const spec: IronSpec = {
    name,
    envVars,
    rules: checkRules(raw.rules, raw.allowAllPaths === true),
    header: raw.header,
    prefix: raw.prefix,
  };
  if (raw.require !== undefined) spec.require = raw.require;
  if (raw.allowAllPaths !== undefined) spec.allowAllPaths = raw.allowAllPaths;
  return spec;
}

export const specHosts = (spec: IronSpec): string[] => [...new Set(spec.rules.map((r) => r.host))];
