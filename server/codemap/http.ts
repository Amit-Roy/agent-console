// Codemap HTTP routes (issue #405). Mounted behind the auth gate; writes are same-origin only.
import express from "express";
import { assertSlug } from "./store.ts";
import type { MapsService } from "./types.ts";

const NOT_FOUND = /not found|unknown codemap node|unknown codemap flow|no flow/i;

function fail(res: express.Response, err: any): void {
  const message = String(err?.message || err);
  res.status(NOT_FOUND.test(message) ? 404 : 400).json({ error: message });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function mountMaps(
  app: express.Express,
  sameOrigin: express.RequestHandler,
  service: MapsService,
): void {
  const parse = express.json({ limit: "4kb" });
  const json: express.RequestHandler = (req, res, next) =>
    parse(req, res, (err?: unknown) =>
      err ? fail(res, { message: "invalid JSON body" }) : next(),
    );
  const route =
    (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        if (req.params.slug) assertSlug(req.params.slug);
        await fn(req, res);
      } catch (err) {
        fail(res, err);
      }
    };

  app.get(
    "/api/maps",
    route(async (_req, res) => void res.json({ maps: await service.list() })),
  );
  app.post(
    "/api/maps",
    sameOrigin,
    json,
    route(async (req, res) => {
      const source = text(req.body?.source);
      if (!source) throw new Error("source required");
      res.status(202).json(await service.add(source));
    }),
  );
  app.get(
    "/api/maps/:slug",
    route(async (req, res) => void res.json(await service.status(req.params.slug))),
  );
  app.get(
    "/api/maps/:slug/view",
    route(
      async (req, res) =>
        void res.json(
          await service.view(req.params.slug, {
            node: text(req.query.node),
            flow: text(req.query.flow),
          }),
        ),
    ),
  );
  app.get(
    "/api/maps/:slug/brief",
    route(async (req, res) => {
      const body = await service.brief(req.params.slug, { node: text(req.query.node) });
      res.type("text/plain").send(body);
    }),
  );
  app.post(
    "/api/maps/:slug/refresh",
    sameOrigin,
    json,
    route(async (req, res) => {
      const describe = req.body?.describe === true;
      res.status(202).json(await service.refresh(req.params.slug, { describe }));
    }),
  );
  app.delete(
    "/api/maps/:slug",
    sameOrigin,
    route(async (req, res) => {
      await service.remove(req.params.slug);
      res.status(204).end();
    }),
  );
}
