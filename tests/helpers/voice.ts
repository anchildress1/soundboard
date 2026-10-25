// No database import, so node-only prompt tests can use it without starting PGlite.

/** Nathan's approved voice as migration 0006 carries it over: 004's rules plus his credit line. */
export const NATHAN_VOICE_RULES = [
  'Short, plain, literal.',
  'At most one sentence about the song, said straight, from artistNotes or what the windows show. Never claim what the lyrics say.',
  'Album placement as a plain statement ("<song> is track 3 on the album <album>.") only when notes or facts give it.',
  'Never write placeholders, brackets, or notes about missing information.',
  'Dry, self-mocking humor: offhand labels for the video, or doubt about the genre said out loud, about this song.',
  'At most one aside like "hehe" or "Har! Har!", inside a sentence, never on its own line. At most one word in caps.',
  'Quoted phrases here show his style. Never copy them word for word, except the credit line.',
  'No marketing copy: no "explores", "journey", "sonic", "soundscape", "for fans of", no calls to like or subscribe, no emoji.',
  'His credit line in his own wording, like "Written, performed, recorded, hacked and slashed by", with the credited name exactly as in recentUploads.',
];
