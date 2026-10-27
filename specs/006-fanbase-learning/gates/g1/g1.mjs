// Gate G1 (research R5): does Gemini hear a public YouTube URL through the Interactions model,
// clipped to 60 s, without our process fetching YouTube? Usage:
//   GEMINI_API_KEY=… node specs/006-fanbase-learning/gates/g1/g1.mjs <public watch URL> <missing watch URL>
// Writes result.json beside this file: no key, no URL query.
import { writeFile } from 'node:fs/promises';
import { createGoogle } from '@ai-sdk/google';
import { generateText, jsonSchema, Output } from 'ai';

const [publicUrl, missingUrl] = process.argv.slice(2);
if (!publicUrl || !missingUrl) throw new Error('Pass a public and a missing watch URL.');

const hosts = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  hosts.add(new URL(typeof input === 'string' ? input : input.url).host);
  return realFetch(input, init);
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['channelKind', 'sound', 'explanation'],
  properties: {
    channelKind: {
      type: 'string',
      enum: ['artist', 'label', 'compilation', 'curator', 'uncertain'],
    },
    sound: { type: 'string', enum: ['same', 'different', 'uncertain'] },
    explanation: { type: 'string' },
  },
};

const google = createGoogle({ apiKey: process.env.GEMINI_API_KEY });

async function hear(url) {
  const started = Date.now();
  try {
    const result = await generateText({
      model: google.interactions(process.env.GEMINI_ANALYST_MODEL || 'gemini-3.8-flash'),
      instructions:
        'Describe what you hear in this clip in one sentence, then say whether it sounds like synthwave. Answer as JSON.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'The artist makes dark synthwave. Is this the same sound?' },
            {
              type: 'file',
              mediaType: 'video/mp4',
              data: new URL(url),
              providerOptions: {
                google: { processing: { type: 'static', startOffset: 0, endOffset: 60 } },
              },
            },
          ],
        },
      ],
      output: Output.object({ schema: jsonSchema(SCHEMA) }),
      maxOutputTokens: 2048,
      maxRetries: 0,
      providerOptions: { google: { store: false, thinkingLevel: 'low', mediaResolution: 'low' } },
    });
    return {
      ok: true,
      ms: Date.now() - started,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reply: result.text,
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      status: error.statusCode ?? null,
      message: String(error.message).slice(0, 300),
    };
  }
}

const clip = await hear(publicUrl);
const missing = await hear(missingUrl);
const leaked = [...hosts].filter((h) => /youtube\.com|googlevideo\.com|youtu\.be/.test(h));
const result = {
  at: new Date().toISOString(),
  model: process.env.GEMINI_ANALYST_MODEL || 'gemini-3.8-flash',
  checks: {
    heard: clip.ok,
    noYouTubeFetch: leaked.length === 0,
    // About 100 tokens per second at low resolution, so a 60 s clip is near 6,000.
    clippedTokens: clip.ok ? clip.inputTokens : null,
    missingVideo: missing.ok ? { ok: true, reply: missing.reply } : missing,
    latencyMs: [clip.ms, missing.ms],
  },
  hosts: [...hosts],
  clipReply: clip.ok ? clip.reply : clip,
};
await writeFile(new URL('./result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
