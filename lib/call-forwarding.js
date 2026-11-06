/**
 * Call forwarding: a call to one of the organization's numbers rings a phone
 * the organization chose instead of the browser.
 *
 * Azure answers the incoming call on our behalf and the chosen phone is then
 * JOINED to that same call as a second participant. Nothing is transferred in
 * the telecom sense - it is one call with two people in it, and Azure mixes the
 * audio. This server only sends instructions; it never touches the audio.
 *
 * Why this is an event machine and not a sequence of awaits:
 *   - addParticipant resolves when Azure ACCEPTS the invitation, not when a
 *     person answers. Only AddParticipantSucceeded / AddParticipantFailed say
 *     what really happened.
 *   - A phone that is still ringing can only be stopped with the invitationId
 *     addParticipant returned, so it is kept.
 *   - Events can be retried or arrive late, so every attempt carries its own
 *     operationContext and a stale one is ignored.
 *   - One side hanging up does not end the call for the other; that has to be
 *     noticed (ParticipantsUpdated) and acted on.
 *
 * The backend decides WHICH calls are forwarded and hands them over through
 * forward(); this module never looks anything up. State is in memory, so this
 * server must run as a single instance (as the parallel dialer already
 * requires).
 */
const {
    describeAzureError,
    labelForFailure,
    phoneOf,
    samePhone,
    abandonListenMs,
} = require('./parallel-dialer');

/** How long the forwarding phone rings before the caller hears the message. */
const FORWARD_RING_SECONDS = 30;

/** A local backstop in case Azure never reports how the invitation ended. */
const RING_BACKSTOP_SECONDS = FORWARD_RING_SECONDS + 5;

/** An answered call that never reports CallConnected is given up after this. */
const CONNECT_TIMEOUT_MS = 20000;

/** No forwarded call is left open longer than this, whatever happens. */
const MAX_CALL_MS = 4 * 60 * 60 * 1000;

/** Finished calls are remembered this long so late events are recognised. */
const ENDED_TTL_MS = 10 * 60 * 1000;

const DEFAULT_UNANSWERED_MESSAGE =
    'Sorry, no one is available to take your call right now. Please try again later. Goodbye.';

/** Final outcomes, as stored in the call log. */
const OUTCOMES = ['completed', 'missed', 'caller_hung_up', 'failed', 'redirected'];

const E164 = /^\+[1-9]\d{7,14}$/;

const secondsBetween = (from, to) => (from && to && to > from ? Math.round((to - from) / 1000) : 0);

/** "+14155550123" read out digit by digit, so a test call says it clearly. */
const spokenNumber = (number) => String(number || '').replace(/\D/g, '').split('').join(' ');

function createCallForwarder({
    client,
    callbackBaseUrl,
    cognitiveServicesEndpoint = '',
    ttsVoice = 'en-US-JennyNeural',
    ringbackUrl = '',
    reportCall = async () => {},
    isCallbackReachable = () => true,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelScheduled = (handle) => clearTimeout(handle),
    log = (...args) => console.log(...args),
}) {
    /** Live calls by our call id, plus a second index by Azure's connection id. */
    const calls = new Map();
    const byConnection = new Map();
    /** Test calls are tracked separately: they have no caller and no log row. */
    const tests = new Map();
    /** Calls that have finished, so a late event is recognised and ignored. */
    const ended = new Map();

    const speaks = Boolean(cognitiveServicesEndpoint);
    const answerOptions = (operationContext) => ({
        operationContext,
        ...(speaks ? { callIntelligenceOptions: { cognitiveServicesEndpoint } } : {}),
    });

    const connectionOf = (call) => client.getCallConnection(call.callConnectionId);
    const mediaOf = (call) => connectionOf(call).getCallMedia();

    const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

    // ─── Reporting ──────────────────────────────────────────────────────────

    /** Tells the backend; a failure is logged and never breaks the call. */
    async function report(call, fields) {
        try {
            await reportCall(call.callId, {
                organizationId: call.organizationId,
                ...fields,
            });
        } catch (error) {
            log(`[forward:${call.callId}] could not report ${fields.status || 'update'}: ${error.message}`);
        }
    }

    // ─── Starting a forwarded call ──────────────────────────────────────────

    /**
     * Take over one incoming call. Resolves once Azure has accepted the answer,
     * so the caller of this knows whether to fall back to the browser popup.
     */
    async function forward({
        callId,
        organizationId = '',
        incomingCallContext,
        from = '',
        to,
        forwardTo,
        unansweredMessage = '',
    }) {
        if (!callId) throw fail(400, 'MISSING_CALL_ID', 'callId is required');
        if (!incomingCallContext) throw fail(400, 'MISSING_CONTEXT', 'incomingCallContext is required');
        if (!E164.test(String(to || ''))) throw fail(400, 'INVALID_NUMBER', 'to must be an E.164 number');
        if (!E164.test(String(forwardTo || ''))) throw fail(400, 'INVALID_FORWARD_TO', 'forwardTo must be an E.164 number');
        if (calls.has(callId) || ended.has(callId)) throw fail(409, 'DUPLICATE_CALL', 'This call is already being handled');

        const call = {
            callId,
            organizationId,
            from,
            to,
            forwardTo,
            unansweredMessage: String(unansweredMessage || '').trim() || DEFAULT_UNANSWERED_MESSAGE,
            state: 'answering',
            callConnectionId: '',
            serverCallId: '',
            attempt: null,
            answeredAt: null,
            receivedAt: now(),
            endedAt: null,
            outcome: '',
            reason: '',
            timers: {},
            ringbackPlaying: false,
        };

        // Azure must be able to reach us with this call's events. If it cannot,
        // answering would strand the caller in silence, so hand the call to the
        // phone directly instead: no message on no-answer and no talk time, but
        // the phone still rings.
        if (!(await isCallbackReachable())) {
            log(`[forward:${callId}] callbacks would not reach this server - redirecting the call instead`);
            try {
                await client.redirectCall(incomingCallContext, {
                    targetParticipant: { phoneNumber: forwardTo },
                    sourceCallIdNumber: { phoneNumber: to },
                });
            } catch (error) {
                throw fail(502, 'REDIRECT_FAILED', `Azure refused to redirect the call: ${describeAzureError(error)}`);
            }
            call.state = 'ended';
            call.outcome = 'redirected';
            call.endedAt = now();
            remember(call);
            await report(call, { status: 'redirected', reason: 'callback address unreachable', endedAt: new Date(call.endedAt) });
            return { callId, mode: 'redirected' };
        }

        calls.set(callId, call);

        try {
            const result = await client.answerCall(
                incomingCallContext,
                `${callbackBaseUrl}/routing/callbacks?call=${encodeURIComponent(callId)}`,
                answerOptions(`cf-call:${callId}`)
            );
            const properties = (result && result.callConnectionProperties) || {};
            call.callConnectionId =
                properties.callConnectionId || (result && result.callConnection && result.callConnection.callConnectionId) || '';
            call.serverCallId = properties.serverCallId || '';
            if (!call.callConnectionId) throw new Error('answerCall returned no callConnectionId');
        } catch (error) {
            calls.delete(callId);
            log(`[forward:${callId}] Azure refused to answer:`, describeAzureError(error));
            throw fail(502, 'ANSWER_FAILED', `Azure refused to answer the call: ${describeAzureError(error)}`);
        }

        byConnection.set(call.callConnectionId, call);
        call.timers.connect = schedule(() => {
            if (call.state === 'answering') {
                log(`[forward:${callId}] Azure never confirmed the call connected - ending it`);
                call.outcome = 'failed';
                call.reason = 'call never connected';
                hangUp(call).finally(() => finish(call));
            }
        }, CONNECT_TIMEOUT_MS);
        call.timers.max = schedule(() => {
            log(`[forward:${callId}] reached the maximum call length - hanging up`);
            hangUp(call).finally(() => finish(call));
        }, MAX_CALL_MS);

        log(`[forward:${callId}] answered a call to ${to}; forwarding to ${forwardTo}`);
        return { callId, mode: 'forwarding', callConnectionId: call.callConnectionId };
    }

    // ─── Ringing the forwarding phone ───────────────────────────────────────

    async function invite(call) {
        if (call.state !== 'answering') return;
        call.state = 'ringing';
        cancelScheduled(call.timers.connect);

        const attemptId = `cf-attempt:${call.callId}:${now()}`;
        call.attempt = { attemptId, invitationId: '', invitedAt: now() };

        startRingback(call);

        try {
            const result = await connectionOf(call).addParticipant(
                {
                    targetParticipant: { phoneNumber: call.forwardTo },
                    // Required for a phone leg, and what the phone displays: the
                    // business's own number, so it reads as a work call.
                    sourceCallIdNumber: { phoneNumber: call.to },
                },
                { invitationTimeoutInSeconds: FORWARD_RING_SECONDS, operationContext: attemptId }
            );
            if (call.attempt && call.attempt.attemptId === attemptId) {
                call.attempt.invitationId = (result && result.invitationId) || '';
            }
        } catch (error) {
            log(`[forward:${call.callId}] Azure refused to ring ${call.forwardTo}:`, describeAzureError(error));
            await unanswered(call, 'failed', describeAzureError(error));
            return;
        }

        // A lost AddParticipantFailed would otherwise leave the caller listening
        // to ringing forever.
        call.timers.ring = schedule(() => {
            if (call.state === 'ringing' && call.attempt && call.attempt.attemptId === attemptId) {
                unanswered(call, 'missed', 'no answer').catch(() => {});
            }
        }, RING_BACKSTOP_SECONDS * 1000);
    }

    /** Ringing for the caller while the phone rings, instead of dead air. */
    function startRingback(call) {
        if (!ringbackUrl) return;
        call.ringbackPlaying = true;
        mediaOf(call)
            .playToAll([{ kind: 'fileSource', url: ringbackUrl }], { loop: true, operationContext: `cf-ringback:${call.callId}` })
            .catch((error) => {
                call.ringbackPlaying = false;
                log(`[forward:${call.callId}] ringback could not play (${error.message}); the caller hears silence while it rings`);
            });
    }

    async function stopRingback(call) {
        if (!call.ringbackPlaying) return;
        call.ringbackPlaying = false;
        try {
            await mediaOf(call).cancelAllOperations();
        } catch (error) {
            log(`[forward:${call.callId}] could not stop the ringback: ${error.message}`);
        }
    }

    /** Stop the phone ringing. Only the invitationId can do this. */
    async function cancelInvitation(call) {
        const invitationId = call.attempt && call.attempt.invitationId;
        if (!invitationId) return;
        call.attempt.invitationId = '';
        try {
            await connectionOf(call).cancelAddParticipantOperation(invitationId);
        } catch (error) {
            log(`[forward:${call.callId}] could not stop ${call.forwardTo} ringing: ${error.message}`);
        }
    }

    // ─── Outcomes ───────────────────────────────────────────────────────────

    async function answered(call) {
        if (call.state !== 'ringing') return;
        call.state = 'connected';
        call.answeredAt = now();
        cancelScheduled(call.timers.ring);
        if (call.attempt) call.attempt.invitationId = '';
        await stopRingback(call);
        log(`[forward:${call.callId}] ${call.forwardTo} answered`);
        await report(call, { status: 'answered', answeredAt: new Date(call.answeredAt) });
    }

    /**
     * Nobody picked up (or the phone could not be rung): the caller hears the
     * organization's message, then the call ends.
     */
    async function unanswered(call, outcome, reason) {
        if (call.state !== 'ringing') return;
        call.state = 'unanswered';
        call.outcome = outcome;
        call.reason = reason;
        cancelScheduled(call.timers.ring);
        await cancelInvitation(call);
        await stopRingback(call);

        log(`[forward:${call.callId}] ${call.forwardTo} did not answer (${reason}) - playing the message`);

        if (!speaks) {
            await hangUp(call);
            return;
        }
        try {
            await mediaOf(call).playToAll([{ kind: 'textSource', text: call.unansweredMessage, voiceName: ttsVoice }], {
                operationContext: `cf-sorry:${call.callId}`,
            });
        } catch (error) {
            log(`[forward:${call.callId}] the message could not play (${error.message}); hanging up`);
            await hangUp(call);
            return;
        }
        // PlayCompleted normally ends the call; this is the backstop.
        call.timers.sorry = schedule(() => {
            hangUp(call).catch(() => {});
        }, abandonListenMs(call.unansweredMessage));
    }

    async function hangUp(call) {
        if (!call.callConnectionId || call.hungUp) return;
        call.hungUp = true;
        try {
            await connectionOf(call).hangUp(true);
        } catch (error) {
            log(`[forward:${call.callId}] hang up failed: ${error.message}`);
        }
    }

    /** The call is over: record it once, bill the talk time, forget it. */
    async function finish(call) {
        if (call.state === 'ended') return;
        const wasRinging = call.state === 'ringing';
        const previous = call.state;
        call.state = 'ended';
        call.endedAt = now();
        Object.values(call.timers).forEach((handle) => handle && cancelScheduled(handle));

        // The caller gave up while the phone rang: the phone must stop too.
        if (wasRinging) await cancelInvitation(call);

        let status = call.outcome;
        if (call.answeredAt) status = 'completed';
        else if (!status) status = previous === 'answering' ? 'failed' : 'caller_hung_up';

        const talkSeconds = call.answeredAt ? secondsBetween(call.answeredAt, call.endedAt) : 0;

        calls.delete(call.callId);
        if (call.callConnectionId) byConnection.delete(call.callConnectionId);
        remember(call);

        log(`[forward:${call.callId}] ended: ${status}${talkSeconds ? ` after ${talkSeconds}s` : ''}`);
        await report(call, {
            status,
            reason: call.reason || '',
            talkSeconds,
            answeredAt: call.answeredAt ? new Date(call.answeredAt) : null,
            endedAt: new Date(call.endedAt),
        });
    }

    function remember(call) {
        ended.set(call.callId, call.endedAt || now());
    }

    // ─── Events from Azure ──────────────────────────────────────────────────

    /** Is this participant list still holding the given number? */
    const holds = (participants, number) =>
        participants.some((participant) => samePhone(phoneOf(participant && participant.identifier), number));

    async function handleEvent(event, query = {}) {
        const type = String((event && (event.type || event.eventType)) || '').replace('Microsoft.Communication.', '');
        const data = (event && event.data) || {};

        if (query.test) return handleTestEvent(String(query.test), type, data);

        const call = calls.get(String(query.call || '')) || byConnection.get(data.callConnectionId || '');
        if (!call) return; // finished, or not ours

        if (data.serverCallId && !call.serverCallId) call.serverCallId = data.serverCallId;
        const context = data.operationContext || '';

        switch (type) {
            case 'CallConnected':
                await invite(call);
                break;

            case 'AddParticipantSucceeded':
                // An event for an attempt already given up must not mark the
                // call answered by a phone that is no longer ringing.
                if (call.attempt && context === call.attempt.attemptId) await answered(call);
                break;

            case 'AddParticipantFailed':
                if (call.attempt && context === call.attempt.attemptId) {
                    const label = labelForFailure(data.resultInformation);
                    const reason = label === 'busy' ? 'busy or declined' : label === 'failed' ? 'number unreachable' : 'no answer';
                    await unanswered(call, label === 'failed' ? 'failed' : 'missed', reason);
                }
                break;

            case 'ParticipantsUpdated': {
                const participants = Array.isArray(data.participants) ? data.participants : [];
                if (call.state === 'ended' || participants.length === 0) break;
                // A caller who withheld their number cannot be matched; their
                // leaving is caught by CallDisconnected instead.
                if (call.from && /\d{6,}/.test(call.from) && !holds(participants, call.from)) {
                    if (call.state === 'ringing') {
                        call.outcome = 'caller_hung_up';
                        call.reason = 'caller hung up while it rang';
                    }
                    await hangUp(call);
                    await finish(call);
                    break;
                }
                // The forwarded phone has no Azure identity, so it is matched by
                // number. When it leaves, the caller must not be left on an
                // open, silent line.
                if (call.state === 'connected' && !holds(participants, call.forwardTo)) {
                    await hangUp(call);
                    await finish(call);
                }
                break;
            }

            case 'PlayCompleted':
            case 'PlayFailed':
                if (context === `cf-sorry:${call.callId}`) await hangUp(call);
                break;

            case 'CallDisconnected':
                await finish(call);
                break;

            default:
                break;
        }
    }

    // ─── Test calls ─────────────────────────────────────────────────────────

    /**
     * Ring the forwarding phone once with a short spoken confirmation, so a
     * mistyped number is found now rather than on a customer's call.
     */
    async function testCall({ testId, from, to }) {
        if (!testId) throw fail(400, 'MISSING_TEST_ID', 'testId is required');
        if (!E164.test(String(from || ''))) throw fail(400, 'INVALID_NUMBER', 'from must be an E.164 number');
        if (!E164.test(String(to || ''))) throw fail(400, 'INVALID_FORWARD_TO', 'to must be an E.164 number');

        const test = { testId, from, to, callConnectionId: '', startedAt: now(), timer: null };
        tests.set(testId, test);
        try {
            const result = await client.createCall(
                { targetParticipant: { phoneNumber: to }, sourceCallIdNumber: { phoneNumber: from } },
                `${callbackBaseUrl}/routing/callbacks?test=${encodeURIComponent(testId)}`,
                answerOptions(`cf-test:${testId}`)
            );
            const properties = (result && result.callConnectionProperties) || {};
            test.callConnectionId =
                properties.callConnectionId || (result && result.callConnection && result.callConnection.callConnectionId) || '';
        } catch (error) {
            tests.delete(testId);
            throw fail(502, 'TEST_CALL_FAILED', `Azure refused the test call: ${describeAzureError(error)}`);
        }
        // Whatever happens, a test call never outlives two minutes.
        test.timer = schedule(() => endTest(test), 120000);
        return { testId };
    }

    async function endTest(test) {
        if (!tests.has(test.testId)) return;
        tests.delete(test.testId);
        cancelScheduled(test.timer);
        if (!test.callConnectionId) return;
        try {
            await client.getCallConnection(test.callConnectionId).hangUp(true);
        } catch {
            // Already gone.
        }
    }

    async function handleTestEvent(testId, type, data) {
        const test = tests.get(testId);
        if (!test) return;
        if (data.callConnectionId && !test.callConnectionId) test.callConnectionId = data.callConnectionId;

        if (type === 'CallConnected') {
            const text =
                `This is a test call from your call routing settings. ` +
                `Calls to ${spokenNumber(test.from)} will be forwarded to this phone. Goodbye.`;
            if (!speaks) return endTest(test);
            try {
                await client
                    .getCallConnection(test.callConnectionId)
                    .getCallMedia()
                    .playToAll([{ kind: 'textSource', text, voiceName: ttsVoice }], { operationContext: `cf-test:${testId}` });
            } catch (error) {
                log(`[forward:test:${testId}] could not speak the test message: ${error.message}`);
                await endTest(test);
            }
        } else if (type === 'PlayCompleted' || type === 'PlayFailed' || type === 'CallDisconnected' || type === 'CreateCallFailed') {
            await endTest(test);
        }
    }

    // ─── Housekeeping ───────────────────────────────────────────────────────

    function sweep() {
        const cutoff = now() - ENDED_TTL_MS;
        for (const [callId, endedAt] of ended) {
            if (endedAt < cutoff) ended.delete(callId);
        }
    }

    function describe() {
        return {
            live: Array.from(calls.values()).map((call) => ({
                callId: call.callId,
                state: call.state,
                to: call.to,
                forwardTo: call.forwardTo,
            })),
            tests: tests.size,
        };
    }

    return { forward, handleEvent, testCall, sweep, describe, _calls: calls, _ended: ended, _tests: tests };
}

/**
 * The North American ringback tone (440 Hz + 480 Hz, two seconds on, four off)
 * as a 16 kHz, 16-bit mono WAV - the format Azure plays. Generated rather than
 * stored so there is no binary file to ship or lose.
 */
function ringbackWav() {
    const sampleRate = 16000;
    const seconds = 6;
    const samples = sampleRate * seconds;
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
        const t = i / sampleRate;
        const on = t < 2;
        const value = on ? 0.18 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) : 0;
        data.writeInt16LE(Math.round(value * 32767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

/**
 * Constant-time comparison of the shared secret, so its value cannot be
 * guessed one character at a time from response timings.
 */
function secretMatches(expected, given) {
    const crypto = require('crypto');
    if (!expected || !given) return false;
    const a = crypto.createHash('sha256').update(String(expected)).digest();
    const b = crypto.createHash('sha256').update(String(given)).digest();
    return crypto.timingSafeEqual(a, b);
}

module.exports = {
    createCallForwarder,
    ringbackWav,
    secretMatches,
    spokenNumber,
    FORWARD_RING_SECONDS,
    RING_BACKSTOP_SECONDS,
    CONNECT_TIMEOUT_MS,
    DEFAULT_UNANSWERED_MESSAGE,
    OUTCOMES,
};
