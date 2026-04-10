const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ============================================================
// Phimmoichill Movie Crawler
// Usage: node crawl-phim.js <movie-info-url>
// Example: node crawl-phim.js https://phimmoichill.you/info/sieu-anh-hung-pha-hoai-phan-5-pm16980
// ============================================================

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
};

// ─── HTTP Helpers ────────────────────────────────────────────

function httpGet(url, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

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

function downloadFile(url, outputPath, customHeaders = {}) {
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
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const fileStream = fs.createWriteStream(outputPath);
        let bytes = 0;
        res.on('data', chunk => bytes += chunk.length);
        res.pipe(fileStream);
        fileStream.on('finish', () => { fileStream.close(); resolve(bytes); });
        fileStream.on('error', err => { fs.unlink(outputPath, () => {}); reject(err); });
      }).on('error', reject);
    };

    doRequest(url);
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function sanitizeFolderName(name) {
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
  const playerUrl = 'https://phimmoichill.you/chillsplayer.php';
  console.log(`   📡 POST ${playerUrl} (qcao=${dataId})`);

  const res = await httpPost(playerUrl, { qcao: dataId, sv: '0', quality_index: '2'}, {
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

// ─── Step 3: Fetch M3U8 and download segments ───────────────

async function downloadEpisode(hash, outputDir) {
  const m3u8Url = `https://sotrim.listpm.net/mpeg/${hash}/index.m3u8`;
  console.log(`   📋 Fetching M3U8: ${m3u8Url}`);

  const res = await httpGet(m3u8Url);

  if (res.statusCode !== 200) {
    throw new Error(`M3U8 fetch failed (HTTP ${res.statusCode})`);
  }

  const m3u8Content = res.body;

  // Save the m3u8 file
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(path.join(outputDir, 'index.m3u8'), m3u8Content);

  // Parse segment URLs from M3U8
  const lines = m3u8Content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const segments = [];
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  for (const line of lines) {
    if (line.startsWith('#')) continue;
    // This is a segment URL
    let url = line;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = baseUrl + url;
    }
    segments.push(url);
  }

  if (segments.length === 0) {
    console.log(`   ⚠️  Không tìm thấy segment nào trong M3U8`);
    console.log(`   📄 M3U8 content:\n${m3u8Content.substring(0, 500)}`);
    return { total: 0, success: 0, bytes: 0 };
  }

  console.log(`   📦 Tìm thấy ${segments.length} segments`);

  // Download all segments
  let totalBytes = 0;
  let successCount = 0;

  // Also rewrite M3U8 with local paths
  let localM3u8 = m3u8Content;

  for (let i = 0; i < segments.length; i++) {
    const segUrl = segments[i];
    const urlObj = new URL(segUrl);
    const filename = path.basename(urlObj.pathname);
    const outputPath = path.join(outputDir, filename);

    process.stdout.write(`   ⬇️  [${i + 1}/${segments.length}] ${filename} ... `);

    try {
      const bytes = await downloadFile(segUrl, outputPath);
      totalBytes += bytes;
      successCount++;
      console.log(`✅ ${formatBytes(bytes)}`);

      // Replace URL in M3U8 with local filename
      localM3u8 = localM3u8.replace(segUrl.includes('://') ? new URL(segUrl).pathname.split('/').pop() : segUrl, filename);
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  // Save local M3U8
  fs.writeFileSync(path.join(outputDir, 'index_local.m3u8'), localM3u8);

  return { total: segments.length, success: successCount, bytes: totalBytes };
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const movieUrl = process.argv[2];

  if (!movieUrl) {
    console.log('═══════════════════════════════════════════════════');
    console.log('  🎬 Phimmoichill Movie Crawler');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    console.log('Usage: node crawl-phim.js <movie-info-url>');
    console.log('');
    console.log('Example:');
    console.log('  node crawl-phim.js https://phimmoichill.you/info/sieu-anh-hung-pha-hoai-phan-5-pm16980');
    console.log('');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('  🎬 Phimmoichill Movie Crawler');
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

  // Create base output directory
  const baseDir = path.join(__dirname, 'downloads', sanitizeFolderName(movieTitle));
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  console.log(`\n📁 Thư mục gốc: ${baseDir}`);

  // Process each episode
  let grandTotalBytes = 0;
  let episodesSuccess = 0;

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const epFolderName = sanitizeFolderName(ep.label);
    const epDir = path.join(baseDir, epFolderName);

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`📺 [${i + 1}/${episodes.length}] ${ep.title}`);
    console.log(`   Folder: ${epFolderName}`);
    console.log(`${'─'.repeat(55)}`);

    try {
      // Step 2: Get player hash
      console.log(`\n   📥 Bước 2: Lấy player hash (data-id: ${ep.dataId})`);
      const hash = await getPlayerHash(ep.dataId, movieUrl);
      console.log(`   🔑 Hash: ${hash}`);

      // Step 3: Download M3U8 and segments
      console.log(`\n   📥 Bước 3: Download M3U8 & segments`);
      const result = await downloadEpisode(hash, epDir);

      if (result.success > 0) {
        episodesSuccess++;
        grandTotalBytes += result.bytes;
        console.log(`\n   ✅ Hoàn thành: ${result.success}/${result.total} segments (${formatBytes(result.bytes)})`);
      } else {
        console.log(`\n   ⚠️  Không download được segment nào`);
      }
    } catch (err) {
      console.log(`\n   ❌ Lỗi: ${err.message}`);
    }

    // Small delay between episodes to be polite
    if (i < episodes.length - 1) {
      console.log(`\n   ⏳ Chờ 1s trước tập tiếp theo...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Final summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`📊 KẾT QUẢ TỔNG HỢP:`);
  console.log(`   🎬 Phim: ${movieTitle}`);
  console.log(`   ✅ Tập thành công: ${episodesSuccess}/${episodes.length}`);
  console.log(`   💾 Tổng dung lượng: ${formatBytes(grandTotalBytes)}`);
  console.log(`   ⏱️  Thời gian: ${elapsed}s`);
  console.log(`   📁 Thư mục: ${baseDir}`);
  console.log(`${'═'.repeat(55)}`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
