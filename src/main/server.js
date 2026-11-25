// Local HTTP server: receives POST /event from hooks/report.js. Binds to 127.0.0.1 only.
const http = require('http');

function startServer(port, onEvent, onError) {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/event') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
        if (body.length > 10 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        res.end('ok'); // respond first so the hook exits quickly
        try {
          const j = JSON.parse(body);
          onEvent(j.event, j.payload || {}, j.at || Date.now());
        } catch { /* ignore malformed */ }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
    res.statusCode = 404;
    res.end();
  });
  srv.on('error', onError);
  srv.listen(port, '127.0.0.1');
  return srv;
}

module.exports = { startServer };
