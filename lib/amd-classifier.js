/**
 * MIRRORED - keep identical to growoutly_campagin_server/lib/classifier.js
 *
 * The parallel dialer needs the same answering-machine heuristic the campaign
 * service uses. The two services deploy separately and share no code, so the
 * file is copied rather than imported. It is a pure function with no
 * dependencies; when the phrase lists are tuned in one place, copy them here.
 */
/**
 * Working out what picked up the phone.
 *
 * Azure Communication Services has no answering-machine detection, so this
 * reads the greeting instead: whatever the line says in its first couple of
 * seconds is recognised as speech, and matched against the things machines say
 * and people do not.
 *
 * It is a heuristic and it is honest about that. Keyword hits are high
 * precision - a line that says "leave a message after the tone" is certainly a
 * machine - but a mailbox greeting of "Hi, it's Dave, you know what to do" has
 * nothing to match on and sounds like a person. Every verdict is stored on the
 * target along with the raw greeting, so the lists below can be tuned against
 * real traffic rather than guessed at indefinitely.
 */

/** Said by voicemail systems and essentially never by a person answering. */
const VOICEMAIL_PHRASES = [
    'leave a message',
    'leave your message',
    'leave a detailed message',
    'after the tone',
    'after the beep',
    'at the tone',
    'record your message',
    'please record',
    'is not available',
    'is unavailable',
    'not available right now',
    'unable to take your call',
    'cannot take your call',
    'can not take your call',
    'away from the phone',
    'voicemail',
    'voice mail',
    'voice message',
    'mailbox',
    'the person you are trying to reach',
    'the person you have called',
    'the party you are trying to reach',
    'has a voice mailbox',
    'please try again later',
    'please try your call again',
    'is not answering',
    'google voice',
    'press pound when finished',
    'when you have finished recording',
];

/**
 * Carrier intercept recordings. These matter more than voicemail: the number is
 * dead, so a second attempt would only waste another call and more money.
 */
const DEAD_NUMBER_PHRASES = [
    'has been disconnected',
    'is no longer in service',
    'no longer in service',
    'not in service',
    'cannot be completed as dialed',
    'cannot be completed as dialled',
    'the number you have dialed',
    'the number you dialed',
    'is not a working number',
    'has been changed',
    'check the number and dial again',
    'your call cannot be completed',
    'all circuits are busy',
];

const CLASSIFICATION = Object.freeze({
    HUMAN: 'human',
    VOICEMAIL: 'voicemail',
    DEAD_NUMBER: 'dead_number',
    UNKNOWN: 'unknown',
});

/**
 * A greeting longer than this is almost certainly recorded.
 *
 * People answer in a word or two and then wait. Machines talk continuously for
 * several seconds. Measured from the call connecting to the recognition
 * completing, because the result itself carries no duration.
 */
const MACHINE_SPEECH_SECONDS = 3.5;

/** Below this, the recognition is too unreliable to draw conclusions from. */
const MIN_CONFIDENCE = 0.3;

const normalise = (text) =>
    String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const firstMatch = (haystack, phrases) => phrases.find((phrase) => haystack.includes(phrase)) || '';

/**
 * Decide who answered.
 *
 * @param {string} speech        what the line said when it picked up
 * @param {number|null} confidence recogniser confidence, 0..1
 * @param {number} elapsedSeconds call connected -> recognition completed
 * @param {boolean} silence      recognition ended with nobody having spoken
 */
function classifyGreeting({ speech = '', confidence = null, elapsedSeconds = 0, silence = false }) {
    // Nobody spoke. Most often a person waiting for the caller to talk first;
    // occasionally a mailbox whose greeting finished before we started. Treating
    // it as human is the safer error: speaking to a machine wastes one call,
    // while hanging up on a person loses a real contact.
    if (silence || !speech) {
        return {
            classification: CLASSIFICATION.HUMAN,
            reason: silence ? 'no speech detected, assuming a person waiting' : 'nothing recognised',
            matched: '',
        };
    }

    const text = normalise(speech);

    // Dead numbers first: the most specific signal, and the only one that should
    // stop a target being retried.
    const deadMatch = firstMatch(text, DEAD_NUMBER_PHRASES);
    if (deadMatch) {
        return {
            classification: CLASSIFICATION.DEAD_NUMBER,
            reason: `carrier intercept matched "${deadMatch}"`,
            matched: deadMatch,
        };
    }

    const voicemailMatch = firstMatch(text, VOICEMAIL_PHRASES);
    if (voicemailMatch) {
        return {
            classification: CLASSIFICATION.VOICEMAIL,
            reason: `greeting matched "${voicemailMatch}"`,
            matched: voicemailMatch,
        };
    }

    // No keyword, but a long uninterrupted greeting. Catches personal mailbox
    // recordings that never use the standard wording.
    if (elapsedSeconds >= MACHINE_SPEECH_SECONDS && (confidence === null || confidence >= MIN_CONFIDENCE)) {
        return {
            classification: CLASSIFICATION.VOICEMAIL,
            reason: `spoke continuously for ${elapsedSeconds.toFixed(1)}s without stopping`,
            matched: '',
        };
    }

    return {
        classification: CLASSIFICATION.HUMAN,
        reason: 'short greeting, no machine wording',
        matched: '',
    };
}

module.exports = {
    CLASSIFICATION,
    classifyGreeting,
    VOICEMAIL_PHRASES,
    DEAD_NUMBER_PHRASES,
    MACHINE_SPEECH_SECONDS,
};
