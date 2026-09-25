/**
 * Vercel serverless: GET /api/playlist?list=PLAYLIST_ID
 * Scrapes YouTube playlist HTML (ytInitialData) for video ids + titles.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_VIDEOS = 50;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function walkCollect(obj, videos, seen, meta) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const v of obj) walkCollect(v, videos, seen, meta);
    return;
  }
  if (obj.playlistMetadataRenderer && meta.title == null) {
    const t = obj.playlistMetadataRenderer.title;
    if (typeof t === 'string' && t) meta.title = t;
  }
  if (obj.lockupViewModel) {
    const lvm = obj.lockupViewModel;
    const videoId = lvm.contentId;
    if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId) && !seen.has(videoId)) {
      seen.add(videoId);
      let title = videoId;
      const lmv = lvm.metadata && lvm.metadata.lockupMetadataViewModel;
      if (lmv && lmv.title) {
        const t = lmv.title;
        if (typeof t === 'string') title = t;
        else if (t && typeof t.content === 'string') title = t.content;
        else if (t && typeof t.simpleText === 'string') title = t.simpleText;
      }
      videos.push({ videoId, title });
    }
  }
  for (const v of Object.values(obj)) walkCollect(v, videos, seen, meta);
}

function parseYtInitialData(html) {
  const m =
    html.match(/ytInitialData\s*=\s*(\{.+?\});<\/script>/s) ||
    html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function scrapePlaylist(listId) {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`YouTube returned ${res.status}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }
  const html = await res.text();
  const data = parseYtInitialData(html);
  if (!data) {
    const err = new Error('Could not parse playlist data');
    err.status = 502;
    throw err;
  }
  const videos = [];
  const seen = new Set();
  const meta = { title: null };
  walkCollect(data, videos, seen, meta);
  return {
    playlistId: listId,
    title: meta.title || 'Playlist',
    videos: videos.slice(0, MAX_VIDEOS),
  };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  const listId = String((req.query && req.query.list) || '').trim();
  if (!listId || !/^[a-zA-Z0-9_-]{10,80}$/.test(listId)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Missing or invalid list parameter' }));
    return;
  }

  try {
    const result = await scrapePlaylist(listId);
    if (!result.videos.length) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'Playlist is empty or unavailable' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        playlistId: result.playlistId,
        title: result.title,
        videos: result.videos,
      })
    );
  } catch (e) {
    const status = e.status || 502;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: e.message || 'Failed to fetch playlist' }));
  }
};
