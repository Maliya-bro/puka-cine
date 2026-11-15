import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { connect } from 'puppeteer-real-browser';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();
const PORT = process.env.PORT || 3000;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = (tag, msg) => {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${time}] [${tag}] ${msg}`);
};

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

app.use(express.json());

// =========================================================================
// 0. REQUEST LOGGER MIDDLEWARE
// =========================================================================
app.use((req, res, next) => {
    const startTime = Date.now();
    const reqId = Math.random().toString(36).substring(2, 7).toUpperCase();
    req.reqId = reqId;

    log(`REQ:${reqId}`, `➡️  Incoming ${req.method} ${req.originalUrl} | IP: ${req.ip}`);

    res.on('finish', () => {
        const duration = Date.now() - startTime;
        log(`RES:${reqId}`, `⬅️  Completed ${res.statusCode} in ${duration}ms`);
        console.log('-------------------------------------------------------------------------');
    });

    next();
});

// =========================================================================
// 1. SCRAPING & RESOLVING FUNCTIONS
// =========================================================================

async function searchMovies(query, reqId) {
    const searchUrl = `https://cinesubz.lk/?s=${encodeURIComponent(query)}`;
    log(`SEARCH:${reqId}`, `🔍 Fetching URL: ${searchUrl}`);

    const { data } = await axios.get(searchUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);
    const results = [];

    $('.display-item .item-box').each((i, el) => {
        const anchor = $(el).find('> a').first();
        const title = anchor.attr('title')?.trim();
        const url = anchor.attr('href');
        const imgEl = $(el).find('img').first();
        const poster = imgEl.attr('data-src') || imgEl.attr('src') || null;
        const year = $(el).find('.year, .metadata span').first().text().trim() || null;

        if (title && url) {
            results.push({ title, year, poster, url });
        }
    });

    log(`SEARCH:${reqId}`, `✅ Found ${results.length} movies for "${query}"`);
    return results;
}

async function resolveZtLink(ztLinkUrl, reqId) {
    log(`ZT-RESOLVE:${reqId}`, `⏳ Fetching ZT redirect page: ${ztLinkUrl}`);

    try {
        const { data } = await axios.get(ztLinkUrl, { headers: COMMON_HEADERS, timeout: 15000 });
        const $ = cheerio.load(data);
        let rawLink = $('#link').attr('href');

        if (!rawLink) {
            log(`ZT-RESOLVE:${reqId}`, `❌ #link element not found on page`);
            return null;
        }

        const urlMappings = [
            { search: ["https://google.com/server11/1:/", "https://google.com/server12/1:/", "https://google.com/server13/1:/"], replace: "https://drive.csplayer2.space/server1/" },
            { search: ["https://google.com/server21/1:/", "https://google.com/server22/1:/", "https://google.com/server23/1:/"], replace: "https://drive.csplayer2.space/server2/" },
            { search: ["https://google.com/server3/1:/"], replace: "https://drive.csplayer2.space/server3/" },
            { search: ["https://google.com/server4/1:/"], replace: "https://drive.csplayer2.space/server4/" },
            { search: ["https://google.com/server5/1:/"], replace: "https://drive.csplayer2.space/server5/" },
            { search: ["https://google.com/server6/"], replace: "https://drive.csplayer2.space/server6/" },
            { search: ["https://google.com/server7/"], replace: "https://drive.csplayer2.space/server7/" }
        ];

        let driveUrl = rawLink;
        for (const mapping of urlMappings) {
            for (const search of mapping.search) {
                if (driveUrl.includes(search)) {
                    driveUrl = driveUrl.replace(search, mapping.replace);
                    break;
                }
            }
        }

        if (driveUrl.includes('.mp4')) driveUrl = driveUrl.replace('.mp4', '?ext=mp4');
        else if (driveUrl.includes('.mkv')) driveUrl = driveUrl.replace('.mkv', '?ext=mkv');
        else if (driveUrl.includes('.zip')) driveUrl = driveUrl.replace('.zip', '?ext=zip');

        log(`ZT-RESOLVE:${reqId}`, `✅ Mapped Drive URL: ${driveUrl}`);
        return driveUrl;
    } catch (err) {
        log(`ZT-RESOLVE:${reqId}`, `⚠️ Failed to resolve ${ztLinkUrl}: ${err.message}`);
        return null;
    }
}

async function getMovieInfoAndQualities(movieUrl, reqId) {
    log(`INFO:${reqId}`, `🎞️  Fetching full movie details & qualities: ${movieUrl}`);

    const { data } = await axios.get(movieUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    // 1. Basic Movie Details
    const title = $('h1.entry-title, .sheader .data h1, meta[property="og:title"]').first().text().trim()
        || $('meta[property="og:title"]').attr('content')?.replace(' - CineSubz', '').trim()
        || 'Unknown Title';

    const poster = $('.poster img, .sheader .poster img').first().attr('data-src')
        || $('.poster img, .sheader .poster img').first().attr('src')
        || $('meta[property="og:image"]').attr('content')
        || null;

    // 2. Backdrop & Gallery Images
    const images = [];
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) images.push(ogImage);

    $('#dt_galery img, .g-item img, .gallery img, .wp-content img').each((i, el) => {
        const src = $(el).attr('data-src') || $(el).attr('src');
        if (src && src.startsWith('http') && !images.includes(src)) {
            images.push(src);
        }
    });

    // 3. Metadata (Rating, Release Date, Duration, Genres, Description)
    const rating = $('.dt_rating_vgs, .rating .value, .starstruck-rating').first().text().trim() || null;
    const releaseDate = $('.sheader .extra .date, span[itemprop="dateCreated"]').first().text().trim() || null;
    const duration = $('.sheader .extra .runtime, span[itemprop="duration"]').first().text().trim() || null;
    const country = $('.sheader .extra .country').first().text().trim() || null;

    const genres = [];
    $('.sgeneros a, a[rel="tag"]').each((i, el) => {
        const g = $(el).text().trim();
        if (g && !genres.includes(g)) genres.push(g);
    });

    const synopsis = $('.wp-content p, #info .wp-content p').first().text().trim()
        || $('meta[property="og:description"]').attr('content')?.trim()
        || null;

    // 4. Extract Raw Quality Items
    const rawQualities = [];
    $('.movie-download-link-item a').each((i, el) => {
        const ztUrl = $(el).attr('href');
        const qualityText = $(el).find('.movie-download-meta').text().trim();
        const sizeText = $(el).find('.movie-download-size, span').last().text().trim();

        if (ztUrl && qualityText) {
            rawQualities.push({
                quality: qualityText,
                size: sizeText !== qualityText ? sizeText : null,
                ztUrl
            });
        }
    });

    log(`INFO:${reqId}`, `⚡ Resolving ${rawQualities.length} ZT links in parallel...`);

    // 5. Resolve All ZT Links Simultaneously (Super Fast)
    const downloads = await Promise.all(
        rawQualities.map(async (item) => {
            const driveUrl = await resolveZtLink(item.ztUrl, reqId);
            return {
                quality: item.quality,
                size: item.size,
                ztUrl: item.ztUrl,
                driveUrl: driveUrl // කෙලින්ම /download එකට දිය හැකි resolved link එක
            };
        })
    );

    log(`INFO:${reqId}`, `✅ Completed full info + ${downloads.length} resolved links`);

    return {
        movie: {
            title,
            url: movieUrl,
            poster,
            images,
            rating,
            releaseDate,
            duration,
            country,
            genres,
            synopsis
        },
        downloads
    };
}

// =========================================================================
// 2. LINUX REAL BROWSER SECTION
// =========================================================================

async function getUltimateR2Link(driveUrl, reqId) {
    let browser;
    let ultimateMediaUrl = null;

    const chromeFlags = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,720'
    ];

    try {
        log(`BROWSER:${reqId}`, `🤖 Launching Chrome via puppeteer-real-browser (DISPLAY=${process.env.DISPLAY || 'none'})...`);

        const connection = await connect({
            headless: false,
            turnstile: true,
            disableXvfb: true,
            args: chromeFlags,
            customConfig: {
                chromePath: '/usr/bin/google-chrome',
                chromeFlags: chromeFlags,
                port: 9222,
                logLevel: 'info'
            }
        });

        browser = connection.browser;
        const page = connection.page;
        log(`BROWSER:${reqId}`, `✅ Chrome launched & connected successfully`);

        page.on('console', msg => {
            if (msg.type() === 'error') {
                log(`PAGE-ERR:${reqId}`, `⚠️  Browser Console Error: ${msg.text()}`);
            }
        });

        page.on('pageerror', err => {
            log(`PAGE-ERR:${reqId}`, `⚠️  Page Runtime Error: ${err.message}`);
        });

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'deny' });

        client.on('Browser.downloadWillBegin', (e) => {
            log(`CDP:${reqId}`, `📥 Browser download event triggered: ${e.url.substring(0, 80)}...`);
            if (e.url.includes('cloudflarestorage') || e.url.includes('X-Amz-Algorithm')) {
                ultimateMediaUrl = e.url;
                log(`CDP:${reqId}`, `🎯 R2 Presigned URL captured via CDP!`);
            }
        });

        await page.evaluateOnNewDocument(() => {
            window.DisableDevtool = function() { };
            window.open = function(url) { window.location.href = url; return window; };
            const originalAssign = window.location.assign;
            window.location.assign = function(url) {
                if (url && (url.includes('error') || url.includes('blocked'))) return;
                return originalAssign.apply(this, arguments);
            };
        });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (url.includes('disable-devtool')) {
                log(`NET:${reqId}`, `🛡️  Blocked anti-devtool script`);
                req.abort();
            } else if (url.includes('X-Amz-Credential') || url.includes('cloudflarestorage.com') || url.includes('?X-Amz-Algorithm')) {
                log(`NET:${reqId}`, `🎯 Intercepted R2/S3 request: ${url.substring(0, 80)}...`);
                if (!ultimateMediaUrl) ultimateMediaUrl = url;
                req.abort();
            } else {
                req.continue();
            }
        });

        log(`BROWSER:${reqId}`, `🌐 Navigating to: ${driveUrl}`);
        await page.goto(driveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        log(`BROWSER:${reqId}`, `📄 Page DOM loaded. Current Title: "${await page.title()}"`);

        log(`BROWSER:${reqId}`, `⏳ Waiting 6 seconds for loading overlay / Turnstile check...`);
        await delay(6000);

        log(`BROWSER:${reqId}`, `🔎 Scanning DOM for visible '.button.direct-download'...`);
        const btnDebugInfo = await page.evaluate(() => {
            const buttons = document.querySelectorAll('.button.direct-download');
            const info = { totalButtons: buttons.length, visibleIndex: -1 };
            for (let i = 0; i < buttons.length; i++) {
                const style = window.getComputedStyle(buttons[i]);
                const rect = buttons[i].getBoundingClientRect();
                if (style.display !== 'none' && style.opacity !== '0' && rect.width > 0) {
                    buttons[i].scrollIntoView({ behavior: 'instant', block: 'center' });
                    info.visibleIndex = i;
                    break;
                }
            }
            return info;
        });

        log(`BROWSER:${reqId}`, `📊 Button scan result: Total=${btnDebugInfo.totalButtons}, VisibleIndex=${btnDebugInfo.visibleIndex}`);

        if (btnDebugInfo.visibleIndex !== -1) {
            await delay(1000);
            const box = await page.evaluate((index) => {
                const btn = document.querySelectorAll('.button.direct-download')[index];
                const rect = btn.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }, btnDebugInfo.visibleIndex);

            const clickX = Math.round(box.x + (box.width / 2));
            const clickY = Math.round(box.y + (box.height / 2));

            log(`BROWSER:${reqId}`, `🖱️  Clicking button at X:${clickX}, Y:${clickY}...`);
            await page.mouse.move(clickX, clickY, { steps: 10 });
            await delay(200);
            await page.mouse.down();
            await delay(100);
            await page.mouse.up();
            log(`BROWSER:${reqId}`, `✅ Mouse click dispatched`);
        } else {
            const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 200).replace(/\n/g, ' '));
            log(`BROWSER:${reqId}`, `❌ No visible download button found! Page text preview: "${bodySnippet}"`);
        }

        log(`BROWSER:${reqId}`, `⏳ Polling for R2 link (max 30s)...`);
        for (let i = 1; i <= 30; i++) {
            if (ultimateMediaUrl) {
                log(`BROWSER:${reqId}`, `🎉 R2 link captured at second ${i}!`);
                break;
            }
            if (i % 5 === 0) {
                log(`BROWSER:${reqId}`, `⏱️  Still waiting... (${i}s / 30s)`);
            }
            await delay(1000);
        }

        if (!ultimateMediaUrl) {
            log(`BROWSER:${reqId}`, `⚠️  Timed out after 30s without capturing R2 link.`);
        }

    } catch (error) {
        log(`BROWSER-ERR:${reqId}`, `💥 Exception: ${error.stack || error.message}`);

        try {
            const tmpDir = os.tmpdir();
            const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('lighthouse'));
            for (const folder of files) {
                const errLogPath = path.join(tmpDir, folder, 'chrome-err.log');
                if (fs.existsSync(errLogPath)) {
                    const logContent = fs.readFileSync(errLogPath, 'utf8');
                    if (logContent.trim()) {
                        log(`CHROME-LOG:${reqId}`, `📄 ${folder}/chrome-err.log:\n${logContent}`);
                    }
                }
            }
        } catch (logErr) {}
    } finally {
        if (browser) {
            log(`BROWSER:${reqId}`, `🧹 Closing Chrome instance...`);
            try {
                await browser.close();
                log(`BROWSER:${reqId}`, `✅ Chrome closed cleanly`);
            } catch (e) {
                log(`BROWSER-ERR:${reqId}`, `⚠️  Error closing browser: ${e.message}`);
            }
        }
    }

    return ultimateMediaUrl;
}

// =========================================================================
// 3. API ENDPOINTS & FULL DOCUMENTATION GUIDE (/)
// =========================================================================

app.get('/', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    if (req.query.format === 'json') {
        return res.json({
            status: 'online',
            baseUrl,
            endpoints: {
                search: `${baseUrl}/search?q=deadpool`,
                infoAndQualities: `${baseUrl}/qualities?url=MOVIE_URL`,
                downloadWithDriveUrl: `${baseUrl}/download?url=DRIVE_URL`,
                downloadWithZtUrl: `${baseUrl}/download?ztUrl=ZT_URL`
            }
        });
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CineSubz Bypass & Scraper API - Full Guide</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --accent: #38bdf8; --green: #22c55e; --code-bg: #020617; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem 1rem; }
        .container { max-width: 920px; margin: 0 auto; }
        header { border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
        h1 { font-size: 1.75rem; color: var(--accent); }
        .badge { background: rgba(34, 197, 94, 0.15); color: var(--green); border: 1px solid rgba(34, 197, 94, 0.4); padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
        .endpoint-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
        .method { background: var(--accent); color: #020617; font-weight: 700; padding: 0.2rem 0.6rem; border-radius: 6px; font-size: 0.85rem; }
        .path { font-family: monospace; font-size: 1.1rem; font-weight: 600; color: #e2e8f0; }
        p { color: var(--muted); margin-bottom: 1rem; }
        pre { background: var(--code-bg); border: 1px solid var(--border); padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.88rem; color: #e2e8f0; margin-top: 0.5rem; margin-bottom: 1rem; }
        code { font-family: "Fira Code", Consolas, monospace; color: var(--accent); }
        .label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; margin-top: 1rem; display: block; }
        table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.9rem; }
        th, td { text-align: left; padding: 0.6rem; border-bottom: 1px solid var(--border); }
        th { color: var(--accent); }
        .note { background: rgba(56, 189, 248, 0.1); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; border-radius: 4px; font-size: 0.9rem; color: #cbd5e1; }
    </style>
</head>
<body>
<div class="container">
    <header>
        <div>
            <h1>🎬 CineSubz Scraper & R2 Bypass API</h1>
            <p style="margin:0; margin-top:4px;">Base URL: <code>${baseUrl}</code></p>
        </div>
        <span class="badge">● SYSTEM ONLINE</span>
    </header>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/search?q={query}</span>
        </div>
        <p>Search movies or TV series by name. Returns title, release year, poster image, and movie page URL.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>q</code></td><td>Yes</td><td>Movie name to search (e.g., <code>deadpool</code>)</td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/search?q=deadpool</pre>
        <span class="label">Example Response</span>
        <pre>{
  "success": true,
  "results": [
    {
      "title": "Deadpool & Wolverine (2024)",
      "year": "2024",
      "poster": "https://cinesubz.lk/wp-content/uploads/...",
      "url": "https://cinesubz.lk/movies/deadpool-wolverine-2024/"
    }
  ]
}</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/qualities?url={movieUrl}</span>
        </div>
        <p>Extracts full movie metadata (poster, gallery images, rating, genres, synopsis) AND automatically resolves all ZT download links into direct <code>driveUrl</code> links in parallel.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code></td><td>Yes</td><td>Movie page URL obtained from <code>/search</code></td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/qualities?url=https://cinesubz.lk/movies/deadpool-wolverine-2024/</pre>
        <span class="label">Example Response</span>
        <pre>{
  "success": true,
  "movie": {
    "title": "Deadpool & Wolverine (2024)",
    "url": "https://cinesubz.lk/movies/deadpool-wolverine-2024/",
    "poster": "https://...",
    "images": ["https://...", "https://..."],
    "rating": "7.8",
    "releaseDate": "Jul. 24, 2024",
    "duration": "128 min",
    "genres": ["Action", "Comedy", "Sci-Fi"],
    "synopsis": "A listless Wade Wilson toils away in civilian life..."
  },
  "downloads": [
    {
      "quality": "480p WEBRip",
      "size": "450 MB",
      "ztUrl": "https://cinesubz.net/api-.../mokn1g449p/",
      "driveUrl": "https://drive.csplayer2.space/server4/new/Deadpool...480p?ext=mp4"
    }
  ]
}</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/download?url={driveUrl_or_ztUrl}</span>
        </div>
        <p>Bypasses Cloudflare & anti-bot protections using Real Chrome and extracts the final Cloudflare R2 / S3 presigned direct download link.</p>
        <div class="note">
            <strong>Smart Link Detection:</strong> You can pass either the pre-resolved <code>driveUrl</code> (faster) OR the raw <code>ztUrl</code> using <code>?url=</code>, <code>?driveUrl=</code>, or <code>?ztUrl=</code>.
        </div>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code> (or <code>driveUrl</code> / <code>ztUrl</code>)</td><td>Yes</td><td>Either <code>driveUrl</code> or <code>ztUrl</code> from <code>/qualities</code></td></tr>
        </table>
        <span class="label">Example Request (Using pre-resolved driveUrl - Recommended)</span>
        <pre>${baseUrl}/download?url=https://drive.csplayer2.space/server4/new/Deadpool...480p?ext=mp4</pre>
        <span class="label">Example Response</span>
        <pre>{
  "success": true,
  "inputType": "driveUrl",
  "driveUrl": "https://drive.csplayer2.space/server4/new/Deadpool...480p?ext=mp4",
  "downloadUrl": "https://pub-xxxx.r2.cloudflarestorage.com/movie.mp4?X-Amz-Algorithm=..."
}</pre>
    </div>

    <div class="card">
        <h3 style="margin-bottom: 0.75rem; color: var(--accent);">⚡ Node.js / Bot Integration Example</h3>
        <pre>import axios from 'axios';

const API = '${baseUrl}';

// 1. Search Movie
const { data: searchData } = await axios.get(\`\${API}/search\`, { params: { q: 'deadpool' } });
const movieUrl = searchData.results[0].url;

// 2. Get Full Movie Info + Resolved Drive Links
const { data: infoData } = await axios.get(\`\${API}/qualities\`, { params: { url: movieUrl } });
console.log(infoData.movie.title, infoData.movie.poster);

// 3. Get Final R2 Direct Download Link (Pass driveUrl directly)
const selected = infoData.downloads[0];
const { data: dlData } = await axios.get(\`\${API}/download\`, { params: { url: selected.driveUrl } });
console.log('Direct R2 Link:', dlData.downloadUrl);</pre>
    </div>
</div>
</body>
</html>`);
});

// 1. Search Endpoint
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        log(`WARN:${req.reqId}`, `Missing query parameter "q"`);
        return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
    }
    try {
        const results = await searchMovies(query, req.reqId);
        res.json({ success: true, results });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Search failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Movie Info + Resolved Qualities Endpoint (Supports /qualities and /info)
app.get(['/qualities', '/info'], async (req, res) => {
    const movieUrl = req.query.url;
    if (!movieUrl) {
        log(`WARN:${req.reqId}`, `Missing query parameter "url"`);
        return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    }
    try {
        const data = await getMovieInfoAndQualities(movieUrl, req.reqId);
        res.json({ success: true, ...data });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Info/Qualities fetch failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Smart Download Endpoint (Accepts driveUrl OR ztUrl via ?url=, ?driveUrl=, or ?ztUrl=)
app.get('/download', async (req, res) => {
    const inputUrl = req.query.url || req.query.driveUrl || req.query.ztUrl;
    if (!inputUrl) {
        log(`WARN:${req.reqId}`, `Missing URL parameter ("url", "driveUrl", or "ztUrl")`);
        return res.status(400).json({
            success: false,
            error: 'Provide either "url", "driveUrl", or "ztUrl" query parameter'
        });
    }

    try {
        let driveUrl = inputUrl;
        let inputType = 'driveUrl';

        // Check if input is already a resolved drive/csplayer link or needs ZT resolution
        const isAlreadyResolved = inputUrl.includes('drive.csplayer') || inputUrl.includes('?ext=');

        if (!isAlreadyResolved) {
            inputType = 'ztUrl';
            log(`DOWNLOAD:${req.reqId}`, `🔄 Input detected as ZT Link. Resolving first...`);
            driveUrl = await resolveZtLink(inputUrl, req.reqId);
            if (!driveUrl) {
                return res.status(404).json({ success: false, error: 'Failed to resolve ZT link' });
            }
        } else {
            log(`DOWNLOAD:${req.reqId}`, `⚡ Input detected as pre-resolved Drive URL. Skipping ZT step!`);
        }

        const finalLink = await getUltimateR2Link(driveUrl, req.reqId);
        if (!finalLink) {
            return res.status(500).json({ success: false, error: 'Failed to extract R2 link' });
        }

        log(`SUCCESS:${req.reqId}`, `🚀 Sending final R2 URL to client`);
        res.json({
            success: true,
            inputType,
            driveUrl,
            downloadUrl: finalLink
        });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Download pipeline failed: ${e.stack || e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    log('SYSTEM', `🚀 Server running on port ${PORT}`);
});
