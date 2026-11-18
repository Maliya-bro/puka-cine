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
// 1. SCRAPING & RESOLVING FUNCTIONS (MOVIES & TV SHOWS)
// =========================================================================

async function searchMovies(query, reqId) {
    const searchUrl = `https://cinesubz.lk/?s=${encodeURIComponent(query)}`;
    log(`SEARCH:${reqId}`, `🔍 Fetching URL: ${searchUrl}`);

    const { data } = await axios.get(searchUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);
    const results = [];
    const seenUrls = new Set();

    $('.page-body .display-item .item-box, .display-item .item-box').each((i, el) => {
        const anchor = $(el).find('> a').first();
        const title = anchor.attr('title')?.trim() || $(el).find('.item-desc-title h3').text().trim();
        const url = anchor.attr('href');
        const type = url && url.includes('/tvshows/') ? 'tvshow' : 'movie';

        if (title && url && !seenUrls.has(url)) {
            seenUrls.add(url);
            results.push({ title, type, url });
        }
    });

    log(`SEARCH:${reqId}`, `✅ Found ${results.length} results for "${query}"`);
    return results;
}

async function resolveZtLink(ztLinkUrl, reqId) {
    if (!ztLinkUrl) return null;
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

async function getMovieOrTvInfo(targetUrl, reqId) {
    const isTvShow = targetUrl.includes('/tvshows/');
    log(`INFO:${reqId}`, `🎞️  Fetching ${isTvShow ? 'TV Show' : 'Movie'} details: ${targetUrl}`);

    const { data } = await axios.get(targetUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    const title = $('.details-title h3').first().text().trim()
        || $('meta[property="og:title"]').attr('content')?.trim()
        || 'Unknown Title';

    const poster = $('.content-poster img.poster-img').first().attr('src')
        || $('.content-poster img').first().attr('data-src')
        || $('meta[property="og:image"]').last().attr('content')
        || null;

    const synopsis = $('.details-desc').first().text().trim() || null;

    if (isTvShow) {
        const seasons = [];
        $('.season-select-box select option, .seasons-list a, .zt-season-item, .tvshows-season-box a').each((i, el) => {
            const seasonNum = $(el).attr('value') || $(el).attr('data-season') || $(el).text().replace(/\D/g, '') || (i + 1);
            const seasonUrl = `${targetUrl.replace(/\/+$/, '')}/?season=${seasonNum}`;
            seasons.push({
                season: Number(seasonNum),
                title: $(el).text().trim() || `Season ${seasonNum}`,
                url: seasonUrl
            });
        });

        if (seasons.length === 0) {
            seasons.push({ season: 1, title: 'Season 1', url: `${targetUrl.replace(/\/+$/, '')}/?season=1` });
        }

        return {
            type: 'tvshow',
            tvshow: { title, url: targetUrl, poster, synopsis },
            totalSeasons: seasons.length,
            seasons
        };
    } else {
        const rawQualities = [];
        $('.movie-download-link-item a').each((i, el) => {
            const ztUrl = $(el).attr('href');
            const metaText = $(el).find('.movie-download-meta').text().trim();

            if (ztUrl && metaText) {
                const parts = metaText.split('•').map(p => p.trim());
                rawQualities.push({
                    label: metaText,
                    quality: parts[0] || metaText,
                    size: parts[1] || null,
                    language: parts[2] || null,
                    ztUrl
                });
            }
        });

        log(`INFO:${reqId}`, `⚡ Resolving ${rawQualities.length} ZT links in parallel...`);
        const downloads = await Promise.all(
            rawQualities.map(async (item) => {
                const driveUrl = await resolveZtLink(item.ztUrl, reqId);
                return {
                    label: item.label,
                    quality: item.quality,
                    size: item.size,
                    language: item.language,
                    ztUrl: item.ztUrl,
                    driveUrl
                };
            })
        );

        return {
            type: 'movie',
            movie: { title, url: targetUrl, poster, synopsis },
            downloads
        };
    }
}

// Scrape All Episodes for a given TV Show Season URL with robust Selectors & Fallback
async function getSeasonEpisodes(seasonUrl, reqId) {
    log(`SEASON:${reqId}`, `📺 Scraping Season Episodes from: ${seasonUrl}`);
    const { data } = await axios.get(seasonUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    const episodes = [];
    
    // Comprehensive selectors for CineSubz TV Show seasons / episodes
    $('.episodes-list-item, .episodess-item, .ep-card, .display-item .item-box, .episodess-box, .tvshow-eps-list li, .seasons-ep-item').each((i, el) => {
        const epTitle = $(el).find('.episodess-title, .ep-title, h3, .item-desc-title, .episodess-name').text().trim() || `Episode ${i + 1}`;
        const ztUrl = $(el).find('a.episodess-link, a.ep-link, a').attr('href');
        const metaText = $(el).find('.episodess-meta, .ep-meta, .episodess-info').text().trim();
        
        const qualityMatch = metaText.match(/(HD \d+P|SD|FHD|4K|720p|1080p)/i);
        const sizeMatch = metaText.match(/(\d+(\.\d+)?\s*(MB|GB))/i);

        if (ztUrl) {
            episodes.push({
                episode: i + 1,
                title: epTitle,
                quality: qualityMatch ? qualityMatch[0] : 'HD 720P',
                size: sizeMatch ? sizeMatch[0] : null,
                ztUrl
            });
        }
    });

    // Fallback: If structured selectors return 0, scan entire page for links leading to zt-links
    if (episodes.length === 0) {
        log(`SEASON:${reqId}`, `⚠️ Primary selectors missed. Scanning all page anchors for zt-links...`);
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && (href.includes('/zt-links/') || href.includes('ztUrl') || text.toLowerCase().includes('episode'))) {
                if (!episodes.some(e => e.ztUrl === href)) {
                    episodes.push({
                        episode: episodes.length + 1,
                        title: text || `Episode ${episodes.length + 1}`,
                        quality: 'HD 720P',
                        size: null,
                        ztUrl: href
                    });
                }
            }
        });
    }

    log(`SEASON:${reqId}`, `✅ Found ${episodes.length} episodes for season`);
    return episodes;
}

// =========================================================================
// 2. LINUX REAL BROWSER SECTION (FAST R2 BYPASS)
// =========================================================================

async function getUltimateR2Link(driveUrl, reqId) {
    if (!driveUrl) return null;
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
        const connection = await connect({
            headless: false,
            turnstile: true,
            disableXvfb: true,
            args: chromeFlags,
            customConfig: {
                chromePath: '/usr/bin/google-chrome',
                chromeFlags: chromeFlags,
                port: 0,
                logLevel: 'silent'
            }
        });

        browser = connection.browser;
        const page = connection.page;

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'deny' });

        client.on('Browser.downloadWillBegin', (e) => {
            if (e.url && e.url.startsWith('http')) ultimateMediaUrl = e.url;
        });

        await page.evaluateOnNewDocument(() => {
            window.DisableDevtool = function() { };
            window.open = function(url) {
                if (url && (url.includes('cloudflarestorage') || url.includes('X-Amz') || url.includes('r2.dev') || url.includes('drive.csplayer'))) {
                    window.location.href = url;
                }
                return window;
            };
        });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (
                url.includes('X-Amz-Credential') ||
                url.includes('cloudflarestorage.com') ||
                url.includes('?X-Amz-Algorithm') ||
                url.includes('.r2.dev/')
            ) {
                if (!ultimateMediaUrl) ultimateMediaUrl = url;
                req.abort();
            } else if (url.includes('disable-devtool')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        page.on('response', (res) => {
            const headers = res.headers();
            const location = headers['location'] || '';
            const contentDisp = headers['content-disposition'] || '';

            if (location.includes('X-Amz') || location.includes('cloudflarestorage') || location.includes('r2.dev')) {
                if (!ultimateMediaUrl) ultimateMediaUrl = location;
            } else if (contentDisp.includes('attachment') && res.url().startsWith('http')) {
                if (!ultimateMediaUrl) ultimateMediaUrl = res.url();
            }
        });

        await page.goto(driveUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        for (let w = 0; w < 8; w++) {
            await delay(1000);
            try {
                const titleNow = await page.title();
                if (titleNow && !titleNow.toLowerCase().includes('loading')) break;
            } catch (e) {}
        }
        await delay(800);

        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('.button.direct-download, a.direct-download, button.direct-download'));
            const btn = buttons.find(b => {
                const style = window.getComputedStyle(b);
                return style.display !== 'none' && style.visibility !== 'hidden';
            }) || buttons[0];

            if (btn) btn.click();
        });

        for (let i = 1; i <= 15; i++) {
            if (ultimateMediaUrl) break;
            await delay(1000);
        }

    } catch (error) {
        log(`BROWSER-ERR:${reqId}`, `💥 Exception: ${error.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }

    return ultimateMediaUrl;
}

// =========================================================================
// 3. API ENDPOINTS & HTML DOCUMENTATION (/)
// =========================================================================

app.get('/', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    if (req.query.format === 'json') {
        return res.json({
            status: 'online',
            baseUrl,
            endpoints: {
                search: `${baseUrl}/search?q=game of thrones`,
                info: `${baseUrl}/info?url=MOVIE_OR_TVSHOW_URL`,
                download: `${baseUrl}/download?url=DRIVE_URL_OR_SEASON_URL`
            }
        });
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CineSubz Unified Movies & TV Shows Scraper & R2 Bypass API</title>
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
            <h1>🎬 CineSubz Unified Scraper & API (Movies & TV Shows)</h1>
            <p style="margin:0; margin-top:4px;">Base URL: <code>${baseUrl}</code></p>
        </div>
        <span class="badge">● SYSTEM ONLINE</span>
    </header>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/search?q={query}</span>
        </div>
        <p>Search for both Movies and TV Series. Returns title, type (movie/tvshow), and URL.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>q</code></td><td>Yes</td><td>Search query (e.g., <code>game of thrones</code> or <code>spider man</code>)</td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/search?q=game of thrones</pre>
        <span class="label">Example Response</span>
        <pre>{
  "success": true,
  "count": 10,
  "results": [
    {
      "title": "Game of Thrones (2011) Sinhala Subtitles",
      "type": "tvshow",
      "url": "https://cinesubz.lk/tvshows/game-of-thrones-2011-sinhala-subtitles/"
    }
  ]
}</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/info?url={url}</span>
            <span style="color:#94a3b8; font-size:0.85rem;">(Alias: <code>/qualities</code>)</span>
        </div>
        <p>Unified endpoint for fetching details. Supports both Movies and TV Shows.</p>
        <ul style="color: var(--muted); margin-left: 1.5rem; margin-bottom: 1rem;">
            <li><strong>Movies:</strong> Returns full details + direct ZT/Drive download links.</li>
            <li><strong>TV Shows:</strong> Returns full details + List of Seasons with pseudo-links (e.g., <code>?season=1</code>).</li>
        </ul>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code></td><td>Yes</td><td>Movie or TV Show page URL from <code>/search</code></td></tr>
        </table>
        <span class="label">Example Request (TV Show)</span>
        <pre>${baseUrl}/info?url=https://cinesubz.lk/tvshows/game-of-thrones-2011-sinhala-subtitles/</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/download?url={season_link_OR_drive_link}</span>
        </div>
        <p>Smartly handles two distinct inputs:</p>
        <ul style="color: var(--muted); margin-left: 1.5rem; margin-bottom: 1rem;">
            <li><strong>TV Series Season Link:</strong> Scrapes all episodes for that season, resolves ZT links, bypasses R2, and returns clean JSON with direct episode DL links.</li>
            <li><strong>Movie Drive/ZT Link:</strong> Launches Real Chrome, bypasses Cloudflare/R2 protections, and returns the final `.r2.dev` direct URL.</li>
        </ul>
        <span class="label">Example Request (Season Link)</span>
        <pre>${baseUrl}/download?url=https://cinesubz.lk/tvshows/game-of-thrones-2011-sinhala-subtitles/?season=1</pre>
    </div>
</div>
</body>
</html>`);
});

app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
    try {
        const results = await searchMovies(query, req.reqId);
        res.json({ success: true, count: results.length, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get(['/qualities', '/info'], async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    try {
        const data = await getMovieOrTvInfo(targetUrl, req.reqId);
        res.json({ success: true, ...data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/download', async (req, res) => {
    const inputUrl = req.query.url || req.query.driveUrl || req.query.ztUrl;
    if (!inputUrl) {
        return res.status(400).json({ success: false, error: 'Provide "url" query parameter' });
    }

    try {
        const isSeasonUrl = inputUrl.includes('?season=') || inputUrl.includes('/tvshows/');

        if (isSeasonUrl) {
            log(`DOWNLOAD:${req.reqId}`, `📺 TV Series Season detected. Scraping all episodes...`);
            const rawEpisodes = await getSeasonEpisodes(inputUrl, req.reqId);

            if (rawEpisodes.length === 0) {
                return res.status(404).json({ success: false, error: 'No episodes found for this season' });
            }

            log(`DOWNLOAD:${req.reqId}`, `⚡ Resolving ZT links & bypassing R2 for ${rawEpisodes.length} episodes in parallel batches...`);

            const resolvedEpisodes = [];
            const batchSize = 3;

            for (let i = 0; i < rawEpisodes.length; i += batchSize) {
                const batch = rawEpisodes.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(async (ep) => {
                    let driveUrl = await resolveZtLink(ep.ztUrl, req.reqId);
                    let directDownloadUrl = null;
                    if (driveUrl) {
                        directDownloadUrl = await getUltimateR2Link(driveUrl, req.reqId);
                    }
                    return {
                        episode: ep.episode,
                        title: ep.title,
                        quality: ep.quality,
                        size: ep.size,
                        driveUrl,
                        directDownloadUrl
                    };
                }));
                resolvedEpisodes.push(...batchResults);
            }

            return res.json({
                success: true,
                type: 'tvshow_season',
                seasonUrl: inputUrl,
                totalEpisodes: resolvedEpisodes.length,
                episodes: resolvedEpisodes
            });
        }

        let driveUrl = inputUrl;
        let inputType = 'driveUrl';

        if (!inputUrl.includes('drive.csplayer') && !inputUrl.includes('?ext=')) {
            inputType = 'ztUrl';
            driveUrl = await resolveZtLink(inputUrl, req.reqId);
            if (!driveUrl) return res.status(404).json({ success: false, error: 'Failed to resolve ZT link' });
        }

        const finalLink = await getUltimateR2Link(driveUrl, req.reqId);
        if (!finalLink) return res.status(500).json({ success: false, error: 'Failed to extract R2 link' });

        res.json({
            success: true,
            type: 'movie',
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
