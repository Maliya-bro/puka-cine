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

const CHROME_FLAGS = [
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
// 1. SCRAPING & RESOLVING FUNCTIONS (MOVIES + TV SHOWS)
// =========================================================================

async function searchContent(query, reqId) {
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
            const type = url.includes('/tvshows/')
                ? 'TV Series'
                : (url.includes('/episodes/') ? 'Episode' : 'Movie');
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

async function getPageInfoAndQualities(targetUrl, reqId, baseUrl = '') {
    log(`INFO:${reqId}`, `🎞️  Fetching full details: ${targetUrl}`);

    const { data } = await axios.get(targetUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    const schemaType = $('.content-info').attr('itemtype') || '';
    const isTvShow = targetUrl.includes('/tvshows/') || schemaType.includes('TVSeries') || $('#episodes-section').length > 0;
    const isEpisode = targetUrl.includes('/episodes/');

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

    // 4. Synopsis
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

    const movieMeta = {
        title,
        tagline,
        url: targetUrl,
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
    };

    // CASE A: TV SHOW -> Extract Seasons & Season Download Links
    if (isTvShow) {
        const seasons = [];
        $('.season-select ul.episodes-list').each((i, ulEl) => {
            const seasonNum = parseInt($(ulEl).attr('data-season'), 10) || (i + 1);
            const episodes = [];

            $(ulEl).find('li a.episode-link').each((j, aEl) => {
                const epUrl = $(aEl).attr('href');
                const epNum = parseInt($(aEl).find('.ep-num').text().trim(), 10) || (j + 1);
                const epTitle = $(aEl).find('.ep-title').text().trim() || `Episode ${epNum}`;
                if (epUrl) {
                    episodes.push({
                        season: seasonNum,
                        episode: epNum,
                        title: epTitle,
                        url: epUrl
                    });
                }
            });

            if (episodes.length > 0) {
                seasons.push({
                    season: seasonNum,
                    episodeCount: episodes.length,
                    seasonDownloadUrl: baseUrl
                        ? `${baseUrl}/download?url=${encodeURIComponent(targetUrl)}&season=${seasonNum}`
                        : null,
                    episodes
                });
            }
        });

        log(`INFO:${reqId}`, `✅ TV Show parsed: ${seasons.length} seasons found`);
        return {
            type: 'tvshow',
            movie: movieMeta,
            seasons
        };
    }

    // CASE B: MOVIE OR EPISODE -> Extract & Resolve ZT Links
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
        type: isEpisode ? 'episode' : 'movie',
        movie: movieMeta,
        downloads
    };
}

// =========================================================================
// 2A. LINUX REAL BROWSER SECTION - MOVIE SINGLE TAB (ORIGINAL UNTOUCHED)
// =========================================================================

async function getUltimateR2Link(driveUrl, reqId) {
    let browser;
    let ultimateMediaUrl = null;

    try {
        log(`BROWSER:${reqId}`, `🤖 Launching Chrome via puppeteer-real-browser (DISPLAY=${process.env.DISPLAY || 'none'})...`);

        const connection = await connect({
            headless: false,
            turnstile: true,
            disableXvfb: true,
            args: CHROME_FLAGS,
            customConfig: {
                chromePath: '/usr/bin/google-chrome',
                chromeFlags: CHROME_FLAGS,
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

        const scanResult = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('.button.direct-download, a.direct-download, button.direct-download'));
            const details = buttons.map((btn, idx) => {
                const style = window.getComputedStyle(btn);
                const rect = btn.getBoundingClientRect();
                const isVisible =
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

                const centerX = newRect.x + newRect.width / 2;
                const centerY = newRect.y + newRect.height / 2;
                const topEl = document.elementFromPoint(centerX, centerY);
                if (topEl && topEl !== targetEl && !targetEl.contains(topEl)) {
                    topEl.style.pointerEvents = 'none';
                    topEl.style.display = 'none';
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
// 2B. LINUX REAL BROWSER SECTION - TV SHOW BATCH 4-TAB POOL
// =========================================================================

async function setupAndNavigateTab(browser, task, reqId) {
    const state = {
        task,
        page: null,
        ultimateMediaUrl: null
    };

    try {
        const page = await browser.newPage();
        state.page = page;

        // CDP Download Interceptor
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'deny' });

        client.on('Browser.downloadWillBegin', (e) => {
            if (e.url && e.url.startsWith('http') && !state.ultimateMediaUrl) {
                state.ultimateMediaUrl = e.url;
                log(`TV-CDP:${reqId}`, `🎯 [CDP Captured] ${task.name}`);
            }
        });

        // Anti-DevTool & Popup Ad Blocker
        await page.evaluateOnNewDocument(() => {
            window.DisableDevtool = function() {};
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

        // Network Request Interceptor
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
                if (!state.ultimateMediaUrl) {
                    state.ultimateMediaUrl = url;
                    log(`TV-NET:${reqId}`, `🎯 [NET Captured] ${task.name}`);
                }
                req.abort();
            } else {
                req.continue();
            }
        });

        // 302 Redirect & Attachment Interceptor
        page.on('response', (res) => {
            const status = res.status();
            const headers = res.headers();
            const location = headers['location'] || '';
            const contentDisp = headers['content-disposition'] || '';

            if ((status >= 300 && status < 400) && (location.includes('X-Amz') || location.includes('cloudflarestorage') || location.includes('r2.dev'))) {
                if (!state.ultimateMediaUrl) {
                    state.ultimateMediaUrl = location;
                    log(`TV-REDIR:${reqId}`, `🎯 [302 Captured] ${task.name}`);
                }
            } else if (contentDisp.includes('attachment') && res.url().startsWith('http')) {
                if (!state.ultimateMediaUrl) {
                    state.ultimateMediaUrl = res.url();
                    log(`TV-FILE:${reqId}`, `🎯 [File Captured] ${task.name}`);
                }
            }
        });

        log(`TV-TAB:${reqId}`, `🌐 [Tab Open] ${task.name}`);
        await page.goto(task.driveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err) {
        log(`TV-ERR:${reqId}`, `⚠️ [Load Error] ${task.name}: ${err.message}`);
    }

    return state;
}

async function findAndRealClickTvButton(state, reqId) {
    const { page, task } = state;
    if (!page || state.ultimateMediaUrl) return;

    try {
        await page.bringToFront();

        for (let w = 0; w < 6; w++) {
            const titleNow = await page.title().catch(() => '');
            if (titleNow && !titleNow.toLowerCase().includes('loading')) {
                break;
            }
            await delay(1000);
        }
        await delay(800);

        const scanResult = await page.evaluate(() => {
            // #dl-links ඇතුළේ තියෙන buttons වලට ප්‍රමුඛතාවය දෙනවා
            const buttons = Array.from(document.querySelectorAll('#dl-links .button.direct-download, .button.direct-download, a.direct-download, button.direct-download'));

            const details = buttons.map((btn, idx) => {
                const style = window.getComputedStyle(btn);
                const rect = btn.getBoundingClientRect();

                // Cinesubz fake buttons hide කරන්න පාවිච්චි කරන CSS tricks filter කිරීම
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

                // Button එක උඩ තියෙන transparent ad overlays ඔක්කොම අයින් කිරීම
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
            await delay(400);
            const box = scanResult.chosen.rect;
            const clickX = Math.round(box.x + (box.width / 2));
            const clickY = Math.round(box.y + (box.height / 2));

            log(`TV-CLICK:${reqId}`, `🖱️  [Click] ${task.name} -> "${scanResult.chosen.text}" (X:${clickX}, Y:${clickY})`);
            await page.mouse.move(clickX, clickY, { steps: 10 });
            await delay(150);
            await page.mouse.down();
            await delay(100);
            await page.mouse.up();
        } else {
            log(`TV-WARN:${reqId}`, `❌ [No Button] ${task.name} -> Download button not found.`);
        }
    } catch (err) {
        log(`TV-ERR:${reqId}`, `⚠️ [Click Error] ${task.name}: ${err.message}`);
    }
}

async function extractTvBatchR2Links(tasks, reqId, batchSize = 4) {
    if (tasks.length === 0) return [];

    let browser;
    const finalResults = [];

    try {
        log(`TV-BROWSER:${reqId}`, `🚀 Launching Linux Chrome for TV Show batch extraction (${tasks.length} episodes, ${batchSize} tabs/batch)...`);

        const connection = await connect({
            headless: false,
            turnstile: true,
            disableXvfb: true,
            args: CHROME_FLAGS,
            customConfig: {
                chromePath: '/usr/bin/google-chrome',
                chromeFlags: CHROME_FLAGS,
                port: 9222,
                logLevel: 'info'
            }
        });

        browser = connection.browser;

        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            log(`TV-BATCH:${reqId}`, `📦 Batch ${batchNum}: Opening ${batch.length} tabs...`);

            const tabStates = await Promise.all(
                batch.map(task => setupAndNavigateTab(browser, task, reqId))
            );

            log(`TV-BATCH:${reqId}`, `⏳ Waiting 6s for Turnstile & buttons to load...`);
            await delay(6000);

            for (const state of tabStates) {
                await findAndRealClickTvButton(state, reqId);
            }

            log(`TV-BATCH:${reqId}`, `⏳ Polling for R2 links across batch ${batchNum} (max 25s)...`);
            for (let sec = 1; sec <= 25; sec++) {
                const allDone = tabStates.every(s => s.ultimateMediaUrl !== null);
                if (allDone) {
                    log(`TV-BATCH:${reqId}`, `🎉 Batch ${batchNum} completed all ${batch.length} links in ${sec}s!`);
                    break;
                }
                await delay(1000);
            }

            for (const state of tabStates) {
                if (state.page) {
                    try { await state.page.close(); } catch (e) {}
                }
                finalResults.push({
                    season: state.task.season,
                    episode: state.task.episode,
                    title: state.task.title,
                    label: state.task.label,
                    size: state.task.size,
                    driveUrl: state.task.driveUrl,
                    downloadUrl: state.ultimateMediaUrl || null,
                    success: Boolean(state.ultimateMediaUrl)
                });
            }

            log(`TV-BATCH:${reqId}`, `🧹 Closed ${batch.length} tabs for Batch ${batchNum}`);
        }
    } catch (error) {
        log(`TV-BROWSER-ERR:${reqId}`, `💥 Batch Browser Exception: ${error.stack || error.message}`);
    } finally {
        if (browser) {
            log(`TV-BROWSER:${reqId}`, `🛑 Closing Chrome instance...`);
            try {
                await browser.close();
            } catch (e) {}
        }
    }

    finalResults.sort((a, b) => a.episode - b.episode);
    return finalResults;
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
                infoAndQualities: `${baseUrl}/qualities?url=MOVIE_OR_TVSHOW_URL`,
                downloadMovieDriveUrl: `${baseUrl}/download?url=DRIVE_URL`,
                downloadMovieZtUrl: `${baseUrl}/download?ztUrl=ZT_URL`,
                downloadTvShowSeason: `${baseUrl}/download?url=TVSHOW_URL&season=1`
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
        .note { background: rgba(56, 189, 248, 0.1); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; border-radius: 4px; font-size: 0.9rem; color: #cbd5e1; margin-bottom: 0.75rem; }
    </style>
</head>
<body>
<div class="container">
    <header>
        <div>
            <h1>🎬 CineSubz Scraper & R2 Bypass API</h1>
            <p style="margin:0; margin-top:4px;">Base URL: <code>${baseUrl}</code></p>
        </div>
        <span class="badge">● SYSTEM ONLINE (MOVIES + TV SHOWS)</span>
    </header>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/search?q={query}</span>
        </div>
        <p>Search movies or TV series by name. Returns title, content type (<code>Movie</code> / <code>TV Series</code>), and page URL.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>q</code></td><td>Yes</td><td>Movie or TV series name to search (e.g., <code>loki</code>)</td></tr>
        </table>
        <span class="label">Example Request</span>
        <pre>${baseUrl}/search?q=loki</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/qualities?url={movieOrTvUrl}</span>
            <span style="color:#94a3b8; font-size:0.85rem;">(Alias: <code>/info</code>)</span>
        </div>
        <p>Extracts full metadata (poster, synopsis, IMDb rating, cast, gallery). For <strong>Movies</strong>, resolves all ZT links into <code>driveUrl</code>. For <strong>TV Shows</strong>, extracts all <code>seasons</code> with episode lists and ready-to-use <code>seasonDownloadUrl</code> links.</p>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code></td><td>Yes</td><td>Movie or TV Series page URL obtained from <code>/search</code></td></tr>
        </table>
        <span class="label">Example Request (TV Show)</span>
        <pre>${baseUrl}/info?url=https://cinesubz.lk/tvshows/loki-2021-sinhala-subtitles/</pre>
    </div>

    <div class="card">
        <div class="endpoint-header">
            <span class="method">GET</span>
            <span class="path">/download?url={driveUrl_ztUrl_or_tvShowUrl}</span>
        </div>
        <p>Automatically detects whether the input is a <strong>Movie link</strong> or a <strong>TV Show Season URL</strong> and extracts the final Cloudflare R2 direct download links.</p>
        <div class="note">
            <strong>TV Show Batch Mode:</strong> Pass a TV Show URL with <code>&season=1</code>. Resolves all episodes' ZT links in parallel first, then opens Chrome in 4-tab batches to extract all direct R2 links.
        </div>
        <table>
            <tr><th>Parameter</th><th>Required</th><th>Description</th></tr>
            <tr><td><code>url</code></td><td>Yes</td><td>Movie <code>driveUrl</code>, <code>ztUrl</code>, Episode URL, or TV Show URL</td></tr>
            <tr><td><code>season</code></td><td>Optional</td><td>Season number for TV Shows (defaults to Season 1)</td></tr>
        </table>
        <span class="label">Example TV Show Season Request</span>
        <pre>${baseUrl}/download?url=https://cinesubz.lk/tvshows/loki-2021-sinhala-subtitles/&season=1</pre>
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
        const results = await searchContent(query, req.reqId);
        res.json({ success: true, count: results.length, results });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Search failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Movie & TV Show Info + Qualities/Seasons Endpoint
app.get(['/qualities', '/info'], async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        log(`WARN:${req.reqId}`, `Missing query parameter "url"`);
        return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    }
    try {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const data = await getPageInfoAndQualities(targetUrl, req.reqId, baseUrl);
        res.json({ success: true, ...data });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Info/Qualities fetch failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Smart Download Endpoint (Movies + TV Show Seasons + Episodes)
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
        // =================================================================
        // BRANCH 1: TV SHOW SEASON BATCH DOWNLOAD (/tvshows/...)
        // =================================================================
        if (inputUrl.includes('/tvshows/')) {
            const requestedSeason = parseInt(req.query.season, 10) || 1;

            log(`TV-DL:${req.reqId}`, `📺 TV Show detected! Fetching Season ${requestedSeason} episodes...`);

            const showData = await getPageInfoAndQualities(inputUrl, req.reqId);
            if (!showData.seasons || showData.seasons.length === 0) {
                return res.status(404).json({ success: false, error: 'No seasons or episodes found for this TV show' });
            }

            const selectedSeason = showData.seasons.find(s => s.season === requestedSeason) || showData.seasons[0];
            log(`TV-DL:${req.reqId}`, `⚡ Resolving ZT links for all ${selectedSeason.episodes.length} episodes in Season ${selectedSeason.season}...`);

            // සියලුම episodes වල ZT links මුලින්ම resolve කර Drive links ලබාගැනීම
            const resolvedEpisodes = await Promise.all(
                selectedSeason.episodes.map(async (ep) => {
                    const epInfo = await getPageInfoAndQualities(ep.url, req.reqId);
                    const validDownloads = (epInfo.downloads || []).filter(d => d.driveUrl);

                    if (validDownloads.length === 0) {
                        log(`TV-DL:${reqId}`, `⚠️ No valid Drive links for S${ep.season}E${ep.episode}`);
                        return null;
                    }

                    const chosenDl = validDownloads[0];

                    return {
                        season: ep.season,
                        episode: ep.episode,
                        title: ep.title,
                        label: chosenDl.label,
                        size: chosenDl.size,
                        name: `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} - ${ep.title}`,
                        driveUrl: chosenDl.driveUrl
                    };
                })
            );

            const tasksToProcess = resolvedEpisodes.filter(Boolean);

            if (tasksToProcess.length === 0) {
                return res.status(404).json({ success: false, error: 'Could not resolve any Drive links for this season' });
            }

            log(`TV-DL:${req.reqId}`, `✅ Resolved ${tasksToProcess.length}/${selectedSeason.episodes.length} episode Drive links. Starting 4-tab Chrome extraction...`);

            const episodeResults = await extractTvBatchR2Links(tasksToProcess, req.reqId, 4);

            log(`SUCCESS:${req.reqId}`, `🚀 Sending ${episodeResults.length} TV Show episode R2 links to client`);
            return res.json({
                success: true,
                type: 'tvshow',
                title: showData.movie.title,
                season: selectedSeason.season,
                totalEpisodes: episodeResults.length,
                episodes: episodeResults
            });
        }

        // =================================================================
        // BRANCH 2: SINGLE EPISODE PAGE URL (/episodes/...)
        // =================================================================
        if (inputUrl.includes('/episodes/')) {
            log(`EP-DL:${req.reqId}`, `🎞️ Single Episode page detected! Resolving ZT link...`);

            const epInfo = await getPageInfoAndQualities(inputUrl, req.reqId);
            const validDownloads = (epInfo.downloads || []).filter(d => d.driveUrl);

            if (validDownloads.length === 0) {
                return res.status(404).json({ success: false, error: 'No valid Drive links found for this episode' });
            }

            const chosenDl = validDownloads[0];

            const [epResult] = await extractTvBatchR2Links([{
                season: null,
                episode: 1,
                title: epInfo.movie.title,
                label: chosenDl.label,
                size: chosenDl.size,
                name: epInfo.movie.title,
                driveUrl: chosenDl.driveUrl
            }], req.reqId, 1);

            if (!epResult || !epResult.downloadUrl) {
                return res.status(500).json({ success: false, error: 'Failed to extract R2 link for episode' });
            }

            return res.json({
                success: true,
                type: 'episode',
                title: epInfo.movie.title,
                label: chosenDl.label,
                driveUrl: chosenDl.driveUrl,
                downloadUrl: epResult.downloadUrl
            });
        }

        // =================================================================
        // BRANCH 3: MOVIE DIRECT DOWNLOAD (ORIGINAL LOGIC UNTOUCHED)
        // =================================================================
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
