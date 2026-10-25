// A fake of the GCS JSON API's resumable sessions for E2E, run as its own process on port 4174
// (playwright.config.ts). The browser's PUTs and the app server's status queries, cancels and
// storage calls (tests/e2e/fakes/storage.ts) all reach this one state. Control routes let a test
// drop, throttle or fail a session. Plain Node, so it runs with type stripping and no build.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = 4174;
const ORIGIN = `http://localhost:${PORT}`;
// Slow enough that a test can see a small clip mid-upload and arm a drop; a test can raise it.
const DEFAULT_BYTES_PER_SEC = 128 * 1024;

type Session = {
  id: string;
  object: string;
  size: number;
  saved: number;
  received: number;
  cancelled: boolean;
  bytesPerSec: number;
  drops: number[];
  fail: { status: number; times: number } | null;
};
type StoredObject = { size: number; contentType: string; landed: boolean; deleted: boolean };

const sessions = new Map<string, Session>();
const objects = new Map<string, StoredObject>();
let created = 0;

// The E2E app (playwright.config.ts) is the only page that PUTs here.
const APP_ORIGIN = 'http://localhost:4173';

function cors(res: ServerResponse) {
  res.setHeader('access-control-allow-origin', APP_ORIGIN);
  res.setHeader('access-control-allow-methods', 'PUT, DELETE, GET, POST');
  res.setHeader('access-control-allow-headers', 'content-range, content-type');
  res.setHeader('access-control-expose-headers', 'range');
}

function send(res: ServerResponse, status: number, body?: unknown, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    ...headers,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    : {};
}

function savedRange(session: Session): Record<string, string> {
  return session.saved > 0 ? { range: `bytes=0-${session.saved - 1}` } : {};
}

function land(session: Session) {
  const object = objects.get(session.object)!;
  object.landed = true;
  object.size = session.size;
}

/** The documented status query and the PUT of the rest, with the test's drops and throttle. */
function put(req: IncomingMessage, res: ServerResponse, session: Session) {
  const range = /^bytes (?:\*|(\d+)-(\d+))\/(\d+)$/.exec(req.headers['content-range'] ?? '');
  if (!range || Number(range[3]) !== session.size) {
    req.resume();
    send(res, 400, { error: { message: 'does not match the expected size' } });
    return;
  }
  if (range[1] === undefined) {
    req.resume();
    if (objects.get(session.object)!.landed) send(res, 200, { name: session.object });
    else send(res, 308, undefined, savedRange(session));
    return;
  }
  let position = Number(range[1]);
  if (position > session.saved) {
    req.resume();
    send(res, 400, { error: { message: 'gap in the upload' } });
    return;
  }
  const started = Date.now();
  let read = 0;
  req.on('data', (chunk: Buffer) => {
    session.received += chunk.length;
    read += chunk.length;
    const end = position + chunk.length;
    const drop = session.drops.find((at) => at > session.saved && at <= end);
    if (drop !== undefined) {
      session.saved = drop;
      session.drops = session.drops.filter((at) => at !== drop);
      req.socket.destroy();
      return;
    }
    position = end;
    session.saved = Math.max(session.saved, position);
    const ahead = (read / session.bytesPerSec) * 1000 - (Date.now() - started);
    if (ahead > 0) {
      req.pause();
      setTimeout(() => req.resume(), ahead);
    }
  });
  req.on('end', () => {
    if (session.saved >= session.size) {
      land(session);
      send(res, 200, { name: session.object, size: String(session.size) });
    } else {
      send(res, 308, undefined, savedRange(session));
    }
  });
}

function sessionRequest(req: IncomingMessage, res: ServerResponse, id: string) {
  const session = sessions.get(id);
  if (!session || session.cancelled) {
    req.resume();
    send(res, 404);
    return;
  }
  if (session.fail && session.fail.times > 0) {
    session.fail.times--;
    req.resume();
    send(res, session.fail.status);
    return;
  }
  if (req.method === 'DELETE') {
    session.cancelled = true;
    send(res, 499);
    return;
  }
  if (req.method === 'PUT') {
    put(req, res, session);
    return;
  }
  req.resume();
  send(res, 405);
}

const listed = (prefix: string) =>
  [...objects.entries()]
    .filter(([name, object]) => name.startsWith(prefix) && object.landed && !object.deleted)
    .map(([name, object]) => ({ name, size: object.size, contentType: object.contentType }));

async function control(req: IncomingMessage, res: ServerResponse, url: URL) {
  const [, , route, ...rest] = url.pathname.split('/');
  const name = decodeURIComponent(rest.join('/'));
  const session = sessions.get(url.searchParams.get('session') ?? '');
  switch (`${req.method} ${route}`) {
    case 'POST create': {
      const body = await readJson(req);
      const id = `fake-${++created}`;
      const object = String(body.object);
      sessions.set(id, {
        id,
        object,
        size: Number(body.size),
        saved: 0,
        received: 0,
        cancelled: false,
        bytesPerSec: DEFAULT_BYTES_PER_SEC,
        drops: [],
        fail: null,
      });
      objects.set(object, {
        size: 0,
        contentType: String(body.contentType),
        landed: false,
        deleted: false,
      });
      send(res, 200, { uri: `${ORIGIN}/upload/${id}?uploadType=resumable&upload_id=${id}` });
      return;
    }
    case 'GET object': {
      const object = objects.get(name);
      if (!object) send(res, 404);
      else
        send(res, 200, {
          landed: object.landed && !object.deleted,
          size: object.size,
          contentType: object.contentType,
        });
      return;
    }
    case 'DELETE object': {
      const object = objects.get(name);
      if (object) object.deleted = true;
      send(res, object?.landed ? 204 : 404);
      return;
    }
    case 'GET objects':
      send(res, 200, listed(url.searchParams.get('prefix') ?? ''));
      return;
    case 'GET sessions': {
      const prefix = url.searchParams.get('prefix') ?? '';
      send(
        res,
        200,
        [...sessions.values()]
          .filter((item) => item.object.startsWith(prefix))
          .map(({ id, object, size, saved, received, cancelled }) => ({
            id,
            object,
            size,
            saved,
            received,
            cancelled,
          })),
      );
      return;
    }
  }
  if (!session) {
    send(res, 404, { error: 'unknown session' });
    return;
  }
  switch (`${req.method} ${route}`) {
    case 'POST drop':
      session.drops.push(Number(url.searchParams.get('after')));
      send(res, 204);
      return;
    case 'POST throttle':
      session.bytesPerSec = Number(url.searchParams.get('bytesPerSec'));
      send(res, 204);
      return;
    case 'POST fail':
      session.fail = {
        status: Number(url.searchParams.get('status')),
        times: Number(url.searchParams.get('times')),
      };
      send(res, 204);
      return;
    default:
      send(res, 404);
  }
}

createServer((req, res) => {
  cors(res);
  const url = new URL(req.url ?? '/', ORIGIN);
  if (req.method === 'OPTIONS') {
    send(res, 204);
    return;
  }
  if (url.pathname.startsWith('/control/')) {
    control(req, res, url).catch((error: unknown) => send(res, 500, { error: String(error) }));
    return;
  }
  const upload = /^\/upload\/([\w-]+)$/.exec(url.pathname);
  if (upload) {
    sessionRequest(req, res, upload[1]!);
    return;
  }
  // The readiness probe from playwright.config.ts.
  send(res, url.pathname === '/' ? 200 : 404);
}).listen(PORT);
