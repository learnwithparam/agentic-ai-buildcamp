# Start here: meet the world

KaaS Freight paid one invoice twice last month. That cost USD 3,140 and a lot of chasing. Your job in this course
is to hire an AI employee who never lets that happen, and to prove it. This page takes about 20 minutes.

| Minutes | You do | You see |
|---|---|---|
| 0 to 5 | Clone the repo, `bun install`, `bun run verify meet-the-world --setup` | A setup table: each line passed, or the fix to try |
| 5 to 8 | `bun run world freight-audit` | The ledger on `localhost:7700/ledger`: 60 invoices, all open |
| 8 to 12 | `bun run reference naive` | The naive employee says "All 6 invoices paid. Done." The ledger disagrees |
| 12 to 17 | `bun run reference`, then open `localhost:7702/board` | Four cards Done, one Needs you, one Refused, and the cost per invoice settled |
| 17 to 20 | `bun run verify meet-the-world` | Your next step |

```mermaid
flowchart LR
  subgraph World["The world (we ship it)"]
    L[(Ledger)]
    T[Tools over HTTP and MCP]
    T --> L
  end
  subgraph Yours["Your employee (any stack)"]
    E[Answers the contract]
  end
  E -->|tool calls| T
  C[Checker: bun run verify] -->|jobs over the contract| E
  C -->|reads| L
  C -->|reads| TR[Your traces]
  E --> TR
```

The world is a freight broker's invoice desk with a ledger behind it. Your employee is yours: any language, any
SDK, any model. The contract is six routes your employee answers. The checker sends jobs through the contract and
then reads the ledger and your traces. It never reads your employee's reply as proof.

## 1. Set up

```bash
bun install
bun run verify meet-the-world --setup
```

Expect: a table that ends with `Ready. Next: bun run world freight-audit`. For example:

```
Setup for the Agentic AI Buildcamp:
  PASS  Bun 1.4.4 or newer     Bun 1.4.4
  SKIP  Model key (optional)   not set
                               Fix: Fine for now: the reference runs on recorded replies. Set ANTHROPIC_API_KEY before your employee calls a model
  SKIP  Docker (optional)      not found
                               Fix: Only needed for ship-it-as-a-service. Install Docker Desktop or Docker Engine before then
  PASS  uv (Python path only)  uv 0.13.8
  PASS  Port 7700 free         free
  PASS  Port 7701 free         free
  PASS  Port 7702 free         free
Ready. Next: bun run world freight-audit
```

A `FAIL` line is something to fix now; its `Fix:` line says how. A `SKIP` line is optional. No model key is
needed today: the reference runs on recorded model replies. On the Python path you still install Bun once,
because the checker runs on Bun.

## 2. Start the world

Open a second terminal and leave this running.

```bash
bun run world freight-audit
```

Expect: `The freight-audit world is running on http://localhost:7700` and `60 invoices, all open`.

Open `localhost:7700/ledger`. Every row changes only through the world's tools, and every write is logged.

![The ledger: 60 invoices, all open](images/world-ledger.png)

## 3. Watch an employee trust its own reply

```bash
bun run reference naive
```

Expect: `Naive employee says: "All 6 invoices paid. Done."`, then the ledger's own table and `4 paid once, 1 paid twice, 1 not paid.`

The pay tool timed out on one invoice after it had already written the payment. The naive employee tried again
with a new key and paid it twice. On another invoice every try failed, and it said done anyway.

![The naive employee says done; the ledger shows one invoice paid twice and one not paid](images/naive-says-done.png)

## 4. Run the reference and open the board

```bash
bun run reference
```

Expect: four `Done` lines, one `Needs you` (USD 6,200, over Ravi's limit, waits for Lena), one `Refused` (the scan with white text), and `Cost per invoice settled`.

Open `localhost:7702/board` while it runs. A card is Done only when the ledger agrees.

![The board: four Done, one Needs you, one Refused](images/board-orientation.png)

## 5. See your goal

Write what you saw in `parts/00-meet-the-world/01-meet-the-world/problem/notes.md`, then:

```bash
bun run verify meet-the-world
```

Expect: `Done. All 5 rules pass.` and `You ran the reference. Your goal: your own employee passes the same checks. Next: bun run verify place-it-on-the-map.`

When a command prints something you do not expect, look it up in [troubleshooting.md](troubleshooting.md).
