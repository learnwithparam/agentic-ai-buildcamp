# Ship it as a service

## The problem

Your employee runs only while your terminal is open. Close the laptop, and KaaS Freight's invoices stop. Ravi asks "is it
up?". Nobody can answer without logging in.

There is also a risk with secrets. If someone builds an image with the key inside, everyone who pulls that image can read
the key.

A real employee runs as a container. A container is a running copy of an image.

A good container says whether it is healthy, and it restarts itself when it fails. It gets its secrets from the environment when it starts. It keeps saved jobs
and traces on volumes. A volume is storage that outlives the container.

For example, the finished sample runs on port 7701. `docker compose ps` shows the `employee` service as `(healthy)`.
`curl -s localhost:7701/health` answers with contract `"1"`. The API key is in the container's environment, but not in its
image.

```mermaid
flowchart LR
  Env[".env or the environment: ANTHROPIC_API_KEY, WORLD_URL"] -->|at start| Container
  subgraph Container["Container: no key inside the image"]
    Employee["Your employee on :7701"]
  end
  Container -->|health check: GET /health| Status[docker compose ps: healthy]
  Container --- Traces[(Volume: traces)]
  Container --- State[(Volume: state)]
  Employee -->|tools| World["The world on :7700, on the host"]
```

## Your challenge

From the repo root, copy the three starter files in this folder into `employee/`:

`cp parts/03-deploy/01-ship-it-as-a-service/problem/{Dockerfile,Dockerfile.dockerignore,compose.yaml} employee/`

Then fill in every `TODO`:

| File                      | What it holds                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`              | Bun's image, your code and `config/`, `PORT`, `TRACE_DIR`, `STATE_DIR`. No key.                                                                                                                                      |
| `Dockerfile.dockerignore` | Keeps `.env` and local state out of the build.                                                                                                                                                                       |
| `compose.yaml`            | One service. It has a build, port `${PORT:-7701}`, `WORLD_URL` and the key from the environment, a health check on `/health`, `restart: unless-stopped`, and a named volume for `TRACE_DIR` and one for `STATE_DIR`. |

The checker sets `PORT`, `WORLD_URL` and `ANTHROPIC_API_KEY` in the environment when it runs `docker compose up`. So your
compose file must read them with `${NAME}`. On Linux, `host.docker.internal` needs
`extra_hosts: ["host.docker.internal:host-gateway"]`.

## Done when

- `compose.yaml` has a health check on `/health` and a restart policy.
- No key is in the Dockerfile or in a build argument. A dockerignore file lists `.env`.
- `TRACE_DIR` and `STATE_DIR` sit on volumes.
- The container comes up healthy and pays a clean invoice from inside. The key is in its environment, but not in its
  image. The container still knows the job after `docker compose down` and `up`.

```bash
bun run verify ship-it-as-a-service
```

Expect: `Done. All 4 rules pass.`

![The container step passing](../images/expected.png)

When Docker is not running, the last rule says `SKIP`. A skip is not a pass. Start Docker and check again.

## If you get stuck

| What you see                                                        | Fix                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `docker compose up --wait did not finish healthy`                   | Run `docker compose up --build` without `-d`, and read the log.                                                          |
| "the ledger shows no payment"                                       | The container cannot reach the world. Use `WORLD_URL: ${WORLD_URL:-http://host.docker.internal:7700}` and `extra_hosts`. |
| The Dockerfile says "ARG ANTHROPIC_API_KEY"                         | Delete it. The key goes in `environment:` in compose.                                                                    |
| `GET /jobs/... answered {"error": "no such job"}` after down and up | `STATE_DIR` is not on a named volume.                                                                                    |

## Words you will use

- **Image**: the frozen files that a container starts from. Anyone who pulls it can read it.
- **Health check**: a command that Docker runs to ask the service if it works, not only if it started.
