# Pixagram API node

Full public API node for the Pixagram blockchain: consensus node, HAF indexer,
Hivemind social layer, JSON-RPC routing and TLS.

This node **does not produce blocks**. If that is what you want, use
[pixagram-blockchain/witness](https://github.com/pixagram-blockchain/witness) —
a two-container stack that needs a fraction of the resources.

## Architecture

```
Internet → Caddy (TLS) → Jussi (routing + field translation) → hived / Hivemind
```

Jussi sends chain queries to hived and social queries to Hivemind, and rewrites
Hive-derived field names on the wire so clients see Pixagram ones
(`hbd_balance` → `pxs_balance`, `reward_hive` → `reward_pixa`, and so on).

| Service | Image | Purpose |
|---|---|---|
| `pixagram` | `pixadock/pixagram:mainnet` | Consensus node (hived) |
| `pixagram_haf` | `pixadock/pixagram-haf:mainnet` | HAF node — hived plus PostgreSQL |
| `hivemind_setup` | `pixadock/hivemind:mainnet` | One-shot schema and role creation |
| `hivemind_sync` | `pixadock/hivemind:mainnet` | Block processor |
| `hivemind` | `pixadock/hivemind:mainnet` | PostgREST social API |
| `jussi` | `openresty/openresty:alpine` | Request routing, field translation |
| `ssl-proxy` | `caddy:alpine` | TLS termination, automatic certificates |

## Sizing

Measured on a production node at 1.75M blocks, two weeks of uptime.

| | |
|---|---|
| RAM, actually resident | **5.4 GB** |
| CPU, steady state | **0.21 vCPU** (2.7% of 8) |
| CPU, peak during initial sync | 2.46 vCPU |
| Disk, chain data | 5.1 GB |
| Disk, total including images | ~15 GB |

**Recommended: 4 vCPU / 16 GB / 100 GB SSD.**

Those RAM figures are PSS, not RSS. `docker stats` sums to about 10 GB because
it double-counts shared memory — PostgreSQL's shared buffers and hived's mmap
are counted once per process that maps them.

One thing to know before you shrink the box: HAF ships PostgreSQL tuned for
full Hive, with `shared_buffers` at 16 GiB against a database that is currently
about 1.3 GB. Postgres will not start if it cannot reserve that, so below
roughly 24 GB of RAM you must retune it. The override directory is bind-mounted
and empty by default:

```bash
cat > pixagram-haf/haf_postgresql_conf.d/local.conf <<'EOF'
shared_buffers = 2GB
effective_cache_size = 4GB
maintenance_work_mem = 512MB
EOF
```

With that in place the stack is comfortable on 8–16 GB.

## Setup

```bash
git clone https://github.com/pixagram-blockchain/pixagram-node.git
cd pixagram-node

# Your public hostname. Caddy obtains and renews the certificate for it.
echo 'SITE_ADDRESS=api.example.com' > .env
chmod 600 .env

docker compose up -d
docker compose logs -f pixagram_haf
```

`SITE_ADDRESS` defaults to `:80` — plain HTTP, no certificate requests. That is
deliberate: a hardcoded hostname in a public template means everyone who runs it
unedited asks Let's Encrypt for a certificate they cannot pass the challenge
for, and those failures count against that domain's rate limits.

First sync pulls the chain over P2P and indexes it into HAF and Hivemind. The
`hivemind_setup` container is a one-shot: it must exit 0 before `hivemind_sync`
and `hivemind` will start.

## Ports

| Port | Exposure | Purpose |
|---|---|---|
| `80`, `443` | public | TLS termination and the public API |
| `2001` | public | hived P2P — needed to sync and to serve peers |
| `2002` | public | HAF node P2P |
| `7777` | local | hived HTTP, direct |
| `7778` | local | Hivemind, direct |
| `7779` | local | HAF node HTTP, direct |

## Verify

```bash
# chain
curl -s -X POST https://your-host -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"condenser_api.get_dynamic_global_properties","params":[],"id":1}'

# social layer
curl -s -X POST https://your-host -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"bridge.get_ranked_posts","params":{"sort":"created","tag":"","limit":1},"id":1}'
```

Compare `head_block_number` against `https://api.pixagram.com`. Hivemind's own
progress is in `hivemind_app.hive_state.last_completed_block_num`; on a healthy
node it tracks the head block with no lag, because the app runs in HAF forking
mode.

## Restarting

The compose file ships `pixagram` and `hivemind` with `restart: "no"`, matching
upstream. That means a host reboot brings the box back with HAF, Jussi and
Caddy healthy and **hived not running**. It looks fine and serves stale data.
If you run this unattended, either change those to `unless-stopped` or add a
boot unit that runs `docker compose up -d`.

Jussi is nginx, which resolves its upstreams when it parses its config and hard
-fails if Hivemind is not up yet. It recovers on its own through its restart
policy, but expect it to flap for up to a minute after a cold start.

## Upgrading

`block_log*` is the chain itself — never delete it. Everything else under
`blockchain/` is derived state and is rebuilt by a replay:

```bash
docker compose down
rm -f pixagram/blockchain/shared_memory.bin
rm -rf pixagram/blockchain/account-history-rocksdb-storage \
       pixagram/blockchain/comments-rocksdb-storage
HIVED_EXTRA_ARGS=--replay-blockchain docker compose up -d pixagram
# once it logs "entering live mode":
docker compose up -d
```

Both steps are needed when enabling a plugin that adds a chainbase index:
keeping the state file gives you "Inconsistency occurs. A new index is created",
and skipping the replay gives you "Headblock and statefile are inconsistent".

## Notes

- `.env` and every datadir are in `.gitignore`. Keep it that way — this repo is
  public and the datadir would otherwise leak your peer list and logs.
- `metadata` must stay in the plugin list. From hived 1.28.7 the account
  metadata index moved out of the core chain object into that plugin, so
  without it every account profile reads back empty.
- If you see `Permission denied` on startup, fix ownership:
  `sudo chown -R 1000:1000 ./pixagram ./pixagram-haf`
