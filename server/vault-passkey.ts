import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type express from "express";

// Passkey step-up for vault writes. Credentials live in vault-passkeys.json (0600); challenges are single-use,
// server-side and expire in 2 minutes; a successful assertion issues a 5 minute write grant (HttpOnly cookie).
// Registration accepts only the device's own platform authenticator with user verification (no roaming key, no QR flow).
const CHALLENGE_TTL = 2 * 60_000;
const GRANT_TTL = 5 * 60_000;
const ALERT_EVERY = 10 * 60_000;
const COOKIE = "vault_grant";

type Cred = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};
type Store = { userID: string; credentials: Cred[] };
type Challenge = {
  challenge: string;
  kind: "reg" | "auth";
  expires: number;
  first: boolean;
  session: string;
};
type Deps = {
  confDir: () => string;
  rpId: () => string | undefined;
  // Extra browser origins, for a proxy alias that rewrites the Origin header (e.g. Caddy console.<domain>).
  origins: () => string[];
  atomicWrite: (file: string, data: string) => void;
  audit: (action: string, source: string, key: string) => void;
  alert: (subject: string, lines: string[]) => Promise<void>;
};
export class PasskeyError extends Error {
  status: number;
  extra: object;
  constructor(status: number, msg: string, extra: object = {}) {
    super(msg);
    this.status = status;
    this.extra = extra;
  }
}

type Grant = { expires: number; session: string };
type Context = {
  deps: Deps;
  challenges: Map<string, Challenge>;
  grants: Map<string, Grant>;
  lastAlert: number;
};
type Handler = (req: express.Request, res: express.Response) => Promise<unknown> | unknown;

const storeFile = (ctx: Context) => path.join(ctx.deps.confDir(), "vault-passkeys.json");

function loadStore(ctx: Context): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(ctx), "utf8"));
    if (Array.isArray(parsed?.credentials) && typeof parsed.userID === "string") return parsed;
  } catch {}
  return { userID: crypto.randomBytes(32).toString("base64url"), credentials: [] };
}
const saveStore = (ctx: Context, store: Store) =>
  ctx.deps.atomicWrite(storeFile(ctx), JSON.stringify(store, null, 2) + "\n");
const publicList = (store: Store) =>
  store.credentials.map((cred) => ({
    id: cred.id,
    name: cred.name,
    createdAt: cred.createdAt,
    lastUsedAt: cred.lastUsedAt,
  }));

const cookies = (req: express.Request) =>
  Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split(/=(.*)/s).slice(0, 2))
      .filter((pair) => pair[0]),
  );
const sessionOf = (req: express.Request) =>
  crypto
    .createHash("sha256")
    .update(cookies(req).ac_session || "")
    .digest("hex");
const originsOf = (ctx: Context, req: express.Request) => [
  ...new Set([String(req.headers.origin || ""), ...ctx.deps.origins()].filter(Boolean)),
];
const rpIdOf = (ctx: Context, req: express.Request) =>
  ctx.deps.rpId() ||
  String(req.headers.host || "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");

function sweep(ctx: Context) {
  const now = Date.now();
  for (const [key, entry] of ctx.challenges) if (entry.expires <= now) ctx.challenges.delete(key);
  for (const [key, entry] of ctx.grants) if (entry.expires <= now) ctx.grants.delete(key);
}
function issue(
  ctx: Context,
  req: express.Request,
  kind: Challenge["kind"],
  challenge: string,
  first = false,
) {
  sweep(ctx);
  const cid = crypto.randomBytes(16).toString("base64url");
  ctx.challenges.set(cid, {
    challenge,
    kind,
    expires: Date.now() + CHALLENGE_TTL,
    first,
    session: sessionOf(req),
  });
  return cid;
}
/* single use: removed whether or not the response verifies */
function take(
  ctx: Context,
  req: express.Request,
  cid: unknown,
  kind: Challenge["kind"],
): Challenge {
  const found = typeof cid === "string" ? ctx.challenges.get(cid) : undefined;
  if (typeof cid === "string") ctx.challenges.delete(cid);
  if (
    !found ||
    found.kind !== kind ||
    found.expires <= Date.now() ||
    found.session !== sessionOf(req)
  )
    throw new PasskeyError(400, "That request expired. Try again.");
  return found;
}

/* ---------- grant ---------- */
function hasGrant(ctx: Context, req: express.Request, consume: boolean): boolean {
  const token = cookies(req)[COOKIE],
    grant = token ? ctx.grants.get(token) : undefined;
  if (!token || !grant || grant.expires <= Date.now() || grant.session !== sessionOf(req)) {
    if (token) ctx.grants.delete(token);
    return false;
  }
  if (consume) ctx.grants.delete(token);
  return true;
}
const cookieHeader = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/api/vault; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAge}`;
/* a fresh grant bound to the caller's session, delivered as the grant cookie */
function openGrant(ctx: Context, req: express.Request, res: express.Response) {
  const token = crypto.randomBytes(24).toString("base64url");
  ctx.grants.set(token, { expires: Date.now() + GRANT_TTL, session: sessionOf(req) });
  res.append("Set-Cookie", cookieHeader(token, GRANT_TTL / 1000));
}
/* Use as middleware on value-changing routes. Delete grants are single-use. */
function requireGrant(ctx: Context, consume: boolean): express.RequestHandler {
  return (req, res, next) => {
    if (hasGrant(ctx, req, consume)) {
      if (consume) res.append("Set-Cookie", cookieHeader("", 0));
      return next();
    }
    res.status(401).json({
      error: "Confirm with your passkey first.",
      stepUp: true,
      enrolled: loadStore(ctx).credentials.length > 0,
    });
  };
}

function fail(ctx: Context, req: express.Request, what: string) {
  ctx.deps.audit("passkey-failed", "-", what);
  const now = Date.now();
  if (now - ctx.lastAlert < ALERT_EVERY) return;
  ctx.lastAlert = now;
  const fwd = String(req.headers["x-forwarded-for"] || "")
    .replace(/[\r\n\0]+/g, " ")
    .slice(0, 120);
  void ctx.deps
    .alert("[Agent Console] vault passkey failed", [
      `Time: ${new Date(now).toISOString()}`,
      `Client IP: ${req.ip || req.socket.remoteAddress || ""}${fwd ? ` (forwarded ${fwd})` : ""}`,
      `User-agent: ${String(req.headers["user-agent"] || "")
        .replace(/[\r\n\0]+/g, " ")
        .slice(0, 200)}`,
      `Step: ${what}`,
    ])
    .catch((error) =>
      console.warn("vault alert failed:", String(error?.message || "").slice(0, 80)),
    );
}

function wrap(handler: Handler): express.RequestHandler {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(await handler(req, res));
    } catch (error: any) {
      if (error instanceof PasskeyError)
        return void res.status(error.status).json({ error: error.message, ...error.extra });
      res.status(500).json({ error: "Passkeys are unavailable." });
    }
  };
}

/* ---------- enrollment ---------- */
// The first passkey needs nothing beyond the console login; later ones need a live grant.
async function registerOptions(ctx: Context, req: express.Request) {
  const store = loadStore(ctx),
    first = store.credentials.length === 0;
  if (!first && !hasGrant(ctx, req, false))
    throw new PasskeyError(401, "Confirm with your passkey first.", { stepUp: true });
  const options = await generateRegistrationOptions({
    rpName: "Agent Console",
    rpID: rpIdOf(ctx, req),
    userName: "owner",
    userDisplayName: "Agent Console owner",
    userID: isoBase64URL.toBuffer(store.userID),
    attestationType: "none",
    excludeCredentials: store.credentials.map((cred) => ({
      id: cred.id,
      transports: cred.transports as any,
    })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
  });
  (options as any).hints = ["client-device"];
  return { cid: issue(ctx, req, "reg", options.challenge, first), options };
}

async function verifyRegistration(ctx: Context, req: express.Request, challenge: Challenge) {
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: originsOf(ctx, req),
      expectedRPID: rpIdOf(ctx, req),
      requireUserVerification: true,
    });
  } catch {
    fail(ctx, req, "registration");
    throw new PasskeyError(400, "The passkey could not be verified.");
  }
  if (!verification.verified) {
    fail(ctx, req, "registration");
    throw new PasskeyError(400, "The passkey could not be verified.");
  }
  return verification;
}

const passkeyName = (req: express.Request, store: Store) =>
  String(req.body?.name || "")
    .replace(/[\r\n\0]+/g, " ")
    .trim()
    .slice(0, 40) || `Passkey ${store.credentials.length + 1}`;

async function registerVerify(ctx: Context, req: express.Request, res: express.Response) {
  const challenge = take(ctx, req, req.body?.cid, "reg");
  const store = loadStore(ctx);
  if (challenge.first !== (store.credentials.length === 0))
    throw new PasskeyError(400, "That request expired. Try again.");
  const verification = await verifyRegistration(ctx, req, challenge);
  // this device's own authenticator only: a thief could otherwise enrol their phone through the cross-device QR flow,
  // which reports "cross-platform". Transports are not checked: synced platform passkeys often list "hybrid" too.
  if (
    req.body?.response?.authenticatorAttachment !== "platform" ||
    !verification.registrationInfo.userVerified
  ) {
    fail(ctx, req, "registration: not a local platform authenticator");
    throw new PasskeyError(
      400,
      "Use this device's own fingerprint or face unlock, not another device or a security key.",
    );
  }
  const registered = verification.registrationInfo.credential;
  const name = passkeyName(req, store);
  store.credentials.push({
    id: registered.id,
    publicKey: isoBase64URL.fromBuffer(registered.publicKey),
    counter: registered.counter,
    transports: registered.transports as string[] | undefined,
    name,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  saveStore(ctx, store);
  ctx.deps.audit("passkey-add", "-", name);
  // the passkey just proved presence and verification, so it also opens a write grant
  openGrant(ctx, req, res);
  return { ok: true, passkeys: publicList(store) };
}

function removePasskey(ctx: Context, req: express.Request) {
  const store = loadStore(ctx),
    count = store.credentials.length;
  const gone = store.credentials.find((cred) => cred.id === req.params.id);
  store.credentials = store.credentials.filter((cred) => cred.id !== req.params.id);
  if (store.credentials.length === count) throw new PasskeyError(404, "No such passkey.");
  saveStore(ctx, store);
  ctx.deps.audit("passkey-remove", "-", gone!.name);
  return { ok: true, passkeys: publicList(store) };
}

/* ---------- step-up: assertion with required user verification, then a grant cookie ---------- */
async function stepupOptions(ctx: Context, req: express.Request) {
  const store = loadStore(ctx);
  if (!store.credentials.length)
    throw new PasskeyError(409, "No passkey is set up yet.", { setup: true });
  const options = await generateAuthenticationOptions({
    rpID: rpIdOf(ctx, req),
    userVerification: "required",
    allowCredentials: store.credentials.map((cred) => ({
      id: cred.id,
      transports: cred.transports as any,
    })),
  });
  return { cid: issue(ctx, req, "auth", options.challenge), options };
}

async function verifyAssertion(
  ctx: Context,
  req: express.Request,
  challenge: Challenge,
  cred: Cred,
) {
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: originsOf(ctx, req),
      expectedRPID: rpIdOf(ctx, req),
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: isoBase64URL.toBuffer(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports as any,
      },
    });
  } catch {
    fail(ctx, req, "assertion");
    throw new PasskeyError(401, "The passkey could not be verified.");
  }
  if (!verification.verified) {
    fail(ctx, req, "assertion");
    throw new PasskeyError(401, "The passkey could not be verified.");
  }
  return verification;
}

async function stepupVerify(ctx: Context, req: express.Request, res: express.Response) {
  const challenge = take(ctx, req, req.body?.cid, "auth");
  const store = loadStore(ctx);
  const cred = store.credentials.find((item) => item.id === req.body?.response?.id);
  if (!cred) {
    fail(ctx, req, "assertion: unknown credential");
    throw new PasskeyError(401, "That passkey is not registered.");
  }
  const verification = await verifyAssertion(ctx, req, challenge, cred);
  cred.counter = verification.authenticationInfo.newCounter;
  cred.lastUsedAt = new Date().toISOString();
  saveStore(ctx, store);
  openGrant(ctx, req, res);
  ctx.deps.audit("stepup", "-", cred.name);
  return { ok: true, expiresIn: GRANT_TTL / 1000 };
}

function mountPasskeys(
  ctx: Context,
  app: express.Express,
  sameOrigin: express.RequestHandler,
  json: express.RequestHandler,
) {
  const PREFIX = "/api/vault";
  app.get(
    `${PREFIX}/passkeys`,
    wrap(() => {
      const store = loadStore(ctx);
      return { enrolled: store.credentials.length, passkeys: publicList(store), granted: false };
    }),
  );
  app.get(
    `${PREFIX}/grant`,
    wrap((req) => ({ granted: hasGrant(ctx, req, false) })),
  );
  app.post(
    `${PREFIX}/passkeys/register/options`,
    sameOrigin,
    json,
    wrap((req) => registerOptions(ctx, req)),
  );
  app.post(
    `${PREFIX}/passkeys/register/verify`,
    sameOrigin,
    json,
    wrap((req, res) => registerVerify(ctx, req, res)),
  );
  app.delete(
    `${PREFIX}/passkeys/:id`,
    sameOrigin,
    requireGrant(ctx, true),
    wrap((req) => removePasskey(ctx, req)),
  );
  app.post(
    `${PREFIX}/stepup/options`,
    sameOrigin,
    wrap((req) => stepupOptions(ctx, req)),
  );
  app.post(
    `${PREFIX}/stepup/verify`,
    sameOrigin,
    json,
    wrap((req, res) => stepupVerify(ctx, req, res)),
  );
}

export function createPasskeys(deps: Deps) {
  const ctx: Context = { deps, challenges: new Map(), grants: new Map(), lastAlert: 0 };
  return {
    mount: (
      app: express.Express,
      sameOrigin: express.RequestHandler,
      json: express.RequestHandler,
    ) => mountPasskeys(ctx, app, sameOrigin, json),
    requireGrant: (consume: boolean) => requireGrant(ctx, consume),
    granted: (req: express.Request) => hasGrant(ctx, req, false),
    expireGrants: () => {
      for (const grant of ctx.grants.values()) grant.expires = 0;
    },
    resetAlertLimit: () => {
      ctx.lastAlert = 0;
    },
  };
}
