import { CreateosSandboxClient, type Sandbox } from "@nodeops-createos/sandbox";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ms: number;
}

const SHARED = "/workspace/shared";
const PATH_PREFIX = 'export PATH="$HOME/.foundry/bin:$PATH"';

const FOUNDRY_TOML = `[profile.default]
src = "src"
test = "test"
libs = ["lib"]
remappings = ["forge-std/=lib/forge-std/src/"]
`;

/** Installs Foundry + forge-std once, and pre-downloads solc so the first audit is fast. Idempotent. */
const BOOTSTRAP = `
set -e
${PATH_PREFIX}
SUDO=""; [ "$(id -u)" != "0" ] && command -v sudo >/dev/null && SUDO="sudo"
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  ($SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl git ca-certificates) >/dev/null 2>&1 || true
fi
if ! command -v forge >/dev/null 2>&1; then
  curl -sSfL https://foundry.paradigm.xyz | bash >/dev/null 2>&1
  "$HOME/.foundry/bin/foundryup" >/dev/null 2>&1
fi
mkdir -p ${SHARED}/src ${SHARED}/lib
cd ${SHARED}
[ -d lib/forge-std/src ] || git clone --depth 1 -q https://github.com/foundry-rs/forge-std lib/forge-std
cat > foundry.toml <<'EOF'
${FOUNDRY_TOML}EOF
printf '// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.20;\\ncontract Warm {}\\n' > src/Warm.sol
forge build >/dev/null 2>&1 || true
forge --version | head -1
`;

/**
 * One CreateOS sandbox kept warm for the whole server session.
 * Each audit gets its own fresh project folder inside it; agent code never touches this machine.
 */
class SandboxManager {
  private ready?: Promise<Sandbox>;
  private readonly client = new CreateosSandboxClient();
  status = "cold";
  id?: string;

  /** Starts booting in the background (call at server start) and returns the same promise to everyone. */
  warm(log: (msg: string) => void = console.log): Promise<Sandbox> {
    if (!this.ready) {
      this.ready = this.boot(log).catch((err) => {
        this.ready = undefined; // allow a retry on the next audit
        this.status = `failed: ${err.message}`;
        throw err;
      });
    }
    return this.ready;
  }

  private async boot(log: (msg: string) => void) {
    this.status = "booting";
    log("Booting CreateOS sandbox...");
    const sandbox = await this.client.createSandbox({
      shape: process.env.SANDBOX_SHAPE ?? "s-1vcpu-1gb",
      rootfs: process.env.SANDBOX_ROOTFS ?? "devbox:1",
      // Setup needs GitHub, foundry.paradigm.xyz and binaries.soliditylang.org.
      egress: (process.env.SANDBOX_EGRESS ?? "*").split(",").map((s) => s.trim()),
    });
    this.id = sandbox.id;
    this.status = "installing Foundry";
    log(`Sandbox ${sandbox.id} running. Installing Foundry (one time, ~1-2 min)...`);
    const res = await exec(sandbox, BOOTSTRAP, 900_000);
    if (res.exitCode !== 0) throw new Error(`Sandbox bootstrap failed:\n${(res.stderr || res.stdout).slice(-2000)}`);
    this.status = "ready";
    log(`Sandbox ready: ${res.stdout.trim()}`);
    return sandbox;
  }

  async destroy() {
    if (!this.ready) return;
    const sandbox = await this.ready.catch(() => undefined);
    await sandbox?.destroy().catch(() => {});
  }
}

export const sandboxManager = new SandboxManager();

async function exec(sandbox: Sandbox, script: string, timeoutMs: number): Promise<RunResult> {
  const { result, exec_ms } = await sandbox.runCommand("bash", ["-lc", script], { timeoutMs });
  return {
    stdout: result.stdout,
    stderr: result.error ? `${result.stderr}\n${result.error}` : result.stderr,
    exitCode: result.exit_code,
    ms: exec_ms,
  };
}

/** A per-audit Foundry project inside the warm sandbox. */
export class AuditWorkspace {
  private constructor(private sandbox: Sandbox, readonly dir: string) {}

  static async create(auditId: string, log: (msg: string) => void) {
    const sandbox = await sandboxManager.warm(log);
    const dir = `/workspace/audits/${auditId.replace(/[^a-zA-Z0-9-]/g, "")}`;
    const res = await exec(
      sandbox,
      `mkdir -p ${dir}/src ${dir}/test ${dir}/lib ${dir}/original && ln -sfn ${SHARED}/lib/forge-std ${dir}/lib/forge-std && cp ${SHARED}/foundry.toml ${dir}/`,
      30_000,
    );
    if (res.exitCode !== 0) throw new Error(`Could not create audit workspace: ${res.stderr}`);
    return new AuditWorkspace(sandbox, dir);
  }

  async writeFile(relPath: string, content: string) {
    const abs = `${this.dir}/${relPath}`;
    await exec(this.sandbox, `mkdir -p "$(dirname "${abs}")"`, 30_000);
    await this.sandbox.files.upload(abs, content);
  }

  async readFile(relPath: string) {
    const buf = await this.sandbox.files.download(`${this.dir}/${relPath}`);
    return new TextDecoder().decode(buf);
  }

  /** Runs a shell command from the project root with Foundry on PATH. */
  run(command: string, timeoutMs = 240_000) {
    return exec(this.sandbox, `${PATH_PREFIX}; cd "${this.dir}" && ${command}`, timeoutMs);
  }

  async cleanup() {
    await exec(this.sandbox, `rm -rf "${this.dir}"`, 30_000).catch(() => {});
  }
}
