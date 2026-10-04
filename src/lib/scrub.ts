// Signed GCS URLs, YouTube upload session URIs, and API-key requests all carry credentials in the
// query string. Sentry keeps the path and loses the query.
const URL_IN_TEXT = /(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g;

export function scrubUrl(text: string): string {
  return text.replace(URL_IN_TEXT, '$1?[redacted]');
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
  scrubData(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubUrl(span.description);
    scrubData(span.data);
  }
  return event;
}
