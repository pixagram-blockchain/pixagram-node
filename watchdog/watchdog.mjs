// Keeps a Pixa API node keeping up, by itself, and says when it couldn't. It is written for the published stack
// (pixagram-blockchain/pixagram-node: hived, HAF, Hivemind, the router) and has no dependencies but Node and Docker.
//
// On 12 November 2026 a Hivemind index stopped taking anything in for four hours while everything about it looked well:
// the node answered, every container ran, and the newest post simply stayed the newest post. Docker restarts a part that
// crashes, but nothing restarts one that's alive and has stopped working, and nothing says so.
//
// Run once a minute as root (it speaks to Docker). Each run it reads, on this machine only: the chain's head from the
// node, how far HAF has written the chain, how far the index (Hivemind) has read it, whether each container is running
// and, if it's told where the router is, whether the router still answers for Hivemind. A problem seen three runs in a
// row is acted on: first the one part is restarted; five minutes later, if that didn't do it and it has been allowed to
// (NODE_WATCH_RECREATE=1), the whole stack is made again; after that it stops and says a person is needed. Nothing here
// ever drops data, replays or syncs again from nothing: that's a person's decision. It touches only its own compose
// project. At most six actions a day.
//
// What it found and did is written to its state folder (state.json, log.jsonl) and sent wherever it's told to send it:
// a webhook (NODE_WATCH_WEBHOOK) or any command (NODE_WATCH_COMMAND). Everything it reads from the environment is in
// `settings` below.
//   node watchdog.mjs            one run
//   node watchdog.mjs --dry      read and decide; change, write and send nothing
//   node watchdog.mjs --drill    restart the index's follower once as if it were stuck, to prove the step and the alert
//   node watchdog.mjs --test     send a test alert and touch nothing
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The long-running services of the published stack. One of these not running is a problem. */
export const SERVICES = ['pixagram', 'pixagram_haf', 'hivemind_sync', 'hivemind', 'jussi'];

export const LIMITS = {
  /** Blocks behind (three seconds each) before a part counts as behind. */
  lag: 60,
  /** A head this old means the node isn't hearing the chain, if someone else's is ahead. */
  staleMs: 180_000,
  aheadBlocks: 60,
  /** Runs in a row a problem has to be seen before anything is done. */
  confirm: 3,
  /** How long a remedy is given before it's judged. */
  settleMs: 300_000,
  /** Runs in a row it has to be well before an incident is over. */
  wellChecks: 2,
  /** Remedies tried for one incident: the part restarted, then the whole stack made again. 1 leaves out the second. */
  steps: 2,
  dayActions: 6,
  /** Runs in a row it may be unable to read HAF or the index before it asks for a person. */
  blindRuns: 10,
};

const DAY_MS = 86_400_000;

// The first thing tried for each problem. The second is always the whole stack made again.
const FIRST = {
  down: { did: 'up' },
  unreachable: { did: 'restart', service: 'pixagram' },
  'node-behind': { did: 'restart', service: 'pixagram' },
  'haf-behind': { did: 'restart', service: 'pixagram_haf' },
  'index-behind': { did: 'restart', service: 'hivemind_sync' },
  // The router resolves Hivemind's address once, when it starts, and answers 502 for it if Hivemind has moved since.
  'api-down': { did: 'restart', service: 'jussi' },
};

/**
 * What's wrong, if anything, from one run's readings and the run before's.
 * @param {{ head: { number: number, time: number } | null, other: number | null, haf: number | null, index: number | null, api?: boolean | null, services: Record<string, string> | null }} readings
 */
export function problemOf(readings, last, now, limits = LIMITS) {
  const { head, other, haf, index, services } = readings;
  if (services) {
    const down = Object.keys(services).filter((service) => services[service] !== 'running');
    if (down.length) return { problem: 'down', detail: down };
  }
  if (!head) return { problem: 'unreachable' };
  if (now - head.time >= limits.staleMs) {
    // The head is old. If another node's is well ahead, this one has lost the chain; if not, the chain itself may be
    // resting, and restarting anything would help nobody.
    return other !== null && other - head.number >= limits.aheadBlocks ? { problem: 'node-behind' } : { problem: 'chain-quiet' };
  }
  // A part that's behind but gaining on the head is catching up (after a restart, say) and is left to it.
  const gaining = (value, was) => last && typeof was === 'number' && typeof last.head === 'number' && value - was > head.number - last.head;
  // An index it can't read is one it can't vouch for: never "well".
  if (haf === null || index === null) return { problem: 'blind' };
  if (head.number - haf >= limits.lag) return gaining(haf, last?.haf) ? { problem: 'catching-up' } : { problem: 'haf-behind' };
  if (haf - index >= limits.lag) return gaining(index, last?.index) ? { problem: 'catching-up' } : { problem: 'index-behind' };
  // Everything is keeping up, and the router still can't answer for the index: only asked where a router was named.
  if (readings.api === false) return { problem: 'api-down' };
  return { problem: 'well' };
}

/**
 * One run's decision. Pure: the same readings and memory always decide the same.
 * `status` is how things stand (well, watching, acting, waiting, needs-person, or a problem nothing is done about:
 * catching-up, chain-quiet, blind); `action` is what to do now, if anything; `events` are what to tell.
 * `first` is the first remedy for each problem, for a stack whose node is read through another service.
 */
export function decide(readings, memory, now, limits = LIMITS, first = FIRST) {
  const was = memory ?? {};
  const incident = was.incident ?? null;
  const found = problemOf(readings, was.last ?? null, now, limits);
  const next = {
    last: { at: now, head: readings.head?.number ?? null, haf: readings.haf ?? null, index: readings.index ?? null },
    seen: null,
    incident,
    actions: (was.actions ?? []).filter((at) => at > now - DAY_MS),
    well: 0,
  };
  const out = (status, more = {}) => ({ status, problem: found.problem === 'well' ? null : found.problem, detail: found.detail ?? null, action: null, events: [], memory: next, ...more });
  const standing = () => (incident.gaveUp ? 'needs-person' : 'waiting');

  if (found.problem === 'well') {
    if (!incident) return out('well');
    next.well = (was.well ?? 0) + 1;
    if (next.well < limits.wellChecks) return out(standing());
    next.incident = null;
    next.well = 0;
    return out('well', { events: [{ kind: 'recovered', problem: incident.problem, began: incident.began, steps: incident.steps.length }] });
  }
  const giveUp = (why) => {
    next.incident = { problem: incident?.problem ?? found.problem, began: incident?.began ?? now, steps: incident?.steps ?? [], waitUntil: null, gaveUp: true };
    return out('needs-person', { events: [{ kind: 'gave-up', problem: next.incident.problem, why, steps: next.incident.steps.length }] });
  };
  if (!Object.hasOwn(first, found.problem)) {
    // Nothing to restart: a chain that's resting, a part catching up. But a watchdog that can't see for ten runs has
    // to say so, once, or it would be the thing that looks well and isn't.
    if (found.problem !== 'blind' || incident) return out(incident ? standing() : found.problem);
    const count = was.seen?.problem === 'blind' ? was.seen.count + 1 : 1;
    next.seen = { problem: 'blind', count };
    return count < limits.blindRuns ? out('blind') : giveUp('blind');
  }
  if (incident) {
    if (incident.gaveUp) return out('needs-person');
    if (now < incident.waitUntil) return out('waiting');
  } else {
    const count = was.seen?.problem === found.problem ? was.seen.count + 1 : 1;
    next.seen = { problem: found.problem, count };
    if (count < limits.confirm) return out('watching');
    next.seen = null;
  }
  const steps = incident?.steps ?? [];
  if (steps.length >= (limits.steps ?? 2)) return giveUp('tried');
  if (next.actions.length >= limits.dayActions) return giveUp('often');
  const action = steps.length === 0 ? first[found.problem] : { did: 'recreate' };
  next.incident = { problem: incident?.problem ?? found.problem, began: incident?.began ?? now, steps: [...steps, { at: now, ...action }], waitUntil: now + limits.settleMs, gaveUp: false };
  next.actions = [...next.actions, now];
  return out('acting', { action });
}

// --- Saying it ---------------------------------------------------------------------------------------------------------

const PROBLEMS = {
  down: 'A container had stopped running',
  unreachable: 'The node wasn’t answering',
  'node-behind': 'The node had lost the chain’s head',
  'haf-behind': 'HAF had stopped keeping up with the chain',
  'index-behind': 'The Hivemind index had stopped keeping up with the chain',
  'api-down': 'The router wasn’t answering for Hivemind',
  blind: 'The watchdog couldn’t read how far HAF and the index had got',
};

const done = (step) => (step.did === 'restart' ? `restarted ${step.service}` : step.did === 'up' ? 'started what had stopped' : 'recreated the whole stack');
const doing = (step) => (step.did === 'restart' ? `restart ${step.service}` : step.did === 'up' ? 'start what had stopped' : 'recreate the whole stack');

/**
 * An event as an alert someone can act on: a title and a sentence or two. `name` is what to call this node.
 * @param {{ kind: string, problem?: string, did?: string, service?: string, ok?: boolean, drill?: boolean, why?: string, steps?: number, detail?: string[] | null }} event
 */
export function say(event, name) {
  const what = PROBLEMS[event.problem] ?? 'Something was wrong';
  if (event.kind === 'test') return { title: `${name}: a test from the watchdog`, body: 'Nothing is wrong. This is where you’d hear that the node had stopped keeping up.' };
  if (event.kind === 'recovered') {
    const steps = event.steps ?? 0;
    return { title: `${name}: keeping up again`, body: `${what}. ${steps ? `It took ${steps} ${steps === 1 ? 'step' : 'steps'} from the watchdog.` : 'It came back without the watchdog.'}` };
  }
  if (event.kind === 'gave-up') {
    return {
      title: `${name}: needs a person`,
      body: event.why === 'often'
        ? 'It has needed putting right six times in a day, so the watchdog has stopped. Nothing more will be tried until it is well again.'
        : event.why === 'blind'
          ? 'For ten minutes the watchdog hasn’t been able to ask HAF’s database how far it and the index have got, so it can’t tell whether they’re keeping up. It restarts nothing it can’t see.'
          : `${what}, and what the watchdog tried didn’t fix it. It has stopped trying: it never resyncs or replays by itself.`,
    };
  }
  const which = event.detail?.length ? ` (${event.detail.join(', ')})` : '';
  if (event.drill) return { title: `${name}: a drill, the watchdog ${done(event)}`, body: 'Nothing was wrong. This is what you’d be sent if something had been.' };
  if (event.ok === false) return { title: `${name}: couldn’t be put right`, body: `${what}${which}. The watchdog tried to ${doing(event)}, and Docker refused. It looks again in 5 minutes.` };
  return { title: `${name}: the watchdog ${done(event)}`, body: `${what}${which}. It looks again in 5 minutes.` };
}

// --- Settings ----------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

/**
 * Everything read from the environment, with what it is when unset. The defaults suit an unchanged clone of the
 * published stack, with this file in a folder of its own inside it.
 */
export function settings(env = process.env, here = HERE, has = existsSync) {
  const list = (value) => (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  const beside = COMPOSE_FILES.some((file) => has(join(here, file)));
  const services = list(env.NODE_WATCH_SERVICES);
  const urlService = env.NODE_WATCH_URL_SERVICE || 'pixagram';
  return {
    /** Where the chain's head is read: any JSON-RPC address of this node, on this machine. hived's own port by default. */
    url: env.NODE_WATCH_URL || 'http://127.0.0.1:7777',
    /** The service restarted first when that address doesn't answer: the router's, if the address is the router. */
    urlService,
    /** The router's address, to ask it one small Hivemind question each run. Unset, that isn't asked. */
    api: env.NODE_WATCH_API || null,
    /** Another node of the same chain, asked only when this one's head is old, to tell a lost node from a resting chain. */
    other: env.NODE_WATCH_OTHER || null,
    services: services.length ? services : SERVICES,
    /** The folder the compose file is in: this one, or the one above it. */
    composeDir: env.NODE_WATCH_COMPOSE_DIR || (beside ? here : dirname(here)),
    stateDir: env.NODE_WATCH_DIR || '/var/lib/pixa-node-watch',
    /** What alerts call this node. */
    name: env.NODE_WATCH_NAME || hostname(),
    /** A URL sent each alert as JSON, with `text` and `content` both holding it, for chat webhooks that read either. */
    webhook: env.NODE_WATCH_WEBHOOK || null,
    /** A shell command run for each alert, with it in NODE_WATCH_TITLE, NODE_WATCH_BODY and NODE_WATCH_EVENT (JSON). */
    command: env.NODE_WATCH_COMMAND || null,
    /** How long a container is given to stop cleanly before Docker kills it, in seconds. */
    stopSeconds: Math.max(10, Number(env.NODE_WATCH_STOP_SECONDS) || 120),
    /** Whether the whole stack may be made again when restarting the one part didn't do it. Not unless it's said. */
    recreate: env.NODE_WATCH_RECREATE === '1',
    limits: { ...LIMITS, steps: env.NODE_WATCH_RECREATE === '1' ? 2 : 1 },
    first: { ...FIRST, unreachable: { did: 'restart', service: urlService } },
  };
}

// --- Reading and doing, on the server -----------------------------------------------------------------------------------

async function rpc(ask, url, method, params) {
  const response = await ask(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  return (await response.json())?.result;
}

async function headOf(ask, url) {
  try {
    const result = await rpc(ask, url, 'condenser_api.get_dynamic_global_properties', []);
    const number = Number(result?.head_block_number);
    const time = Date.parse(`${result?.time}Z`);
    return Number.isSafeInteger(number) && number > 0 && Number.isFinite(time) ? { number, time } : null;
  } catch {
    return null;
  }
}

/** Whether the router answers a question only Hivemind can: how many follow the null account. Small, and always there. */
async function answersForIndex(ask, url) {
  try {
    const result = await rpc(ask, url, 'condenser_api.get_follow_count', ['null']);
    return Number.isFinite(Number(result?.follower_count));
  } catch {
    return false;
  }
}

/**
 * The reading and the doing, for one stack. `run` runs `docker compose` with some arguments in the stack's folder and
 * `ask` is fetch: both are the real ones unless a test hands in its own.
 */
export function machine(config, { run = null, ask: web = fetch } = {}) {
  const compose = run ?? ((args, timeout = 60_000) => spawnSync('docker', ['compose', ...args], { cwd: config.composeDir, encoding: 'utf8', timeout }));
  function ask(sql) {
    const result = compose(['exec', '-T', 'pixagram_haf', 'psql', '-U', 'haf_admin', '-d', 'haf_block_log', '-At', '-c', sql], 20_000);
    // No row, or a null, comes back as an empty line: that's "can't say", never block 0.
    const text = result.status === 0 ? String(result.stdout ?? '').trim() : '';
    return /^\d+$/.test(text) ? Number(text) : null;
  }
  function servicesNow() {
    const result = compose(['ps', '--all', '--format', '{{.Service}} {{.State}}'], 20_000);
    if (result.status !== 0) return null;
    const found = Object.fromEntries(result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split(' ')));
    return Object.fromEntries(config.services.map((service) => [service, found[service] ?? 'missing']));
  }
  async function read(now) {
    const head = await headOf(web, config.url);
    // Someone else's head is only needed to tell this node losing the chain from the chain resting.
    const other = config.other && (!head || now - head.time >= config.limits.staleMs) ? (await headOf(web, config.other))?.number ?? null : null;
    const context = "(select current_block_num from hafd.contexts where name = 'hivemind_app')";
    return {
      head,
      other,
      haf: ask('select max(num) from hafd.blocks'),
      // How far the index has really got: the lower of where HAF has it and what Hivemind says it has finished, or
      // HAF's word alone where this Hivemind keeps no such note.
      index: ask(`select least(${context}, (select last_completed_block_num from hivemind_app.hive_state))`) ?? ask(`select ${context}`),
      api: config.api && head ? await answersForIndex(web, config.api) : null,
      services: servicesNow(),
    };
  }
  function perform(action) {
    const grace = ['-t', String(config.stopSeconds)];
    const one = (config.stopSeconds + 120) * 1000;
    if (action.did === 'restart') return compose(['restart', ...grace, action.service], one).status === 0;
    if (action.did === 'up') return compose(['up', '-d'], one).status === 0;
    // Long enough for every container to be given its time to stop, one after another.
    if (compose(['up', '-d', '--force-recreate', ...grace], (config.stopSeconds * (config.services.length + 2) + 120) * 1000).status !== 0) return false;
    // The router resolved Hivemind's address as it started, perhaps before Hivemind had its new one, and would answer
    // 502 for it from then on: the stack's own README restarts it last after anything that recreates Hivemind.
    return !config.services.includes('jussi') || compose(['restart', ...grace, 'jussi'], one).status === 0;
  }
  return { read, perform };
}

/**
 * Sends one alert wherever the settings say, and says whether it got anywhere. Never throws: an alert that can't be
 * sent mustn't stop the watching.
 */
async function tell(config, event) {
  const words = say(event, config.name);
  const text = `${words.title}\n${words.body}`;
  let sent = false;
  if (config.webhook) {
    try {
      const response = await fetch(config.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text, title: words.title, body: words.body, node: config.name, event }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) sent = true;
      else console.error(`[node-watch] the webhook answered ${response.status}`);
    } catch (error) {
      console.error('[node-watch] the webhook couldn’t be reached', error?.message ?? error);
    }
  }
  if (config.command) {
    const result = spawnSync(config.command, {
      shell: true,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NODE_WATCH_TITLE: words.title, NODE_WATCH_BODY: words.body, NODE_WATCH_EVENT: JSON.stringify(event) },
    });
    if (result.status === 0) sent = true;
    else console.error(`[node-watch] the alert command failed${result.stderr ? `: ${result.stderr.trim().slice(0, 300)}` : ''}`);
  }
  return { words, sent };
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};
function writeJson(path, value) {
  writeFileSync(`${path}.new`, JSON.stringify(value), { mode: 0o644 });
  renameSync(`${path}.new`, path);
}

async function main(flags) {
  const config = settings();
  const dry = flags.includes('--dry');
  const now = Date.now();
  const { read, perform } = machine(config);
  const memoryPath = join(config.stateDir, 'memory.json');
  const log = (event) => appendFileSync(join(config.stateDir, 'log.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`, { mode: 0o644 });

  if (flags.includes('--test')) {
    const { words, sent } = await tell(config, { kind: 'test' });
    if (!config.webhook && !config.command) console.log('Nothing to send to: set NODE_WATCH_WEBHOOK or NODE_WATCH_COMMAND.');
    else if (sent) console.log(`sent: ${words.title}`);
    else process.exitCode = 1;
    return;
  }
  if (flags.includes('--drill')) {
    // The first remedy for a stuck index, done once for real on a healthy one. Nothing is remembered from it.
    const action = config.first['index-behind'];
    mkdirSync(config.stateDir, { recursive: true, mode: 0o755 });
    const event = { kind: 'action', problem: 'index-behind', ...action, ok: perform(action), drill: true };
    log(event);
    await tell(config, event);
    console.log(`drill: ${action.did} ${action.service}: ${event.ok ? 'done' : 'failed'}`);
    return;
  }

  const readings = await read(now);
  const decision = decide(readings, readJson(memoryPath), now, config.limits, config.first);
  if (dry) {
    console.log(JSON.stringify({ settings: { ...config, webhook: config.webhook ? 'set' : null, command: config.command ? 'set' : null, limits: undefined, first: undefined }, readings, status: decision.status, problem: decision.problem, action: decision.action, events: decision.events }, null, 2));
    return;
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o755 });
  writeJson(memoryPath, decision.memory);
  const events = [];
  if (decision.action) {
    const ok = perform(decision.action);
    events.push({ kind: 'action', problem: decision.memory.incident.problem, detail: decision.detail, ...decision.action, ok });
    console.log(`${decision.memory.incident.problem}: ${decision.action.did} ${decision.action.service ?? 'everything'}: ${ok ? 'done' : 'failed'}`);
  }
  for (const event of decision.events) {
    events.push(event);
    console.log(`${event.kind}: ${event.problem}`);
  }
  for (const event of events) log(event);
  writeJson(join(config.stateDir, 'state.json'), {
    checked: now,
    status: decision.status,
    problem: decision.problem,
    detail: decision.detail,
    readings: { head: readings.head?.number ?? null, headTime: readings.head?.time ?? null, haf: readings.haf, index: readings.index, api: readings.api },
    incident: decision.memory.incident,
    limits: { lag: config.limits.lag, confirm: config.limits.confirm, settleMs: config.limits.settleMs, dayActions: config.limits.dayActions },
  });
  for (const event of events) await tell(config, event);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[node-watch] failed', error?.message ?? error);
    process.exitCode = 1;
  });
}
