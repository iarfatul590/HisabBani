import express from "express";
import { rateLimit } from "express-rate-limit";
import { healthCheck } from "./controllers/health-controller";
import { receiveWebhook, verifyWebhook } from "./controllers/webhook-controller";
import { RequestWithRawBody, verifyMetaSignature } from "./middleware/verify-meta-signature";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buffer) => { (req as RequestWithRawBody).rawBody = Buffer.from(buffer); }
}));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.get("/health", healthCheck);
app.get("/webhooks/whatsapp", verifyWebhook);
app.post("/webhooks/whatsapp", verifyMetaSignature, (req, res, next) => {
  void receiveWebhook(req, res).catch(next);
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error", error);
  res.status(500).json({ error: "Internal server error" });
});