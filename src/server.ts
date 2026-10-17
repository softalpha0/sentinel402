import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Stripe from "stripe";
import { PORT, PRICE_CENTS, PUBLIC_URL, STRIPE_KEY, requireEnv } from "./config.js";
import { runAudit, type AgentEvent } from "./agent.js";
import { sandboxManager } from "./sandbox.js";

requireEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

interface Audit {
  id: string;
  source: string;
  paid: boolean;
  started: boolean;
  events: AgentEvent[];
  bus: EventEmitter;
}
const audits = new Map<string, Audit>(); // in-memory: fine for a hackathon demo

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/config", (_req, res) => {
  res.json({ paymentsEnabled: Boolean(stripe), priceCents: PRICE_CENTS, sandbox: sandboxManager.status });
});

app.get("/api/demos", async (_req, res) => {
  const dir = path.join(ROOT, "demo-contracts");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sol"));
  res.json(await Promise.all(files.map(async (name) => ({ name, source: await readFile(path.join(dir, name), "utf8") }))));
});

/** Step 1: register the contract -> Stripe Checkout URL (or an audit id when payments are off). */
app.post("/api/audits", async (req, res) => {
  const source = String(req.body?.source ?? "");
  if (!source.includes("contract ") || source.length > 50_000) {
    res.status(400).json({ error: "Paste a Solidity contract (max 50,000 chars)." });
    return;
  }
  const audit: Audit = { id: randomUUID(), source, paid: !stripe, started: false, events: [], bus: new EventEmitter() };
  audits.set(audit.id, audit);
  if (!stripe) {
    res.json({ auditId: audit.id });
    return;
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          product_data: {
            name: "Sentinel402 exploit-proven audit",
            description: "An AI agent writes and runs real exploits against your contract in a CreateOS sandbox, then patches it.",
          },
        },
      }],
      client_reference_id: audit.id,
      success_url: `${PUBLIC_URL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/?canceled=1`,
    });
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    res.status(500).json({ error: `Stripe error: ${(err as Error).message}` });
  }
});

/** Step 2: back from Stripe -> verify payment server-side. */
app.get("/api/checkout/confirm", async (req, res) => {
  if (!stripe) {
    res.status(400).json({ error: "Payments are disabled." });
    return;
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(String(req.query.session_id ?? ""));
    const audit = audits.get(session.client_reference_id ?? "");
    if (!audit) {
      res.status(404).json({ error: "Audit not found (server restarted?). Please submit again." });
      return;
    }
    if (session.payment_status !== "paid") {
      res.status(402).json({ error: "Payment not completed." });
      return;
    }
    audit.paid = true;
    res.json({ auditId: audit.id });
  } catch (err) {
    res.status(500).json({ error: `Stripe error: ${(err as Error).message}` });
  }
});

/** Step 3: stream the agent's work (Server-Sent Events). Reconnects replay past events. */
app.get("/api/audits/:id/stream", (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return void res.status(404).end();
  if (!audit.paid) return void res.status(402).json({ error: "Payment required." });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  audit.events.forEach(send);
  audit.bus.on("event", send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    audit.bus.off("event", send);
  });

  if (!audit.started) {
    audit.started = true;
    runAudit(audit.source, (e) => {
      audit.events.push(e);
      audit.bus.emit("event", e);
    });
  }
});

app.listen(PORT, () => {
  console.log(`Sentinel402 on ${PUBLIC_URL}`);
  console.log(`Payments: ${stripe ? "Stripe Checkout (test mode)" : "disabled (no STRIPE_SECRET_KEY)"}`);
  // Boot the sandbox and install Foundry now, so the first audit doesn't wait for it.
  sandboxManager.warm().catch((err) => console.error("Sandbox warm-up failed:", err.message));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log("\nDestroying sandbox...");
    await sandboxManager.destroy();
    process.exit(0);
  });
}
