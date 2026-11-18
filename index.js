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

// ------ EXISTING MOVIE INFO FUNCTION ------
async function getMovieInfoAndQualities(movieUrl, reqId) {
    log(`INFO:${reqId}`, `🎞️  Fetching full movie details & qualities: ${movieUrl}`);

    const { data } = await axios.get(movieUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    // 1. Title & Tagline
    const title = $('.details-title h3').first().text().trim()
        || $('meta[property="og:title"]').attr('content')?.trim()
        || 'Unknown Title';

    const tagline = $('.movie-tagline-box .tagline-text').first().text().trim() || null;

    // 2. Main Poster Image
    const poster = $('.content-poster img.poster-img').first().attr('src')
        || $('.content-poster img').first().attr('data-src')
        || $('meta[property="og:image"]').last().attr('content')
        || null;

    // 3. Backdrop & Gallery Screenshots
    const backdrop = $('.player-splash .splash-bg img').first().attr('src') || null;
    const gallery = [];
    $('.content-gall .gall-item a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.startsWith('http') && !gallery.includes(href)) {
            gallery.push(href);
        }
    });

    // 4. Synopsis / හැඳින්වීම
    const descClone = $('.details-desc').first().clone();
    descClone.find('br').replaceWith('\n');
    const synopsis = descClone.text()
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n\n') || null;

    // 5. Ratings, Duration, Release Date, Quality, IMDb ID
    const imdbId = $('.imdb-data').attr('data-imdb') || null;
    const imdbText = $('.data-imdb').text().replace(/\s+/g, ' ').trim();
    const imdbMatch = imdbText.match(/IMDb:\s*([\d.]+)/i);
    const imdbRating = imdbMatch ? imdbMatch[1] : null;

    const siteRating = $('.zt_rating_vgs').first().text().trim() || null;
    const qualityBadge = $('.details-data .data-quality').first().text().trim() || null;
    const duration = $('.details-data span[itemprop="duration"]').first().text().trim() || null;
    const releaseDate = $('meta[itemprop="dateCreated"]').attr('content')?.trim() || null;

    // 6. Genres
    const genres = [];
    $('.details-genre a').each((i, el) => {
        const g = $(el).text().trim();
        if (g && !g.startsWith('#') && !genres.includes(g)) {
            genres.push(g);
        }
    });

    // 7. Extra Info
    let director = null;
    let year = null;
    let subtitleBy = null;
    let country = null;

    $('.details-info p').each((i, el) => {
        const label = $(el).find('strong').text().trim().toLowerCase();
        const value = $(el).clone().children('strong').remove().end().text().trim();
        if (label.includes('director')) director = value || null;
        else if (label.includes('year')) year = value || null;
        else if (label.includes('subtitle')) subtitleBy = value || null;
        else if (label.includes('country')) country = value || null;
    });

    // 8. Cast List
    const cast = [];
    $('.zt-cast-card').each((i, el) => {
        const name = $(el).find('.zt-cast-name').text().trim();
        const character = $(el).find('.zt-cast-role').text().trim() || null;
        const image = $(el).find('.zt-cast-image img').attr('src') || null;
        if (name) {
            cast.push({ name, character, image });
        }
    });

    // 9. Extract Download Links & Resolve ZT Links in Parallel
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

    log(`INFO:${reqId}`, `✅ Completed full info + ${downloads.length} resolved links`);

    return {
        movie: {
            title,
            tagline,
            url: movieUrl,
            poster,
            backdrop,
            synopsis,
            details: {
                imdbId,
                imdbRating,
                siteRating,
                quality: qualityBadge,
                releaseDate,
                year,
                duration,
                director,
                subtitleBy,
                country,
                genres
            },
            cast,
            gallery
        },
        downloads
    };
}

// ------ NEW: TV SHOW INFO FUNCTION ------
async function getTvShowInfoAndEpisodes(tvShowUrl, reqId) {
    log(`INFO:${reqId}`, `📺 Fetching TV Show details & episodes: ${tvShowUrl}`);

    const { data } = await axios.get(tvShowUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    // Title & Poster
    const title = $('.details-title h3').first().text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || 'Unknown Title';
    const poster = $('.content-poster img.poster-img').first().attr('src') || $('.content-poster img').first().attr('data-src') || $('meta[property="og:image"]').last().attr('content') || null;

    // Synopsis
    const descClone = $('.details-desc').first().clone();
    descClone.find('br').replaceWith('\n');
    const synopsis = descClone.text().split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n\n') || null;

    // Seasons and Episodes
    const seasons = [];
    $('.season-select ul.episodes-list').each((i, ulEl) => {
        const seasonNum = parseInt($(ulEl).attr('data-season'), 10) || (i + 1);
        const episodes = [];

        $(ulEl).find('li a.episode-link').each((j, aEl) => {
            const epUrl = $(aEl).attr('href');
            const epNum = parseInt($(aEl).find('.ep-num').text().trim(), 10) || (j + 1);
            const epTitle = $(aEl).find('.ep-title').text().trim() || `Episode ${epNum}`;
            if (epUrl) {
                episodes.push({ season: seasonNum, episode: epNum, title: epTitle, url: epUrl });
            }
        });

        if (episodes.length > 0) {
            seasons.push({ season: seasonNum, episodes });
        }
    });

    log(`INFO:${reqId}`, `✅ Completed TV Show info. Found ${seasons.length} seasons.`);

    return {
        tvshow: { title, url: tvShowUrl, poster, synopsis },
        seasons
    };
}

// ------ NEW: EPISODE INFO FUNCTION ------
async function getEpisodeInfoAndQualities(episodeUrl, reqId) {
    log(`INFO:${reqId}`, `🎬 Fetching Episode details & links: ${episodeUrl}`);

    const { data } = await axios.get(episodeUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    const title = $('.details-title h3').first().text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || 'Unknown Title';

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

    log(`INFO:${reqId}`, `⚡ Resolving ${rawQualities.length} ZT links for Episode...`);

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

    log(`INFO:${reqId}`, `✅ Completed episode info + ${downloads.length} resolved links`);

    return {
        episode: { title, url: episodeUrl },
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
            if (msg.type() === 'error' && !msg.text().includes('ERR_FAILED')) {
                log(`PAGE-ERR:${reqId}`, `⚠️  Browser Console Error: ${msg.text()}`);
            }
        });

        // CDP Download Interceptor
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'deny' });

        client.on('Browser.downloadWillBegin', (e) => {
            log(`CDP:${reqId}`, `📥 Browser download event triggered: ${e.url.substring(0, 100)}...`);
            if (e.url && e.url.startsWith('http')) {
                ultimateMediaUrl = e.url;
                log(`CDP:${reqId}`, `🎯 Final Download URL captured via CDP!`);
            }
        });

        // Anti-DevTool & Popup Ad Blocker
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

        // Network Request & Redirect Response Interceptor
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
                log(`NET:${reqId}`, `🎯 Intercepted R2/S3 request: ${url.substring(0, 100)}...`);
                if (!ultimateMediaUrl) ultimateMediaUrl = url;
                req.abort();
            } else {
                req.continue();
            }
        });

        // Capture 302 Redirects or Attachment Downloads
        page.on('response', (res) => {
            const status = res.status();
            const headers = res.headers();
            const location = headers['location'] || '';
            const contentDisp = headers['content-disposition'] || '';

            if ((status >= 300 && status < 400) && (location.includes('X-Amz') || location.includes('cloudflarestorage') || location.includes('r2.dev'))) {
                log(`NET-REDIR:${reqId}`, `🎯 Captured 302 Redirect to R2: ${location.substring(0, 100)}...`);
                if (!ultimateMediaUrl) ultimateMediaUrl = location;
            } else if (contentDisp.includes('attachment') && res.url().startsWith('http')) {
                log(`NET-FILE:${reqId}`, `🎯 Captured Attachment Response: ${res.url().substring(0, 100)}...`);
                if (!ultimateMediaUrl) ultimateMediaUrl = res.url();
            }
        });

        log(`BROWSER:${reqId}`, `🌐 Navigating to: ${driveUrl}`);
        await page.goto(driveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        log(`BROWSER:${reqId}`, `📄 Page DOM loaded. Current Title: "${await page.title()}"`);

        log(`BROWSER:${reqId}`, `⏳ Waiting for loading screen / Turnstile to finish...`);
        for (let w = 0; w < 12; w++) {
            await delay(1000);
            try {
                const titleNow = await page.title();
                if (titleNow && !titleNow.toLowerCase().includes('loading')) {
                    log(`BROWSER:${reqId}`, `✅ Page ready at ${w + 1}s. Title: "${titleNow}"`);
                    break;
                }
            } catch (e) {
                log(`BROWSER:${reqId}`, `🔄 Page navigating/redirecting at ${w + 1}s, waiting...`);
            }
        }
        await delay(1500);

        // 🔴 Buttons පරීක්ෂා කර සැබෑ button එක තෝරාගැනීම
        const scanResult = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('.button.direct-download, a.direct-download, button.direct-download, #dl-links .button.direct-download'));
            const details = buttons.map((btn, idx) => {
                const style = window.getComputedStyle(btn);
                const rect = btn.getBoundingClientRect();
                
                const isFake = 
                    style.position === 'absolute' || 
                    (style.clipPath && style.clipPath.includes('inset')) || 
                    parseInt(style.zIndex || '0') < 0 || 
                    (style.transform && (style.transform.includes('scale(0)') || style.transform.includes('translate(-100vw'))) ||
                    parseFloat(style.fontSize) === 0;

                const isVisible =
                    !isFake &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    parseFloat(style.opacity || '1') > 0.1 &&
                    style.pointerEvents !== 'none' &&
                    rect.width > 20 &&
                    rect.height > 10;

                return {
                    idx,
                    text: (btn.innerText || '').trim().replace(/\s+/g, ' '),
                    href: btn.getAttribute('href') || '',
                    id: btn.id || '',
                    isVisible,
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                };
            });

            const visibleBtns = details.filter(d => d.isVisible);
            const preferred =
                visibleBtns.find(d => /direct|download/i.test(d.text) && !/telegram|ads|fast/i.test(d.text)) ||
                visibleBtns[0] ||
                null;

            if (preferred) {
                const targetEl = buttons[preferred.idx];
                targetEl.scrollIntoView({ behavior: 'instant', block: 'center' });
                const newRect = targetEl.getBoundingClientRect();
                preferred.rect = { x: newRect.x, y: newRect.y, width: newRect.width, height: newRect.height };

                // Button එක උඩ invisible ad overlay එකක් තියෙනවා නම් එය remove කිරීම
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

            return {
                total: buttons.length,
                visibleCount: visibleBtns.length,
                visibleSummary: visibleBtns.map(v => `[${v.idx}] "${v.text}" (href=${v.href})`),
                chosen: preferred
            };
        });

        log(`BROWSER:${reqId}`, `📊 Buttons: Total=${scanResult.total}, Visible=${scanResult.visibleCount} -> ${JSON.stringify(scanResult.visibleSummary)}`);

        if (scanResult.chosen) {
            await delay(800);
            const box = scanResult.chosen.rect;
            const clickX = Math.round(box.x + (box.width / 2));
            const clickY = Math.round(box.y + (box.height / 2));

            log(`BROWSER:${reqId}`, `🖱️  Clicking chosen button [${scanResult.chosen.idx}] "${scanResult.chosen.text}" at X:${clickX}, Y:${clickY}...`);
            await page.mouse.move(clickX, clickY, { steps: 10 });
            await delay(200);
            await page.mouse.down();
            await delay(100);
            await page.mouse.up();
            log(`BROWSER:${reqId}`, `✅ Mouse click dispatched`);
        } else {
            const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 250).replace(/\n/g, ' '));
            log(`BROWSER:${reqId}`, `❌ No valid visible download button found! Page text: "${bodySnippet}"`);
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
            log(`BROWSER:${reqId}`, `⚠️  Timed out after 30s without capturing R2 link. Current URL: ${page.url()}`);
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
                search: `${baseUrl}/search?q=spider-man`,
                movieInfo: `${baseUrl}/qualities?url=MOVIE_URL`,
                tvShowInfo: `${baseUrl}/tvshow?url=TVSHOW_URL`,
                episodeInfo: `${baseUrl}/episode?url=EPISODE_URL`,
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
        :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --accent: #38bdf8; --green: #22c55e; --purple: #a855f7; --code-bg: #020617; }
- { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem 1rem; }
        .container { max-width: 920px; margin: 0 auto; }
        header { border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
        h1 { font-size: 1.75rem; color: var(--accent); }
        .badge { background: rgba(34, 197, 94, 0.15); color: var(--green); border: 1px solid rgba(34, 197, 94, 0.4); padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
        .endpoint-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
        .method { background: var(--accent); color: #020617; font-weight: 700; padding: 0.2rem 0.6rem; border-radius: 6px; font-size: 0.85rem; }
        .method.purple { background: var(--purple); color: #fff; }
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
        <p>Search movies or TV series by name. Returns title, type (movie/tvshow/episode) and URL.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>q</code></td><td>Yes</td><td>Movie or TV series name to search (e.g., <code>spider man</code>)</td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/search?q=spider man</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/qualities?url={movieUrl}</span>
            <span style="color:#94a3b8; font-size:0.85rem;">(Alias: <code>/info</code>)</span>
        </div>
        <p>Extracts full Movie details AND automatically resolves all ZT download links into direct <code>driveUrl</code> links.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code></td><td>Yes</td><td>Movie page URL obtained from <code>/search</code></td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/qualities?url=https://cinesubz.lk/movies/spider-man-brand-new-day-2026/</pre>
    </div>

    <!-- NEW TV SHOW ENDPOINT -->
    <div class="card">
        <div class="endpoint-header">
            <span class="method purple">GET</span>
            <span class="path">/tvshow?url={tvshowUrl}</span>
        </div>
        <p>Extracts TV Show details (Title, Poster, Synopsis) AND lists all seasons and episodes with their URLs.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code></td><td>Yes</td><td>TV Show page URL obtained from <code>/search</code></td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/tvshow?url=https://cinesubz.lk/tvshows/the-boys/</pre>
    </div>

    <!-- NEW EPISODE ENDPOINT -->
    <div class="card">
        <div class="endpoint-header">
            <span class="method purple">GET</span>
            <span class="path">/episode?url={episodeUrl}</span>
        </div>
        <p>Extracts specific Episode details and resolves all ZT download links for that episode.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code></td><td>Yes</td><td>Episode page URL obtained from <code>/tvshow</code></td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/episode?url=https://cinesubz.lk/episodes/the-boys-1x1/</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/download?url={driveUrl_or_ztUrl}</span>
        </div>
        <p>Bypasses Cloudflare & anti-bot protections using Real Chrome and extracts the final Cloudflare R2 / S3 presigned direct download link. Works for BOTH Movies and Episodes.</p>
        <div class="note">
            <strong>Smart Link Detection:</strong> Pass either the pre-resolved <code>driveUrl</code> (faster) OR the raw <code>ztUrl</code> using <code>?url=</code>, <code>?driveUrl=</code>, or <code>?ztUrl=</code>.
        </div>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code> (or <code>driveUrl</code> / <code>ztUrl</code>)</td><td>Yes</td><td>Either <code>driveUrl</code> or <code>ztUrl</code> from <code>/qualities</code> or <code>/episode</code></td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/download?url=https://drive.csplayer2.space/server4/new/Spider-Man...480p?ext=mp4</pre>
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
        res.json({ success: true, count: results.length, results });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Search failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Movie Info + Resolved Qualities Endpoint
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

// 3. NEW: TV Show Info & Episodes Endpoint
app.get('/tvshow', async (req, res) => {
    const tvShowUrl = req.query.url;
    if (!tvShowUrl) {
        log(`WARN:${req.reqId}`, `Missing query parameter "url"`);
        return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    }
    try {
        const data = await getTvShowInfoAndEpisodes(tvShowUrl, req.reqId);
        res.json({ success: true, ...data });
    } catch (e) {
        log(`ERR:${req.reqId}`, `TV Show fetch failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. NEW: Episode Info & Qualities Endpoint
app.get('/episode', async (req, res) => {
    const episodeUrl = req.query.url;
    if (!episodeUrl) {
        log(`WARN:${req.reqId}`, `Missing query parameter "url"`);
        return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    }
    try {
        const data = await getEpisodeInfoAndQualities(episodeUrl, req.reqId);
        res.json({ success: true, ...data });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Episode fetch failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. Smart Download Endpoint
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
