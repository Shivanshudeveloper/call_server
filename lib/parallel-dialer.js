const { classifyGreeting, CLASSIFICATION } = require('./amd-classifier');

/**
 * Parallel dialer.
 *
 * One agent, several phones ringing at once, and the first person to answer is
 * put straight through to the agent.
 *
 * The agent sits in one long-lived SESSION call for the whole run. Each round
 * invites a handful of leads into that same call. Whoever answers first lands in
 * a call the agent is already on, so there is no bridging step and no dead air
 * after "hello?". That gap is the main reason people hang up on predictive
 * dialers, and connecting someone more than two seconds after their greeting
 * counts as an abandoned call under US telemarketing rules - so avoiding it is
 * not only a matter of polish.
 *
 * The moment one lead answers, every other line in the round is cancelled.
 * A line cut off before it had rung for FAIR_RING_SECONDS never got a real
 * chance, so it is labelled `cancelled` and the caller may try it once more
 * later. A line that had rung longer than that is simply `no_answer`.
 *
 * Voicemail detection runs alongside the conversation, never in front of it:
 * the agent is already talking when the verdict arrives, and only a confident
 * verdict produces anything on screen.
 *
 * All Azure calls go through the injected `client`, so the whole engine runs in
 * tests without a phone in sight. State lives in memory, like the voicemail
 * drops and conference invites elsewhere in this service, which is why it must
 * run as a single instance. Every lead's outcome is reported to the browser,
 * which writes it to the backend straight away - a restart loses the live
 * session, not the call history.
 */

const DEFAULT_LINES = 2;
const MAX_LINES = 3;

/** A cancelled line that had rung at least this long was a real attempt. */
const FAIR_RING_SECONDS = 15;

/** Give up on a round where nobody has answered by now. */
const DEFAULT_RING_TIMEOUT_SECONDS = 30;

/**
 * The shorter cut used when the organization would rather skip voicemails.
 *
 * Voicemail picks up after a carrier-set ring time. Hanging up just before that
 * avoids most machines entirely, at no cost in delay. It sits above
 * FAIR_RING_SECONDS so every unanswered line still counts as a fair attempt.
 */
const SKIP_VOICEMAIL_RING_TIMEOUT_SECONDS = 18;

/** An answer this late is more often a machine than a person. */
const LATE_ANSWER_SECONDS = 20;

/**
 * How long to leave an abandoned lead listening before letting them go.
 *
 * Their message is played while they are ON HOLD, and Azure reports no end for
 * hold audio, so removal is timed from the length of the text instead - about
 * thirteen characters a second spoken, plus a margin, within sane bounds.
 */
const ABANDON_MIN_MS = 6000;
const ABANDON_MAX_MS = 25000;
const abandonListenMs = (text) =>
    Math.min(ABANDON_MAX_MS, Math.max(ABANDON_MIN_MS, Math.ceil(String(text || '').length / 13) * 1000 + 1500));

/** A session nobody has looked at for this long is presumed abandoned. */
const IDLE_SESSION_MS = 60000;

/** How long a finished session stays readable, so the browser can see the end. */
const ENDED_SESSION_TTL_MS = 15 * 60 * 1000;

/** States in which a leg is finished and nothing more will happen to it. */
const FINAL_STATES = ['ended', 'no_answer', 'cancelled', 'busy', 'failed', 'abandoned', 'voicemail'];

const digitsOf = (value) => String(value || '').replace(/\D/g, '');

/** The phone number inside an ACS identifier, whatever shape it arrives in. */
function phoneOf(identifier) {
    if (!identifier) return '';
    if (identifier.phoneNumber) {
        return typeof identifier.phoneNumber === 'string' ? identifier.phoneNumber : identifier.phoneNumber.value || '';
    }
    const raw = String(identifier.rawId || '');
    return raw.startsWith('4:') ? raw.slice(2) : '';
}

/** The ACS user id inside an identifier, whatever shape it arrives in. */
function userOf(identifier) {
    if (!identifier) return '';
    if (identifier.communicationUserId) return identifier.communicationUserId;
    if (identifier.communicationUser) return identifier.communicationUser.id || '';
    const raw = String(identifier.rawId || '');
    return raw.startsWith('8:') ? raw : '';
}

const samePhone = (a, b) => {
    const left = digitsOf(a);
    const right = digitsOf(b);
    if (!left || !right) return false;
    // Tolerates one side carrying a country code the other leaves off.
    return left === right || left.endsWith(right) || right.endsWith(left);
};

/**
 * Turn an ACS failure into the label an agent understands.
 *
 * Carriers often report a declined call the same way as a busy one, or send it
 * to voicemail, so "busy" here really means busy or declined.
 */
function labelForFailure(resultInformation) {
    const code = Number(resultInformation?.code) || 0;
    const subCode = Number(resultInformation?.subCode) || 0;
    const message = String(resultInformation?.message || '').toLowerCase();

    if (code === 486 || code === 600 || code === 603 || /busy|declin/.test(message)) return 'busy';
    if (code === 404 || code === 484 || code === 410 || /not found|invalid|not exist/.test(message)) return 'failed';
    if (code === 408 || code === 480 || code === 487 || subCode === 10004 || /timeout|no answer|not answer/.test(message)) {
        return 'no_answer';
    }
    // Anything else is treated as a phone that simply was not picked up: the
    // most common reason, and the label that does least harm if it is wrong.
    return 'no_answer';
}

/**
 * Everything Azure said about a refusal, not just its two-word summary.
 *
 * "Invalid request" alone gives no clue which part was invalid. The status code,
 * Azure's error code and its detailed message usually do - and for the one case
 * seen in practice, a hint is added that names the likely culprit.
 */
function describeAzureError(error) {
    const parts = [];
    if (error?.statusCode) parts.push(String(error.statusCode));
    parts.push(error?.message || 'unknown error');

    const detail =
        error?.details?.message ||
        error?.details?.error?.message ||
        (typeof error?.response?.bodyAsText === 'string' ? error.response.bodyAsText.slice(0, 300) : '');
    if (detail && detail !== error?.message) parts.push(`- ${detail}`);

    // Not when Azure names the real problem itself (e.g. an expired call context).
    if (error?.statusCode === 400 && !/context/i.test(`${error?.message || ''} ${detail || ''}`)) {
        parts.push('(usually a malformed setting - check COGNITIVE_SERVICE_ENDPOINT and CALLBACK_BASE_URL have no quotes or spaces)');
    }
    return parts.join(' ');
}

function createParallelDialer({
    client,
    callbackBaseUrl,
    cognitiveServicesEndpoint,
    ttsVoice = 'en-US-JennyNeural',
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelScheduled = (handle) => clearTimeout(handle),
    log = (...args) => console.log(...args),
    /**
     * Confirms CALLBACK_BASE_URL reaches THIS process before anything rings.
     *
     * Azure delivers every event for a session to that address. If it points
     * anywhere else - production while testing locally, an ngrok tunnel that
     * has since changed - the agent's browser is rung, picks up, and the
     * session waits forever for a "connected" event that went to another
     * server. Resolves { ok, reason }. Omitted in tests.
     */
    verifyCallbackUrl = null,
}) {
    const sessions = new Map();

    const newId = (prefix) => `${prefix}-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const fail = (status, code, message) => {
        const error = new Error(message);
        error.status = status;
        error.code = code;
        return error;
    };

    const connectionOf = (session) => client.getCallConnection(session.callConnectionId);
    const mediaOf = (session) => connectionOf(session).getCallMedia();

    const secondsSince = (from, to = now()) => (from ? Math.max(0, Math.round((to - from) / 1000)) : 0);

    const touch = (session) => {
        session.updatedAt = now();
    };

    const legsOf = (session, roundId) =>
        Array.from(session.legs.values()).filter((leg) => !roundId || leg.roundId === roundId);

    // ─── Reading a session ───────────────────────────────────────────────────

    /** A plain, JSON-safe copy of a session - what the browser polls. */
    function snapshot(session) {
        const legs = Array.from(session.legs.values()).map((leg) => ({
            legId: leg.legId,
            roundId: leg.roundId,
            leadId: leg.leadId,
            name: leg.name,
            phoneNumber: leg.phoneNumber,
            state: leg.state,
            retryEligible: leg.state === 'cancelled',
            invitedAt: leg.invitedAt,
            answeredAt: leg.answeredAt || null,
            endedAt: leg.endedAt || null,
            ringSeconds: leg.ringSeconds,
            talkSeconds: leg.state === 'connected' ? secondsSince(leg.answeredAt) : leg.talkSeconds,
            amd: leg.amd,
            voicemail: leg.voicemail,
            error: leg.error || '',
        }));

        return {
            sessionId: session.sessionId,
            state: session.state,
            error: session.error || '',
            serverCallId: session.serverCallId || '',
            lines: session.lines,
            ringTimeoutSeconds: session.ringTimeoutSeconds,
            amdAvailable: session.amdAvailable,
            round: session.round
                ? {
                      roundId: session.round.roundId,
                      state: session.round.state,
                      winnerLegId: session.round.winnerLegId || null,
                      startedAt: session.round.startedAt,
                  }
                : null,
            legs,
            createdAt: session.createdAt,
            endedAt: session.endedAt || null,
        };
    }

    function getSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) throw fail(404, 'SESSION_NOT_FOUND', 'That dialing session no longer exists.');
        // Being polled is how a live browser proves it is still there.
        session.lastSeenAt = now();
        return snapshot(session);
    }

    // ─── Starting a session ──────────────────────────────────────────────────

    /**
     * Ring the agent's own browser to open the session call.
     *
     * The browser accepts it automatically. Every lead in every round is then
     * invited into this one call, so the agent never has to be connected to
     * anybody - they are already there.
     */
    async function startSession({
        organizationId,
        userEmail,
        agentUserId,
        callerId,
        lines = DEFAULT_LINES,
        voicemailMode = 'leave',
        abandonMessage,
    }) {
        if (!client) throw fail(503, 'CALL_AUTOMATION_UNAVAILABLE', 'Call Automation is not configured on this server.');
        if (!callbackBaseUrl || !/^https:\/\//i.test(callbackBaseUrl)) {
            throw fail(500, 'CALLBACK_URL_NOT_CONFIGURED', 'This server is not configured with a public callback URL.');
        }
        /**
         * Refused outright without speech services.
         *
         * They are what speaks the message to a lead who answers while the
         * agent is busy. Dialing without them would leave such a person in
         * silence and then hang up on them - precisely what the abandoned-call
         * rules forbid - so the session does not start at all.
         */
        if (!cognitiveServicesEndpoint) {
            throw fail(
                500,
                'SPEECH_NOT_CONFIGURED',
                'COGNITIVE_SERVICE_ENDPOINT is not set on the calling server, so parallel dialing is unavailable.'
            );
        }
        /**
         * Checked here because Azure's own answer to a malformed endpoint is a
         * bare "Invalid request", which says nothing about which setting is wrong.
         */
        if (!/^https:\/\/[^\s"'<>]+$/i.test(cognitiveServicesEndpoint)) {
            throw fail(
                500,
                'SPEECH_ENDPOINT_INVALID',
                'COGNITIVE_SERVICE_ENDPOINT on the calling server is not a plain https address. Check it has no quote ' +
                    'marks or spaces around it - Azure App Service settings keep quotes that a local .env file drops.'
            );
        }
        if (!organizationId) throw fail(400, 'MISSING_ORGANIZATION', 'organizationId is required.');
        if (!agentUserId || !String(agentUserId).startsWith('8:')) {
            throw fail(400, 'MISSING_AGENT', 'A valid agentUserId is required.');
        }
        if (!callerId) throw fail(400, 'MISSING_CALLER_ID', 'callerId is required.');
        if (!String(abandonMessage || '').trim()) {
            throw fail(400, 'MISSING_ABANDON_MESSAGE', 'An abandon message is required.');
        }

        if (verifyCallbackUrl) {
            const check = await verifyCallbackUrl();
            if (!check || !check.ok) {
                throw fail(
                    500,
                    'CALLBACK_URL_MISMATCH',
                    `Azure would send this session's call events to ${callbackBaseUrl}, but that address does not reach ` +
                        `this calling server${check && check.reason ? ` (${check.reason})` : ''}. Set CALLBACK_BASE_URL in ` +
                        "call_server's .env to this server's public address - a tunnel to its port when running locally."
                );
            }
        }

        const requestedLines = Math.round(Number(lines) || DEFAULT_LINES);
        // Enforced here as well as in the browser, so the ceiling cannot be
        // raised by calling this endpoint directly.
        const safeLines = Math.min(MAX_LINES, Math.max(1, requestedLines));

        const sessionId = newId('pd');
        const session = {
            sessionId,
            organizationId,
            userEmail: userEmail || '',
            agentUserId,
            callerId: String(callerId).trim(),
            lines: safeLines,
            ringTimeoutSeconds:
                voicemailMode === 'skip' ? SKIP_VOICEMAIL_RING_TIMEOUT_SECONDS : DEFAULT_RING_TIMEOUT_SECONDS,
            voicemailMode: voicemailMode === 'skip' ? 'skip' : 'leave',
            abandonMessage: String(abandonMessage).trim(),
            amdAvailable: true,
            state: 'connecting',
            error: '',
            callConnectionId: '',
            serverCallId: '',
            agentSeen: false,
            round: null,
            legs: new Map(),
            createdAt: now(),
            updatedAt: now(),
            lastSeenAt: now(),
            ringTimer: null,
        };
        sessions.set(sessionId, session);

        try {
            const result = await client.createCall(
                { targetParticipant: { communicationUserId: agentUserId } },
                `${callbackBaseUrl}/parallel/callbacks?session=${encodeURIComponent(sessionId)}`,
                {
                    operationContext: `pd-session:${sessionId}`,
                    callIntelligenceOptions: { cognitiveServicesEndpoint },
                }
            );

            const properties = result?.callConnectionProperties || {};
            session.callConnectionId = properties.callConnectionId || result?.callConnection?.callConnectionId || '';
            session.serverCallId = properties.serverCallId || '';

            if (!session.callConnectionId) throw new Error('createCall returned no callConnectionId');
        } catch (error) {
            session.state = 'failed';
            session.error = error.message;
            session.endedAt = now();
            log(`[parallel:${sessionId}] Azure refused the session call:`, describeAzureError(error));
            throw fail(502, 'SESSION_CALL_FAILED', `Could not ring the agent: ${describeAzureError(error)}`);
        }

        log(`[parallel:${sessionId}] ringing agent ${agentUserId} (${safeLines} line(s), ${session.voicemailMode} voicemails)`);
        return snapshot(session);
    }

    // ─── Rounds ──────────────────────────────────────────────────────────────

    /**
     * Ring a batch of leads at once.
     *
     * Refused while somebody from the previous round is still on the line: the
     * agent is talking to them, and anyone who answered now would be abandoned.
     */
    async function startRound(sessionId, leads) {
        const session = sessions.get(sessionId);
        if (!session) throw fail(404, 'SESSION_NOT_FOUND', 'That dialing session no longer exists.');
        if (session.state !== 'ready') {
            throw fail(409, 'SESSION_NOT_READY', `The session is ${session.state}, not ready to dial.`);
        }
        if (session.round && session.round.state !== 'settled') {
            throw fail(409, 'ROUND_IN_PROGRESS', 'The previous round is still in progress.');
        }

        const list = Array.isArray(leads) ? leads.filter((lead) => lead && digitsOf(lead.phoneNumber)) : [];
        if (list.length === 0) throw fail(400, 'NO_LEADS', 'At least one lead with a phone number is required.');
        if (list.length > session.lines) {
            throw fail(400, 'TOO_MANY_LEADS', `This session dials at most ${session.lines} lead(s) at once.`);
        }

        // The same number twice in one round would ring one phone twice.
        const seen = new Set();
        for (const lead of list) {
            const key = digitsOf(lead.phoneNumber);
            if (seen.has(key)) throw fail(400, 'DUPLICATE_NUMBER', 'The same number appears twice in this round.');
            seen.add(key);
        }

        const roundId = newId('rd');
        session.round = { roundId, state: 'ringing', winnerLegId: null, startedAt: now() };
        touch(session);

        const legs = list.map((lead) => {
            const leg = {
                legId: newId('lg'),
                roundId,
                leadId: String(lead.leadId || ''),
                name: String(lead.name || ''),
                phoneNumber: String(lead.phoneNumber).trim(),
                state: 'ringing',
                invitationId: '',
                invitedAt: now(),
                answeredAt: null,
                endedAt: null,
                ringSeconds: 0,
                talkSeconds: 0,
                amd: { verdict: 'pending', reason: '', greeting: '' },
                voicemail: { state: 'none' },
                seenInRoster: false,
                cancelRequested: false,
                error: '',
            };
            session.legs.set(leg.legId, leg);
            return leg;
        });

        const connection = connectionOf(session);

        await Promise.all(
            legs.map(async (leg) => {
                try {
                    const result = await connection.addParticipant(
                        {
                            targetParticipant: { phoneNumber: leg.phoneNumber },
                            sourceCallIdNumber: { phoneNumber: session.callerId },
                        },
                        {
                            // Longer than our own ring timeout, so it is our timer
                            // that ends a round and Azure's expiry is only a backstop.
                            invitationTimeoutInSeconds: session.ringTimeoutSeconds + 15,
                            operationContext: `pd-leg:${sessionId}:${leg.legId}`,
                        }
                    );
                    leg.invitationId = result?.invitationId || '';

                    // Answered before the invitation id came back: the cancel
                    // could not be sent at the time, so send it now.
                    if (leg.cancelRequested && leg.invitationId) {
                        await cancelInvite(session, leg);
                    }
                } catch (error) {
                    leg.state = 'failed';
                    leg.error = error.message;
                    leg.endedAt = now();
                    log(`[parallel:${sessionId}] could not ring ${leg.phoneNumber}: ${error.message}`);
                }
            })
        );

        settleRoundIfDone(session);

        if (session.round.state === 'ringing') {
            if (session.ringTimer) cancelScheduled(session.ringTimer);
            session.ringTimer = schedule(() => {
                ringTimedOut(sessionId, roundId).catch((error) =>
                    log(`[parallel:${sessionId}] ring timeout failed: ${error.message}`)
                );
            }, session.ringTimeoutSeconds * 1000);
        }

        log(`[parallel:${sessionId}] round ${roundId}: ringing ${legs.map((l) => l.phoneNumber).join(', ')}`);
        return snapshot(session);
    }

    async function cancelInvite(session, leg) {
        if (!leg.invitationId) return;
        try {
            await connectionOf(session).cancelAddParticipantOperation(leg.invitationId);
        } catch (error) {
            // Most often the phone answered a moment before the cancel arrived.
            // That shows up as an answer and is handled there.
            log(`[parallel:${session.sessionId}] cancel ${leg.phoneNumber} failed: ${error.message}`);
        }
    }

    /**
     * Stop a ringing line because somebody else answered.
     *
     * The label depends on how long it HAD rung, looking back - nothing keeps
     * ringing to find out.
     */
    async function cancelBecauseAnswered(session, leg) {
        leg.ringSeconds = secondsSince(leg.invitedAt);
        leg.state = leg.ringSeconds >= FAIR_RING_SECONDS ? 'no_answer' : 'cancelled';
        leg.endedAt = now();
        leg.cancelRequested = true;
        await cancelInvite(session, leg);
    }

    async function ringTimedOut(sessionId, roundId) {
        const session = sessions.get(sessionId);
        if (!session || !session.round || session.round.roundId !== roundId) return;
        session.ringTimer = null;
        if (session.round.state !== 'ringing') return;

        const ringing = legsOf(session, roundId).filter((leg) => leg.state === 'ringing');
        log(`[parallel:${sessionId}] nobody answered within ${session.ringTimeoutSeconds}s`);

        for (const leg of ringing) {
            leg.ringSeconds = secondsSince(leg.invitedAt);
            leg.state = 'no_answer';
            leg.endedAt = now();
            leg.cancelRequested = true;
            await cancelInvite(session, leg);
        }
        settleRoundIfDone(session);
    }

    /** A round is settled once nobody in it is ringing or on the line. */
    function settleRoundIfDone(session) {
        if (!session.round || session.round.state === 'settled') return;

        const roundLegs = legsOf(session, session.round.roundId);
        const busy = roundLegs.some((leg) => leg.state === 'ringing' || leg.state === 'connected');

        if (!busy) {
            session.round.state = 'settled';
            if (session.ringTimer) {
                cancelScheduled(session.ringTimer);
                session.ringTimer = null;
            }
        } else if (roundLegs.some((leg) => leg.state === 'connected')) {
            session.round.state = 'connected';
        }
        touch(session);
    }

    // ─── Somebody answered ───────────────────────────────────────────────────

    async function onAnswered(session, leg) {
        /**
         * Azure delivers events at least once. A repeat of the answer that made
         * this lead the winner must change nothing - treating it as a second,
         * late answer would put the person the agent is talking to on hold and
         * hang up on them mid-sentence.
         */
        if (session.round && session.round.winnerLegId === leg.legId) return;

        // A lead already finished - talked, voicemail left, or never reachable -
        // cannot meaningfully answer again; this is a stale repeat.
        if (['ended', 'voicemail', 'failed', 'busy', 'abandoned'].includes(leg.state)) return;

        // Too late: another line already won, or we had already given up on
        // this one. Either way the agent is not free for them.
        const roundWon = session.round && session.round.winnerLegId && session.round.winnerLegId !== leg.legId;
        if (roundWon || leg.state !== 'ringing' || session.state !== 'ready') {
            await abandon(session, leg);
            return;
        }

        session.round.winnerLegId = leg.legId;
        leg.state = 'connected';
        leg.answeredAt = now();
        leg.ringSeconds = secondsSince(leg.invitedAt, leg.answeredAt);

        if (session.ringTimer) {
            cancelScheduled(session.ringTimer);
            session.ringTimer = null;
        }

        log(`[parallel:${session.sessionId}] ${leg.phoneNumber} answered after ${leg.ringSeconds}s - connected to agent`);

        // Everybody else in the round stops ringing at once.
        const others = legsOf(session, leg.roundId).filter((other) => other.legId !== leg.legId && other.state === 'ringing');
        await Promise.all(others.map((other) => cancelBecauseAnswered(session, other)));

        settleRoundIfDone(session);
        await startVoicemailDetection(session, leg);
    }

    /**
     * Somebody answered while the agent was already busy.
     *
     * They are put ON HOLD with the organization's message as their hold audio,
     * then let go. Hold matters: this person has joined the agent's live call,
     * and merely playing them a message would leave them able to hear the
     * agent's conversation with somebody else - and the agent able to hear them.
     * On hold they hear only the message and nobody hears them.
     *
     * Hanging up on a person in silence is exactly what the abandoned-call rules
     * prohibit, so silence is never the fallback.
     */
    async function abandon(session, leg) {
        if (leg.state === 'abandoned') return;

        leg.state = 'abandoned';
        leg.answeredAt = leg.answeredAt || now();
        leg.ringSeconds = leg.ringSeconds || secondsSince(leg.invitedAt, leg.answeredAt);
        leg.endedAt = null;
        if (leg.abandonTimer) cancelScheduled(leg.abandonTimer);

        log(`[parallel:${session.sessionId}] ${leg.phoneNumber} answered while the agent was busy - playing the abandon message`);

        const source = { kind: 'textSource', text: session.abandonMessage, voiceName: ttsVoice };
        const operationContext = `pd-abandon:${session.sessionId}:${leg.legId}`;

        try {
            await mediaOf(session).hold({ phoneNumber: leg.phoneNumber }, { playSource: source, operationContext });
        } catch (holdError) {
            log(`[parallel:${session.sessionId}] hold failed for ${leg.phoneNumber} (${holdError.message}); playing to them directly`);
            if (!(await playAbandonDirectly(session, leg))) return;
        }

        leg.abandonTimer = schedule(() => {
            removeLeg(session, leg, 'abandoned').catch(() => {});
        }, abandonListenMs(session.abandonMessage));
    }

    /**
     * Second best, used only if hold is refused: play to them alone. They may
     * briefly hear the agent, which is still better than being hung up on in
     * silence. Returns false if even this failed and the lead has been removed.
     */
    async function playAbandonDirectly(session, leg) {
        try {
            await mediaOf(session).play(
                [{ kind: 'textSource', text: session.abandonMessage, voiceName: ttsVoice }],
                [{ phoneNumber: leg.phoneNumber }],
                { operationContext: `pd-abandon:${session.sessionId}:${leg.legId}` }
            );
            return true;
        } catch (playError) {
            log(`[parallel:${session.sessionId}] abandon message failed for ${leg.phoneNumber}: ${playError.message}`);
            await removeLeg(session, leg, 'abandoned');
            return false;
        }
    }

    // ─── Voicemail detection ─────────────────────────────────────────────────

    /**
     * Listen to the lead alone while the conversation carries on.
     *
     * Recognition is aimed at that one participant, so the agent's own voice is
     * never part of what is being classified.
     */
    async function startVoicemailDetection(session, leg) {
        try {
            await mediaOf(session).startRecognizing(
                { phoneNumber: leg.phoneNumber },
                {
                    kind: 'callMediaRecognizeSpeechOptions',
                    // Whole seconds only: a fractional value is refused outright.
                    initialSilenceTimeoutInSeconds: 3,
                    endSilenceTimeoutInSeconds: 0.5,
                    operationContext: `pd-amd:${session.sessionId}:${leg.legId}`,
                }
            );
        } catch (error) {
            // The call goes on regardless; the agent can still judge for
            // themselves. Detection is help, never a gate.
            leg.amd = { verdict: 'unavailable', reason: error.message, greeting: '' };
            log(`[parallel:${session.sessionId}] voicemail detection unavailable: ${error.message}`);
        }
    }

    /**
     * Turn what the lead said into something the agent can act on.
     *
     *   voicemail            a phrase only machines say - the browser offers to
     *                        drop the message automatically, with a cancel
     *   voicemail_suggested  sounds like one, but on weaker evidence - a hint only
     *   dead_number          carrier recording - the lead is removed
     *   human                nothing happens; the agent is already talking
     */
    async function recordVerdict(session, leg, { speech = '', confidence = null, silence = false }) {
        if (leg.state !== 'connected') return;

        const elapsedSeconds = secondsSince(leg.answeredAt);
        const result = classifyGreeting({ speech, confidence, elapsedSeconds, silence });

        let verdict = 'human';
        let reason = result.reason;

        if (result.classification === CLASSIFICATION.DEAD_NUMBER) {
            verdict = 'dead_number';
        } else if (result.classification === CLASSIFICATION.VOICEMAIL) {
            // Only a matched phrase is trusted enough to act on by itself.
            verdict = result.matched ? 'voicemail' : 'voicemail_suggested';
        } else if (leg.ringSeconds >= LATE_ANSWER_SECONDS && !silence) {
            verdict = 'voicemail_suggested';
            reason = `answered after ${leg.ringSeconds}s of ringing, which is typical of voicemail`;
        }

        leg.amd = { verdict, reason, greeting: String(speech || '').slice(0, 300) };
        log(`[parallel:${session.sessionId}] ${leg.phoneNumber} sounds like: ${verdict} (${reason})`);

        if (verdict === 'dead_number') {
            await removeLeg(session, leg, 'failed', 'Number not in service');
        }
    }

    // ─── Ending a lead ───────────────────────────────────────────────────────

    async function removeLeg(session, leg, finalState, error = '') {
        if (leg.abandonTimer) {
            cancelScheduled(leg.abandonTimer);
            leg.abandonTimer = null;
        }
        if (FINAL_STATES.includes(leg.state) && leg.endedAt) return;

        try {
            await connectionOf(session).removeParticipant({ phoneNumber: leg.phoneNumber });
        } catch (removeError) {
            // Already gone - they hung up, or the call ended.
            log(`[parallel:${session.sessionId}] remove ${leg.phoneNumber}: ${removeError.message}`);
        }

        finishLeg(session, leg, finalState, error);
    }

    function finishLeg(session, leg, finalState, error = '') {
        if (leg.endedAt && FINAL_STATES.includes(leg.state)) return;
        leg.talkSeconds = secondsSince(leg.answeredAt);
        leg.state = finalState;
        leg.endedAt = now();
        if (error) leg.error = error;
        settleRoundIfDone(session);
    }

    /** The agent finished the conversation. The session stays open. */
    async function endLead(sessionId, legId) {
        const session = sessions.get(sessionId);
        if (!session) throw fail(404, 'SESSION_NOT_FOUND', 'That dialing session no longer exists.');
        const leg = session.legs.get(legId);
        if (!leg) throw fail(404, 'LEG_NOT_FOUND', 'That lead is not part of this session.');

        if (leg.state === 'connected') {
            try {
                await mediaOf(session).cancelAllOperations();
            } catch {
                // Nothing was running.
            }
            await removeLeg(session, leg, leg.voicemail.state === 'completed' ? 'voicemail' : 'ended');
        }
        return snapshot(session);
    }

    /**
     * Leave the agent's recorded message on this lead's voicemail.
     *
     * Played to the lead alone, then the lead is removed. The existing voicemail
     * drop is NOT reused here on purpose: it ends the call for everyone when it
     * finishes, which would close the agent's whole session.
     */
    async function dropVoicemail(sessionId, legId, { voicemailUrl, voicemailId }) {
        const session = sessions.get(sessionId);
        if (!session) throw fail(404, 'SESSION_NOT_FOUND', 'That dialing session no longer exists.');
        const leg = session.legs.get(legId);
        if (!leg) throw fail(404, 'LEG_NOT_FOUND', 'That lead is not part of this session.');
        if (leg.state !== 'connected') throw fail(409, 'LEAD_NOT_CONNECTED', 'That lead is not on the line.');
        if (!voicemailUrl || !/^https:\/\//i.test(voicemailUrl)) {
            throw fail(400, 'INVALID_VOICEMAIL_URL', 'A public https voicemail URL is required.');
        }
        if (leg.voicemail.state === 'playing') return snapshot(session);

        try {
            // Voicemail detection may still be listening; it would be cut off
            // anyway, and stopping it first avoids the two colliding.
            await mediaOf(session).cancelAllOperations();
        } catch {
            // Nothing was running.
        }

        leg.voicemail = { state: 'playing', startedAt: now() };
        try {
            await mediaOf(session).play(
                [{ kind: 'fileSource', url: voicemailUrl, playSourceCacheId: voicemailId || undefined }],
                [{ phoneNumber: leg.phoneNumber }],
                { operationContext: `pd-vm:${sessionId}:${legId}` }
            );
        } catch (error) {
            leg.voicemail = { state: 'failed', error: error.message };
            throw fail(502, 'VOICEMAIL_FAILED', `Could not play the voicemail: ${error.message}`);
        }

        log(`[parallel:${sessionId}] leaving voicemail for ${leg.phoneNumber}`);
        return snapshot(session);
    }

    // ─── Ending the session ──────────────────────────────────────────────────

    async function endSession(sessionId, reason = 'ended by agent') {
        const session = sessions.get(sessionId);
        if (!session) throw fail(404, 'SESSION_NOT_FOUND', 'That dialing session no longer exists.');
        await shutDown(session, reason);
        return snapshot(session);
    }

    async function shutDown(session, reason) {
        if (session.state === 'ended' || session.state === 'failed') return;

        session.state = 'ended';
        session.endedAt = now();
        session.error = session.error || '';
        if (session.ringTimer) {
            cancelScheduled(session.ringTimer);
            session.ringTimer = null;
        }

        log(`[parallel:${session.sessionId}] ending session: ${reason}`);

        for (const leg of session.legs.values()) {
            if (leg.state === 'ringing') {
                leg.ringSeconds = secondsSince(leg.invitedAt);
                leg.state = leg.ringSeconds >= FAIR_RING_SECONDS ? 'no_answer' : 'cancelled';
                leg.endedAt = now();
                await cancelInvite(session, leg);
            } else if (leg.state === 'connected' || leg.state === 'abandoned') {
                finishLeg(session, leg, leg.state === 'abandoned' ? 'abandoned' : 'ended');
            }
            if (leg.abandonTimer) cancelScheduled(leg.abandonTimer);
        }

        if (session.round) session.round.state = 'settled';

        if (session.callConnectionId) {
            try {
                await connectionOf(session).hangUp(true);
            } catch (error) {
                log(`[parallel:${session.sessionId}] hang up: ${error.message}`);
            }
        }
    }

    // ─── Events from Azure ───────────────────────────────────────────────────

    const contextParts = (context) => String(context || '').split(':');

    function findSession(data, query) {
        const fromQuery = query && query.session ? sessions.get(query.session) : null;
        if (fromQuery) return fromQuery;

        const [, sessionId] = contextParts(data?.operationContext);
        if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);

        if (data?.callConnectionId) {
            for (const session of sessions.values()) {
                if (session.callConnectionId === data.callConnectionId) return session;
            }
        }
        return null;
    }

    /**
     * Route one Azure event.
     *
     * Every branch tolerates events arriving late, twice, or out of order:
     * Azure delivers at least once and makes no promise about sequence.
     */
    async function handleEvent(event, query = {}) {
        const type = String(event?.type || event?.eventType || '').replace('Microsoft.Communication.', '');
        const data = event?.data || {};
        const session = findSession(data, query);
        if (!session) return false;

        touch(session);

        /**
         * The session call's serverCallId.
         *
         * Azure does not return it when the call is created - it arrives with
         * the call's events. Recording needs it: without it every lead's
         * recording silently fails to start. Taken from the first event that
         * carries it.
         */
        if (!session.serverCallId && data.serverCallId) {
            session.serverCallId = data.serverCallId;
            log(`[parallel:${session.sessionId}] serverCallId known - recordings can start`);
        }

        const [kind, , legId] = contextParts(data.operationContext);
        const leg = legId ? session.legs.get(legId) : null;

        switch (type) {
            case 'CallConnected':
                if (session.state === 'connecting') {
                    session.state = 'ready';
                    log(`[parallel:${session.sessionId}] agent connected - ready to dial`);
                }
                // Belt and braces: if the event did not carry the serverCallId,
                // ask Azure for it now, before any lead connects and needs it.
                if (!session.serverCallId) {
                    try {
                        const connection = connectionOf(session);
                        if (typeof connection.getCallConnectionProperties === 'function') {
                            const properties = await connection.getCallConnectionProperties();
                            if (properties?.serverCallId) session.serverCallId = properties.serverCallId;
                        }
                    } catch (error) {
                        log(`[parallel:${session.sessionId}] could not read serverCallId: ${error.message}`);
                    }
                }
                return true;

            case 'CallDisconnected':
                await shutDown(session, 'the session call ended');
                return true;

            case 'CreateCallFailed':
                // Azure could not ring the agent at all. Reported as Azure gave
                // it, so the browser can show the real reason.
                session.state = 'failed';
                session.error = `Azure could not ring your browser: ${
                    data.resultInformation?.message || `code ${data.resultInformation?.code || 'unknown'}`
                }`;
                session.endedAt = now();
                log(`[parallel:${session.sessionId}] ${session.error}`);
                return true;

            case 'AddParticipantSucceeded':
                if (leg) await onAnswered(session, leg);
                return true;

            case 'AddParticipantFailed':
                if (leg && leg.state === 'ringing') {
                    leg.ringSeconds = secondsSince(leg.invitedAt);
                    leg.state = labelForFailure(data.resultInformation);
                    leg.endedAt = now();
                    leg.error = data.resultInformation?.message || '';
                    settleRoundIfDone(session);
                }
                return true;

            case 'ParticipantsUpdated':
                await onRosterChanged(session, data.participants || []);
                return true;

            case 'RecognizeCompleted':
                if (leg && kind === 'pd-amd') {
                    await recordVerdict(session, leg, {
                        speech: data.speechResult?.speech || data.recognizeResult?.speech || '',
                        confidence: data.speechResult?.confidence ?? null,
                    });
                }
                return true;

            case 'RecognizeFailed':
                if (leg && kind === 'pd-amd') {
                    // Silence on answering is read as a person waiting to be
                    // spoken to: hanging up on a human is the costlier mistake.
                    await recordVerdict(session, leg, { silence: true });
                }
                return true;

            case 'PlayCompleted':
                if (leg && kind === 'pd-abandon') {
                    await removeLeg(session, leg, 'abandoned');
                } else if (leg && kind === 'pd-vm') {
                    leg.voicemail = { state: 'completed' };
                    await removeLeg(session, leg, 'voicemail');
                }
                return true;

            case 'HoldFailed':
                if (leg && kind === 'pd-abandon' && leg.state === 'abandoned' && !leg.endedAt) {
                    log(`[parallel:${session.sessionId}] hold failed for ${leg.phoneNumber}; playing to them directly`);
                    await playAbandonDirectly(session, leg);
                }
                return true;

            case 'PlayFailed':
                if (leg && kind === 'pd-abandon') {
                    await removeLeg(session, leg, 'abandoned');
                } else if (leg && kind === 'pd-vm') {
                    // Left on the line: the agent can still speak to them.
                    leg.voicemail = { state: 'failed', error: data.resultInformation?.message || 'Playback failed' };
                }
                return true;

            default:
                return true;
        }
    }

    /**
     * Who is on the call right now.
     *
     * Notices the two departures nothing else reports: a lead hanging up on the
     * agent, and the agent's own browser leaving. A departure only counts once
     * the participant has been SEEN on the call, so an update that arrives
     * before the answer event cannot end a lead that is still joining.
     */
    async function onRosterChanged(session, participants) {
        const identities = participants.map((entry) => entry.identifier || entry);
        const phones = identities.map(phoneOf).filter(Boolean);
        const users = identities.map(userOf).filter(Boolean);

        const agentHere = users.includes(session.agentUserId);
        if (agentHere) session.agentSeen = true;
        if (session.agentSeen && !agentHere && session.state === 'ready') {
            // Awaited: until the ringing lines are cancelled, somebody could
            // still answer into a call with no agent in it.
            await shutDown(session, 'the agent left the call');
            return;
        }

        for (const leg of session.legs.values()) {
            if (leg.state !== 'connected') continue;
            const present = phones.some((phone) => samePhone(phone, leg.phoneNumber));
            if (present) {
                leg.seenInRoster = true;
            } else if (leg.seenInRoster) {
                log(`[parallel:${session.sessionId}] ${leg.phoneNumber} hung up`);
                finishLeg(session, leg, leg.voicemail.state === 'completed' ? 'voicemail' : 'ended');
            }
        }
    }

    // ─── Housekeeping ────────────────────────────────────────────────────────

    /**
     * End sessions whose browser has gone, and forget finished ones.
     *
     * A closed tab leaves the session call up with nobody watching it, and a
     * lead who answered into it would hear nothing. Anything not polled for a
     * minute is ended.
     */
    async function sweep() {
        for (const session of Array.from(sessions.values())) {
            const finished = session.state === 'ended' || session.state === 'failed';
            if (finished && now() - (session.endedAt || session.updatedAt) > ENDED_SESSION_TTL_MS) {
                sessions.delete(session.sessionId);
                continue;
            }
            if (!finished && now() - session.lastSeenAt > IDLE_SESSION_MS) {
                await shutDown(session, 'the browser stopped checking in');
            }
        }
    }

    return {
        startSession,
        startRound,
        getSession,
        endLead,
        dropVoicemail,
        endSession,
        handleEvent,
        sweep,
        // Exposed for tests and diagnostics.
        _sessions: sessions,
    };
}

module.exports = {
    createParallelDialer,
    describeAzureError,
    labelForFailure,
    phoneOf,
    userOf,
    samePhone,
    DEFAULT_LINES,
    MAX_LINES,
    FAIR_RING_SECONDS,
    DEFAULT_RING_TIMEOUT_SECONDS,
    SKIP_VOICEMAIL_RING_TIMEOUT_SECONDS,
    LATE_ANSWER_SECONDS,
    IDLE_SESSION_MS,
    abandonListenMs,
};
