import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { connect } from 'puppeteer-real-browser';

const app = express();
const PORT = process.env.PORT || 3000;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.use(express.json());

// =========================================================================
// 1. SCRAPING & RESOLVING FUNCTIONS
// =========================================================================

async function searchMovies(query) {
    const searchUrl = `https://cinesubz.lk/?s=${encodeURIComponent(query)}`;
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
    return results;
}

async function getQualities(movieUrl) {
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
    return qualities;
}

async function resolveZtLink(ztLinkUrl) {
    const { data } = await axios.get(ztLinkUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
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
}

// =========================================================================
// 2. LINUX REAL BROWSER SECTION (Railway Compatible)
// =========================================================================

async function getUltimateR2Link(driveUrl) {
    let browser;
    let ultimateMediaUrl = null;

    try {
        const connection = await connect({
            headless: false,
            turnstile: true,
            disableXvfb: false,
            customConfig: {
                chromePath: '/usr/bin/google-chrome',
                chromeFlags: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--window-size=1920,1080'
                ]
            }
        });

        browser = connection.browser;
        const page = connection.page;

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'deny' });

        client.on('Browser.downloadWillBegin', (e) => {
            if (e.url.includes('cloudflarestorage') || e.url.includes('X-Amz-Algorithm')) {
                ultimateMediaUrl = e.url;
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
                req.abort();
            } else if (url.includes('X-Amz-Credential') || url.includes('cloudflarestorage.com') || url.includes('?X-Amz-Algorithm')) {
                if (!ultimateMediaUrl) ultimateMediaUrl = url;
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(driveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(6000);

        const visibleBtnIndex = await page.evaluate(() => {
            const buttons = document.querySelectorAll('.button.direct-download');
            for (let i = 0; i < buttons.length; i++) {
                const style = window.getComputedStyle(buttons[i]);
                const rect = buttons[i].getBoundingClientRect();
                if (style.display !== 'none' && style.opacity !== '0' && rect.width > 0) {
                    buttons[i].scrollIntoView({ behavior: 'instant', block: 'center' });
                    return i;
                }
            }
            return -1;
        });

        if (visibleBtnIndex !== -1) {
            await delay(1000);
            const box = await page.evaluate((index) => {
                const btn = document.querySelectorAll('.button.direct-download')[index];
                const rect = btn.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }, visibleBtnIndex);

            const clickX = box.x + (box.width / 2);
            const clickY = box.y + (box.height / 2);

            await page.mouse.move(clickX, clickY, { steps: 10 });
            await delay(200);
            await page.mouse.down();
            await delay(100);
            await page.mouse.up();
        }

        for (let i = 0; i < 30; i++) {
            if (ultimateMediaUrl) break;
            await delay(1000);
        }

    } catch (error) {
        console.error("Browser Error:", error.message);
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
    if (!query) return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
    try {
        const results = await searchMovies(query);
        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/qualities', async (req, res) => {
    const movieUrl = req.query.url;
    if (!movieUrl) return res.status(400).json({ success: false, error: 'Query parameter "url" is required' });
    try {
        const qualities = await getQualities(movieUrl);
        res.json({ success: true, qualities });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/download', async (req, res) => {
    const ztUrl = req.query.ztUrl;
    if (!ztUrl) return res.status(400).json({ success: false, error: 'Query parameter "ztUrl" is required' });
    try {
        const driveUrl = await resolveZtLink(ztUrl);
        if (!driveUrl) return res.status(404).json({ success: false, error: 'Failed to resolve ZT link' });

        const finalLink = await getUltimateR2Link(driveUrl);
        if (!finalLink) return res.status(500).json({ success: false, error: 'Failed to extract R2 link' });

        res.json({ success: true, driveUrl, downloadUrl: finalLink });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
