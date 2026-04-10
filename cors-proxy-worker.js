/**
 * Cloudflare Worker — CORS Proxy cho HLS segments
 * 
 * Deploy lên Cloudflare Workers (miễn phí 100K request/ngày)
 * URL: https://<your-worker>.workers.dev/?url=<encoded-target-url>
 */

// Whitelist domains được phép proxy (tránh bị abuse)
const ALLOWED_TARGET_DOMAINS = [
  'sochim.xyz',
  'sotrim.listpm.net',
];

// Whitelist origins được phép gọi proxy (optional, set rỗng = cho tất cả)
const ALLOWED_ORIGINS = [
  // Thêm domain deploy của bạn vào đây
  // 'https://longdmhe161226.github.io',
];

export default {
  async fetch(request, env, ctx) {
    // Handle preflight (OPTIONS)
    if (request.method === 'OPTIONS') {
      return handleCORS(request, new Response(null, { status: 204 }));
    }

    // Chỉ cho phép GET
    if (request.method !== 'GET') {
      return handleCORS(request, new Response('Method not allowed', { status: 405 }));
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    // Validate parameter
    if (!targetUrl) {
      return handleCORS(request, new Response(JSON.stringify({
        error: 'Missing "url" parameter',
        usage: `${url.origin}/?url=https://sochim.xyz/example.dat`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // Validate target URL
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return handleCORS(request, new Response('Invalid target URL', { status: 400 }));
    }

    // Check domain whitelist
    if (ALLOWED_TARGET_DOMAINS.length > 0) {
      const isAllowed = ALLOWED_TARGET_DOMAINS.some(
        domain => parsedTarget.hostname === domain || parsedTarget.hostname.endsWith('.' + domain)
      );
      if (!isAllowed) {
        return handleCORS(request, new Response(
          `Domain "${parsedTarget.hostname}" is not in the allowed list`, 
          { status: 403 }
        ));
      }
    }

    // Check origin whitelist (nếu có)
    if (ALLOWED_ORIGINS.length > 0) {
      const origin = request.headers.get('Origin') || '';
      if (!ALLOWED_ORIGINS.includes(origin) && !origin.includes('localhost')) {
        return handleCORS(request, new Response('Origin not allowed', { status: 403 }));
      }
    }

    try {
      // Fetch target resource
      const proxyResponse = await fetch(targetUrl, {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'CORS-Proxy/1.0',
          'Accept': request.headers.get('Accept') || '*/*',
          'Accept-Encoding': request.headers.get('Accept-Encoding') || 'gzip, deflate, br',
        },
        // Không gửi Origin để tránh conflict
      });

      // Clone response và thêm CORS headers
      return handleCORS(request, new Response(proxyResponse.body, {
        status: proxyResponse.status,
        statusText: proxyResponse.statusText,
        headers: {
          'Content-Type': proxyResponse.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Length': proxyResponse.headers.get('Content-Length') || '',
          'Cache-Control': proxyResponse.headers.get('Cache-Control') || 'public, max-age=86400',
          'ETag': proxyResponse.headers.get('ETag') || '',
        },
      }));

    } catch (err) {
      return handleCORS(request, new Response(`Proxy error: ${err.message}`, { status: 502 }));
    }
  }
};

function handleCORS(request, response) {
  const origin = request.headers.get('Origin') || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Range');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
