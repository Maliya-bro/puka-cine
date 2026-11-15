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

    const { data } = await axios.get(searchUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    const $ = cheerio.load(data);
    const results = [];
    $('.display-item .item-box > a').each((i, el) => {
        const title = $(el).attr('title');
        const url = $(el).attr('href');
        if (title && url) results.push({ title, url });
    });

    log(`SEARCH:${reqId}`, `✅ Found ${results.length} movies for "${query}"`);
    return results;
}

async function getQualities(movieUrl, reqId) {
    log(`QUALITIES:${reqId}`, `🎞️  Fetching movie page: ${movieUrl}`);

    const { data } = await axios.get(movieUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    const $ = cheerio.load(data);
    const qualities = [];
    $('.movie-download-link-item a').each((i, el) => {
        const url = $(el).attr('href');
        const qualityText = $(el).find('.movie-download-meta').text().trim();
        if (url && qualityText) qualities.push({ quality: qualityText, url });
    });

    log(`QUALITIES:${reqId}`, `✅ Extracted ${qualities.length} quality links`);
    return qualities;
}

async function resolveZtLink(ztLinkUrl, reqId) {
    log(`ZT-RESOLVE:${reqId}`, `⏳ Fetching ZT redirect page: ${ztLinkUrl}`);

    const { data } = await axios.get(ztLinkUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    const $ = cheerio.load(data);
    let rawLink = $('#link').attr('href');
    if (!rawLink) {
        log(`ZT-RESOLVE:${reqId}`, `❌ #link element not found on page`);
        return null;
    }

    log(`ZT-RESOLVE:${reqId}`, `🔗 Raw #link found: ${rawLink}`);

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
}

// =========================================================================
// 2. LINUX REAL BROWSER SECTION (Fixed Port 9222 + Low Memory Flags)
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
// 3. API ENDPOINTS
// =========================================================================

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        endpoints: {
            search: '/search?q=movie_name',
            qualities: '/qualities?url=movie_page_url',
            download: '/download?ztUrl=zt_link_url'
        }
    });
});

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

app.get('/qualities', async (req, res) => {
    const movieUrl = req.query.url;
    if (!movieUrl) {
        log(`WARN:${req.reqId}`, `Missing query parameter "url"`);
        return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    }
    try {
        const qualities = await getQualities(movieUrl, req.reqId);
        res.json({ success: true, qualities });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Qualities fetch failed: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/download', async (req, res) => {
    const ztUrl = req.query.ztUrl;
    if (!ztUrl) {
        log(`WARN:${req.reqId}`, `Missing query parameter "ztUrl"`);
        return res.status(400).json({ success: false, error: 'Query parameter "ztUrl" is required' });
    }
    try {
        const driveUrl = await resolveZtLink(ztUrl, req.reqId);
        if (!driveUrl) {
            return res.status(404).json({ success: false, error: 'Failed to resolve ZT link' });
        }

        const finalLink = await getUltimateR2Link(driveUrl, req.reqId);
        if (!finalLink) {
            return res.status(500).json({ success: false, error: 'Failed to extract R2 link' });
        }

        log(`SUCCESS:${req.reqId}`, `🚀 Sending final R2 URL to client`);
        res.json({ success: true, driveUrl, downloadUrl: finalLink });
    } catch (e) {
        log(`ERR:${req.reqId}`, `Download pipeline failed: ${e.stack || e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    log('SYSTEM', `🚀 Server running on port ${PORT}`);
});
