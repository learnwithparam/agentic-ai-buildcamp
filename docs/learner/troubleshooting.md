# Fix a problem on your own laptop

Something broke. Run this first:

```bash
npm run doctor
```

It checks your machine, Docker, the `.env` file, every container, the services and one model call. It starts nothing and changes nothing. It never prints a key. Each problem it finds names a fix and a section on this page.

Fix the first problem it names, then run it again. One fix often clears the problems after it.

On a checkpoint tag before lesson 22, `npm run doctor` is not there yet. Read the sections below in order and check each one by hand.

The end of this page covers problems the doctor cannot see. One is a lesson that does not match your code.

## What the doctor checks

<a id="node"></a>

### Node is too old

The app needs Node 22.18 or newer. An older Node installs without an error, then the page server fails to start.

- Install Node 22.18 or newer from nodejs.org, or with a version manager such as `nvm` or `fnm`.
- Then run `npm ci` again, because packages built for the old Node may not load.

<a id="docker"></a>

### Docker is not running, or has too little memory

The course runs Langfuse, Postgres, Keycloak, OpenFGA and Docling in Docker. Together they need about 6 GB of memory.

- Start Docker Desktop and wait until it says it is running. On Linux, start the Docker service.
- If the doctor says Docker has too little memory, open Docker's settings. Under Resources, set the memory to 6 GB or more, then apply and restart.
- A laptop with 8 GB in total is tight. Close the browser tabs and apps you do not need.

<a id="compose"></a>

### Docker Compose is missing or too old

The course starts its containers with `docker compose`, which is version 2. The old `docker-compose` command, with a dash, is version 1 and does not work here.

- Docker Desktop includes version 2.
- On Linux, install the `docker-compose-plugin` package, then run `docker compose version` to see it.

<a id="disk"></a>

### The disk is almost full

The container images and their data take several gigabytes. A full disk makes containers stop with errors that do not mention the disk.

- Free at least 10 GB.
- `docker system prune` removes stopped containers and images you no longer use. It does not touch the course data while the containers run.

<a id="env"></a>

### A key is missing in .env

The app reads its keys from `.env` in the repo folder. Your shell's own variables do not count, because `.env` wins.

Three keys come from you:

| Key | Where it comes from |
| --- | --- |
| `OPENAI_API_KEY` | Your OpenRouter key, from openrouter.ai, under Keys |
| `GATEWAY_KEY_MEDINFO_APP` | Langfuse, under AI Gateway, then Gateway keys. Lesson 10 shows each screen. |
| `GATEWAY_KEY_EVAL_RUNNER` | The same place, the second key |

`npm run setup` makes every other key. If the doctor names any other key, run `npm run setup` again.

<a id="langfuse-stack"></a>

### A Langfuse container is not ready

Langfuse is several containers. There is the web app, a worker and the AI gateway. It also has its own Postgres, ClickHouse, Redis and MinIO.

- Right after a start, a container can say "starting" for a minute or two. Wait, then run the doctor again.
- If one says "exited", run `npm run setup`. It starts them all again.
- If one keeps stopping, the doctor prints the command that shows its log. The last lines say why. Too little memory is the usual reason.

<a id="infra-stack"></a>

### A Postgres, Keycloak, OpenFGA or Docling container is not ready

These hold the app's data, the sign-in, the permissions and the PDF reader.

- Keycloak is the slowest to start. Give it two minutes.
- If one says "exited", run `npm run setup`.
- Did Postgres stop right after you changed `.env` by hand? Then its password may not match the stored data. Put the old value back, or ask for help before you delete any data.

<a id="ports"></a>

### A port is in use by another program

Each container listens on a fixed port. If another program already uses that port, the container cannot start.

| Port | Used by |
| --- | --- |
| 5174 | Langfuse |
| 5442 | Postgres for the app |
| 8180 | Keycloak |
| 8280 | OpenFGA |
| 5001 | Docling |
| 3333 | The app's page server |

- On macOS or Linux, run this with the port the doctor named. It shows the program.

```bash
lsof -i :5442
```

- On Windows, run `netstat -ano` and look for the port.
- Stop that program, or another Postgres or Keycloak you run, then run `npm run setup`.

<a id="services"></a>

### A service does not answer

The containers run, but one does not answer yet. That is normal for a minute after a start.

- Wait a minute and run the doctor again.
- If it still does not answer, run `npm run setup`.

<a id="model"></a>

### The model call fails

The doctor sends one short question through the Langfuse AI gateway to OpenRouter. It costs a tiny fraction of a cent.

| The doctor says | What to do |
| --- | --- |
| The gateway refused the key | Copy `GATEWAY_KEY_MEDINFO_APP` again from Langfuse into `.env` |
| The key spent its daily budget | Raise the key's daily budget in Langfuse under AI Gateway, or wait until tomorrow |
| The model call failed | Check the OpenRouter key and its credit. In Langfuse, open AI Gateway, then Connections & Models |

<a id="app"></a>

### The app is not running

This is not an error. The doctor says if `npm run dev` is running. Then you know why the page at port 3333 does not open. Start it with `npm run dev` and keep that terminal open.

## Problems the doctor cannot see

| What you see | Why | What to do |
| --- | --- | --- |
| A lesson's command is missing, such as `npm run setup` | You are on an older checkpoint tag | Follow that lesson's page. Each page uses the commands its tag has. |
| An edit seems to do nothing | You are on `main`, not the lesson's tag | Run `git checkout` with the tag at the top of the lesson |
| Your code is lost after a checkout | Git keeps changes only when you commit them | Commit your work before you change tags |
| You are stuck in the middle of a lesson | It happens | Check out the next lesson's tag and carry on from there |
| A trace is missing in Langfuse | Traces arrive a few seconds after the answer | Refresh the Traces page. Keep `npm run dev` running until it shows. |
| The sign-in page says the password is wrong | Each demo user's password is in your own `.env` | Use the value of `SEED_USER_PASSWORD` |
| You are signed in as the wrong person | The browser keeps one sign-in at a time | Use a private window, or one browser profile per person |
| The chat says "The agent could not finish this answer" | The model call failed | Run `npm run doctor`. The model check names the reason. |
| The app stops with "password authentication failed" | Another copy of this repo on your laptop started the containers, with its own passwords | Stop that copy's containers with `docker compose down`, then run `npm run setup` here |
| The first `npm run setup` is slow | Docker downloads every image once | Wait. A second run is fast. |
| The answer differs from the lesson's example | The model words things a bit differently each time | Check that the facts and the citation match, not the wording |

## Still stuck

Copy the full output of `npm run doctor` into your question. It has no keys in it, so it is safe to share. Add the lesson number and the command you ran.
