// Drives the real parallel-dialer engine against a fake Azure client and a
// clock the test controls, so every timing rule - the 15-second fairness line,
// the ring timeout, the abandon message - can be exercised exactly.
const path = require('path');
const {
    createParallelDialer,
    describeAzureError,
    labelForFailure,
    phoneOf,
    userOf,
    samePhone,
    MAX_LINES,
    FAIR_RING_SECONDS,
    DEFAULT_RING_TIMEOUT_SECONDS,
    SKIP_VOICEMAIL_RING_TIMEOUT_SECONDS,
    IDLE_SESSION_MS,
    abandonListenMs,
} = require(path.join(__dirname, '..', 'lib', 'parallel-dialer.js'));

// ─── A controllable clock ───────────────────────────────────────────────────

let clock = 0;
let timers = [];
let timerId = 0;

const now = () => clock;
const schedule = (fn, ms) => {
    timerId += 1;
    timers.push({ id: timerId, at: clock + ms, fn });
    return timerId;
};
const cancelScheduled = (id) => {
    timers = timers.filter((t) => t.id !== id);
};
const advance = async (ms) => {
    const target = clock + ms;
    for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock = due.at;
        await due.fn();
        await new Promise((resolve) => setImmediate(resolve));
    }
    clock = target;
};

// ─── A fake Azure client that records everything asked of it ────────────────

let calls = [];
let options = {};

const fakeClient = {
    createCall: async (target, url, opts) => {
        calls.push({ op: 'createCall', target, url, opts });
        if (options.createFails) throw new Error('agent unreachable');
        // Real Azure returns no serverCallId at creation; tests opt into that.
        return {
            callConnectionProperties: {
                callConnectionId: 'conn-1',
                serverCallId: options.noServerCallIdAtCreate ? '' : 'server-1',
            },
        };
    },
    getCallConnection: () => ({
        addParticipant: async (invite, opts) => {
            const phone = invite.targetParticipant.phoneNumber;
            calls.push({ op: 'add', phone, callerId: invite.sourceCallIdNumber.phoneNumber, opts });
            if ((options.addFails || []).includes(phone)) throw new Error('invite refused');
            return { invitationId: `inv-${phone}` };
        },
        cancelAddParticipantOperation: async (invitationId) => {
            calls.push({ op: 'cancel', invitationId });
        },
        removeParticipant: async (participant) => {
            calls.push({ op: 'remove', phone: participant.phoneNumber });
        },
        hangUp: async (forEveryone) => {
            calls.push({ op: 'hangUp', forEveryone });
        },
        getCallConnectionProperties: async () => ({ serverCallId: options.propertiesServerCallId || '' }),
        getCallMedia: () => ({
            play: async (sources, playTo, opts) => {
                calls.push({ op: 'play', sources, playTo, opts });
                if (options.playFails) throw new Error('play refused');
            },
            hold: async (participant, opts) => {
                calls.push({ op: 'hold', phone: participant.phoneNumber, opts });
                if (options.holdFails) throw new Error('hold refused');
            },
            startRecognizing: async (participant, opts) => {
                calls.push({ op: 'recognize', phone: participant.phoneNumber, opts });
            },
            cancelAllOperations: async () => {
                calls.push({ op: 'cancelAll' });
            },
        }),
    }),
};

const opsOf = (op) => calls.filter((c) => c.op === op);

const make = (over = {}) =>
    createParallelDialer({
        client: fakeClient,
        callbackBaseUrl: 'https://calls.example.com',
        cognitiveServicesEndpoint: 'https://speech.example.com/',
        now,
        schedule,
        cancelScheduled,
        log: () => {},
        ...over,
    });

const AGENT = '8:acs:agent-1';
const startArgs = (over = {}) => ({
    organizationId: 'org-1',
    userEmail: 'agent@example.com',
    agentUserId: AGENT,
    callerId: '+15550000000',
    lines: 3,
    abandonMessage: 'Hi, this is Acme. Sorry we missed you. Please call us back.',
    ...over,
});

const lead = (n, over = {}) => ({ leadId: `lead-${n}`, name: `Lead ${n}`, phoneNumber: `+1555100000${n}`, ...over });

// Events, in the shape Azure sends them.
const ev = (type, data) => ({ type: `Microsoft.Communication.${type}`, data: { callConnectionId: 'conn-1', ...data } });
const answered = (sessionId, leg) =>
    ev('AddParticipantSucceeded', {
        operationContext: `pd-leg:${sessionId}:${leg.legId}`,
        participant: { rawId: `4:${leg.phoneNumber}`, phoneNumber: { value: leg.phoneNumber } },
    });
const roster = (...phones) =>
    ev('ParticipantsUpdated', {
        participants: [
            { identifier: { rawId: AGENT, communicationUser: { id: AGENT } } },
            ...phones.map((p) => ({ identifier: { rawId: `4:${p}`, phoneNumber: { value: p } } })),
        ],
    });

const reset = () => {
    clock = 1_000_000;
    timers = [];
    calls = [];
    options = {};
};

/** A connected, ready session. */
async function readySession(dialer, over = {}) {
    const s = await dialer.startSession(startArgs(over));
    await dialer.handleEvent(ev('CallConnected', { operationContext: `pd-session:${s.sessionId}` }));
    return s.sessionId;
}

const legByPhone = (snap, phone) => snap.legs.find((l) => l.phoneNumber === phone);

// ─── Harness ────────────────────────────────────────────────────────────────

const results = [];
const check = (name, cond, detail) => results.push({ name, pass: Boolean(cond), detail });
const rejects = async (promise) => {
    try {
        await promise;
        return null;
    } catch (error) {
        return error;
    }
};

(async () => {
    // ════ starting a session ═════════════════════════════════════════════
    reset();
    let err = await rejects(make({ client: null }).startSession(startArgs()));
    check('no Call Automation client is a 503', err && err.status === 503, err && err.code);

    err = await rejects(make({ cognitiveServicesEndpoint: '' }).startSession(startArgs()));
    check('no speech services refuses to start', err && err.code === 'SPEECH_NOT_CONFIGURED', err && err.code);
    check('and says which setting is missing', err && /COGNITIVE_SERVICE_ENDPOINT/.test(err.message));

    err = await rejects(make({ callbackBaseUrl: 'http://localhost' }).startSession(startArgs()));
    check('a non-public callback url is refused', err && err.code === 'CALLBACK_URL_NOT_CONFIGURED', err && err.code);

    err = await rejects(make().startSession(startArgs({ agentUserId: 'nonsense' })));
    check('an invalid agent identity is refused', err && err.status === 400, err && err.code);

    err = await rejects(make().startSession(startArgs({ callerId: '' })));
    check('a caller id is required', err && err.code === 'MISSING_CALLER_ID', err && err.code);

    err = await rejects(make().startSession(startArgs({ abandonMessage: '   ' })));
    check('an abandon message is required', err && err.code === 'MISSING_ABANDON_MESSAGE', err && err.code);

    reset();
    let dialer = make();
    let snap = await dialer.startSession(startArgs({ lines: 10 }));
    check('lines are capped at the maximum', snap.lines === MAX_LINES, snap.lines);
    check('the session starts by ringing the agent', opsOf('createCall')[0].target.targetParticipant.communicationUserId === AGENT);
    check('events come back to the parallel callback', /\/parallel\/callbacks\?session=/.test(opsOf('createCall')[0].url), opsOf('createCall')[0].url);
    check('speech services are attached to the call', Boolean(opsOf('createCall')[0].opts.callIntelligenceOptions.cognitiveServicesEndpoint));
    check('the session waits for the agent to pick up', snap.state === 'connecting', snap.state);

    reset();
    snap = await make().startSession(startArgs({ lines: 0 }));
    check('a missing line count falls back to the default', snap.lines === 2, snap.lines);

    reset();
    snap = await make().startSession(startArgs({ voicemailMode: 'skip' }));
    check('skipping voicemails shortens the ring', snap.ringTimeoutSeconds === SKIP_VOICEMAIL_RING_TIMEOUT_SECONDS, snap.ringTimeoutSeconds);
    check('and still gives every line a fair ring', SKIP_VOICEMAIL_RING_TIMEOUT_SECONDS > FAIR_RING_SECONDS);

    reset();
    options.createFails = true;
    err = await rejects(make().startSession(startArgs()));
    check('an unreachable agent is reported', err && err.code === 'SESSION_CALL_FAILED', err && err.code);

    // ════ the callback address must lead back here ═══════════════════════
    //
    // The failure seen live: the browser was rung and joined, but Azure sent
    // the session's events to a different server, so the session waited for a
    // "connected" that never came. Now it is refused before anything rings.
    reset();
    err = await rejects(
        make({ verifyCallbackUrl: async () => ({ ok: false, reason: 'the server there answered 404' }) }).startSession(startArgs())
    );
    check('a callback address that leads elsewhere is refused', err && err.code === 'CALLBACK_URL_MISMATCH', err && err.code);
    check('the message names the address', err && err.message.includes('https://calls.example.com'), err && err.message);
    check('and the reason', err && /answered 404/.test(err.message), err && err.message);
    check('and says how to fix it', err && /CALLBACK_BASE_URL/.test(err.message));
    check('nothing is rung when the check fails', opsOf('createCall').length === 0, opsOf('createCall'));

    reset();
    err = await rejects(make({ verifyCallbackUrl: async () => null }).startSession(startArgs()));
    check('a check that returns nothing counts as a failure', err && err.code === 'CALLBACK_URL_MISMATCH', err && err.code);

    reset();
    snap = await make({ verifyCallbackUrl: async () => ({ ok: true }) }).startSession(startArgs());
    check('a callback address that leads back here proceeds', snap.state === 'connecting' && opsOf('createCall').length === 1);

    // Azure refusing to ring the agent at all.
    reset();
    dialer = make();
    snap = await dialer.startSession(startArgs());
    await dialer.handleEvent(
        ev('CreateCallFailed', { operationContext: `pd-session:${snap.sessionId}`, resultInformation: { code: 403, message: 'Forbidden' } })
    );
    snap = dialer.getSession(snap.sessionId);
    check('Azure failing to ring the agent fails the session', snap.state === 'failed', snap.state);
    check("with Azure's own reason", /Forbidden/.test(snap.error), snap.error);

    // ════ settings typed with quotes ════════════════════════════════════
    // Azure App Service keeps the quotes a local .env drops; Azure then
    // refuses the endpoint with a bare "Invalid request".
    reset();
    err = await rejects(make({ cognitiveServicesEndpoint: '"https://speech.example.com/"' }).startSession(startArgs()));
    check('a quoted speech endpoint is caught before Azure sees it', err && err.code === 'SPEECH_ENDPOINT_INVALID', err && err.code);
    check('and the message says to look for quotes', err && /quote/i.test(err.message), err && err.message);
    check('nothing is rung with a malformed endpoint', opsOf('createCall').length === 0);

    reset();
    err = await rejects(make({ cognitiveServicesEndpoint: 'https://speech.example.com/ extra' }).startSession(startArgs()));
    check('an endpoint with a space in it is refused', err && err.code === 'SPEECH_ENDPOINT_INVALID', err && err.code);

    reset();
    err = await rejects(make({ cognitiveServicesEndpoint: 'speech.example.com' }).startSession(startArgs()));
    check('an endpoint without https is refused', err && err.code === 'SPEECH_ENDPOINT_INVALID', err && err.code);

    // Azure's refusals are reported in full.
    const refusal = Object.assign(new Error('Invalid request'), { statusCode: 400, details: { message: 'cognitiveServicesEndpoint is not valid' } });
    const described = describeAzureError(refusal);
    check('a refusal carries its status code', described.startsWith('400 '), described);
    check("and Azure's detailed reason", described.includes('cognitiveServicesEndpoint is not valid'), described);
    check('and a hint about the usual cause', /no quotes or spaces/.test(described), described);
    check('a refusal with no detail still reads cleanly', describeAzureError(new Error('Boom')) === 'Boom', describeAzureError(new Error('Boom')));
    check('nothing at all still produces a message', describeAzureError(undefined) === 'unknown error');

    // ════ the serverCallId recording needs ══════════════════════════════
    // Seen live: Azure returns no serverCallId when the call is created, so it
    // stayed empty and no lead was ever recorded.
    reset();
    options.noServerCallIdAtCreate = true;
    dialer = make();
    snap = await dialer.startSession(startArgs());
    check('at creation, like real Azure, there is no serverCallId yet', snap.serverCallId === '', snap.serverCallId);
    await dialer.handleEvent(ev('CallConnected', { operationContext: `pd-session:${snap.sessionId}`, serverCallId: 'srv-from-event' }));
    check('it is taken from the first event that carries it', dialer.getSession(snap.sessionId).serverCallId === 'srv-from-event');

    reset();
    options.noServerCallIdAtCreate = true;
    options.propertiesServerCallId = 'srv-from-properties';
    dialer = make();
    snap = await dialer.startSession(startArgs());
    await dialer.handleEvent(ev('CallConnected', { operationContext: `pd-session:${snap.sessionId}` }));
    check('if no event carries it, Azure is asked for it on connect', dialer.getSession(snap.sessionId).serverCallId === 'srv-from-properties');

    reset();
    options.noServerCallIdAtCreate = true;
    dialer = make();
    snap = await dialer.startSession(startArgs());
    await dialer.handleEvent(ev('CallConnected', { operationContext: `pd-session:${snap.sessionId}`, serverCallId: 'first' }));
    await dialer.handleEvent(ev('ParticipantsUpdated', { serverCallId: 'something-else', participants: [] }));
    check('once known, it is not overwritten', dialer.getSession(snap.sessionId).serverCallId === 'first');

    // ════ the agent picks up ═════════════════════════════════════════════
    reset();
    dialer = make();
    snap = await dialer.startSession(startArgs());
    err = await rejects(dialer.startRound(snap.sessionId, [lead(1)]));
    check('nothing dials before the agent has picked up', err && err.code === 'SESSION_NOT_READY', err && err.code);

    await dialer.handleEvent(ev('CallConnected', { operationContext: `pd-session:${snap.sessionId}` }));
    check('the agent answering makes the session ready', dialer.getSession(snap.sessionId).state === 'ready');

    // ════ a round ════════════════════════════════════════════════════════
    reset();
    dialer = make();
    let sid = await readySession(dialer, { lines: 2 });

    err = await rejects(dialer.startRound(sid, [lead(1), lead(2), lead(3)]));
    check('more leads than lines is refused', err && err.code === 'TOO_MANY_LEADS', err && err.code);

    err = await rejects(dialer.startRound(sid, [lead(1), lead(1)]));
    check('the same number twice in a round is refused', err && err.code === 'DUPLICATE_NUMBER', err && err.code);

    err = await rejects(dialer.startRound(sid, []));
    check('an empty round is refused', err && err.code === 'NO_LEADS', err && err.code);

    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    check('every lead in the round is rung at once', opsOf('add').length === 2, opsOf('add').length);
    check('from the organization number', opsOf('add').every((c) => c.callerId === '+15550000000'));
    check('each invite is tagged with its leg', opsOf('add').every((c) => c.opts.operationContext.startsWith(`pd-leg:${sid}:`)));
    check('our timer ends the round, not Azure', opsOf('add')[0].opts.invitationTimeoutInSeconds > DEFAULT_RING_TIMEOUT_SECONDS);
    check('both legs are ringing', snap.legs.every((l) => l.state === 'ringing'));

    // ════ first answer wins, others cancelled straight away ══════════════
    await advance(4000);
    let winner = legByPhone(snap, lead(1).phoneNumber);
    await dialer.handleEvent(answered(sid, winner));
    snap = dialer.getSession(sid);

    check('the first to answer is connected to the agent', legByPhone(snap, lead(1).phoneNumber).state === 'connected');
    check('and is the round winner', snap.round.winnerLegId === winner.legId);
    check('the other line is cancelled at once', opsOf('cancel').some((c) => c.invitationId === `inv-${lead(2).phoneNumber}`), opsOf('cancel'));
    check('a line cut off after 4s is labelled cancelled, not unanswered', legByPhone(snap, lead(2).phoneNumber).state === 'cancelled');
    check('and is eligible for one more try', legByPhone(snap, lead(2).phoneNumber).retryEligible === true);
    check('the ring time is recorded', legByPhone(snap, lead(1).phoneNumber).ringSeconds === 4, legByPhone(snap, lead(1).phoneNumber).ringSeconds);
    check('voicemail detection listens to the lead only', opsOf('recognize').length === 1 && opsOf('recognize')[0].phone === lead(1).phoneNumber);
    check('with whole-second timeouts', Number.isInteger(opsOf('recognize')[0].opts.initialSilenceTimeoutInSeconds));

    err = await rejects(dialer.startRound(sid, [lead(3)]));
    check('no new round while somebody is on the line', err && err.code === 'ROUND_IN_PROGRESS', err && err.code);

    // A repeat of the winning answer must not hang up on the person talking.
    const holdsBefore = opsOf('hold').length;
    await dialer.handleEvent(answered(sid, winner));
    snap = dialer.getSession(sid);
    check('a duplicate answer event changes nothing', legByPhone(snap, lead(1).phoneNumber).state === 'connected');
    check('and never puts the person talking on hold', opsOf('hold').length === holdsBefore, opsOf('hold'));

    // ════ the agent finishes and moves on ════════════════════════════════
    await advance(30000);
    snap = await dialer.endLead(sid, winner.legId);
    check('ending the lead removes them from the call', opsOf('remove').some((c) => c.phone === lead(1).phoneNumber));
    check('the lead is marked ended', legByPhone(snap, lead(1).phoneNumber).state === 'ended');
    check('with their talk time', legByPhone(snap, lead(1).phoneNumber).talkSeconds === 30, legByPhone(snap, lead(1).phoneNumber).talkSeconds);
    check('the session stays open', snap.state === 'ready');
    check('the session call itself is never hung up', opsOf('hangUp').length === 0);
    check('the round is settled', snap.round.state === 'settled');

    snap = await dialer.startRound(sid, [lead(3)]);
    check('the next round can start', snap.round.state === 'ringing');

    // ════ a late answer is a fair attempt ════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await advance(22000);
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(1).phoneNumber)));
    snap = dialer.getSession(sid);
    check('a line that rang 22s before being cancelled is unanswered', legByPhone(snap, lead(2).phoneNumber).state === 'no_answer');
    check('and is not retried', legByPhone(snap, lead(2).phoneNumber).retryEligible === false);

    // ════ two people answer at once ══════════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 3 });
    snap = await dialer.startRound(sid, [lead(1), lead(2), lead(3)]);
    await advance(3000);
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(1).phoneNumber)));
    // Lead 2's cancel lost the race - it answered anyway.
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(2).phoneNumber)));
    snap = dialer.getSession(sid);

    check('the second person to answer is abandoned', legByPhone(snap, lead(2).phoneNumber).state === 'abandoned');
    check('the first stays with the agent', legByPhone(snap, lead(1).phoneNumber).state === 'connected');
    check('the abandoned person is put on hold', opsOf('hold').some((c) => c.phone === lead(2).phoneNumber), opsOf('hold'));
    check(
        'and hears the organization message as they wait',
        opsOf('hold')[0].opts.playSource.kind === 'textSource' && /Acme/.test(opsOf('hold')[0].opts.playSource.text)
    );
    check('nobody else is put on hold', opsOf('hold').every((c) => c.phone === lead(2).phoneNumber));
    check('nothing is played to the whole call', opsOf('play').length === 0, opsOf('play'));

    await advance(abandonListenMs(startArgs().abandonMessage) + 100);
    snap = dialer.getSession(sid);
    check('the abandoned person is let go once the message has played', opsOf('remove').some((c) => c.phone === lead(2).phoneNumber));
    check('and stays recorded as abandoned', legByPhone(snap, lead(2).phoneNumber).state === 'abandoned' && Boolean(legByPhone(snap, lead(2).phoneNumber).endedAt));
    check('the conversation is untouched', legByPhone(snap, lead(1).phoneNumber).state === 'connected');

    // Hold refused: they still hear the message rather than silence.
    reset();
    options.holdFails = true;
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(1).phoneNumber)));
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(2).phoneNumber)));
    check('if hold is refused the message is played to them alone', opsOf('play').length === 1 && opsOf('play')[0].playTo[0].phoneNumber === lead(2).phoneNumber, opsOf('play'));

    // Nothing works at all: removed, never left in silence on the line.
    reset();
    options.holdFails = true;
    options.playFails = true;
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(1).phoneNumber)));
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(2).phoneNumber)));
    check('if no message can be played they are released, not held in silence', opsOf('remove').some((c) => c.phone === lead(2).phoneNumber));

    // A late answer on a leg from a round already given up on.
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await advance(DEFAULT_RING_TIMEOUT_SECONDS * 1000 + 10);
    await dialer.handleEvent(answered(sid, legByPhone(snap, lead(1).phoneNumber)));
    snap = dialer.getSession(sid);
    check('an answer after we gave up is abandoned, not connected', legByPhone(snap, lead(1).phoneNumber).state === 'abandoned');
    check('so the agent is never surprised by a stray caller', !snap.round.winnerLegId);

    // ════ nobody answers ═════════════════════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await advance(DEFAULT_RING_TIMEOUT_SECONDS * 1000 - 1000);
    check('lines keep ringing until the timeout', dialer.getSession(sid).legs.every((l) => l.state === 'ringing'));
    await advance(1500);
    snap = dialer.getSession(sid);
    check('at the timeout every line is cancelled', opsOf('cancel').length === 2, opsOf('cancel'));
    check('and marked unanswered', snap.legs.every((l) => l.state === 'no_answer'));
    check('none of them is retried', snap.legs.every((l) => !l.retryEligible));
    check('the round settles so the next can start', snap.round.state === 'settled');

    // ════ Azure reports a failure ════════════════════════════════════════
    check('486 reads as busy', labelForFailure({ code: 486 }) === 'busy');
    check('603 reads as busy / declined', labelForFailure({ code: 603 }) === 'busy');
    check('408 reads as unanswered', labelForFailure({ code: 408 }) === 'no_answer');
    check('404 reads as a bad number', labelForFailure({ code: 404 }) === 'failed');
    check('an unknown failure reads as unanswered', labelForFailure({ code: 999 }) === 'no_answer');
    check('no detail at all reads as unanswered', labelForFailure(undefined) === 'no_answer');

    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await dialer.handleEvent(
        ev('AddParticipantFailed', {
            operationContext: `pd-leg:${sid}:${legByPhone(snap, lead(1).phoneNumber).legId}`,
            resultInformation: { code: 486, message: 'Busy here' },
        })
    );
    snap = dialer.getSession(sid);
    check('a busy line is recorded as busy', legByPhone(snap, lead(1).phoneNumber).state === 'busy');
    check('the rest of the round keeps ringing', legByPhone(snap, lead(2).phoneNumber).state === 'ringing');

    reset();
    options.addFails = [lead(1).phoneNumber];
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    check('an invite Azure refuses is marked failed', legByPhone(snap, lead(1).phoneNumber).state === 'failed');
    check('without stopping the others', legByPhone(snap, lead(2).phoneNumber).state === 'ringing');

    reset();
    options.addFails = [lead(1).phoneNumber, lead(2).phoneNumber];
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    check('a round where every invite failed settles immediately', snap.round.state === 'settled');

    // ════ voicemail detection ════════════════════════════════════════════
    const detection = async (speech, { answerAfter = 3000, silence = false } = {}) => {
        reset();
        const d = make();
        const id = await readySession(d, { lines: 1 });
        let s = await d.startRound(id, [lead(1)]);
        const leg = s.legs[0];
        await advance(answerAfter);
        await d.handleEvent(answered(id, leg));
        await advance(2000);
        await d.handleEvent(
            silence
                ? ev('RecognizeFailed', { operationContext: `pd-amd:${id}:${leg.legId}`, resultInformation: { subCode: 8510 } })
                : ev('RecognizeCompleted', {
                      operationContext: `pd-amd:${id}:${leg.legId}`,
                      speechResult: { speech, confidence: 0.9 },
                  })
        );
        return d.getSession(id).legs[0];
    };

    let leg = await detection('Hi you have reached John please leave a message after the tone');
    check('a voicemail phrase is a confident verdict', leg.amd.verdict === 'voicemail', leg.amd);
    check('the greeting is kept for tuning', /leave a message/.test(leg.amd.greeting));
    check('the lead stays on the line until the agent acts', leg.state === 'connected');

    leg = await detection('hi its dave you know what to do', { answerAfter: 3000 });
    check('a long greeting with no phrase is only a suggestion', ['voicemail_suggested', 'human'].includes(leg.amd.verdict), leg.amd);

    leg = await detection('Hello?');
    check('a short hello is a person', leg.amd.verdict === 'human', leg.amd);

    leg = await detection('', { silence: true });
    check('silence on answering is read as a person', leg.amd.verdict === 'human', leg.amd);

    leg = await detection('Hello?', { answerAfter: 24000 });
    check('a late answer is flagged as possible voicemail', leg.amd.verdict === 'voicemail_suggested', leg.amd);
    check('and explains why', /typical of voicemail/.test(leg.amd.reason), leg.amd.reason);

    leg = await detection('The number you have dialed has been disconnected');
    check('a dead number is recognised', leg.amd.verdict === 'dead_number', leg.amd);
    check('and the lead is removed and marked failed', leg.state === 'failed', leg.state);

    // ════ leaving a voicemail ════════════════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 1 });
    snap = await dialer.startRound(sid, [lead(1)]);
    winner = snap.legs[0];

    err = await rejects(dialer.dropVoicemail(sid, winner.legId, { voicemailUrl: 'https://x/vm.mp3' }));
    check('a voicemail cannot be left on a lead not yet connected', err && err.code === 'LEAD_NOT_CONNECTED', err && err.code);

    await dialer.handleEvent(answered(sid, winner));

    err = await rejects(dialer.dropVoicemail(sid, winner.legId, { voicemailUrl: 'http://insecure/vm.mp3' }));
    check('the recording must be a public https url', err && err.code === 'INVALID_VOICEMAIL_URL', err && err.code);

    snap = await dialer.dropVoicemail(sid, winner.legId, { voicemailUrl: 'https://cdn/vm.mp3', voicemailId: 'vm-1' });
    check('detection is stopped first, so the two do not collide', opsOf('cancelAll').length === 1);
    check('the message plays to the lead alone', opsOf('play')[0].playTo.length === 1 && opsOf('play')[0].playTo[0].phoneNumber === lead(1).phoneNumber);
    check('using the agent recording', opsOf('play')[0].sources[0].url === 'https://cdn/vm.mp3');
    check('the call is not ended for everyone afterwards', opsOf('hangUp').length === 0);

    await dialer.handleEvent(ev('PlayCompleted', { operationContext: `pd-vm:${sid}:${winner.legId}` }));
    snap = dialer.getSession(sid);
    check('once played the lead is removed', opsOf('remove').some((c) => c.phone === lead(1).phoneNumber));
    check('and recorded as voicemail', snap.legs[0].state === 'voicemail', snap.legs[0].state);
    check('the agent session carries on', snap.state === 'ready');

    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 1 });
    snap = await dialer.startRound(sid, [lead(1)]);
    winner = snap.legs[0];
    await dialer.handleEvent(answered(sid, winner));
    await dialer.dropVoicemail(sid, winner.legId, { voicemailUrl: 'https://cdn/vm.mp3' });
    await dialer.handleEvent(ev('PlayFailed', { operationContext: `pd-vm:${sid}:${winner.legId}` }));
    snap = dialer.getSession(sid);
    check('a failed voicemail leaves the lead connected', snap.legs[0].state === 'connected');
    check('and says so', snap.legs[0].voicemail.state === 'failed');

    // ════ the lead hangs up ══════════════════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 1 });
    snap = await dialer.startRound(sid, [lead(1)]);
    winner = snap.legs[0];

    // An update that arrives before the answer must not end the lead.
    await dialer.handleEvent(roster());
    await dialer.handleEvent(answered(sid, winner));
    await dialer.handleEvent(roster());
    check('an out-of-order update does not end a lead still joining', dialer.getSession(sid).legs[0].state === 'connected');

    await dialer.handleEvent(roster(lead(1).phoneNumber));
    await advance(12000);
    await dialer.handleEvent(roster());
    snap = dialer.getSession(sid);
    check('a lead who hangs up is marked ended', snap.legs[0].state === 'ended');
    check('with the time they were on the line', snap.legs[0].talkSeconds === 12, snap.legs[0].talkSeconds);
    check('and the session moves on', snap.round.state === 'settled');

    // ════ the agent goes away ════════════════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await dialer.handleEvent(roster());
    await dialer.handleEvent(
        ev('ParticipantsUpdated', { participants: [] })
    );
    snap = dialer.getSession(sid);
    check('the agent leaving ends the session', snap.state === 'ended');
    check('ringing lines are cancelled so nobody answers into an empty call', opsOf('cancel').length === 2, opsOf('cancel'));
    check('and the call is closed', opsOf('hangUp').some((c) => c.forEveryone === true));

    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 1 });
    await dialer.handleEvent(ev('CallDisconnected', {}));
    check('the session call dropping ends the session', dialer.getSession(sid).state === 'ended');

    // A closed tab: nobody polls any more.
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 1 });
    await dialer.startRound(sid, [lead(1)]);
    await advance(IDLE_SESSION_MS + 1000);
    await dialer.sweep();
    check('a session nobody is watching is ended', dialer._sessions.get(sid).state === 'ended');

    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 1 });
    await advance(IDLE_SESSION_MS - 5000);
    dialer.getSession(sid); // the browser checks in
    await advance(10000);
    await dialer.sweep();
    check('a session being polled stays alive', dialer._sessions.get(sid).state === 'ready');

    // ════ ending a session ═══════════════════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 2 });
    snap = await dialer.startRound(sid, [lead(1), lead(2)]);
    await advance(3000);
    snap = await dialer.endSession(sid);
    check('ending a session cancels lines still ringing', opsOf('cancel').length === 2);
    check('a line cut short by the agent stopping is eligible for retry', snap.legs.every((l) => l.state === 'cancelled'));
    check('the session call is hung up for everyone', opsOf('hangUp').some((c) => c.forEveryone === true));
    check('the final state is still readable', dialer.getSession(sid).state === 'ended');

    await advance(16 * 60 * 1000);
    await dialer.sweep();
    check('a finished session is forgotten after a while', !dialer._sessions.has(sid));

    // ════ snapshots and helpers ══════════════════════════════════════════
    reset();
    dialer = make();
    sid = await readySession(dialer, { lines: 1 });
    await dialer.startRound(sid, [lead(1)]);
    let threw = false;
    try {
        JSON.stringify(dialer.getSession(sid));
    } catch {
        threw = true;
    }
    check('a snapshot is safe to send as JSON', !threw);

    err = await rejects(Promise.resolve().then(() => dialer.getSession('nope')));
    check('an unknown session is a 404', err && err.status === 404, err && err.code);

    check('a phone is read from the typed identifier', phoneOf({ phoneNumber: { value: '+15551234' } }) === '+15551234');
    check('a phone is read from a raw id', phoneOf({ rawId: '4:+15551234' }) === '+15551234');
    check('an agent id is read from a raw id', userOf({ rawId: '8:acs:abc' }) === '8:acs:abc');
    check('numbers compare across formats', samePhone('+1 (555) 100-0001', '5551000001'));
    check('different numbers do not match', !samePhone('+15551000001', '+15551000002'));
    check('a blank never matches', !samePhone('', '+15551000001'));
    check('the abandon wait grows with the message', abandonListenMs('x'.repeat(300)) > abandonListenMs('short'));
    check('but is bounded', abandonListenMs('x'.repeat(100000)) <= 25000);

    // ── report ──────────────────────────────────────────────────────────
    const failed = results.filter((x) => !x.pass);
    for (const x of results) {
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}`);
        if (!x.pass) console.log(`        -> ${JSON.stringify(x.detail)}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();
