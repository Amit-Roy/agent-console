import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type express from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

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

export function createPasskeys(d: Deps) {
  const storeFile = () => path.join(d.confDir(), "vault-passkeys.json");
  const challenges = new Map<string, Challenge>();
  const grants = new Map<string, { expires: number; session: string }>();
  let lastAlert = 0;

  function load(): Store {
    try {
      const j = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
      if (Array.isArray(j?.credentials) && typeof j.userID === "string") return j;
    } catch {}
    return { userID: crypto.randomBytes(32).toString("base64url"), credentials: [] };
  }
  const save = (s: Store) => d.atomicWrite(storeFile(), JSON.stringify(s, null, 2) + "\n");
  const publicList = (s: Store) =>
    s.credentials.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }));

  const cookies = (req: express.Request) =>
    Object.fromEntries(
      String(req.headers.cookie || "")
        .split(";")
        .map((p) => p.trim().split(/=(.*)/s).slice(0, 2))
        .filter((p) => p[0]),
    );
  const session = (req: express.Request) =>
    crypto
      .createHash("sha256")
      .update(cookies(req).ac_session || "")
      .digest("hex");
  const origin = (req: express.Request) => [
    ...new Set([String(req.headers.origin || ""), ...d.origins()].filter(Boolean)),
  ];
  const rpID = (req: express.Request) =>
    d.rpId() ||
    String(req.headers.host || "")
      .replace(/:\d+$/, "")
      .replace(/^\[|\]$/g, "");

  function sweep() {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires <= now) challenges.delete(k);
    for (const [k, v] of grants) if (v.expires <= now) grants.delete(k);
  }
  function issue(req: express.Request, kind: Challenge["kind"], challenge: string, first = false) {
    sweep();
    const cid = crypto.randomBytes(16).toString("base64url");
    challenges.set(cid, {
      challenge,
      kind,
      expires: Date.now() + CHALLENGE_TTL,
      first,
      session: session(req),
    });
    return cid;
  }
  /* single use: removed whether or not the response verifies */
  function take(req: express.Request, cid: unknown, kind: Challenge["kind"]): Challenge {
    const c = typeof cid === "string" ? challenges.get(cid) : undefined;
    if (typeof cid === "string") challenges.delete(cid);
    if (!c || c.kind !== kind || c.expires <= Date.now() || c.session !== session(req))
      throw new PasskeyError(400, "That request expired. Try again.");
    return c;
  }

  /* ---------- grant ---------- */
  function hasGrant(req: express.Request, consume: boolean): boolean {
    const t = cookies(req)[COOKIE],
      g = t ? grants.get(t) : undefined;
    if (!t || !g || g.expires <= Date.now() || g.session !== session(req)) {
      if (t) grants.delete(t);
      return false;
    }
    if (consume) grants.delete(t);
    return true;
  }
  const cookieHeader = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/api/vault; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAge}`;
  /* Use as middleware on value-changing routes. Delete grants are single-use. */
  const requireGrant =
    (consume: boolean): express.RequestHandler =>
    (req, res, next) => {
      if (hasGrant(req, consume)) {
        if (consume) res.append("Set-Cookie", cookieHeader("", 0));
        return next();
      }
      res.status(401).json({
        error: "Confirm with your passkey first.",
        stepUp: true,
        enrolled: load().credentials.length > 0,
      });
    };

  function fail(req: express.Request, what: string) {
    d.audit("passkey-failed", "-", what);
    const now = Date.now();
    if (now - lastAlert < ALERT_EVERY) return;
    lastAlert = now;
    const fwd = String(req.headers["x-forwarded-for"] || "")
      .replace(/[\r\n\0]+/g, " ")
      .slice(0, 120);
    void d
      .alert("[Agent Console] vault passkey failed", [
        `Time: ${new Date(now).toISOString()}`,
        `Client IP: ${req.ip || req.socket.remoteAddress || ""}${fwd ? ` (forwarded ${fwd})` : ""}`,
        `User-agent: ${String(req.headers["user-agent"] || "")
          .replace(/[\r\n\0]+/g, " ")
          .slice(0, 200)}`,
        `Step: ${what}`,
      ])
      .catch((e) => console.warn("vault alert failed:", String(e?.message || "").slice(0, 80)));
  }

  const wrap =
    (
      fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown,
    ): express.RequestHandler =>
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        res.json(await fn(req, res));
      } catch (e: any) {
        if (e instanceof PasskeyError)
          return void res.status(e.status).json({ error: e.message, ...e.extra });
        res.status(500).json({ error: "Passkeys are unavailable." });
      }
    };

  function mount(
    app: express.Express,
    sameOrigin: express.RequestHandler,
    json: express.RequestHandler,
  ) {
    const P = "/api/vault";
    app.get(
      `${P}/passkeys`,
      wrap(() => {
        const s = load();
        return { enrolled: s.credentials.length, passkeys: publicList(s), granted: false };
      }),
    );
    app.get(
      `${P}/grant`,
      wrap((req) => ({ granted: hasGrant(req, false) })),
    );

    // Enrollment: the first passkey needs nothing beyond the console login; later ones need a live grant.
    app.post(
      `${P}/passkeys/register/options`,
      sameOrigin,
      json,
      wrap(async (req) => {
        const s = load(),
          first = s.credentials.length === 0;
        if (!first && !hasGrant(req, false))
          throw new PasskeyError(401, "Confirm with your passkey first.", { stepUp: true });
        const options = await generateRegistrationOptions({
          rpName: "Agent Console",
          rpID: rpID(req),
          userName: "owner",
          userDisplayName: "Agent Console owner",
          userID: isoBase64URL.toBuffer(s.userID),
          attestationType: "none",
          excludeCredentials: s.credentials.map((c) => ({
            id: c.id,
            transports: c.transports as any,
          })),
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "preferred",
            userVerification: "required",
          },
        });
        (options as any).hints = ["client-device"];
        return { cid: issue(req, "reg", options.challenge, first), options };
      }),
    );
    app.post(
      `${P}/passkeys/register/verify`,
      sameOrigin,
      json,
      wrap(async (req, res) => {
        const c = take(req, req.body?.cid, "reg");
        const s = load();
        if (c.first !== (s.credentials.length === 0))
          throw new PasskeyError(400, "That request expired. Try again.");
        let v;
        try {
          v = await verifyRegistrationResponse({
            response: req.body?.response,
            expectedChallenge: c.challenge,
            expectedOrigin: origin(req),
            expectedRPID: rpID(req),
            requireUserVerification: true,
          });
        } catch {
          fail(req, "registration");
          throw new PasskeyError(400, "The passkey could not be verified.");
        }
        if (!v.verified) {
          fail(req, "registration");
          throw new PasskeyError(400, "The passkey could not be verified.");
        }
        // this device's own authenticator only: a thief could otherwise enrol their phone through the cross-device QR flow,
        // which reports "cross-platform". Transports are not checked: synced platform passkeys often list "hybrid" too.
        if (
          req.body?.response?.authenticatorAttachment !== "platform" ||
          !v.registrationInfo.userVerified
        ) {
          fail(req, "registration: not a local platform authenticator");
          throw new PasskeyError(
            400,
            "Use this device's own fingerprint or face unlock, not another device or a security key.",
          );
        }
        const cr = v.registrationInfo.credential;
        const name =
          String(req.body?.name || "")
            .replace(/[\r\n\0]+/g, " ")
            .trim()
            .slice(0, 40) || `Passkey ${s.credentials.length + 1}`;
        s.credentials.push({
          id: cr.id,
          publicKey: isoBase64URL.fromBuffer(cr.publicKey),
          counter: cr.counter,
          transports: cr.transports as string[] | undefined,
          name,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        });
        save(s);
        d.audit("passkey-add", "-", name);
        // the passkey just proved presence and verification, so it also opens a write grant
        const t = crypto.randomBytes(24).toString("base64url");
        grants.set(t, { expires: Date.now() + GRANT_TTL, session: session(req) });
        res.append("Set-Cookie", cookieHeader(t, GRANT_TTL / 1000));
        return { ok: true, passkeys: publicList(s) };
      }),
    );
    app.delete(
      `${P}/passkeys/:id`,
      sameOrigin,
      requireGrant(true),
      wrap((req) => {
        const s = load(),
          n = s.credentials.length;
        const gone = s.credentials.find((c) => c.id === req.params.id);
        s.credentials = s.credentials.filter((c) => c.id !== req.params.id);
        if (s.credentials.length === n) throw new PasskeyError(404, "No such passkey.");
        save(s);
        d.audit("passkey-remove", "-", gone!.name);
        return { ok: true, passkeys: publicList(s) };
      }),
    );

    // Step-up: assertion with required user verification, then a grant cookie.
    app.post(
      `${P}/stepup/options`,
      sameOrigin,
      wrap(async (req) => {
        const s = load();
        if (!s.credentials.length)
          throw new PasskeyError(409, "No passkey is set up yet.", { setup: true });
        const options = await generateAuthenticationOptions({
          rpID: rpID(req),
          userVerification: "required",
          allowCredentials: s.credentials.map((c) => ({
            id: c.id,
            transports: c.transports as any,
          })),
        });
        return { cid: issue(req, "auth", options.challenge), options };
      }),
    );
    app.post(
      `${P}/stepup/verify`,
      sameOrigin,
      json,
      wrap(async (req, res) => {
        const c = take(req, req.body?.cid, "auth");
        const s = load();
        const cred = s.credentials.find((x) => x.id === req.body?.response?.id);
        if (!cred) {
          fail(req, "assertion: unknown credential");
          throw new PasskeyError(401, "That passkey is not registered.");
        }
        let v;
        try {
          v = await verifyAuthenticationResponse({
            response: req.body.response,
            expectedChallenge: c.challenge,
            expectedOrigin: origin(req),
            expectedRPID: rpID(req),
            requireUserVerification: true,
            credential: {
              id: cred.id,
              publicKey: isoBase64URL.toBuffer(cred.publicKey),
              counter: cred.counter,
              transports: cred.transports as any,
            },
          });
        } catch {
          fail(req, "assertion");
          throw new PasskeyError(401, "The passkey could not be verified.");
        }
        if (!v.verified) {
          fail(req, "assertion");
          throw new PasskeyError(401, "The passkey could not be verified.");
        }
        cred.counter = v.authenticationInfo.newCounter;
        cred.lastUsedAt = new Date().toISOString();
        save(s);
        const t = crypto.randomBytes(24).toString("base64url");
        grants.set(t, { expires: Date.now() + GRANT_TTL, session: session(req) });
        res.append("Set-Cookie", cookieHeader(t, GRANT_TTL / 1000));
        d.audit("stepup", "-", cred.name);
        return { ok: true, expiresIn: GRANT_TTL / 1000 };
      }),
    );
  }
  return {
    mount,
    requireGrant,
    granted: (req: express.Request) => hasGrant(req, false),
    expireGrants: () => {
      for (const g of grants.values()) g.expires = 0;
    },
    resetAlertLimit: () => {
      lastAlert = 0;
    },
  };
}
