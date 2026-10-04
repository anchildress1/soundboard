import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubEvent, scrubSpan, scrubUrl } from '$lib/scrub';

const REDACTED = '[redacted]';
const SCRUBBED_UPLOAD_URL = 'https://storage.googleapis.com/b/uploads/j1?[redacted]';

const SIGNED =
  'https://storage.googleapis.com/bucket/uploads/j1?X-Goog-Signature=abc&X-Goog-Credential=svc';

describe('scrubUrl', () => {
  it('replaces the query string and keeps the path', () => {
    expect(scrubUrl(SIGNED)).toBe('https://storage.googleapis.com/bucket/uploads/j1?[redacted]');
  });

  it('scrubs every URL inside free text and keeps fragments', () => {
    const text = `PUT ${SIGNED} failed; retry http://h/p?key=k#frag "https://a/b?c=d"`;
    expect(scrubUrl(text)).toBe(
      'PUT https://storage.googleapis.com/bucket/uploads/j1?[redacted] failed; retry http://h/p?[redacted]#frag "https://a/b?[redacted]"',
    );
  });

  it('leaves URLs without a query and plain text untouched', () => {
    expect(scrubUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(scrubUrl('no urls here ?a=b')).toBe('no urls here ?a=b');
    expect(scrubUrl('')).toBe('');
  });
});

describe('scrubBreadcrumb', () => {
  it('scrubs URL fields, redacts query fields, and scrubs the message', () => {
    const crumb = scrubBreadcrumb({
      message: `fetch ${SIGNED}`,
      data: {
        url: SIGNED,
        'http.query': 'key=secret',
        'url.query': 'sig=1',
        from: '/a?x=1',
        to: 'https://h/b?y=2',
        method: 'PUT',
        status_code: 200,
      },
    });
    expect(crumb.message).toBe('fetch https://storage.googleapis.com/bucket/uploads/j1?[redacted]');
    expect(crumb.data).toEqual({
      url: 'https://storage.googleapis.com/bucket/uploads/j1?[redacted]',
      'http.query': REDACTED,
      'url.query': REDACTED,
      from: '/a?x=1',
      to: 'https://h/b?[redacted]',
      method: 'PUT',
      status_code: 200,
    });
  });

  it('skips non-string values and tolerates missing data and message', () => {
    const crumb = scrubBreadcrumb({ data: { url: 42, 'http.query': null } });
    expect(crumb.data).toEqual({ url: 42, 'http.query': null });
    expect(scrubBreadcrumb({})).toEqual({});
    expect(scrubBreadcrumb({ message: '' })).toEqual({ message: '' });
  });
});

describe('scrubEvent', () => {
  it('scrubs signed URLs quoted in messages and exception values', () => {
    const url = 'https://storage.googleapis.com/b/uploads/x?X-Goog-Signature=abc';
    const event = scrubEvent({
      message: `ffmpeg failed on ${url}`,
      exception: { values: [{ value: `GET ${url} 403` }, {}] },
    });
    expect(JSON.stringify(event)).not.toContain('Signature');
    expect(event.message).toBe(
      'ffmpeg failed on https://storage.googleapis.com/b/uploads/x?[redacted]',
    );
  });

  it('scrubs request, transaction, trace data, and spans', () => {
    const event = scrubEvent({
      request: { url: SIGNED, query_string: 'X-Goog-Signature=abc' },
      transaction: 'GET https://h/a?b=c',
      contexts: { trace: { data: { 'url.full': SIGNED } } },
      spans: [
        { description: `PUT ${SIGNED}`, data: { 'http.url': SIGNED } },
        { description: 'no url' },
        {},
      ],
    });
    expect(JSON.stringify(event)).not.toContain('abc');
    expect(JSON.stringify(event)).not.toContain('svc');
    expect(event.request.query_string).toBe(REDACTED);
    expect(event.transaction).toBe('GET https://h/a?[redacted]');
    expect(event.spans[1]).toEqual({ description: 'no url' });
    expect(event.spans[2]).toEqual({});
  });

  it('tolerates an event without request, spans, or contexts', () => {
    expect(scrubEvent({})).toEqual({});
    expect(scrubEvent({ request: {}, contexts: {} })).toEqual({ request: {}, contexts: {} });
  });

  it('leaves an empty query_string alone', () => {
    expect(scrubEvent({ request: { url: '', query_string: '' } }).request).toEqual({
      url: '',
      query_string: '',
    });
  });
});

describe('scrubSpan', () => {
  const SIGNED =
    'https://storage.googleapis.com/b/uploads/j1?X-Goog-Signature=secret&X-Goog-Expires=600';

  it('strips query strings from the span name and every string attribute', () => {
    const span = scrubSpan({
      name: `GET ${SIGNED}`,
      attributes: {
        'url.full': SIGNED,
        'gen_ai.input.messages': JSON.stringify([{ content: `see ${SIGNED}` }]),
        'http.query': 'key=AIza-secret',
        'url.query': 'X-Goog-Signature=secret',
        'gen_ai.usage.input_tokens': 900,
        'job.ok': true,
      },
    });
    expect(span.name).toBe('GET https://storage.googleapis.com/b/uploads/j1?[redacted]');
    expect(span.attributes['url.full']).toBe(SCRUBBED_UPLOAD_URL);
    expect(span.attributes['gen_ai.input.messages']).not.toContain('secret');
    expect(span.attributes['http.query']).toBe(REDACTED);
    expect(span.attributes['url.query']).toBe(REDACTED);
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(900);
    expect(span.attributes['job.ok']).toBe(true);
  });

  it('scrubs string arrays and { value, unit } attribute objects', () => {
    const span = scrubSpan({
      name: 'fetch',
      attributes: {
        'url.list': [SIGNED, 'plain'],
        'url.full': { value: SIGNED, unit: 'none' },
        'url.query': { value: 'X-Goog-Signature=secret' },
        'job.sizes': [1, 2],
      },
    });
    expect(span.attributes['url.list']).toEqual([SCRUBBED_UPLOAD_URL, 'plain']);
    expect(span.attributes['url.full']).toEqual({
      value: SCRUBBED_UPLOAD_URL,
      unit: 'none',
    });
    expect(span.attributes['url.query']).toEqual({ value: REDACTED });
    expect(span.attributes['job.sizes']).toEqual([1, 2]);
  });

  it('leaves spans without credentials unchanged', () => {
    const span = { name: 'chat gemma-4-12b-it', attributes: { 'gen_ai.agent.name': 'smart-pick' } };
    expect(scrubSpan(structuredClone(span))).toEqual(span);
  });
});
