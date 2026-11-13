# Watchdog

Restarts the part of this stack that has stopped keeping up with the chain, and tells you that it did. One file,
nothing to install beyond Node 18 and the Docker the stack already runs on.

## Why

`restart: unless-stopped` brings back a service that exits. It does nothing for one that is still running and no
longer working. On 12 November 2026 the Hivemind index behind a public node took in nothing for four hours: hived
answered, every container was up, `bridge.*` kept answering, and the newest post simply stayed the newest post.
Nothing restarts that and nothing reports it, because by every check Docker has, the stack is healthy.

The only thing that shows it is a comparison between the chain's head and how far the index has got. That
comparison is what this makes, once a minute.

## What it does

Each run it reads, on this machine only:

| Reading | From |
|---|---|
| the chain's head | hived, `condenser_api.get_dynamic_global_properties` |
| how far HAF has written | `select max(num) from hafd.blocks` |
| how far Hivemind has read | the lower of `hafd.contexts.current_block_num` for `hivemind_app` and `hivemind_app.hive_state.last_completed_block_num` |
| whether each service is running | `docker compose ps` |
| whether the router still answers for Hivemind | one small call through it, only if you say where it is (`NODE_WATCH_API`) |

and gives what it finds one of these names:

| Finding | Meaning | First step |
|---|---|---|
| `down` | a service isn't running | `docker compose up -d` |
| `unreachable` | hived doesn't answer | restart `pixagram` |
| `node-behind` | the head is 3 minutes old and another node is 60 blocks ahead | restart `pixagram` |
| `haf-behind` | HAF is 60 blocks (3 minutes) behind the head and not gaining | restart `pixagram_haf` |
| `index-behind` | Hivemind is 60 blocks behind HAF and not gaining | restart `hivemind_sync` |
| `api-down` | everything is keeping up, and the router can't answer for Hivemind | restart `jussi` |
| `catching-up` | behind, but gaining on the head | none |
| `chain-quiet` | the head is old and nobody else is ahead | none |
| `blind` | it can't ask HAF's database | none; says so after ten minutes |

A finding has to be there three runs in a row before anything is done about it. Then:

1. the first step above;
2. five minutes later, if it is still so and you have allowed it (`NODE_WATCH_RECREATE=1`), the whole stack
   again: `docker compose up -d --force-recreate`, then `docker compose restart jussi`;
3. five minutes after that, it stops and says a person is needed.

Two good runs in a row and it is well again, and says so.

Step 2 is off unless you turn it on, because it takes the public API away for as long as the stack takes to come
back. Without it the watchdog restarts the one part and then asks for you.

`api-down`, and the Jussi restart that ends step 2, are there because of the note under Upgrading in this
repository's README: Jussi resolves Hivemind's address once, when it starts, and answers 502 on `bridge.*` if
Hivemind has moved since.

## What it never does

- It never deletes anything, replays or resyncs. Those are a person's decision.
- It never touches anything outside this compose project.
- It never acts more than six times in a day. After that it stops and says so.
- It never acts on a chain that has stopped for everyone, or on a part that is catching up.
- It never calls an index it couldn't read "well".

It gives a container two minutes to stop cleanly (`NODE_WATCH_STOP_SECONDS`) where Docker gives ten seconds.

## Install

It needs Node 18 or newer on the host (`node --version`), and a user who may use Docker: the unit runs it as root.

```bash
cd /path/to/pixagram-node

# 1. See what it sees. This changes, writes and sends nothing.
sudo node watchdog/watchdog.mjs --dry

# 2. Say where alerts go (see Alerts), then send yourself one.
sudo install -m 600 watchdog/watchdog.env.example /etc/pixa-node-watch.env
sudoedit /etc/pixa-node-watch.env
sudo sh -c 'set -a; . /etc/pixa-node-watch.env; node watchdog/watchdog.mjs --test'

# 3. Run it every minute.
sed "s|/opt/pixagram-node|$PWD|g" watchdog/pixa-node-watch.service | sudo tee /etc/systemd/system/pixa-node-watch.service >/dev/null
sudo cp watchdog/pixa-node-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pixa-node-watch.timer

# 4. Once, if you like: prove the restart and the alert on a healthy node.
#    This restarts hivemind_sync, which is back within seconds.
sudo sh -c 'set -a; . /etc/pixa-node-watch.env; node watchdog/watchdog.mjs --drill'
```

`journalctl -u pixa-node-watch` shows each run that did or said something.

## Settings

All from the environment, all optional. The defaults suit an unchanged clone of this repository.

| Variable | Default | What it is |
|---|---|---|
| `NODE_WATCH_WEBHOOK` | none | A URL each alert is posted to as JSON |
| `NODE_WATCH_COMMAND` | none | A command run for each alert |
| `NODE_WATCH_NAME` | the hostname | What alerts call this node |
| `NODE_WATCH_URL` | `http://127.0.0.1:7777` | Where the head is read: hived's own port |
| `NODE_WATCH_URL_SERVICE` | `pixagram` | The service restarted when that address doesn't answer |
| `NODE_WATCH_API` | none | The address apps use, to ask the router for Hivemind each run |
| `NODE_WATCH_OTHER` | none | Another node of the chain, to tell a lost node from a stopped chain |
| `NODE_WATCH_SERVICES` | the five long-running services | Add `ssl-proxy` to count it too |
| `NODE_WATCH_RECREATE` | off | `1` allows step 2 |
| `NODE_WATCH_STOP_SECONDS` | `120` | How long a container is given to stop cleanly |
| `NODE_WATCH_COMPOSE_DIR` | this folder's parent | Where the compose file is |
| `NODE_WATCH_DIR` | `/var/lib/pixa-node-watch` | Where it keeps what it found and did |

Without `NODE_WATCH_OTHER` an old head is always taken for a chain that has stopped, and nothing is restarted
for it.

## Alerts

An alert is a title and a sentence or two, sent when the watchdog does something, gives up, or sees the node
well again after trouble. Each is sent once.

```
api.example.com: the watchdog restarted hivemind_sync
The Hivemind index had stopped keeping up with the chain. It looks again in 5 minutes.
```

**A webhook** gets it as JSON, with the same text under `text` and under `content`, the two names chat webhooks
read, and the parts beside them:

```json
{
  "text": "api.example.com: the watchdog restarted hivemind_sync\nThe Hivemind index had stopped…",
  "content": "(the same)",
  "title": "api.example.com: the watchdog restarted hivemind_sync",
  "body": "The Hivemind index had stopped keeping up with the chain. It looks again in 5 minutes.",
  "node": "api.example.com",
  "event": { "kind": "action", "problem": "index-behind", "did": "restart", "service": "hivemind_sync", "ok": true }
}
```

**A command** is run through the shell with the alert in `NODE_WATCH_TITLE`, `NODE_WATCH_BODY` and
`NODE_WATCH_EVENT` (the event as JSON). Point it at a script and send the alert any way you like:

```sh
#!/bin/sh
# /usr/local/bin/pixa-node-alert
printf '%s\n' "$NODE_WATCH_BODY" | mail -s "$NODE_WATCH_TITLE" ops@example.com
```

An alert that can't be sent is logged and never stops the watching.

## When it says a person is needed

It has restarted the part (and recreated the stack, if you allowed that) and the finding is still there; or it
has acted six times in a day; or it hasn't been able to read HAF's database for ten minutes. It will do nothing more until the node is
well, and then it starts watching again by itself.

```bash
sudo node watchdog/watchdog.mjs --dry                 # the head, HAF, the index and each service, as it sees them
docker compose logs --tail 200 hivemind_sync          # a healthy one logs a line for each block
docker compose logs --tail 200 pixagram_haf
```

Keep those logs before trying anything else: if the index is stuck in a way a restart doesn't cure, they are the
only record of why. Resyncing HAF and Hivemind (Upgrading, in this repository's README) rebuilds the index from
the chain in minutes, and is the step this script will never take for you.

## What it writes

In `NODE_WATCH_DIR`, readable by anyone on the machine, nothing secret:

- `state.json`: the last run. `status` is one of `well`, `watching`, `acting`, `waiting`, `needs-person`,
  `catching-up`, `chain-quiet`, `blind`; `readings` are the head, HAF and index block numbers.
- `log.jsonl`: one line for everything it did or told, with the time in milliseconds.
- `memory.json`: what it carries from run to run.

## Tests

The decision is one pure function, `decide(readings, memory, now)`, tested run by run with made-up readings.
The reading and the doing are tested with Docker and the node stood in for, down to the exact commands:

```bash
node --test watchdog/watchdog.test.mjs
```

## What has been tried, and what hasn't

Written by [Pixtopia](https://pixtopia.net), where this file runs every minute against `api.pixtopia.net`, a node
built from this repository with the TLS container left out and Jussi published on localhost.

- Tried on that node: every reading, a clean run each minute, and the drill, which restarted `hivemind_sync` in
  three seconds with the index one block behind afterwards. The alert reached a command and a local webhook
  listener.
- Not tried: an unchanged clone of this repository; a chat service's real webhook; and a real stall. A plain
  `up -d --force-recreate` has been run by hand on that node and came back by itself, but step 2 as written
  here, with its stop time and its Jussi restart, has only been run against a stand-in for Docker, which is one
  more reason it is off by default.
- Not known: whether a restart cures the kind of stall seen on 12 November. If it doesn't, what this gives you
  is the alert: five or six minutes after the index stops, and again five minutes later when it gives up.
