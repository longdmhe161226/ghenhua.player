const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ============================================================
// Phimmoichill Movie Crawler → JSON Export
// Usage: node crawl-phim-json.js <movie-info-url>
// Example: node crawl-phim-json.js https://phimmoichill.you/info/sieu-anh-hung-pha-hoai-phan-5-pm16980
//
// Output: A JSON file with server_name, is_ai, and server_data
//         containing M3U8 links for each episode.
// ============================================================

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
};

// ─── HTTP Helpers ────────────────────────────────────────────

function httpGet(url, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      const u = new URL(requestUrl);
      const proto = u.protocol === 'https:' ? https : http;

      proto.get(requestUrl, {
        headers: { ...HEADERS, ...customHeaders, 'Host': u.host },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (loc) {
            const full = loc.startsWith('http') ? loc : new URL(loc, requestUrl).href;
            return doRequest(full, redirectCount + 1);
          }
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      }).on('error', reject);
    };

    doRequest(url);
  });
}

/**
 * HTTP GET that tracks the final URL after all redirects.
 * Returns { statusCode, headers, body, finalUrl }.
 */
function httpGetWithFinalUrl(url, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      const u = new URL(requestUrl);
      const proto = u.protocol === 'https:' ? https : http;

      proto.get(requestUrl, {
        headers: { ...HEADERS, ...customHeaders, 'Host': u.host },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (loc) {
            const full = loc.startsWith('http') ? loc : new URL(loc, requestUrl).href;
            return doRequest(full, redirectCount + 1);
          }
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          finalUrl: requestUrl,
        }));
      }).on('error', reject);
    };

    doRequest(url);
  });
}

function httpPost(url, formData, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    let body = '';
    for (const [key, value] of Object.entries(formData)) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
      body += `${value}\r\n`;
    }
    body += `--${boundary}--\r\n`;

    const options = {
      method: 'POST',
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      headers: {
        ...HEADERS,
        ...customHeaders,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body),
        'Origin': `${urlObj.protocol}//${urlObj.host}`,
        'Referer': `${urlObj.protocol}//${urlObj.host}/`,
      },
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"\/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// ─── Step 1: Parse movie page for episodes ───────────────────

async function getEpisodes(movieUrl) {
  console.log(`\n📥 Bước 1: Lấy danh sách tập phim từ: ${movieUrl}`);
  const res = await httpGet(movieUrl);

  if (res.statusCode !== 200) {
    throw new Error(`Không thể tải trang phim (HTTP ${res.statusCode})`);
  }

  // Extract movie title from <title> tag
  const titleMatch = res.body.match(/<title[^>]*>(.*?)<\/title>/i);
  const movieTitle = titleMatch ? titleMatch[1].replace(/\s*-\s*Phim.*/i, '').trim() : 'Unknown Movie';

  // Parse episodes from latest-episode div and also from full episode list
  const episodes = [];
  
  // Pattern to match episode links with data-id
  const episodeRegex = /<a[^>]*\s+data-id="(\d+)"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
  let match;

  while ((match = episodeRegex.exec(res.body)) !== null) {
    const dataId = match[1];
    const href = match[2];
    const title = match[3];
    const label = match[4].trim();

    // Avoid duplicates
    if (!episodes.find(e => e.dataId === dataId)) {
      episodes.push({ dataId, href, title, label });
    }
  }

  // Sort episodes by label (extract number)
  episodes.sort((a, b) => {
    const numA = parseInt(a.label.replace(/\D/g, '')) || 0;
    const numB = parseInt(b.label.replace(/\D/g, '')) || 0;
    return numA - numB;
  });

  return { movieTitle, episodes };
}

// ─── Step 2: Get player hash from chillsplayer.php ───────────

async function getPlayerHash(dataId, movieUrl) {
  const playerUrl = 'https://phimmoichill.men/chillsplayer.php';
  console.log(`   📡 POST ${playerUrl} (qcao=${dataId})`);

  const res = await httpPost(playerUrl, { qcao: dataId, sv: '0', quality_index: '2' }, {
    'Referer': movieUrl,
  });

  if (res.statusCode !== 200) {
    throw new Error(`Player request failed (HTTP ${res.statusCode})`);
  }

  // Extract hash from iniPlayers("hash", ...)
  const iniMatch = res.body.match(/iniPlayers?\s*\(\s*"([a-f0-9]+)"/i);
  if (!iniMatch) {
    // Try alternative patterns
    const altMatch = res.body.match(/iniPlayers?\s*\(\s*'([a-f0-9]+)'/i);
    if (altMatch) return altMatch[1];
    
    // Debug: save response for inspection
    const debugFile = path.join(__dirname, `debug_player_${dataId}.html`);
    fs.writeFileSync(debugFile, res.body);
    throw new Error(`Không tìm thấy hash trong player response. Đã lưu debug tại: ${debugFile}`);
  }

  return iniMatch[1];
}

// ─── Step 3: Resolve M3U8 URL from hash ──────────────────────

async function resolveM3u8Url(hash) {
  const m3u8Url = `https://sotrim.listpm.net/mpeg/${hash}/index.m3u8`;
  console.log(`   📋 Resolving M3U8: ${m3u8Url}`);

  const res = await httpGetWithFinalUrl(m3u8Url);

  if (res.statusCode !== 200) {
    throw new Error(`M3U8 fetch failed (HTTP ${res.statusCode})`);
  }

  // Return the final URL after all redirects
  return res.finalUrl;
}

// ─── Step 4: Extract filename from M3U8 URL ─────────────────

function extractFilenameFromUrl(url) {
  try {
    const u = new URL(url);
    // Typical: https://vip.opstream90.com/20260408/29012_bfbf094d/index.m3u8
    // We want the directory name (e.g. "29012_bfbf094d") as part of the filename
    const parts = u.pathname.split('/').filter(Boolean);
    // Remove the last part ("index.m3u8") and take the parent folder name
    if (parts.length >= 2) {
      return parts.slice(0, -1).join('/');
    }
    return parts.join('/');
  } catch {
    return url;
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const movieUrl = process.argv[2];

  if (!movieUrl) {
    console.log('═══════════════════════════════════════════════════');
    console.log('  🎬 Phimmoichill Movie Crawler → JSON Export');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    console.log('Usage: node crawl-phim-json.js <movie-info-url>');
    console.log('');
    console.log('Example:');
    console.log('  node crawl-phim-json.js https://phimmoichill.you/info/sieu-anh-hung-pha-hoai-phan-5-pm16980');
    console.log('');
    console.log('Output: <movie-title>.json in same directory');
    console.log('');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('  🎬 Phimmoichill Movie Crawler → JSON Export');
  console.log('═══════════════════════════════════════════════════');

  const startTime = Date.now();

  // Step 1: Get episode list
  const { movieTitle, episodes } = await getEpisodes(movieUrl);

  if (episodes.length === 0) {
    console.log('❌ Không tìm thấy tập phim nào!');
    process.exit(1);
  }

  console.log(`\n🎬 Phim: ${movieTitle}`);
  console.log(`📺 Số tập: ${episodes.length}`);
  episodes.forEach((ep, i) => {
    console.log(`   ${i + 1}. [${ep.label}] data-id=${ep.dataId}`);
  });

  // Build server_data array
  const serverData = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];

    console.log(`\n${'─'.repeat(55)}`);
    console.log(`📺 [${i + 1}/${episodes.length}] ${ep.title}`);

    try {
      // Step 2: Get player hash
      console.log(`\n   📥 Bước 2: Lấy player hash (data-id: ${ep.dataId})`);
      const hash = await getPlayerHash(ep.dataId, movieUrl);
      console.log(`   🔑 Hash: ${hash}`);

      // Step 3: Resolve final M3U8 URL
      console.log(`\n   📥 Bước 3: Resolve M3U8 URL`);
      const finalM3u8Url = await resolveM3u8Url(hash);
      console.log(`   🔗 Final URL: ${finalM3u8Url}`);

      // Extract episode number from label
      const epNumber = ep.label.replace(/\D/g, '') || String(i + 1);

      // Build filename from title
      const filename = extractFilenameFromUrl(finalM3u8Url);

      serverData.push({
        name: epNumber,
        slug: epNumber,
        filename: ep.title || `Episode ${epNumber}`,
        link_embed: finalM3u8Url,
        link_m3u8: finalM3u8Url,
      });

      console.log(`   ✅ Đã thêm tập ${epNumber}`);
    } catch (err) {
      console.log(`\n   ❌ Lỗi: ${err.message}`);
    }

    // Small delay between episodes to be polite
    if (i < episodes.length - 1) {
      console.log(`\n   ⏳ Chờ 500ms trước tập tiếp theo...`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Build final JSON
  const output = {
    server_name: 'Phimmoi 4k',
    is_ai: false,
    server_data: serverData,
  };

  // Write JSON file
  const outputFilename = sanitizeFilename(movieTitle) + '.json';
  const outputPath = path.join(__dirname, outputFilename);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 4), 'utf-8');

  // Final summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`📊 KẾT QUẢ:`);
  console.log(`   🎬 Phim: ${movieTitle}`);
  console.log(`   ✅ Số tập thu thập: ${serverData.length}/${episodes.length}`);
  console.log(`   📄 File JSON: ${outputPath}`);
  console.log(`   ⏱️  Thời gian: ${elapsed}s`);
  console.log(`${'═'.repeat(55)}`);

  // Also print the JSON to console
  console.log('\n📋 Nội dung JSON:');
  console.log(JSON.stringify(output, null, 4));
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
