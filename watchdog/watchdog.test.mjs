import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIMITS, SERVICES, decide, machine, problemOf, say, settings } from './watchdog.mjs';

// The watchdog for a Pixa API node (watchdog.mjs): what it calls a problem, what it does about one, run by run, and
// what it says. It never touches a server here: readings are made up.

const T0 = Date.UTC(2026, 10, 12, 22);
const MIN = 60_000;
const running = Object.fromEntries(SERVICES.map((service) => [service, 'running']));
// A healthy minute: the head moves 20 blocks, and HAF and the index are at it.
const well = (minute) => ({ head: { number: 2_000_000 + minute * 20, time: T0 + minute * MIN - 2000 }, other: null, haf: 2_000_000 + minute * 20, index: 2_000_000 + minute * 20, services: running });
// The index stopped at block 2,000,000 while the chain went on.
const stuck = (minute) => ({ ...well(minute), index: 2_000_000 });

/** Runs a minute at a time, carrying the memory on, and returns each run's decision. */
function runs(readings, memory = null, from = 0, limits = LIMITS, first = undefined) {
  const out = [];
  readings.forEach((reading, i) => {
    const decision = decide(reading, memory, T0 + (from + i) * MIN, limits, first);
    memory = decision.memory;
    out.push(decision);
  });
  return out;
}

test('a node keeping up is well, and nothing is done or told', () => {
  for (const run of runs([0, 1, 2, 3, 4].map(well))) {
    assert.equal(run.status, 'well');
    assert.equal(run.action, null);
    assert.deepEqual(run.events, []);
  }
});

test('an index that has stopped is restarted once it has been seen three runs in a row, never sooner', () => {
  // It falls 60 blocks behind in the fourth minute.
  const all = runs([0, 1, 2, 3, 4, 5, 6].map((minute) => (minute < 1 ? well(minute) : stuck(minute))));
  assert.deepEqual(all.map((run) => run.status), ['well', 'well', 'well', 'watching', 'watching', 'acting', 'waiting']);
  assert.deepEqual(all[5].action, { did: 'restart', service: 'hivemind_sync' });
  assert.equal(all[5].problem, 'index-behind');
  assert.equal(all.filter((run) => run.action).length, 1);
});

test('a blip that clears before the third run is forgotten', () => {
  const all = runs([well(0), stuck(4), stuck(5), well(6), stuck(10), stuck(11), well(12)]);
  assert.ok(all.every((run) => run.action === null));
});

test('the restart is given five minutes, then the whole stack is made again, then a person is asked for, once', () => {
  const minutes = Array.from({ length: 22 }, (_, i) => i + 4);
  const all = runs(minutes.map(stuck), null, 4);
  const acted = all.map((run, i) => (run.action ? [minutes[i], run.action.did] : null)).filter(Boolean);
  assert.deepEqual(acted, [[6, 'restart'], [11, 'recreate']]);
  const gaveUp = all.flatMap((run, i) => run.events.filter((event) => event.kind === 'gave-up').map(() => minutes[i]));
  assert.deepEqual(gaveUp, [16]);
  assert.ok(all.slice(13).every((run) => run.status === 'needs-person' && run.action === null));
});

test('once it is well for two runs the incident is over, and says how many steps it took', () => {
  const all = runs([stuck(4), stuck(5), stuck(6), well(7), well(8), well(9)], null, 4);
  assert.deepEqual(all.map((run) => run.status), ['watching', 'watching', 'acting', 'waiting', 'well', 'well']);
  assert.deepEqual(all[4].events, [{ kind: 'recovered', problem: 'index-behind', began: T0 + 6 * MIN, steps: 1 }]);
  assert.equal(all[4].memory.incident, null);
  assert.deepEqual(all[5].events, []);
});

test('a part that is behind but gaining on the head is catching up, and is left alone', () => {
  // After a restart the index reads thousands of blocks a minute.
  const catching = (minute, index) => ({ ...well(minute), index });
  const all = runs([well(0), catching(1, 1_990_000), catching(2, 1_995_000), catching(3, 1_999_000), catching(4, 2_000_080)]);
  assert.deepEqual(all.map((run) => run.status), ['well', 'watching', 'catching-up', 'catching-up', 'well']);
  assert.ok(all.every((run) => run.action === null));
});

test('each problem has its own first remedy', () => {
  const now = T0 + 10 * MIN;
  const last = { at: now - MIN, head: 2_000_180, haf: 2_000_000, index: 2_000_000 };
  assert.deepEqual(problemOf({ ...well(10), services: { ...running, hivemind: 'exited' } }, last, now), { problem: 'down', detail: ['hivemind'] });
  assert.deepEqual(problemOf({ ...well(10), head: null }, last, now), { problem: 'unreachable' });
  assert.deepEqual(problemOf({ ...well(10), haf: 2_000_000 }, last, now), { problem: 'haf-behind' });
  assert.deepEqual(problemOf({ ...well(10), haf: null, index: null }, last, now), { problem: 'blind' });
  assert.deepEqual(problemOf({ ...well(10), api: false }, last, now), { problem: 'api-down' });
  const first = (reading, remedies) => runs([reading, reading, reading].map((one) => ({ ...one })), { last }, 10, LIMITS, remedies).at(-1).action;
  assert.deepEqual(first({ ...well(10), services: { ...running, hivemind: 'exited' } }), { did: 'up' });
  assert.deepEqual(first({ ...well(10), head: null }), { did: 'restart', service: 'pixagram' });
  assert.deepEqual(first({ ...well(10), haf: 2_000_000 }), { did: 'restart', service: 'pixagram_haf' });
  assert.deepEqual(first({ ...well(10), api: false }), { did: 'restart', service: 'jussi' });
  // Where the head is read through the router, a router that doesn't answer is what's restarted first.
  assert.deepEqual(first({ ...well(10), head: null }, settings({ NODE_WATCH_URL_SERVICE: 'jussi' }).first), { did: 'restart', service: 'jussi' });
});

test('a service that was added to the list counts, and one that is not in it does not', () => {
  const now = T0 + 10 * MIN;
  assert.deepEqual(problemOf({ ...well(10), services: { ...running, 'ssl-proxy': 'exited' } }, null, now), { problem: 'down', detail: ['ssl-proxy'] });
  assert.deepEqual(problemOf({ ...well(10), services: running }, null, now), { problem: 'well' });
  assert.deepEqual(problemOf({ ...well(10), services: null }, null, now), { problem: 'well' });
});

test('a router that stops answering for the index is only blamed once everything behind it is keeping up', () => {
  const now = T0 + 10 * MIN;
  // An index that's behind is the index's problem, whatever the router says.
  assert.deepEqual(problemOf({ ...stuck(10), api: false }, null, now), { problem: 'index-behind' });
  // A router nobody named is never asked, so it's never blamed.
  assert.deepEqual(problemOf({ ...well(10), api: null }, null, now), { problem: 'well' });
  const all = runs(Array.from({ length: 14 }, (_, i) => ({ ...well(i), api: false })));
  const acted = all.map((run, i) => (run.action ? [i, run.action.did, run.action.service ?? null] : null)).filter(Boolean);
  assert.deepEqual(acted, [[2, 'restart', 'jussi'], [7, 'recreate', null]]);
  assert.equal(all.at(-1).status, 'needs-person');
});

test('an index it cannot read is never called well, and after ten runs of that it asks for a person, once', () => {
  const now = T0 + 10 * MIN;
  assert.deepEqual(problemOf({ ...well(10), index: null }, null, now), { problem: 'blind' });
  assert.deepEqual(problemOf({ ...well(10), haf: null }, null, now), { problem: 'blind' });
  const all = runs([...Array.from({ length: 14 }, (_, i) => ({ ...well(i), haf: null, index: null })), well(14), well(15)]);
  assert.ok(all.every((run) => run.action === null));
  assert.deepEqual(all.slice(0, 9).map((run) => run.status), Array(9).fill('blind'));
  assert.deepEqual(all[9].events, [{ kind: 'gave-up', problem: 'blind', why: 'blind', steps: 0 }]);
  assert.ok(all.slice(10, 15).every((run) => run.status === 'needs-person' && run.events.length === 0));
  assert.deepEqual(all[15].events.map((event) => [event.kind, event.problem, event.steps]), [['recovered', 'blind', 0]]);
  // A blink of it is nothing.
  assert.ok(runs([well(0), { ...well(1), index: null }, well(2), { ...well(3), index: null }, well(4)]).every((run) => run.events.length === 0));
});

test('unless it has been allowed to make the whole stack again, it restarts the part and then asks for a person', () => {
  const { limits } = settings({});
  assert.equal(settings({ NODE_WATCH_RECREATE: '1' }).limits.steps, 2);
  const minutes = Array.from({ length: 16 }, (_, i) => i + 4);
  const all = runs(minutes.map(stuck), null, 4, limits);
  assert.deepEqual(all.map((run, i) => (run.action ? [minutes[i], run.action.did] : null)).filter(Boolean), [[6, 'restart']]);
  assert.deepEqual(all.flatMap((run, i) => run.events.map((event) => [minutes[i], event.kind, event.why, event.steps])), [[11, 'gave-up', 'tried', 1]]);
});

test('settings: an unchanged clone needs none, and each can be set', () => {
  const inside = settings({}, '/srv/pixagram-node/watchdog', (path) => path === '/srv/pixagram-node/docker-compose.yml');
  assert.equal(inside.composeDir, '/srv/pixagram-node');
  assert.equal(inside.url, 'http://127.0.0.1:7777');
  assert.equal(inside.urlService, 'pixagram');
  assert.deepEqual(inside.services, SERVICES);
  assert.equal(inside.stateDir, '/var/lib/pixa-node-watch');
  assert.deepEqual([inside.api, inside.other, inside.webhook, inside.command], [null, null, null, null]);
  assert.deepEqual([inside.recreate, inside.limits.steps], [false, 1]);
  assert.equal(inside.stopSeconds, 120);
  // The script beside its compose file, as ours is.
  assert.equal(settings({}, '/opt/node', (path) => path === '/opt/node/compose.yaml').composeDir, '/opt/node');
  const set = settings({
    NODE_WATCH_URL: 'http://127.0.0.1:8098', NODE_WATCH_URL_SERVICE: 'jussi', NODE_WATCH_API: 'http://127.0.0.1:8098', NODE_WATCH_OTHER: 'https://other.example',
    NODE_WATCH_SERVICES: 'pixagram, pixagram_haf,hivemind_sync,hivemind,jussi,ssl-proxy', NODE_WATCH_COMPOSE_DIR: '/x', NODE_WATCH_DIR: '/y', NODE_WATCH_NAME: 'api-1',
    NODE_WATCH_WEBHOOK: 'https://chat.example/hook', NODE_WATCH_COMMAND: 'mail', NODE_WATCH_STOP_SECONDS: '45', NODE_WATCH_RECREATE: '1',
  }, '/z', () => false);
  assert.deepEqual(set.services.slice(-2), ['jussi', 'ssl-proxy']);
  assert.deepEqual([set.url, set.urlService, set.api, set.other, set.composeDir, set.stateDir, set.name, set.webhook, set.command, set.stopSeconds, set.limits.steps],
    ['http://127.0.0.1:8098', 'jussi', 'http://127.0.0.1:8098', 'https://other.example', '/x', '/y', 'api-1', 'https://chat.example/hook', 'mail', 45, 2]);
  assert.deepEqual(set.first.unreachable, { did: 'restart', service: 'jussi' });
  // Docker's own ten seconds is the least a container is ever given.
  assert.equal(settings({ NODE_WATCH_STOP_SECONDS: '2' }, '/z', () => false).stopSeconds, 10);
});

test('every alert is a title and a sentence someone can act on', () => {
  const said = (event) => say(event, 'api-1');
  assert.deepEqual(said({ kind: 'action', problem: 'index-behind', did: 'restart', service: 'hivemind_sync', ok: true }), {
    title: 'api-1: the watchdog restarted hivemind_sync',
    body: 'The Hivemind index had stopped keeping up with the chain. It looks again in 5 minutes.',
  });
  assert.equal(said({ kind: 'action', problem: 'index-behind', did: 'recreate', ok: true }).title, 'api-1: the watchdog recreated the whole stack');
  assert.equal(said({ kind: 'action', problem: 'down', detail: ['hivemind'], did: 'up', ok: true }).body, 'A container had stopped running (hivemind). It looks again in 5 minutes.');
  assert.match(said({ kind: 'action', problem: 'api-down', did: 'restart', service: 'jussi', ok: false }).body, /tried to restart jussi, and Docker refused/);
  assert.match(said({ kind: 'action', problem: 'index-behind', did: 'restart', service: 'hivemind_sync', ok: true, drill: true }).title, /a drill, the watchdog restarted hivemind_sync/);
  assert.match(said({ kind: 'gave-up', problem: 'index-behind', why: 'tried', steps: 2 }).body, /what the watchdog tried didn’t fix it.*never resyncs or replays/);
  assert.match(said({ kind: 'gave-up', problem: 'index-behind', why: 'often', steps: 1 }).body, /six times in a day/);
  assert.match(said({ kind: 'gave-up', problem: 'blind', why: 'blind', steps: 0 }).body, /can’t tell whether they’re keeping up/);
  assert.equal(said({ kind: 'recovered', problem: 'index-behind', steps: 1 }).body, 'The Hivemind index had stopped keeping up with the chain. It took 1 step from the watchdog.');
  assert.match(said({ kind: 'recovered', problem: 'blind', steps: 0 }).body, /came back without the watchdog/);
  assert.match(said({ kind: 'test' }).title, /a test from the watchdog/);
  // Everything decide() can tell has words, and none of them is a blank.
  const events = [];
  for (const problem of ['down', 'unreachable', 'node-behind', 'haf-behind', 'index-behind', 'api-down', 'blind']) {
    for (const kind of ['action', 'gave-up', 'recovered']) events.push({ kind, problem, did: 'restart', service: 'x', why: 'tried', steps: 1, ok: true });
  }
  for (const event of events) {
    const { title, body } = said(event);
    assert.doesNotMatch(`${title} ${body}`, /undefined|null|Something was wrong/, JSON.stringify(event));
  }
});

test('an old head is this node only when another node is ahead: a resting chain is left alone', () => {
  const old = { ...well(0), head: { number: 2_000_000, time: T0 - 10 * MIN } };
  assert.deepEqual(problemOf({ ...old, other: 2_000_200 }, null, T0), { problem: 'node-behind' });
  assert.deepEqual(problemOf({ ...old, other: 2_000_001 }, null, T0), { problem: 'chain-quiet' });
  assert.deepEqual(problemOf({ ...old, other: null }, null, T0), { problem: 'chain-quiet' });
  const all = runs([0, 1, 2, 3].map(() => ({ ...old, other: null })));
  assert.ok(all.every((run) => run.status === 'chain-quiet' && run.action === null));
  assert.deepEqual(runs([0, 1, 2].map(() => ({ ...old, other: 2_000_200 }))).at(-1).action, { did: 'restart', service: 'pixagram' });
});

test('no more than six actions in a day: after that it asks for a person instead', () => {
  let memory = null;
  let minute = 0;
  let actions = 0;
  const told = [];
  // An index that sticks again and again, recovering after each restart.
  for (let round = 0; round < 9; round++) {
    for (const reading of [stuck, stuck, stuck, well, well]) {
      const decision = decide(reading(minute), memory, T0 + minute * MIN);
      memory = decision.memory;
      if (decision.action) actions += 1;
      told.push(...decision.events.map((event) => event.kind + (event.why ? `:${event.why}` : '')));
      minute += 1;
    }
  }
  assert.equal(actions, LIMITS.dayActions);
  assert.ok(told.includes('gave-up:often'));
});

// --- The reading and the doing, with Docker and the node stood in for ---------------------------------------------------

/** A stand-in for `docker compose`: answers psql and ps from what it's given, and keeps every command it was handed. */
function stack({ haf = '2000100', least = '2000100', context = '2000090', ps = SERVICES.map((service) => `${service} running`).join('\n'), fail = [] } = {}) {
  const ran = [];
  const run = (args) => {
    ran.push(args.join(' '));
    const line = args.join(' ');
    if (fail.some((part) => line.includes(part))) return { status: 1, stdout: '', stderr: 'no' };
    if (line.includes('max(num)')) return { status: haf === null ? 1 : 0, stdout: `${haf}\n` };
    if (line.includes('select least(')) return { status: least === null ? 1 : 0, stdout: `${least}\n` };
    if (line.includes('hafd.contexts')) return { status: context === null ? 1 : 0, stdout: `${context}\n` };
    if (args[0] === 'ps') return { status: 0, stdout: `${ps}\n` };
    return { status: 0, stdout: '' };
  };
  return { run, ran };
}
/** A stand-in for the node: answers each address with a head, or for the index, or not at all. */
const node = (answers) => async (url, request) => {
  const { method } = JSON.parse(request.body);
  const answer = answers[url]?.[method];
  if (answer === undefined) throw new Error('unreachable');
  return { json: async () => ({ result: answer }) };
};
const head = (number, at) => ({ head_block_number: number, time: new Date(at).toISOString().slice(0, 19) });

test('it reads the head, HAF, the index and each service, and asks the router only where one was named', async () => {
  const config = settings({ NODE_WATCH_API: 'http://router', NODE_WATCH_OTHER: 'http://other' }, '/z', () => false);
  const { run, ran } = stack();
  const ask = node({ 'http://127.0.0.1:7777': { 'condenser_api.get_dynamic_global_properties': head(2_000_100, T0) }, 'http://router': { 'condenser_api.get_follow_count': { account: 'null', follower_count: 0, following_count: 0 } } });
  const readings = await machine(config, { run, ask }).read(T0 + 2000);
  assert.deepEqual(readings, { head: { number: 2_000_100, time: T0 }, other: null, haf: 2_000_100, index: 2_000_100, api: true, services: Object.fromEntries(SERVICES.map((service) => [service, 'running'])) });
  // Reading changes nothing: every command is a question.
  assert.ok(ran.every((line) => line.startsWith('exec -T pixagram_haf psql -U haf_admin -d haf_block_log -At -c select ') || line.startsWith('ps ')), ran.join(' / '));
  // Nobody named a router: it isn't asked, and it isn't blamed.
  assert.equal((await machine(settings({}, '/z', () => false), { run, ask }).read(T0 + 2000)).api, null);
});

test('a Hivemind with no note of its own is read from HAF’s; one that can’t be read at all is nothing, never a number', async () => {
  const ask = node({ 'http://127.0.0.1:7777': { 'condenser_api.get_dynamic_global_properties': head(2_000_100, T0) } });
  const config = settings({}, '/z', () => false);
  assert.equal((await machine(config, { ...stack({ least: null }), ask }).read(T0)).index, 2_000_090);
  const none = await machine(config, { ...stack({ least: null, context: null, haf: null }), ask }).read(T0);
  assert.deepEqual([none.haf, none.index], [null, null]);
  assert.equal(problemOf(none, null, T0).problem, 'blind');
  // An empty answer isn't block 0.
  assert.equal((await machine(config, { ...stack({ least: '', context: '' }), ask }).read(T0)).index, null);
});

test('a service with no container is missing, a router that errors is not answering, and a silent node has no head', async () => {
  const config = settings({ NODE_WATCH_API: 'http://router', NODE_WATCH_OTHER: 'http://other', NODE_WATCH_SERVICES: [...SERVICES, 'ssl-proxy'].join(',') }, '/z', () => false);
  const up = { 'http://127.0.0.1:7777': { 'condenser_api.get_dynamic_global_properties': head(2_000_100, T0) } };
  const one = await machine(config, { ...stack({ ps: 'pixagram running\npixagram_haf running\nhivemind_sync exited\nhivemind running\njussi restarting' }), ask: node(up) }).read(T0);
  assert.deepEqual(one.services, { pixagram: 'running', pixagram_haf: 'running', hivemind_sync: 'exited', hivemind: 'running', jussi: 'restarting', 'ssl-proxy': 'missing' });
  assert.equal(one.api, false);
  assert.deepEqual(problemOf(one, null, T0), { problem: 'down', detail: ['hivemind_sync', 'jussi', 'ssl-proxy'] });
  // Silent: the other node is asked, so a lost node can be told from a resting chain.
  const silent = await machine(config, { ...stack(), ask: node({ 'http://other': { 'condenser_api.get_dynamic_global_properties': head(2_000_300, T0) } }) }).read(T0);
  assert.deepEqual([silent.head, silent.other, silent.api], [null, 2_000_300, null]);
});

test('what it does is one of three commands, each given time to stop cleanly, and a recreated stack has its router restarted last', () => {
  const config = settings({ NODE_WATCH_STOP_SECONDS: '90' }, '/z', () => false);
  const did = (action, more) => {
    const { run, ran } = stack(more);
    return [machine(config, { run }).perform(action), ran];
  };
  assert.deepEqual(did({ did: 'restart', service: 'hivemind_sync' }), [true, ['restart -t 90 hivemind_sync']]);
  assert.deepEqual(did({ did: 'up' }), [true, ['up -d']]);
  assert.deepEqual(did({ did: 'recreate' }), [true, ['up -d --force-recreate -t 90', 'restart -t 90 jussi']]);
  // Docker refusing is said, and a stack that wasn't made again doesn't have its router restarted.
  assert.deepEqual(did({ did: 'restart', service: 'hivemind_sync' }, { fail: ['restart'] }), [false, ['restart -t 90 hivemind_sync']]);
  assert.deepEqual(did({ did: 'recreate' }, { fail: ['--force-recreate'] }), [false, ['up -d --force-recreate -t 90']]);
  // Nothing it can be asked to do removes, replays or resyncs anything.
  for (const action of [{ did: 'restart', service: 'pixagram_haf' }, { did: 'up' }, { did: 'recreate' }]) {
    for (const line of did(action)[1]) assert.doesNotMatch(line, /\b(down|rm|kill|prune|replay|volume|exec)\b/, line);
  }
});
