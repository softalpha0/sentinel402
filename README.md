# Sentinel402

**An AI agent that hacks your smart contract before attackers do.**

Paste a Solidity contract. Sentinel402's agent **writes its own Foundry exploit tests**, **runs them
in an isolated CreateOS sandbox**, fixes its own code when it fails, and only reports bugs it has
**proven with a working attack**. Then it patches the contract and re-runs every attack to show
the fix holds. Audits are paid per run with **Stripe Checkout**; the stack is set up with **Stripe Projects**.

Built at the CreateOS × Stripe Projects hackathon (17 Oct 2026).

## How it works

```
Browser ── paste contract ──▶ Stripe Checkout ($1, test mode) ──▶ paid
                                        │
                                        ▼
                       Claude agent (tool-use loop)
            write_file · read_file · run_forge · report_finding · mark_patched
                                        │
                                        ▼
               CreateOS sandbox (isolated micro-VM, kept warm)
               Foundry project per audit: src/Target.sol + test/Exploit_*.t.sol
                                        │
          live events (Server-Sent Events) ◀── forge output · findings · patches
```

1. The contract is uploaded into a fresh project folder inside the sandbox.
2. The agent writes `test/Exploit_*.t.sol` tests that **pass only if the attack works**.
3. `forge test` runs in the sandbox. Compile errors or failed attacks go back to the agent, which fixes and retries.
4. Passing exploits become findings, with the exploit code as proof.
5. The agent patches the contract and re-runs the exploits; blocked attacks are marked patched.

**Why a sandbox:** the agent writes attack code. It must never run on our server. CreateOS gives
each run an isolated micro-VM, and the sandbox is kept warm (Foundry installed once) so audits take seconds.

## Setup

```bash
stripe login
stripe projects init          # provisions the stack (+ CreateOS) and writes .env
npm install
cp .env.example .env          # fill in anything missing
npm run dev                   # http://localhost:3000  (boots + warms the sandbox on start)
```

CLI: `npm run audit -- demo-contracts/VulnerableVault.sol`

Stripe test card: `4242 4242 4242 4242`, any future date, any CVC.

## Demo contracts
| File | Planted bug |
|---|---|
| `VulnerableVault.sol` | Reentrancy in `withdraw()` |
| `CommunityTreasury.sol` | Unprotected `setOwner()` + `tx.origin` auth |
| `SafeVault.sol` | None: every attack should fail (no false alarms) |

## Limitations
Single-file Solidity contracts; not a replacement for a professional audit. No findings means no
exploit succeeded, not a guarantee of safety.
