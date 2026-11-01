// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CommunicationIdentityClient } = require('@azure/communication-identity');
const { CallAutomationClient } = require('@azure/communication-call-automation');
const appConfig = require('./config');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');
const { SpeechConfig, AudioConfig, SpeechRecognizer, PushAudioInputStream, AudioStreamFormat } = require('microsoft-cognitiveservices-speech-sdk');

ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize Call Automation Client for call transfer
let callAutomationClient = null;

const app = express();
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.requestId = requestId;
  const startTime = Date.now();
  
  console.log(`[${requestId}] ${req.method} ${req.path} - Started`);
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`[${requestId}] ${req.method} ${req.path} - Completed ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// String
const connectionString = process.env.ACS_CONNECTION_STRING; 
if (!connectionString) {
    console.error("Please set the ACS_CONNECTION_STRING in your .env file!");
    process.exit(1);
}

const identityClient = new CommunicationIdentityClient(connectionString);

// Initialize Call Automation Client
try {
  callAutomationClient = new CallAutomationClient(connectionString);
  console.log('Call Automation Client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Call Automation Client:', error.message);
}

// Configure multer with limits for concurrent uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
    files: 1
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Token generation endpoint - supports concurrent requests
app.get('/token', async (req, res) => {
  const requestId = req.requestId;
  
  try {
    console.log(`[${requestId}] Creating new ACS user and token`);
    
    // Each request gets its own user identity - perfectly fine for concurrent requests
    const user = await identityClient.createUser();
    const tokenResponse = await identityClient.getToken(user, ["voip"]);

    console.log(`[${requestId}] Token generated successfully for user: ${user.communicationUserId}`);

    res.json({
      userId: user.communicationUserId,
      token: tokenResponse.token,
      expiresOn: tokenResponse.expiresOn
    });
  } catch (error) {
    console.error(`[${requestId}] Error generating token:`, error.message);
    res.status(500).json({ 
      error: "Error generating token",
      message: error.message 
    });
  }
});

// Callbacks endpoint for Call Automation events (kept for future use)
// ─── Voicemail drop ─────────────────────────────────────────────────────────
//
// The Power Dialer places its calls from the browser, so Call Automation is not
// part of the call until an agent asks for a voicemail drop. At that point we
// attach to the ongoing call with connectCall(ServerCallLocator) and play the
// agent's pre-recorded greeting into it.
//
// State lives in memory on purpose: a drop is seconds long, and if this process
// restarts mid-drop the worst case is that the call simply carries on and the
// agent hangs up manually. Nothing is lost that a database would have saved.

const VOICEMAIL_DROPS = new Map();
const DROP_TTL_MS = 10 * 60 * 1000;

/**
 * A setting as a person typed it, minus the wrapping they did not mean.
 *
 * Locally, dotenv strips quotes around values. Azure App Service settings keep
 * them, so a line copied from .env - KEY="https://..." - arrives with the quote
 * characters as part of the value. Azure then refuses the URL with nothing more
 * than "Invalid request".
 */
const unquote = (value) =>
  String(value || '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();

// ACS must be able to reach this to deliver events, so it has to be the public
// URL of THIS service, not localhost. Set it in config.js; an environment
// variable still wins where one exists, so a deployed host can override without
// editing code.
const CALLBACK_BASE_URL = unquote(
  process.env.CALLBACK_BASE_URL || appConfig.CALLBACK_BASE_URL || ''
).replace(/\/+$/, '');

const pruneDrops = () => {
  const cutoff = Date.now() - DROP_TTL_MS;
  for (const [id, drop] of VOICEMAIL_DROPS) {
    if (drop.updatedAt < cutoff) VOICEMAIL_DROPS.delete(id);
  }
};

const setDropState = (dropId, state, extra = {}) => {
  const drop = VOICEMAIL_DROPS.get(dropId);
  if (!drop) return null;

  Object.assign(drop, extra, { state, updatedAt: Date.now() });

  // Stamp each stage so the log shows where the delay between the agent's click
  // and the greeting actually goes, rather than leaving it to guesswork.
  drop.timings = drop.timings || {};
  if (drop.timings[state] === undefined) drop.timings[state] = Date.now() - drop.startedAt;

  const since = `+${Date.now() - drop.startedAt}ms`;
  console.log(`[voicemail:${dropId}] -> ${state} ${since}${extra.error ? ` (${extra.error})` : ''}`);
  return drop;
};

const findDropByConnection = (callConnectionId) => {
  if (!callConnectionId) return null;
  for (const drop of VOICEMAIL_DROPS.values()) {
    if (drop.callConnectionId === callConnectionId) return drop;
  }
  return null;
};

/** End our leg (and the call) once the greeting has finished or failed. */
const finishDrop = async (drop, state, error) => {
  setDropState(drop.dropId, state, error ? { error } : {});

  const t = drop.timings || {};
  console.log(
    `[voicemail:${drop.dropId}] BREAKDOWN  connectCall=${t.connectCallReturned ?? '?'}ms  ` +
    `callConnected=${t.playing ?? '?'}ms  finished=${t[state] ?? '?'}ms  ` +
    `(playback itself = ${(t[state] ?? 0) - (t.playing ?? 0)}ms)`
  );

  try {
    if (drop.callConnectionId) {
      await callAutomationClient.getCallConnection(drop.callConnectionId).hangUp(true);
    }
  } catch (hangUpError) {
    // The call may already be gone; that is the outcome we wanted anyway.
    console.log(`[voicemail:${drop.dropId}] hangUp skipped: ${hangUpError.message}`);
  }
};

/**
 * Start a voicemail drop on a call the browser is already on.
 *
 * Returns immediately with a dropId; progress arrives asynchronously through
 * /callbacks and can be polled from /voicemail/drop/:dropId.
 */
app.post('/voicemail/drop', async (req, res) => {
  const requestId = req.requestId;
  pruneDrops();

  try {
    const { serverCallId, voicemailUrl, voicemailId, targetPhone, organizationId, userEmail, leadId } = req.body || {};

    if (!callAutomationClient) {
      return res.status(503).json({ success: false, code: 'CALL_AUTOMATION_UNAVAILABLE', message: 'Call Automation is not configured.' });
    }
    if (!serverCallId) {
      return res.status(400).json({ success: false, code: 'MISSING_SERVER_CALL_ID', message: 'serverCallId is required.' });
    }
    if (!voicemailUrl || !/^https:\/\//i.test(voicemailUrl)) {
      return res.status(400).json({ success: false, code: 'INVALID_VOICEMAIL_URL', message: 'A public https voicemail URL is required.' });
    }
    if (!CALLBACK_BASE_URL || !/^https:\/\//i.test(CALLBACK_BASE_URL)) {
      console.error(`[${requestId}] CALLBACK_BASE_URL is not set to a public https URL`);
      return res.status(500).json({
        success: false,
        code: 'CALLBACK_URL_NOT_CONFIGURED',
        message: 'This server is not configured with a public callback URL.',
      });
    }

    const dropId = `vm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    VOICEMAIL_DROPS.set(dropId, {
      dropId,
      state: 'connecting',
      serverCallId,
      voicemailUrl,
      voicemailId: voicemailId || dropId,
      targetPhone: targetPhone || null,
      organizationId: organizationId || null,
      userEmail: userEmail || null,
      leadId: leadId || null,
      callConnectionId: null,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });

    console.log(`[${requestId}] [voicemail:${dropId}] connecting to serverCallId ${serverCallId}`);

    let connectResult;
    try {
      connectResult = await callAutomationClient.connectCall(
        { kind: 'serverCallLocator', id: serverCallId },
        `${CALLBACK_BASE_URL}/callbacks`,
        { operationContext: dropId }
      );
    } catch (connectError) {
      setDropState(dropId, 'failed', { error: connectError.message });
      console.error(`[${requestId}] [voicemail:${dropId}] connectCall failed:`, connectError.message);
      return res.status(502).json({
        success: false,
        code: 'CONNECT_FAILED',
        message: 'Could not attach to the call to play the voicemail.',
        data: { dropId },
      });
    }

    const callConnectionId =
      connectResult?.callConnectionProperties?.callConnectionId ||
      connectResult?.callConnection?.callConnectionId ||
      null;

    const drop = VOICEMAIL_DROPS.get(dropId);
    if (drop) {
      drop.timings = drop.timings || {};
      drop.timings.connectCallReturned = Date.now() - drop.startedAt;
      console.log(`[voicemail:${dropId}] connectCall returned +${drop.timings.connectCallReturned}ms`);
    }

    setDropState(dropId, 'connecting', { callConnectionId });

    return res.status(202).json({ success: true, data: { dropId, callConnectionId } });
  } catch (error) {
    console.error(`[${requestId}] Voicemail drop error:`, error.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal server error.' });
  }
});

/** Progress for one drop, polled by the dialer while it waits. */
app.get('/voicemail/drop/:dropId', (req, res) => {
  const drop = VOICEMAIL_DROPS.get(req.params.dropId);
  if (!drop) {
    return res.status(404).json({ success: false, message: 'Unknown drop' });
  }
  return res.status(200).json({
    success: true,
    data: {
      dropId: drop.dropId,
      state: drop.state,
      error: drop.error,
      elapsedMs: Date.now() - drop.startedAt,
      timings: drop.timings || {},
    },
  });
});

/**
 * Drive one drop forward from a Call Automation event.
 * Returns true when the event belonged to a drop.
 */
const handleVoicemailDropEvent = async (type, data) => {
  const operationContext = data && data.operationContext;
  const callConnectionId = data && data.callConnectionId;

  const drop =
    (operationContext && VOICEMAIL_DROPS.get(operationContext)) || findDropByConnection(callConnectionId);

  if (!drop) return false;

  if (callConnectionId && !drop.callConnectionId) {
    drop.callConnectionId = callConnectionId;
  }

  switch (type) {
    case 'Microsoft.Communication.CallConnected': {
      if (drop.state !== 'connecting') return true;
      setDropState(drop.dropId, 'playing');

      try {
        // playToAll rather than a targeted play: the agent is muted and waiting,
        // so hearing the greeting confirms it actually went out, and it avoids
        // depending on an exact participant identifier match.
        await callAutomationClient
          .getCallConnection(drop.callConnectionId)
          .getCallMedia()
          .playToAll(
            [{ kind: 'fileSource', url: drop.voicemailUrl, playSourceCacheId: drop.voicemailId }],
            { operationContext: drop.dropId, loop: false }
          );
      } catch (playError) {
        await finishDrop(drop, 'failed', playError.message);
      }
      return true;
    }

    case 'Microsoft.Communication.PlayCompleted':
      await finishDrop(drop, 'completed');
      return true;

    case 'Microsoft.Communication.PlayFailed':
      await finishDrop(drop, 'failed', (data && data.resultInformation && data.resultInformation.message) || 'Play failed');
      return true;

    case 'Microsoft.Communication.ConnectFailed':
      setDropState(drop.dropId, 'failed', { error: 'Could not connect to the call' });
      return true;

    case 'Microsoft.Communication.CallDisconnected':
      // Completion already hung up; anything else means the call ended early.
      if (drop.state !== 'completed') {
        setDropState(drop.dropId, drop.state === 'playing' ? 'interrupted' : 'failed');
      }
      return true;

    default:
      return true;
  }
};

// ─── Force-remove a participant ──────────────────────────────────────────────
//
// The browser Calling SDK cannot reliably drop a PSTN participant that has not
// answered yet. While an invite sits in Connecting/Ringing, removeParticipant
// and hangUp are both known to be no-ops against PSTN legs, so a number that
// simply rings forever - one with no voicemail to answer it - can be neither
// removed from the roster nor stopped from ringing.
//
// Call Automation has no such restriction. We attach to the live call with the
// same connectCall(ServerCallLocator) the voicemail drop uses, and remove the
// participant server-side. Nothing else about the call is disturbed: the other
// legs carry on.
// ─── Conference invitations ──────────────────────────────────────────────────
//
// Conference legs are invited from here rather than from the browser, for one
// reason: a pending invite can only be cancelled with the invitationId that
// Call Automation's addParticipant returns, and the browser Calling SDK never
// surfaces one. An invite sent from the browser therefore cannot be cancelled
// while it is still ringing - removeParticipant only works once the person has
// answered - which is why a number with no voicemail rang forever.
//
// Holding the invitationId here makes "Remove" work in every state: cancel the
// invitation while it rings, remove the participant once they are on the call.

const CONFERENCE_INVITES = new Map();
const INVITE_TTL_MS = 30 * 60 * 1000;

const inviteKey = (serverCallId, phoneNumber) =>
  `${serverCallId}::${String(phoneNumber).replace(/\D/g, '')}`;

const rememberInvite = (serverCallId, phoneNumber, value) => {
  CONFERENCE_INVITES.set(inviteKey(serverCallId, phoneNumber), { ...value, at: Date.now() });

  // Opportunistic cleanup; these entries are only useful while a call is live.
  for (const [key, entry] of CONFERENCE_INVITES) {
    if (Date.now() - entry.at > INVITE_TTL_MS) CONFERENCE_INVITES.delete(key);
  }
};

/**
 * Attach to an in-progress call, retrying until the connection is usable.
 *
 * connectCall resolves before the connection can be acted on - the voicemail
 * drop waits for the CallConnected event for exactly this reason. Probing with
 * listParticipants is a cheap stand-in for that wait.
 */
async function connectAndWait(serverCallId, operationContext, requestId) {
  const connectResult = await callAutomationClient.connectCall(
    { kind: 'serverCallLocator', id: serverCallId },
    `${CALLBACK_BASE_URL}/callbacks`,
    { operationContext }
  );

  const callConnectionId =
    connectResult?.callConnectionProperties?.callConnectionId ||
    connectResult?.callConnection?.callConnectionId ||
    null;

  if (!callConnectionId) throw new Error('connectCall returned no callConnectionId');

  const connection = callAutomationClient.getCallConnection(callConnectionId);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await connection.listParticipants();
      return { connection, callConnectionId };
    } catch (notReady) {
      if (attempt === 10) {
        console.error(`[${requestId}] connection never became usable: ${notReady.message}`);
        throw notReady;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  throw new Error('connection never became usable');
}

app.post('/participant/add', async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 8);

  try {
    const { serverCallId, phoneNumber, callerId } = req.body || {};

    if (!serverCallId) {
      return res.status(400).json({ success: false, code: 'MISSING_SERVER_CALL_ID', message: 'serverCallId is required.' });
    }
    if (!phoneNumber) {
      return res.status(400).json({ success: false, code: 'MISSING_PHONE_NUMBER', message: 'phoneNumber is required.' });
    }
    if (!callerId) {
      return res.status(400).json({ success: false, code: 'MISSING_CALLER_ID', message: 'callerId is required for a PSTN invite.' });
    }
    if (!CALLBACK_BASE_URL) {
      return res.status(500).json({ success: false, code: 'NO_CALLBACK_URL', message: 'This server is not configured with a public callback URL.' });
    }

    const target = String(phoneNumber).trim();

    // An invitation for this number is already outstanding on this call. Sending
    // a second one makes the phone ring twice from two live invitations, and
    // cancelling one leaves the other going - which is exactly what happens when
    // an agent, seeing nothing on screen, presses Add again.
    const outstanding = CONFERENCE_INVITES.get(inviteKey(serverCallId, target));
    if (outstanding && outstanding.invitationId && Date.now() - outstanding.at < 3 * 60 * 1000) {
      console.log(`[${requestId}] [invite] ${target} already has invitation ${outstanding.invitationId}; not inviting again`);
      return res.status(200).json({
        success: true,
        alreadyInvited: true,
        data: { invitationId: outstanding.invitationId, callConnectionId: outstanding.callConnectionId, phoneNumber: target },
      });
    }

    console.log(`[${requestId}] [invite] inviting ${target} to serverCallId ${serverCallId}`);

    let connection;
    let callConnectionId;
    try {
      ({ connection, callConnectionId } = await connectAndWait(serverCallId, `invite-${requestId}`, requestId));
    } catch (connectError) {
      console.error(`[${requestId}] [invite] connect failed:`, connectError.message);
      return res.status(502).json({ success: false, code: 'CONNECT_FAILED', message: connectError.message });
    }

    try {
      const result = await connection.addParticipant(
        {
          targetParticipant: { phoneNumber: target },
          sourceCallIdNumber: { phoneNumber: String(callerId).trim() },
        },
        // Deliberately longer than the panel's own 45s ring deadline, so the
        // cancel from the UI is what ends the invite rather than racing an
        // expiry that has already happened. ACS giving up at 90s is the
        // backstop if the browser never gets to ask.
        { invitationTimeoutInSeconds: 90, operationContext: `invite-${requestId}` }
      );

      const invitationId = result?.invitationId || '';
      rememberInvite(serverCallId, target, { invitationId, callConnectionId });

      console.log(`[${requestId}] [invite] invited ${target}, invitationId=${invitationId || 'none'}`);
      return res.status(200).json({ success: true, data: { invitationId, callConnectionId, phoneNumber: target } });
    } catch (addError) {
      console.error(`[${requestId}] [invite] addParticipant failed:`, addError.message);
      return res.status(502).json({ success: false, code: 'ADD_FAILED', message: addError.message });
    }
  } catch (error) {
    console.error(`[${requestId}] [invite] error:`, error.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Cancel an invitation that is still ringing. This is the only operation that
// stops a PSTN phone that has not answered yet.
app.post('/participant/cancel', async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 8);

  try {
    const { serverCallId, phoneNumber } = req.body || {};

    if (!serverCallId || !phoneNumber) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'serverCallId and phoneNumber are required.' });
    }

    const remembered = CONFERENCE_INVITES.get(inviteKey(serverCallId, phoneNumber));
    if (!remembered || !remembered.invitationId) {
      // The invite did not come from here, so there is no invitationId to use.
      console.log(`[${requestId}] [cancel] no invitation on record for ${phoneNumber}`);
      return res.status(404).json({
        success: false,
        code: 'NO_INVITATION',
        message: 'This participant was not invited by the server, so the invitation cannot be cancelled.',
      });
    }

    console.log(`[${requestId}] [cancel] cancelling invitation ${remembered.invitationId} for ${phoneNumber}`);

    try {
      await callAutomationClient
        .getCallConnection(remembered.callConnectionId)
        .cancelAddParticipantOperation(remembered.invitationId);

      CONFERENCE_INVITES.delete(inviteKey(serverCallId, phoneNumber));
      console.log(`[${requestId}] [cancel] cancelled`);
      return res.status(200).json({ success: true, data: { cancelled: true, phoneNumber } });
    } catch (cancelError) {
      const message = String(cancelError.message || '');
      console.error(`[${requestId}] [cancel] failed:`, message);

      // Already answered or already gone: nothing left to cancel, and the
      // caller should fall through to removing the participant instead.
      return res.status(409).json({ success: false, code: 'CANCEL_FAILED', message });
    }
  } catch (error) {
    console.error(`[${requestId}] [cancel] error:`, error.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/participant/remove', async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 8);

  try {
    const { serverCallId, phoneNumber } = req.body || {};

    if (!serverCallId) {
      return res.status(400).json({ success: false, code: 'MISSING_SERVER_CALL_ID', message: 'serverCallId is required.' });
    }
    if (!phoneNumber) {
      return res.status(400).json({ success: false, code: 'MISSING_PHONE_NUMBER', message: 'phoneNumber is required.' });
    }
    if (!CALLBACK_BASE_URL) {
      return res.status(500).json({ success: false, code: 'NO_CALLBACK_URL', message: 'This server is not configured with a public callback URL.' });
    }

    const target = String(phoneNumber).trim();
    const targetDigits = target.replace(/\D/g, '');
    console.log(`[${requestId}] [remove] removing ${target} from serverCallId ${serverCallId}`);

    let connectResult;
    try {
      connectResult = await callAutomationClient.connectCall(
        { kind: 'serverCallLocator', id: serverCallId },
        `${CALLBACK_BASE_URL}/callbacks`,
        { operationContext: `remove-${requestId}` }
      );
    } catch (connectError) {
      console.error(`[${requestId}] [remove] connectCall failed:`, connectError.message);
      return res.status(502).json({
        success: false,
        code: 'CONNECT_FAILED',
        message: 'Could not attach to the call to remove the participant.',
      });
    }

    const callConnectionId =
      connectResult?.callConnectionProperties?.callConnectionId ||
      connectResult?.callConnection?.callConnectionId ||
      null;

    if (!callConnectionId) {
      console.error(`[${requestId}] [remove] connectCall returned no callConnectionId`);
      return res.status(502).json({ success: false, code: 'NO_CONNECTION', message: 'Could not attach to the call.' });
    }

    const connection = callAutomationClient.getCallConnection(callConnectionId);

    /** Is the target still on the call, according to the service itself? */
    const stillPresent = async () => {
      try {
        const roster = await connection.listParticipants();
        const values = roster?.values || roster?.participants || [];
        return values.some((participant) => {
          const id = participant?.identifier || {};
          const number = id.phoneNumber || id.rawId || '';
          return String(number).replace(/\D/g, '') === targetDigits;
        });
      } catch (listError) {
        // Cannot see the roster yet - assume still there and keep trying.
        console.log(`[${requestId}] [remove] listParticipants not ready: ${listError.message}`);
        return true;
      }
    };

    /**
     * connectCall returns before the connection is usable - the voicemail drop
     * waits for the CallConnected event for exactly this reason. Rather than
     * run a whole state machine for one operation, retry until the service
     * accepts it, and confirm against listParticipants rather than trusting the
     * call to have worked.
     */
    const MAX_ATTEMPTS = 12;
    const RETRY_DELAY_MS = 1000;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await connection.removeParticipant({ phoneNumber: target });
        console.log(`[${requestId}] [remove] removeParticipant accepted on attempt ${attempt}`);
      } catch (removeError) {
        lastError = String(removeError.message || removeError);
        console.log(`[${requestId}] [remove] attempt ${attempt} failed: ${lastError}`);
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

      if (!(await stillPresent())) {
        console.log(`[${requestId}] [remove] ${target} is off the call after ${attempt} attempt(s)`);

        // Leave the call ourselves without ending it for anyone else.
        try {
          await connection.hangUp(false);
        } catch (leaveError) {
          console.log(`[${requestId}] [remove] could not detach: ${leaveError.message}`);
        }

        return res.status(200).json({ success: true, data: { removed: true, phoneNumber: target, attempts: attempt } });
      }
    }

    console.error(`[${requestId}] [remove] gave up after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`);

    try {
      await connection.hangUp(false);
    } catch (leaveError) {
      console.log(`[${requestId}] [remove] could not detach: ${leaveError.message}`);
    }

    return res.status(502).json({
      success: false,
      code: 'REMOVE_FAILED',
      message: lastError || 'The participant could not be removed from the call.',
    });
  } catch (error) {
    console.error(`[${requestId}] [remove] error:`, error.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/callbacks', async (req, res) => {
  const requestId = req.requestId;
  
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    
    for (const event of events) {
      console.log(`[${requestId}] Received callback event:`, event.type || 'unknown');

      // Voicemail drops own their events; everything else falls through to the
      // original logging below so existing behaviour is unchanged.
      try {
        const handled = await handleVoicemailDropEvent(event.type, event.data || event);
        if (handled) continue;
      } catch (dropError) {
        console.error(`[${requestId}] Voicemail drop event error:`, dropError.message);
      }
      
      // Handle different event types as needed
      if (event.type === 'Microsoft.Communication.CallConnected') {
        console.log(`[${requestId}] Call connected`);
      } else if (event.type === 'Microsoft.Communication.CallDisconnected') {
        console.log(`[${requestId}] Call disconnected`);
      } else if (event.type === 'Microsoft.Communication.CallTransferAccepted') {
        console.log(`[${requestId}] Call transfer accepted`);
      } else if (event.type === 'Microsoft.Communication.CallTransferFailed') {
        console.log(`[${requestId}] Call transfer failed`);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error(`[${requestId}] Callback error:`, error);
    res.sendStatus(500);
  }
});

// ─── Parallel dialer ────────────────────────────────────────────────────────
//
// One agent, several phones ringing at once, first answer is put straight
// through. The engine lives in lib/parallel-dialer.js; these routes only adapt
// it to HTTP. Everything here is on new paths with its own callback URL, so the
// voicemail drop, conference invites and /callbacks above are untouched.
//
// Needs COGNITIVE_SERVICE_ENDPOINT (the same value the campaign service uses):
// it is what speaks the message to a lead who answers while the agent is busy,
// and what listens for voicemail. Without it a session refuses to start.
const { createParallelDialer } = require('./lib/parallel-dialer');

/**
 * Identifies THIS running process, so a session can check that the address
 * Azure will call back on actually leads here.
 *
 * Without the check, a callback address pointing at the wrong server - the
 * production URL while testing locally, or a tunnel that has since changed -
 * means the agent's browser is rung and joins, and the session then waits
 * forever for an event that was delivered somewhere else.
 */
const PARALLEL_INSTANCE_ID = require('crypto').randomUUID();

app.get('/parallel/ping', (req, res) => {
  res.status(200).json({ success: true, instanceId: PARALLEL_INSTANCE_ID });
});

const verifyParallelCallbackUrl = async () => {
  // Node without fetch cannot run the check; it must not block dialing.
  if (typeof fetch !== 'function') return { ok: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${CALLBACK_BASE_URL}/parallel/ping`, {
      // ngrok shows browsers a warning page; this skips it for the check.
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return { ok: false, reason: 'the server there does not have the parallel dialer - it answered 404' };
    }
    if (!response.ok) return { ok: false, reason: `it answered ${response.status}` };

    const body = await response.json().catch(() => null);
    if (!body || body.instanceId !== PARALLEL_INSTANCE_ID) {
      return { ok: false, reason: 'a different calling server answered' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error.name === 'AbortError' ? 'it did not answer within 6 seconds' : `it could not be reached: ${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

console.log(`[parallel] Azure will send session events to ${CALLBACK_BASE_URL}/parallel/callbacks`);

const parallelDialer = createParallelDialer({
  client: callAutomationClient,
  callbackBaseUrl: CALLBACK_BASE_URL,
  cognitiveServicesEndpoint: unquote(process.env.COGNITIVE_SERVICE_ENDPOINT),
  ttsVoice: process.env.TTS_VOICE || 'en-US-JennyNeural',
  verifyCallbackUrl: verifyParallelCallbackUrl,
});

// Ends sessions whose browser has gone away, so a closed tab cannot leave a
// call up that a lead might answer into.
setInterval(() => {
  parallelDialer.sweep().catch((error) => console.error('[parallel] sweep failed:', error.message));
}, 15000).unref();

const sendParallelError = (res, error) => {
  if (!error.status) console.error('[parallel] unexpected error:', error);
  return res.status(error.status || 500).json({
    success: false,
    code: error.code || 'INTERNAL_ERROR',
    message: error.status ? error.message : 'Internal server error',
  });
};

const parallelRoute = (handler) => async (req, res) => {
  try {
    const data = await handler(req);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendParallelError(res, error);
  }
};

app.post('/parallel/session', parallelRoute((req) => parallelDialer.startSession(req.body || {})));

app.get('/parallel/session/:sessionId', parallelRoute((req) => parallelDialer.getSession(req.params.sessionId)));

app.post(
  '/parallel/session/:sessionId/round',
  parallelRoute((req) => parallelDialer.startRound(req.params.sessionId, (req.body || {}).leads))
);

app.post(
  '/parallel/session/:sessionId/leads/:legId/end',
  parallelRoute((req) => parallelDialer.endLead(req.params.sessionId, req.params.legId))
);

app.post(
  '/parallel/session/:sessionId/leads/:legId/voicemail',
  parallelRoute((req) => parallelDialer.dropVoicemail(req.params.sessionId, req.params.legId, req.body || {}))
);

app.post('/parallel/session/:sessionId/end', parallelRoute((req) => parallelDialer.endSession(req.params.sessionId)));

// Azure posts session events here. CloudEvents arrive with their own content
// type, which the global JSON parser ignores, so this route reads both.
app.post(
  '/parallel/callbacks',
  express.json({ type: ['application/json', 'application/cloudevents+json', 'application/cloudevents-batch+json'] }),
  async (req, res) => {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      try {
        await parallelDialer.handleEvent(event, req.query || {});
      } catch (error) {
        console.error('[parallel] event failed:', (event && (event.type || event.eventType)) || 'unknown', error.message);
      }
    }
    // Always acknowledged: Azure retries anything else, and one odd event must
    // not be redelivered forever.
    res.sendStatus(200);
  }
);

// Function to convert webm to PCM buffer - handles concurrent conversions
const convertWebmToPcm = (webmBuffer, requestId) => {
  return new Promise((resolve, reject) => {
    const timeoutMs = 30000; // 30 second timeout
    let isResolved = false;
    
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.error(`[${requestId}] FFmpeg conversion timeout after ${timeoutMs}ms`);
        reject(new Error('Audio conversion timeout'));
      }
    }, timeoutMs);
    
    const inputStream = new PassThrough();
    inputStream.end(webmBuffer);

    const pcmChunks = [];

    console.log(`[${requestId}] Starting audio conversion (${(webmBuffer.length / 1024).toFixed(2)} KB)`);

    ffmpeg(inputStream)
      .inputFormat('webm')
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('s16le')
      .on('error', (err) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          console.error(`[${requestId}] Error converting audio:`, err.message);
          reject(err);
        }
      })
      .pipe()
      .on('data', (chunk) => {
        pcmChunks.push(chunk);
      })
      .on('end', () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          const totalSize = (Buffer.concat(pcmChunks).length / 1024).toFixed(2);
          console.log(`[${requestId}] Audio conversion completed (${totalSize} KB PCM)`);
          resolve(Buffer.concat(pcmChunks));
        }
      })
      .on('error', (err) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          console.error(`[${requestId}] Error in ffmpeg pipe:`, err.message);
          reject(err);
        }
      });
  });
};

// STT endpoint - handles concurrent transcription requests
app.post('/stt', upload.single('audio'), async (req, res) => {
  const requestId = req.requestId;
  let recognizer = null;
  
  try {
    const speechKey = process.env.SPEECH_KEY;
    const speechRegion = process.env.SPEECH_REGION;

    if (!speechKey || !speechRegion) {
      console.error(`[${requestId}] Speech service credentials not configured`);
      return res.status(500).json({ error: 'Speech service credentials not set.' });
    }

    if (!req.file || !req.file.buffer) {
      console.error(`[${requestId}] No audio file provided`);
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const audioBuffer = req.file.buffer;
    console.log(`[${requestId}] Received audio file: ${req.file.originalname || 'unnamed'} (${(audioBuffer.length / 1024).toFixed(2)} KB)`);

    // Convert webm to PCM - each request gets its own conversion
    const pcmBuffer = await convertWebmToPcm(audioBuffer, requestId);

    // Create a push stream with the correct format
    const format = AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    const pushStream = PushAudioInputStream.createPushStream(format);

    // Write the PCM buffer to the push stream
    pushStream.write(pcmBuffer);
    pushStream.close();

    const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = "en-US";

    const audioConfig = AudioConfig.fromStreamInput(pushStream);
    recognizer = new SpeechRecognizer(speechConfig, audioConfig);

    console.log(`[${requestId}] Starting speech recognition`);

    // Wrap in promise with timeout for better error handling
    const transcriptionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Speech recognition timeout'));
      }, 60000); // 60 second timeout

      recognizer.recognizeOnceAsync(
        result => {
          clearTimeout(timeout);
          let text = '';
          if (result && result.text) {
            text = result.text;
          }
          console.log(`[${requestId}] Transcription completed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
          resolve(text);
        },
        error => {
          clearTimeout(timeout);
          console.error(`[${requestId}] Speech recognition error:`, error);
          reject(error);
        }
      );
    });

    const text = await transcriptionPromise;
    
    // Clean up recognizer
    if (recognizer) {
      recognizer.close();
      recognizer = null;
    }

    return res.json({ text, requestId });

  } catch (error) {
    console.error(`[${requestId}] Transcription error:`, error.message);
    
    // Clean up recognizer on error
    if (recognizer) {
      try {
        recognizer.close();
      } catch (closeError) {
        console.error(`[${requestId}] Error closing recognizer:`, closeError.message);
      }
    }
    
    res.status(500).json({ 
      error: 'Transcription error',
      message: error.message,
      requestId
    });
  }
});

// Error handling for uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const port = process.env.PORT || 8081;
const server = app.listen(port, () => {
  console.log(`🚀 Call Server is running on port ${port}`);
  console.log(`📞 Token endpoint: http://localhost:${port}/token`);
  console.log(`🎙️  STT endpoint: http://localhost:${port}/stt`);
  console.log(`📲 Callbacks endpoint: http://localhost:${port}/callbacks`);
  console.log(`💚 Health check: http://localhost:${port}/health`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});