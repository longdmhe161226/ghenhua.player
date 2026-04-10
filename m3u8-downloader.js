const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ============================================================
// M3U8 Segment Downloader
// Usage: node m3u8-downloader.js [m3u8-file-or-url] [output-dir]
//
// Examples:
//   node m3u8-downloader.js playlist.m3u8
//   node m3u8-downloader.js https://example.com/playlist.m3u8
//   node m3u8-downloader.js playlist.m3u8 ./downloaded
// ============================================================

const M3U8_CONTENT_DEFAULT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:7
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4,
https://sochim.xyz/segment1.dat
#EXTINF:3.5,
https://sochim.xyz/segment2.woff2
#EXT-X-ENDLIST`;

// Parse M3U8 content and extract segment URLs
function parseM3U8(content, baseUrl = '') {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments/tags
    if (line.startsWith('#')) continue;

    // This is a segment URL
    let url = line;
    // If relative URL, resolve against base
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      if (baseUrl) {
        url = new URL(url, baseUrl).href;
      }
    }

    // Get duration from previous EXTINF line
    let duration = 0;
    if (i > 0 && lines[i - 1].startsWith('#EXTINF:')) {
      const match = lines[i - 1].match(/#EXTINF:([\d.]+)/);
      if (match) duration = parseFloat(match[1]);
    }

    segments.push({ url, duration, index: segments.length });
  }

  return segments;
}

// Download a single file
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const doRequest = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        return reject(new Error('Too many redirects'));
      }

      protocol.get(requestUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
        }
      }, (res) => {
        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, requestUrl).href;
            return doRequest(fullUrl, redirectCount + 1);
          }
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const fileStream = fs.createWriteStream(outputPath);
        let downloadedBytes = 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          resolve({ bytes: downloadedBytes, path: outputPath });
        });

        fileStream.on('error', (err) => {
          fs.unlink(outputPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    };

    doRequest(url);
  });
}

// Format bytes to human-readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Main function
async function main() {
  const args = process.argv.slice(2);
  let m3u8Content = '';
  let baseUrl = '';
  let outputDir = args[1] || './m3u8_downloads';

  if (args[0]) {
    const input = args[0];
    if (input.startsWith('http://') || input.startsWith('https://')) {
      // Download M3U8 from URL
      console.log(`📥 Fetching M3U8 from: ${input}`);
      m3u8Content = await new Promise((resolve, reject) => {
        const protocol = input.startsWith('https') ? https : http;
        protocol.get(input, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      baseUrl = input;
    } else {
      // Read from local file
      console.log(`📂 Reading M3U8 from file: ${input}`);
      m3u8Content = fs.readFileSync(input, 'utf-8');
    }
  } else {
    console.log('📋 Using embedded M3U8 content');
    m3u8Content = M3U8_CONTENT_DEFAULT;
  }

  // Parse segments
  const segments = parseM3U8(m3u8Content, baseUrl);

  if (segments.length === 0) {
    console.log('❌ No segments found in M3U8 content!');
    process.exit(1);
  }

  console.log(`\n🎬 Found ${segments.length} segment(s) to download:`);
  segments.forEach((seg, i) => {
    console.log(`   ${i + 1}. ${seg.url} (${seg.duration}s)`);
  });

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  console.log(`\n📁 Output directory: ${path.resolve(outputDir)}`);
  console.log('─'.repeat(60));

  // Download all segments
  let totalBytes = 0;
  let successCount = 0;
  let failCount = 0;
  const startTime = Date.now();

  for (const seg of segments) {
    const urlObj = new URL(seg.url);
    const filename = path.basename(urlObj.pathname);
    const outputPath = path.join(outputDir, filename);

    process.stdout.write(`⬇️  [${seg.index + 1}/${segments.length}] ${filename} ... `);

    try {
      const result = await downloadFile(seg.url, outputPath);
      totalBytes += result.bytes;
      successCount++;
      console.log(`✅ ${formatBytes(result.bytes)}`);
    } catch (err) {
      failCount++;
      console.log(`❌ ${err.message}`);
    }
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('─'.repeat(60));
  console.log(`\n📊 Download Summary:`);
  console.log(`   ✅ Success: ${successCount}/${segments.length}`);
  if (failCount > 0) console.log(`   ❌ Failed:  ${failCount}/${segments.length}`);
  console.log(`   💾 Total size: ${formatBytes(totalBytes)}`);
  console.log(`   ⏱️  Time: ${elapsed}s`);
  console.log(`   📁 Saved to: ${path.resolve(outputDir)}`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
