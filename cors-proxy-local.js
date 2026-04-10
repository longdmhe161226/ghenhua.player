/**
 * Local CORS Proxy Server (v2 - fixed streaming)
 * Chạy: node cors-proxy-local.js
 * URL:  http://localhost:8787/?url=<encoded-target-url>
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 3000;

const ALLOWED_DOMAINS = ['sochim.xyz', 'sotrim.listpm.net'];

const server = http.createServer((req, res) => {
  // CORS headers cho mọi response
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
    'Access-Control-Allow-Private-Network': 'true', // Chrome Private Network Access
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Parse URL
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const targetUrl = reqUrl.searchParams.get('url');

  if (!targetUrl) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "url" parameter' }));
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    res.writeHead(400, corsHeaders);
    res.end('Invalid URL');
    return;
  }

  // Check whitelist
  const isAllowed = ALLOWED_DOMAINS.some(d => parsedTarget.hostname === d || parsedTarget.hostname.endsWith('.' + d));
  if (!isAllowed) {
    res.writeHead(403, corsHeaders);
    res.end(`Domain "${parsedTarget.hostname}" not allowed`);
    return;
  }

  const client = parsedTarget.protocol === 'https:' ? https : http;
  const shortPath = parsedTarget.pathname.length > 40 
    ? parsedTarget.pathname.substring(0, 40) + '...' 
    : parsedTarget.pathname;

  console.log(`[PROXY] ${req.method} ${parsedTarget.hostname}${shortPath}`);

  const options = {
    hostname: parsedTarget.hostname,
    port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
    path: parsedTarget.pathname + parsedTarget.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity', // Không nén để tránh vấn đề decode
    },
  };

  const proxyReq = client.request(options, (proxyRes) => {
    const responseHeaders = { ...corsHeaders };
    
    // Copy essential headers từ upstream
    if (proxyRes.headers['content-type']) {
      responseHeaders['Content-Type'] = proxyRes.headers['content-type'];
    }
    if (proxyRes.headers['content-length']) {
      responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
    }
    if (proxyRes.headers['cache-control']) {
      responseHeaders['Cache-Control'] = proxyRes.headers['cache-control'];
    }
    if (proxyRes.headers['accept-ranges']) {
      responseHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
    }

    const size = proxyRes.headers['content-length'] 
      ? `${(parseInt(proxyRes.headers['content-length']) / 1024).toFixed(0)} KB` 
      : 'streaming';
    console.log(`  → ${proxyRes.statusCode} | ${size} | ${proxyRes.headers['content-type'] || 'unknown'}`);

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[ERROR] ${parsedTarget.hostname}: ${err.message}`);
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${err.message}`);
  });

  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'unknown';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
        break;
      }
    }
  }
  console.log(`\n🚀 CORS Proxy v2 running on:`);
  console.log(`   - Local:   http://localhost:${PORT}`);
  console.log(`   - Network: http://${localIP}:${PORT}`);
  console.log(`📌 Usage: http://localhost:${PORT}/?url=https://sochim.xyz/xxx.dat`);
  console.log(`✅ Allowed domains: ${ALLOWED_DOMAINS.join(', ')}\n`);
});
