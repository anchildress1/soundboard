// Signed GCS URLs, YouTube upload session URIs, and API-key requests all carry credentials in the
// query string. Sentry keeps the path and loses the query.
const URL_IN_TEXT = /(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g;

export function scrubUrl(text: string): string {
  return text.replaceAll(URL_IN_TEXT, '$1?[redacted]');
}

const URL_KEYS = ['url', 'url.full', 'http.url', 'http.query', 'url.query', 'from', 'to'];

function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of URL_KEYS) {
    const value = data[key];
    if (typeof value !== 'string') continue;
    data[key] = key.endsWith('query') ? '[redacted]' : scrubUrl(value);
  }
}

type Crumb = { data?: Record<string, unknown>; message?: string };

export function scrubBreadcrumb<T extends Crumb>(crumb: T): T {
  scrubData(crumb.data);
  if (crumb.message) crumb.message = scrubUrl(crumb.message);
  return crumb;
}

type SpanLike = { description?: string; data?: Record<string, unknown> };
type EventLike = {
  message?: string;
  exception?: { values?: { value?: string }[] };
  request?: { url?: string; query_string?: unknown };
  spans?: SpanLike[];
  contexts?: { trace?: { data?: Record<string, unknown> } };
  transaction?: string;
};

/** Strips query strings from request, span, and trace data before an event leaves the process. */
export function scrubEvent<T extends EventLike>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    if (event.request.query_string) event.request.query_string = '[redacted]';
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  // ffmpeg and fetch errors quote the signed URL they failed on.
  if (event.message) event.message = scrubUrl(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubUrl(exception.value);
  }
  scrubData(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubUrl(span.description);
    scrubData(span.data);
  }
  return event;
}

type StreamedSpanLike = { name: string; attributes: Record<string, unknown> };

/**
 * Span streaming (the SDK default) sends spans one by one instead of in a transaction event, so this
 * is where span names and attributes lose their query strings. Every string attribute is checked:
 * a signed URL can sit in any of them, including the serialized model messages.
 */
export function scrubSpan<T extends StreamedSpanLike>(span: T): T {
  span.name = scrubUrl(span.name);
  for (const [key, value] of Object.entries(span.attributes)) {
    span.attributes[key] = scrubAttribute(key, value);
  }
  return span;
}

/** Raw attributes can be a string, a string array, or a `{ value, unit }` object. */
function scrubAttribute(key: string, value: unknown): unknown {
  if (typeof value === 'string') return key.endsWith('query') ? '[redacted]' : scrubUrl(value);
  if (Array.isArray(value)) return value.map((item) => scrubAttribute(key, item));
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return { ...value, value: scrubAttribute(key, value.value) };
  }
  return value;
}
