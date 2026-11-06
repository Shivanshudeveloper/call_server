// Drives the real call-forwarding engine against a fake Azure client and a
// clock the test controls: answering, ringing the forwarding phone, every way a
// call can end, and the safety nets for events that never arrive.
const path = require('path');
const {
    createCallForwarder,
    ringbackWav,
    secretMatches,
    spokenNumber,
    FORWARD_RING_SECONDS,
    RING_BACKSTOP_SECONDS,
    CONNECT_TIMEOUT_MS,
    DEFAULT_UNANSWERED_MESSAGE,
} = require(path.join(__dirname, '..', 'lib', 'call-forwarding.js'));

// ─── A controllable clock ───────────────────────────────────────────────────

let clock = 1_000_000;
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
const settle = () => new Promise((resolve) => setImmediate(resolve));
const advance = async (ms) => {
    const target = clock + ms;
    for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock = due.at;
        due.fn();
        await settle();
        await settle();
    }
    clock = target;
};

// ─── A fake Azure client that records what it was asked ─────────────────────

function fakeAzure(options = {}) {
    const calls = [];
    const record = (name, args) => calls.push({ name, args });
    const connection = (id) => ({
        addParticipant: async (...args) => {
            record('addParticipant', [id, ...args]);
            if (options.addParticipantFails) throw Object.assign(new Error('Invalid target'), { statusCode: 400 });
            return { invitationId: 'inv-1' };
        },
        cancelAddParticipantOperation: async (...args) => record('cancelAddParticipantOperation', [id, ...args]),
        hangUp: async (...args) => record('hangUp', [id, ...args]),
        getCallMedia: () => ({
            playToAll: async (...args) => {
                record('playToAll', [id, ...args]);
                if (options.playFails) throw new Error('play refused');
            },
            cancelAllOperations: async () => record('cancelAllOperations', [id]),
        }),
    });
    return {
        calls,
        named: (name) => calls.filter((c) => c.name === name),
        answerCall: async (...args) => {
            record('answerCall', args);
            if (options.answerFails) throw Object.assign(new Error('Call already answered'), { statusCode: 400 });
            return { callConnectionProperties: { callConnectionId: 'conn-1', serverCallId: 'srv-1' } };
        },
        redirectCall: async (...args) => record('redirectCall', args),
        createCall: async (...args) => {
            record('createCall', args);
            return { callConnectionProperties: { callConnectionId: 'test-conn' } };
        },
        getCallConnection: (id) => connection(id),
    };
}

function setup(options = {}) {
    const azure = fakeAzure(options);
    const reports = [];
    const forwarder = createCallForwarder({
        client: azure,
        callbackBaseUrl: 'https://calls.example.com',
        cognitiveServicesEndpoint: options.noSpeech ? '' : 'https://speech.example.com/',
        ringbackUrl: 'https://calls.example.com/routing/ringback.wav',
        reportCall: async (callId, payload) => {
            if (options.reportFails) throw new Error('backend down');
            reports.push({ callId, ...payload });
        },
        isCallbackReachable: async () => !options.unreachable,
        now,
        schedule,
        cancelScheduled,
        log: () => {},
    });
    return { azure, reports, forwarder };
}

const CALLER = '+14155550100';
const BUSINESS = '+18887108482';
const MOBILE = '+919625241459';

const incoming = (over = {}) => ({
    callId: 'call-1',
    organizationId: 'org-1',
    incomingCallContext: 'ctx-abc',
    from: CALLER,
    to: BUSINESS,
    forwardTo: MOBILE,
    unansweredMessage: 'Nobody is in. Call back tomorrow.',
    ...over,
});

const event = (type, data = {}) => ({ type: `Microsoft.Communication.${type}`, data: { callConnectionId: 'conn-1', ...data } });
const phone = (number) => ({ identifier: { rawId: `4:${number}`, phoneNumber: { value: number } } });
const send = (forwarder, type, data, query = { call: 'call-1' }) => forwarder.handleEvent(event(type, data), query);

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
    // ── refusing bad requests ──────────────────────────────────────────────
    {
        const { forwarder, azure } = setup();
        let error = await rejects(forwarder.forward(incoming({ incomingCallContext: '' })));
        check('a call without its Azure context is refused', error && error.status === 400);
        error = await rejects(forwarder.forward(incoming({ forwardTo: '4155550123' })));
        check('a forwarding number that is not E.164 is refused', error && error.code === 'INVALID_FORWARD_TO');
        error = await rejects(forwarder.forward(incoming({ to: 'Unknown' })));
        check('a call with no business number is refused', error && error.code === 'INVALID_NUMBER');
        check('nothing was answered for a refused request', azure.named('answerCall').length === 0);

        await forwarder.forward(incoming());
        error = await rejects(forwarder.forward(incoming()));
        check('the same call cannot be taken twice', error && error.status === 409);
        check('and Azure was asked to answer it only once', azure.named('answerCall').length === 1);
    }

    // ── a call that is answered ────────────────────────────────────────────
    {
        const { forwarder, azure, reports } = setup();
        const started = await forwarder.forward(incoming());
        check('forward() reports that it is forwarding', started.mode === 'forwarding' && started.callConnectionId === 'conn-1', started);

        const [ctx, callbackUrl, answerOptions] = azure.named('answerCall')[0].args;
        check('the call is answered with its own context', ctx === 'ctx-abc');
        check('the callback address carries the call id', callbackUrl === 'https://calls.example.com/routing/callbacks?call=call-1', callbackUrl);
        check('speech is enabled so the message can be spoken', answerOptions.callIntelligenceOptions.cognitiveServicesEndpoint === 'https://speech.example.com/');
        check('the phone is not rung before Azure says the call is up', azure.named('addParticipant').length === 0);

        await send(forwarder, 'CallConnected');
        const [, invite, inviteOptions] = azure.named('addParticipant')[0].args;
        check('the forwarding phone is rung as a phone, not an app user', invite.targetParticipant.phoneNumber === MOBILE);
        check('it shows the business number, so it reads as a work call', invite.sourceCallIdNumber.phoneNumber === BUSINESS);
        check(`it rings for ${FORWARD_RING_SECONDS} seconds`, inviteOptions.invitationTimeoutInSeconds === FORWARD_RING_SECONDS);
        check('the attempt carries its own token', /^cf-attempt:call-1:/.test(inviteOptions.operationContext));

        const ringback = azure.named('playToAll')[0];
        check('the caller hears ringing while the phone rings', ringback && ringback.args[1][0].kind === 'fileSource' && ringback.args[2].loop === true);

        await send(forwarder, 'CallConnected');
        check('a repeated CallConnected does not ring the phone twice', azure.named('addParticipant').length === 1);

        await send(forwarder, 'AddParticipantSucceeded', { operationContext: 'cf-attempt:somebody-else' });
        check('an event for another attempt is ignored', !reports.some((r) => r.status === 'answered'));

        await send(forwarder, 'AddParticipantSucceeded', { operationContext: inviteOptions.operationContext });
        check('the answer is reported', reports.some((r) => r.status === 'answered' && r.organizationId === 'org-1'), reports);
        check('the ringing stops when they answer', azure.named('cancelAllOperations').length === 1);

        await advance(125000);
        await send(forwarder, 'CallDisconnected');
        const final = reports[reports.length - 1];
        check('a finished conversation is reported as completed', final.status === 'completed', final);
        check('with the talk time to bill', final.talkSeconds === 125, final);
        check('the finished call is forgotten', forwarder._calls.size === 0);

        await send(forwarder, 'AddParticipantSucceeded', { operationContext: inviteOptions.operationContext });
        await send(forwarder, 'CallDisconnected');
        check('late events after the end change nothing', reports.length === 2, reports);
    }

    // ── nobody answers ─────────────────────────────────────────────────────
    {
        const { forwarder, azure, reports } = setup();
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        const context = azure.named('addParticipant')[0].args[2].operationContext;

        await send(forwarder, 'AddParticipantFailed', { operationContext: context, resultInformation: { code: 408, subCode: 10004 } });
        const message = azure.named('playToAll')[1];
        check('the caller hears the organization\'s message', message && message.args[1][0].text === 'Nobody is in. Call back tomorrow.', message);
        check('the call is not hung up while the message plays', azure.named('hangUp').length === 0);

        await send(forwarder, 'PlayCompleted', { operationContext: 'cf-sorry:call-1' });
        check('the call ends once the message has played', azure.named('hangUp').length === 1 && azure.named('hangUp')[0].args[1] === true);

        await send(forwarder, 'CallDisconnected');
        const final = reports[reports.length - 1];
        check('an unanswered call is reported as missed', final.status === 'missed' && final.reason === 'no answer', final);
        check('and costs no talk time', final.talkSeconds === 0);
    }

    {
        const { forwarder, azure, reports } = setup();
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        const context = azure.named('addParticipant')[0].args[2].operationContext;
        await send(forwarder, 'AddParticipantFailed', { operationContext: context, resultInformation: { code: 486 } });
        await send(forwarder, 'CallDisconnected');
        check('a declined call is reported as busy or declined', reports[reports.length - 1].reason === 'busy or declined', reports);
    }

    {
        const { forwarder, azure } = setup({ });
        await forwarder.forward(incoming({ unansweredMessage: '   ' }));
        await send(forwarder, 'CallConnected');
        const context = azure.named('addParticipant')[0].args[2].operationContext;
        await send(forwarder, 'AddParticipantFailed', { operationContext: context, resultInformation: { code: 408 } });
        check('an empty message falls back to the default', azure.named('playToAll')[1].args[1][0].text === DEFAULT_UNANSWERED_MESSAGE);
    }

    // ── safety nets ────────────────────────────────────────────────────────
    {
        const { forwarder, azure, reports } = setup();
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        await advance((RING_BACKSTOP_SECONDS - 1) * 1000);
        check('the backstop waits for Azure first', azure.named('cancelAddParticipantOperation').length === 0);
        await advance(2000);
        const cancel = azure.named('cancelAddParticipantOperation')[0];
        check('if Azure never says, the phone is stopped with its invitation id', cancel && cancel.args[1] === 'inv-1', azure.calls);
        check('and the caller hears the message', azure.named('playToAll').length === 2);

        await advance(60000);
        check('if the message never reports finishing, the call is still ended', azure.named('hangUp').length === 1);
        await send(forwarder, 'CallDisconnected');
        check('and recorded as missed', reports[reports.length - 1].status === 'missed');
    }

    {
        const { forwarder, azure, reports } = setup();
        await forwarder.forward(incoming());
        await advance(CONNECT_TIMEOUT_MS + 10);
        check('a call Azure never connects is ended', azure.named('hangUp').length === 1);
        check('and recorded as failed', reports.some((r) => r.status === 'failed'), reports);
        check('and forgotten', forwarder._calls.size === 0);
    }

    // ── someone hangs up ───────────────────────────────────────────────────
    {
        const { forwarder, azure, reports } = setup();
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        await send(forwarder, 'ParticipantsUpdated', { participants: [phone(CALLER)] });
        check('the caller being alone on the line does not end it', azure.named('hangUp').length === 0);

        await send(forwarder, 'ParticipantsUpdated', { participants: [phone(BUSINESS)] });
        check('when the caller gives up, the phone stops ringing', azure.named('cancelAddParticipantOperation').length === 1);
        check('and the call is ended', azure.named('hangUp').length === 1);
        const final = reports[reports.length - 1];
        check('it is recorded as the caller hanging up', final.status === 'caller_hung_up' && final.talkSeconds === 0, final);
    }

    {
        const { forwarder, azure, reports } = setup();
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        const context = azure.named('addParticipant')[0].args[2].operationContext;
        await send(forwarder, 'AddParticipantSucceeded', { operationContext: context });
        await send(forwarder, 'ParticipantsUpdated', { participants: [phone(CALLER), phone(MOBILE)] });
        check('both people on the line keeps the call up', azure.named('hangUp').length === 0);

        await advance(42000);
        // The forwarded phone hung up. Azure's own number shape for it differs.
        await send(forwarder, 'ParticipantsUpdated', { participants: [{ identifier: { rawId: `4:${CALLER}` } }] });
        check('when the forwarded phone hangs up, the caller is not left on an open line', azure.named('hangUp').length === 1);
        const final = reports[reports.length - 1];
        check('and the conversation is billed for its length', final.status === 'completed' && final.talkSeconds === 42, final);
    }

    {
        const { forwarder, azure } = setup();
        await forwarder.forward(incoming({ from: 'anonymous' }));
        await send(forwarder, 'CallConnected');
        await send(forwarder, 'ParticipantsUpdated', { participants: [phone(BUSINESS)] });
        check('a caller who withheld their number is not mistaken for having left', azure.named('hangUp').length === 0);
    }

    // ── when Azure refuses ─────────────────────────────────────────────────
    {
        const { forwarder } = setup({ answerFails: true });
        const error = await rejects(forwarder.forward(incoming()));
        check('a refused answer is reported back so the backend can fall back to the browser', error && error.status === 502 && error.code === 'ANSWER_FAILED', error && error.message);
        check('and leaves nothing behind', forwarder._calls.size === 0);
    }

    {
        const { forwarder, azure, reports } = setup({ addParticipantFails: true });
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        check('a phone Azure will not ring still gets the caller the message', azure.named('playToAll').some((c) => c.args[1][0].kind === 'textSource'));
        await send(forwarder, 'CallDisconnected');
        check('and is recorded as failed', reports[reports.length - 1].status === 'failed', reports);
    }

    {
        const { forwarder, azure, reports } = setup({ unreachable: true });
        const result = await forwarder.forward(incoming());
        const redirect = azure.named('redirectCall')[0];
        check('if Azure could not reach us, the call is redirected straight to the phone', result.mode === 'redirected' && redirect, result);
        check('to the forwarding phone, showing the business number', redirect.args[1].targetParticipant.phoneNumber === MOBILE && redirect.args[1].sourceCallIdNumber.phoneNumber === BUSINESS);
        check('it is never answered here', azure.named('answerCall').length === 0);
        check('and the redirect is recorded', reports.some((r) => r.status === 'redirected'));
    }

    {
        const { forwarder, azure } = setup({ noSpeech: true });
        await forwarder.forward(incoming());
        check('without a speech endpoint the answer asks for no speech features', !azure.named('answerCall')[0].args[2].callIntelligenceOptions);
        await send(forwarder, 'CallConnected');
        const context = azure.named('addParticipant')[0].args[2].operationContext;
        await send(forwarder, 'AddParticipantFailed', { operationContext: context, resultInformation: { code: 408 } });
        check('and an unanswered call simply ends', azure.named('hangUp').length === 1);
    }

    {
        const { forwarder, azure, reports } = setup({ playFails: true });
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        const context = azure.named('addParticipant')[0].args[2].operationContext;
        await send(forwarder, 'AddParticipantFailed', { operationContext: context, resultInformation: { code: 408 } });
        check('if the message cannot play, the call still ends', azure.named('hangUp').length === 1);
        await send(forwarder, 'CallDisconnected');
        check('and is still recorded', reports[reports.length - 1].status === 'missed');
    }

    {
        const { forwarder } = setup({ reportFails: true });
        await forwarder.forward(incoming());
        await send(forwarder, 'CallConnected');
        let threw = false;
        try {
            await send(forwarder, 'CallDisconnected');
        } catch {
            threw = true;
        }
        check('a backend that cannot be told never breaks the call', !threw && forwarder._calls.size === 0);
    }

    // ── test calls ─────────────────────────────────────────────────────────
    {
        const { forwarder, azure } = setup();
        const error = await rejects(forwarder.testCall({ testId: 't1', from: BUSINESS, to: '12345' }));
        check('a test call to a malformed number is refused', error && error.status === 400);

        await forwarder.testCall({ testId: 't1', from: BUSINESS, to: MOBILE });
        const [invite, callbackUrl] = azure.named('createCall')[0].args;
        check('a test call rings the forwarding phone from the business number', invite.targetParticipant.phoneNumber === MOBILE && invite.sourceCallIdNumber.phoneNumber === BUSINESS);
        check('with its own callback address', callbackUrl.endsWith('/routing/callbacks?test=t1'));

        await forwarder.handleEvent(event('CallConnected', { callConnectionId: 'test-conn' }), { test: 't1' });
        const spoken = azure.named('playToAll')[0];
        check('it speaks a confirmation naming the business number', spoken && spoken.args[1][0].text.includes('8 8 8 7 1 0 8 4 8 2'), spoken && spoken.args[1][0].text);
        await forwarder.handleEvent(event('PlayCompleted', { callConnectionId: 'test-conn' }), { test: 't1' });
        check('and hangs up when done', azure.named('hangUp').length === 1);
        check('test calls never touch the forwarded-call log', forwarder._calls.size === 0);
    }

    // ── helpers ────────────────────────────────────────────────────────────
    check('the shared secret must match exactly', secretMatches('s3cret', 's3cret') && !secretMatches('s3cret', 's3cre') && !secretMatches('s3cret', ''));
    check('no secret configured means nothing matches', !secretMatches('', ''));
    check('numbers are read out digit by digit', spokenNumber('+1 888') === '1 8 8 8');

    const wav = ringbackWav();
    check(
        'the ringback tone is a 16 kHz mono WAV, the format Azure plays',
        wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(22) === 1 && wav.length === 44 + 16000 * 6 * 2
    );

    const failed = results.filter((x) => !x.pass);
    for (const x of results) {
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}`);
        if (!x.pass) console.log(`        -> ${JSON.stringify(x.detail)}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();
