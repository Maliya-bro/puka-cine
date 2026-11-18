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
// 1. SCRAPING & RESOLVING FUNCTIONS (UNIFIED)
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

        if (title && url && !seenUrls.has(url)) {
            seenUrls.add(url);
            const type = url.includes('/tvshows/') ? 'tvshow' : (url.includes('/episodes/') ? 'episode' : 'movie');
            results.push({ title, type, url });
        }
    });

    log(`SEARCH:${reqId}`, `✅ Found ${results.length} results for "${query}"`);
    return results;
}

async function resolveZtLink(ztLinkUrl, reqId) {
    try {
        const { data } = await axios.get(ztLinkUrl, { headers: COMMON_HEADERS, timeout: 15000 });
        const $ = cheerio.load(data);
        let rawLink = $('#link').attr('href');

        if (!rawLink) return null;

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

        return driveUrl;
    } catch (err) {
        return null;
    }
}

async function getContentInfo(targetUrl, reqId) {
    const cleanUrl = targetUrl.split('?')[0];

    log(`INFO:${reqId}`, `🎞️  Fetching content: ${cleanUrl}`);

    const { data } = await axios.get(cleanUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    const schemaType = $('.content-info').attr('itemtype') || '';
    const isTvShow = cleanUrl.includes('/tvshows/') || schemaType.includes('TVSeries') || $('#episodes-section').length > 0;

    const title = $('.details-title h3').first().text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || 'Unknown Title';
    const tagline = $('.movie-tagline-box .tagline-text').first().text().trim() || null;
    const poster = $('.content-poster img.poster-img').first().attr('src') || $('.content-poster img').first().attr('data-src') || $('meta[property="og:image"]').last().attr('content') || null;
    const backdrop = $('.player-splash .splash-bg img').first().attr('src') || null;
    
    const gallery = [];
    $('.content-gall .gall-item a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.startsWith('http') && !gallery.includes(href)) gallery.push(href);
    });

    const descClone = $('.details-desc').first().clone();
    descClone.find('br').replaceWith('\n');
    const synopsis = descClone.text().split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n\n') || null;

    const imdbId = $('.imdb-data').attr('data-imdb') || null;
    const imdbMatch = $('.data-imdb').text().replace(/\s+/g, ' ').trim().match(/IMDb:\s*([\d.]+)/i);
    const imdbRating = imdbMatch ? imdbMatch[1] : null;
    const siteRating = $('.zt_rating_vgs').first().text().trim() || null;
    const qualityBadge = $('.details-data .data-quality').first().text().trim() || null;
    const duration = $('.details-data span[itemprop="duration"]').first().text().trim() || null;
    const releaseDate = $('meta[itemprop="dateCreated"]').attr('content')?.trim() || null;

    const genres = [];
    $('.details-genre a').each((i, el) => {
        const g = $(el).text().trim();
        if (g && !g.startsWith('#') && !genres.includes(g)) genres.push(g);
    });

    let director = null, year = null, subtitleBy = null, country = null;
    $('.details-info p').each((i, el) => {
        const label = $(el).find('strong').text().trim().toLowerCase();
        const value = $(el).clone().children('strong').remove().end().text().trim();
        if (label.includes('director')) director = value || null;
        else if (label.includes('year')) year = value || null;
        else if (label.includes('subtitle')) subtitleBy = value || null;
        else if (label.includes('country')) country = value || null;
    });

    const cast = [];
    $('.zt-cast-card').each((i, el) => {
        const name = $(el).find('.zt-cast-name').text().trim();
        const character = $(el).find('.zt-cast-role').text().trim() || null;
        const image = $(el).find('.zt-cast-image img').attr('src') || null;
        if (name) cast.push({ name, character, image });
    });

    if (isTvShow) {
        // --- 1. TV SHOW : Returns TV Show details and Seasons List ---
        const seasons = [];
        $('.season-select ul.episodes-list').each((i, ulEl) => {
            const sNum = parseInt($(ulEl).attr('data-season'), 10) || (i + 1);
            const epCount = $(ulEl).find('li a.episode-link').length;
            if (epCount > 0) {
                seasons.push({
                    season: sNum,
                    episodesCount: epCount,
                    link: `${cleanUrl}?season=${sNum}` // /download එකට යැවීමට
                });
            }
        });

        return {
            type: 'tvshow',
            tvshow: { 
                title, tagline, url: cleanUrl, poster, backdrop, synopsis,
                details: { imdbId, imdbRating, siteRating, quality: qualityBadge, releaseDate, year, duration, director, subtitleBy, country, genres },
                cast, gallery
            },
            seasons
        };
    } else {
        // --- 2. MOVIE : Returns Movie details and Resolves links ---
        const rawQualities = [];
        $('.movie-download-link-item a, .download-link-item a').each((i, el) => {
            const ztUrl = $(el).attr('href');
            const metaText = $(el).find('.movie-download-meta, .download-meta').text().trim();
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
                return { ...item, driveUrl };
            })
        );

        return {
            type: 'movie',
            movie: {
                title, tagline, url: cleanUrl, poster, backdrop, synopsis,
                details: { imdbId, imdbRating, siteRating, quality: qualityBadge, releaseDate, year, duration, director, subtitleBy, country, genres },
                cast, gallery
            },
            downloads
        };
    }
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
        log(`BROWSER:${reqId}`, `🤖 Launching Chrome via puppeteer-real-browser...`);

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

        page.on('console', msg => {
            if (msg.type() === 'error' && !msg.text().includes('ERR_FAILED')) {
                log(`PAGE-ERR:${reqId}`, `⚠️  Browser Console Error: ${msg.text()}`);
            }
        });

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'deny' });

        client.on('Browser.downloadWillBegin', (e) => {
            if (e.url && e.url.startsWith('http')) {
                ultimateMediaUrl = e.url;
            }
        });

        await page.evaluateOnNewDocument(() => {
            window.DisableDevtool = function() { };
            window.open = function(url) {
                if (url && (url.includes('cloudflarestorage') || url.includes('X-Amz') || url.includes('r2.dev') || url.includes('drive.csplayer'))) {
                    window.location.href = url;
                }
                return window;
            };
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
                req.abort();
            } else if (
                url.includes('X-Amz-Credential') ||
                url.includes('cloudflarestorage.com') ||
                url.includes('?X-Amz-Algorithm') ||
                url.includes('.r2.dev/')
            ) {
                if (!ultimateMediaUrl) ultimateMediaUrl = url;
                req.abort();
            } else {
                req.continue();
            }
        });

        page.on('response', (res) => {
            const status = res.status();
            const headers = res.headers();
            const location = headers['location'] || '';
            const contentDisp = headers['content-disposition'] || '';

            if ((status >= 300 && status < 400) && (location.includes('X-Amz') || location.includes('cloudflarestorage') || location.includes('r2.dev'))) {
                if (!ultimateMediaUrl) ultimateMediaUrl = location;
            } else if (contentDisp.includes('attachment') && res.url().startsWith('http')) {
                if (!ultimateMediaUrl) ultimateMediaUrl = res.url();
            }
        });

        await page.goto(driveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        for (let w = 0; w < 12; w++) {
            await delay(1000);
            try {
                const titleNow = await page.title();
                if (titleNow && !titleNow.toLowerCase().includes('loading')) {
                    break;
                }
            } catch (e) {}
        }
        await delay(1500);

        const scanResult = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('.button.direct-download, a.direct-download, button.direct-download, #dl-links .button.direct-download'));
            const details = buttons.map((btn, idx) => {
                const style = window.getComputedStyle(btn);
                const rect = btn.getBoundingClientRect();
                const isFake = style.position === 'absolute' || (style.clipPath && style.clipPath.includes('inset')) || parseInt(style.zIndex || '0') < 0 || (style.transform && (style.transform.includes('scale(0)') || style.transform.includes('translate(-100vw'))) || parseFloat(style.fontSize) === 0;
                const isVisible = !isFake && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.1 && style.pointerEvents !== 'none' && rect.width > 20 && rect.height > 10;
                return { idx, text: (btn.innerText || '').trim().replace(/\s+/g, ' '), href: btn.getAttribute('href') || '', isVisible, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
            });

            const visibleBtns = details.filter(d => d.isVisible);
            const preferred = visibleBtns.find(d => /direct|download/i.test(d.text) && !/telegram|ads|fast/i.test(d.text)) || visibleBtns[0] || null;

            if (preferred) {
                const targetEl = buttons[preferred.idx];
                targetEl.scrollIntoView({ behavior: 'instant', block: 'center' });
                const newRect = targetEl.getBoundingClientRect();
                preferred.rect = { x: newRect.x, y: newRect.y, width: newRect.width, height: newRect.height };

                const centerX = newRect.x + newRect.width / 2;
                const centerY = newRect.y + newRect.height / 2;
                let topEl = document.elementFromPoint(centerX, centerY);
                let attempts = 0;
                while (topEl && topEl !== targetEl && !targetEl.contains(topEl) && attempts < 5) {
                    topEl.style.pointerEvents = 'none';
                    topEl.style.display = 'none';
                    topEl = document.elementFromPoint(centerX, centerY);
                    attempts++;
                }
            }
            return { chosen: preferred };
        });

        if (scanResult.chosen) {
            await delay(800);
            const box = scanResult.chosen.rect;
            const clickX = Math.round(box.x + (box.width / 2));
            const clickY = Math.round(box.y + (box.height / 2));

            await page.mouse.move(clickX, clickY, { steps: 10 });
            await delay(200);
            await page.mouse.down();
            await delay(100);
            await page.mouse.up();
        }

        for (let i = 1; i <= 30; i++) {
            if (ultimateMediaUrl) break;
            await delay(1000);
        }

    } catch (error) {
        log(`BROWSER-ERR:${reqId}`, `💥 Exception: ${error.stack || error.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }

    return ultimateMediaUrl;
}

// =========================================================================
// 3. API ENDPOINTS & DOCUMENTATION
// =========================================================================

app.get('/', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CineSubz Bypass API</title>
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
        .note { background: rgba(56, 189, 248, 0.1); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; border-radius: 4px; font-size: 0.9rem; color: #cbd5e1; }
        ul { margin-left: 1.5rem; margin-bottom: 1rem; }
    </style>
</head>
<body>
<div class="container">
    <header>
        <div>
            <h1>🎬 CineSubz Scraper & API (Unified Architecture)</h1>
            <p style="margin:0; margin-top:4px;">Base URL: <code>${baseUrl}</code></p>
        </div>
        <span class="badge">● SYSTEM ONLINE</span>
    </header>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/search?q={query}</span>
        </div>
        <p>Search for Movies or TV Series. Returns title, type (movie/tvshow), and URL.</p>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/search?q=spider man</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/info?url={movie_or_tvshow_url}</span>
            <span style="color:#94a3b8; font-size:0.85rem;">(Alias: <code>/qualities</code>)</span>
        </div>
        <p>Unified endpoint for fetching details. <strong>Fully supports both Movies and TV Shows.</strong></p>
        <ul>
            <li style="color:#cbd5e1; margin-bottom:8px;"><strong>🎬 For Movies:</strong> Returns full details + direct ZT/Drive download links.</li>
            <li style="color:#cbd5e1; margin-bottom:8px;"><strong>📺 For TV Shows:</strong> Returns full details + List of Seasons with pseudo-links (e.g. <code>?season=1</code>) to fetch episodes later.</li>
        </ul>
        <span class="label">Example Request (Movie)</span>
        <pre>${baseUrl}/info?url=https://cinesubz.lk/movies/spider-man/</pre>
        <span class="label">Example Request (TV Show)</span>
        <pre>${baseUrl}/info?url=https://cinesubz.lk/tvshows/the-boys/</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/download?url={season_link_OR_drive_link}</span>
        </div>
        <p>This endpoint smartly handles two completely different things based on the URL you pass to it:</p>
        <div class="note">
            <strong>📺 1. TV Series (Season Link):</strong> (e.g., <code>?season=1</code> from the info response)<br>
            It will scrape that TV show, extract <strong>ALL episodes</strong> for that season, resolve all their ZT links to Drive links, bypass R2 sequentially, and return a clean JSON of all episodes with their final DL links.
            <br><br>
            <strong>🎬 2. Movie (Drive/ZT Link):</strong><br>
            It will launch Real Chrome, bypass the Cloudflare/R2 protections, and return the final playable/downloadable <code>.r2.dev</code> URL.
        </div>
        <span class="label">Example 1: Fetching all Episode DL Links for Season 1 (TV Show)</span>
        <pre>${baseUrl}/download?url=https://cinesubz.lk/tvshows/the-boys/?season=1</pre>
        <span class="label">Example 2: Bypassing R2 for a Final Download (Movie)</span>
        <pre>${baseUrl}/download?url=https://drive.csplayer2.space/server4/movie.mp4?ext=mp4</pre>
    </div>
</div>
</body>
</html>`);
});

// 1. Search Endpoint
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

// 2. Info / Qualities Endpoint
app.get(['/qualities', '/info'], async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    try {
        const data = await getContentInfo(targetUrl, req.reqId);
        res.json({ success: true, ...data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Smart Download Endpoint
app.get('/download', async (req, res) => {
    const inputUrl = req.query.url || req.query.driveUrl || req.query.ztUrl;
    if (!inputUrl) return res.status(400).json({ success: false, error: 'Provide a URL parameter' });

    try {
        // --- 🔴 IF USER PASSED A SEASON LINK (e.g. ?season=1) ---
        if (inputUrl.includes('?season=')) {
            log(`DOWNLOAD:${req.reqId}`, `🔄 Season Link detected. Extracting episodes & final DL links sequentially...`);
            const urlObj = new URL(inputUrl);
            const sNum = parseInt(urlObj.searchParams.get('season'), 10);
            const cleanUrl = inputUrl.split('?')[0];

            const { data } = await axios.get(cleanUrl, { headers: COMMON_HEADERS });
            const $ = cheerio.load(data);

            const epLinks = [];
            $(`.season-select ul.episodes-list[data-season="${sNum}"] li a.episode-link`).each((i, el) => {
                const epUrl = $(el).attr('href');
                const epNum = parseInt($(el).find('.ep-num').text().trim(), 10) || (i + 1);
                const epTitle = $(el).find('.ep-title').text().trim() || `Episode ${epNum}`;
                if (epUrl) epLinks.push({ url: epUrl, episodeNumber: epNum, episodeName: epTitle, season: sNum });
            });

            const episodesResult = [];
            
            // එකින් එක (Sequential) විදිහට process කිරීම
            for (const ep of epLinks) {
                log(`DOWNLOAD:${req.reqId}`, `🎬 Processing Ep ${ep.episodeNumber}: ${ep.episodeName}`);
                try {
                    const epData = await axios.get(ep.url, { headers: COMMON_HEADERS });
                    const $ep = cheerio.load(epData.data);
                    const rawQualities = [];
                    
                    $ep('.movie-download-link-item a, .download-link-item a').each((i, el) => {
                        const ztUrl = $ep(el).attr('href');
                        const metaText = $ep(el).find('.movie-download-meta, .download-meta').text().trim();
                        if (ztUrl && metaText) {
                            const parts = metaText.split('•').map(p => p.trim());
                            rawQualities.push({
                                quality: parts[0] || metaText,
                                size: parts[1] || null,
                                ztUrl
                            });
                        }
                    });

                    const downloads = [];
                    for (const item of rawQualities) {
                        const driveUrl = await resolveZtLink(item.ztUrl, req.reqId);
                        if (driveUrl) {
                            log(`DOWNLOAD:${req.reqId}`, `⚙️ Extracting Final DL Link for Ep ${ep.episodeNumber} [${item.quality}]...`);
                            
                            // Get Final R2 link via Chrome (Wait for it to finish before moving to next)
                            const finalLink = await getUltimateR2Link(driveUrl, req.reqId);
                            if (finalLink) {
                                downloads.push({
                                    quality: item.quality,
                                    size: item.size,
                                    dl_link: finalLink
                                });
                            }
                        }
                    }

                    episodesResult.push({
                        epi_name: ep.episodeName,
                        epi_season: ep.season,
                        epi_number: ep.episodeNumber,
                        downloads: downloads
                    });

                } catch (err) {
                    log(`ERR:${req.reqId}`, `Failed Ep ${ep.episodeNumber}: ${err.message}`);
                }
            }

            return res.json({
                success: true,
                type: 'season_episodes',
                season: sNum,
                episodes: episodesResult
            });
        }

        // --- 🔴 IF USER PASSED A NORMAL ZT OR DRIVE LINK (MOVIE) ---
        let driveUrl = inputUrl;
        let inputType = 'driveUrl';
        const isAlreadyResolved = inputUrl.includes('drive.csplayer') || inputUrl.includes('?ext=');

        if (!isAlreadyResolved) {
            inputType = 'ztUrl';
            driveUrl = await resolveZtLink(inputUrl, req.reqId);
            if (!driveUrl) return res.status(404).json({ success: false, error: 'Failed to resolve ZT link' });
        }

        const finalLink = await getUltimateR2Link(driveUrl, req.reqId);
        if (!finalLink) return res.status(500).json({ success: false, error: 'Failed to extract R2 link' });

        res.json({
            success: true,
            inputType,
            driveUrl,
            downloadUrl: finalLink
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    log('SYSTEM', `🚀 Server running on port ${PORT}`);
});
