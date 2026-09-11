// APIs and other constants

/**
 * Public URL that Azure Communication Services calls back on.
 *
 * A voicemail drop attaches to a live call and then waits for ACS to POST
 * CallConnected and PlayCompleted to `${CALLBACK_BASE_URL}/callbacks`. Azure
 * reaches this from the public internet, so it can never be localhost — during
 * local development it has to be a tunnel pointing at this service's port.
 *
 * This file is CommonJS, so everything here is `const` + module.exports.
 * There is no `export` keyword; switch environments by changing which constant
 * is assigned below, not by commenting lines in and out.
 */

const PRODUCTION = 'https://callingservermanualmain-bfc9apaffzcnbybm.centralus-01.azurewebsites.net';

// ngrok free URLs change every restart, so expect to update this each session.
const LOCAL_TUNNEL = 'https://1ae2-103-106-235-210.ngrok-free.app';

// ─── Switch this one line: PRODUCTION or LOCAL_TUNNEL ───────────────────────
const CALLBACK_BASE_URL = PRODUCTION;

module.exports = {
  CALLBACK_BASE_URL,
  PRODUCTION,
  LOCAL_TUNNEL,
};
