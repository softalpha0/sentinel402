import { readFile } from "node:fs/promises";
import { requireEnv } from "./config.js";
import { runAudit } from "./agent.js";
import { sandboxManager } from "./sandbox.js";

// Usage: npm run audit -- demo-contracts/VulnerableVault.sol
requireEnv();
const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run audit -- <path/to/Contract.sol>");
  process.exit(1);
}

await runAudit(await readFile(file, "utf8"), (e) => {
  switch (e.type) {
    case "status": return console.log(`\n▶ ${e.message}`);
    case "thinking": return console.log(`\n💭 ${e.text}`);
    case "text": return console.log(`\n🤖 ${e.text}`);
    case "file": return console.log(`\n📝 wrote ${e.path}`);
    case "run": return console.log(`\n⚙️  $ ${e.command} -> exit ${e.exitCode} (${e.ms} ms)\n${e.output.slice(-1500)}`);
    case "finding": return console.log(`\n🚨 PROVEN [${e.finding.severity}] ${e.finding.title}`);
    case "patched": return console.log(`\n✅ patched ${e.id}: ${e.notes}`);
    case "error": return console.error(`\n❌ ${e.message}`);
    case "done": {
      const r = e.report;
      console.log(`\n==== ${r.verdict}: ${r.findings.length} proven finding(s), ${r.sandboxRuns} sandbox runs ====`);
      for (const f of r.findings) console.log(`- [${f.severity}] ${f.title} ${f.patched ? "(patched)" : "(NOT patched)"}`);
    }
  }
});
await sandboxManager.destroy();
