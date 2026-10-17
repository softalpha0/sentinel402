import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { EFFORT, MODEL } from "./config.js";
import { AuditWorkspace, sandboxManager } from "./sandbox.js";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  description: string;
  exploitTest: string;
  patched: boolean;
  patchNotes?: string;
}

export interface AuditReport {
  summary: string;
  verdict: "SAFE TO DEPLOY" | "FIX BEFORE DEPLOY";
  findings: Finding[];
  originalSource: string;
  patchedSource: string;
  sandboxRuns: number;
  sandboxId?: string;
}

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "file"; path: string; content: string }
  | { type: "run"; command: string; exitCode: number; ms: number; output: string }
  | { type: "finding"; finding: Finding }
  | { type: "patched"; id: string; notes: string }
  | { type: "done"; report: AuditReport }
  | { type: "error"; message: string };

const SYSTEM_PROMPT = `You are Sentinel402, a defensive smart contract security agent. The developer owns the
contract and wants it tested before deployment. You prove vulnerabilities by writing and running
exploit tests in an isolated sandbox, never by speculation alone.

The sandbox contains a Foundry project:
- src/Target.sol: the contract under audit (you may edit it when patching)
- original/Target.sol: read-only copy of the original
- test/: your exploit tests. forge-std is available: import "forge-std/Test.sol";

Process:
1. Read the contract. List plausible vulnerabilities (reentrancy, access control, tx.origin auth,
   unchecked calls, accounting errors, price manipulation...).
2. For each, write test/Exploit_<Name>.t.sol whose test PASSES only if the attack succeeds
   (assert the attacker gained funds, took ownership, broke an invariant). Deploy the target in
   setUp(). Use vm.deal / vm.prank / vm.startPrank for actors. Import the target with
   import "../src/Target.sol";
3. Run it with run_forge. If it fails to compile or the attack fails, read the output, fix your
   test, retry. Give up on a hypothesis after 3 honest attempts.
4. Call report_finding ONLY for exploits whose test passed. The passing test is the proof.
5. Patch src/Target.sol with the smallest correct fix (checks-effects-interactions, msg.sender
   checks, inline reentrancy lock). No external libraries.
6. Re-run every exploit. A blocked exploit now FAILS. Call mark_patched for each blocked finding.
7. Finish with a short plain-English summary for the developer: what was wrong, how it was
   exploited, what changed. If nothing was exploitable, say so and list what you tried.

Never weaken a test to make it pass or fail. Keep tests minimal.`;

const SAFE_PATH = /^(src|test)\/[A-Za-z0-9_\-./]+\.sol$/;
const SAFE_MATCH = /^[A-Za-z0-9_\-./*]+$/;

function clip(text: string, max = 12_000) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n...[${text.length - max} chars truncated]...\n${text.slice(-half)}`;
}

export async function runAudit(source: string, emit: (e: AgentEvent) => void): Promise<AuditReport | undefined> {
  const client = new Anthropic();
  const findings: Finding[] = [];
  let runs = 0;
  let ws: AuditWorkspace | undefined;

  try {
    emit({ type: "status", message: `CreateOS sandbox: ${sandboxManager.status}` });
    ws = await AuditWorkspace.create(randomUUID(), (message) => emit({ type: "status", message }));
    const workspace = ws;
    await workspace.writeFile("src/Target.sol", source);
    await workspace.writeFile("original/Target.sol", source);
    emit({ type: "status", message: `Contract loaded into sandbox ${sandboxManager.id}. Agent is starting.` });

    const tools = [
      betaZodTool({
        name: "write_file",
        description: "Create or overwrite a Solidity file. Only src/*.sol or test/*.sol paths are allowed.",
        inputSchema: z.object({
          path: z.string().describe("e.g. test/Exploit_Reentrancy.t.sol or src/Target.sol"),
          content: z.string().describe("Full file contents"),
        }),
        run: async ({ path, content }) => {
          if (!SAFE_PATH.test(path) || path.includes("..")) return `Rejected path "${path}". Use src/*.sol or test/*.sol.`;
          await workspace.writeFile(path, content);
          emit({ type: "file", path, content });
          return `Wrote ${path} (${content.length} bytes).`;
        },
      }),
      betaZodTool({
        name: "read_file",
        description: "Read a project file, e.g. src/Target.sol or original/Target.sol.",
        inputSchema: z.object({ path: z.string() }),
        run: async ({ path }) => {
          if (path.includes("..") || path.startsWith("/")) return "Relative project paths only.";
          try {
            return clip(await workspace.readFile(path));
          } catch (err) {
            return `Could not read ${path}: ${(err as Error).message}`;
          }
        },
      }),
      betaZodTool({
        name: "run_forge",
        description: "Run Foundry in the sandbox: 'build' compiles, 'test' runs tests with -vvv traces. Use match_path for one file.",
        inputSchema: z.object({
          subcommand: z.enum(["build", "test"]),
          match_path: z.string().optional().describe("e.g. test/Exploit_Reentrancy.t.sol"),
          match_test: z.string().optional(),
        }),
        run: async ({ subcommand, match_path, match_test }) => {
          const args: string[] = [subcommand];
          if (subcommand === "test") args.push("-vvv");
          for (const [flag, value] of [["--match-path", match_path], ["--match-test", match_test]] as const) {
            if (!value) continue;
            if (!SAFE_MATCH.test(value)) return `Rejected unsafe ${flag} value: ${value}`;
            args.push(flag, value);
          }
          const command = `forge ${args.join(" ")}`;
          const res = await workspace.run(command);
          runs++;
          const output = `${res.stdout}\n${res.stderr}`.trim();
          emit({ type: "run", command, exitCode: res.exitCode, ms: res.ms, output: clip(output, 4000) });
          return `$ ${command}\nexit code: ${res.exitCode}\n\n${clip(output)}`;
        },
      }),
      betaZodTool({
        name: "report_finding",
        description: "Record a vulnerability whose exploit test PASSED in the sandbox. Never report unproven bugs.",
        inputSchema: z.object({
          id: z.string().describe("short slug, e.g. reentrancy-withdraw"),
          title: z.string(),
          severity: z.enum(["critical", "high", "medium", "low"]),
          description: z.string().describe("What is wrong and how the exploit works, 2-4 sentences"),
          exploit_test_path: z.string(),
        }),
        run: async (input) => {
          let exploitTest = "";
          try {
            exploitTest = await workspace.readFile(input.exploit_test_path);
          } catch {
            return `No file at ${input.exploit_test_path}. Write and run the exploit first.`;
          }
          const finding: Finding = {
            id: input.id, title: input.title, severity: input.severity,
            description: input.description, exploitTest, patched: false,
          };
          findings.push(finding);
          emit({ type: "finding", finding });
          return `Recorded ${input.id}.`;
        },
      }),
      betaZodTool({
        name: "mark_patched",
        description: "Mark a finding fixed ONLY after re-running its exploit against the patched contract and seeing it fail.",
        inputSchema: z.object({ id: z.string(), notes: z.string().describe("One sentence: what the fix changed") }),
        run: async ({ id, notes }) => {
          const f = findings.find((x) => x.id === id);
          if (!f) return `Unknown finding ${id}.`;
          f.patched = true;
          f.patchNotes = notes;
          emit({ type: "patched", id, notes });
          return `Marked ${id} patched.`;
        },
      }),
    ];

    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      max_iterations: 40,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: EFFORT },
      // Writing exploit code can trip the cyber safety classifier; this reruns a declined
      // request on the recommended fallback model instead of failing the audit.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      tools,
      messages: [{ role: "user", content: `Audit this contract (already at src/Target.sol):\n\n\`\`\`solidity\n${source}\n\`\`\`` }],
    });

    let summary = "";
    for await (const message of runner) {
      if (message.stop_reason === "refusal") {
        emit({ type: "error", message: "The model declined to continue this audit." });
        break;
      }
      for (const block of message.content) {
        if (block.type === "thinking" && block.thinking) emit({ type: "thinking", text: block.thinking });
        if (block.type === "text" && block.text.trim()) {
          emit({ type: "text", text: block.text });
          summary = block.text;
        }
      }
    }

    const report: AuditReport = {
      summary,
      verdict: findings.length > 0 ? "FIX BEFORE DEPLOY" : "SAFE TO DEPLOY",
      findings,
      originalSource: source,
      patchedSource: await workspace.readFile("src/Target.sol"),
      sandboxRuns: runs,
      sandboxId: sandboxManager.id,
    };
    emit({ type: "done", report });
    return report;
  } catch (err) {
    emit({ type: "error", message: (err as Error).message });
    return undefined;
  } finally {
    await ws?.cleanup();
  }
}
