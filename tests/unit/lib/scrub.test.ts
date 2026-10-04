import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubEvent, scrubUrl } from '$lib/scrub';

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
      'http.query': '[redacted]',
      'url.query': '[redacted]',
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
    expect(event.request.query_string).toBe('[redacted]');
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
