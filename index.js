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
        $('.season-select-box select option, .seasons-list a, .zt-season-item').each((i, el) => {
            const seasonNum = $(el).attr('value') || $(el).text().replace(/\D/g, '') || (i + 1);
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

// Scrape All Episodes for a given TV Show Season URL with Fallback
async function getSeasonEpisodes(seasonUrl, reqId) {
    log(`SEASON:${reqId}`, `📺 Scraping Season Episodes from: ${seasonUrl}`);
    const { data } = await axios.get(seasonUrl, { headers: COMMON_HEADERS });
    const $ = cheerio.load(data);

    const episodes = [];
    
    // Primary Selectors for CineSubz TV Show Season pages
    $('.episodes-list-item, .episodess-item, .ep-card, .display-item .item-box, .episodess-box').each((i, el) => {
        const epTitle = $(el).find('.episodess-title, .ep-title, h3, .item-desc-title').text().trim() || `Episode ${i + 1}`;
        const ztUrl = $(el).find('a.episodess-link, a.ep-link, a').attr('href');
        const metaText = $(el).find('.episodess-meta, .ep-meta').text().trim();
        
        const qualityMatch = metaText.match(/(HD \d+P|SD|FHD|4K)/i);
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

    // Fallback: If primary selectors miss, scan all page links for zt-links / episodes
    if (episodes.length === 0) {
        log(`SEASON:${reqId}`, `⚠️ Primary selectors missed. Trying fallback link extraction...`);
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
// 3. API ENDPOINTS
// =========================================================================

app.get('/', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
        status: 'online',
        baseUrl,
        endpoints: {
            search: `${baseUrl}/search?q=game of thrones`,
            infoAndQualities: `${baseUrl}/qualities?url=MOVIE_OR_TVSHOW_URL`,
            download: `${baseUrl}/download?url=DRIVE_URL_OR_SEASON_URL`
        }
    });
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
