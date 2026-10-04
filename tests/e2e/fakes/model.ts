import { createServer } from 'node:http';

// These browser tests exercise model loading, independently of a developer's running sidecar.
createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/ready') {
    response.end(JSON.stringify({ ok: true }));
  } else if (request.url === '/health') {
    response.writeHead(503);
    response.end(
      JSON.stringify({ error: { message: 'Loading model', type: 'unavailable_error' } }),
    );
  } else {
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'Unexpected model request' }));
  }
}).listen(4174, '127.0.0.1');
