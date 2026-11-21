'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const {
  SITE_ORIGIN,
  parseListing,
  parsePost,
  extractVideoLinks,
  postUrlFromId,
  normalizeText
} = require('./doostiha');

const PORT = Number(process.env.PORT || 7000);
const USER_AGENT = 'Mozilla/5.0 (compatible; PersianDubHubDoostiha/0.2.0; +https://www.doostihaa.com/)';
const CACHE_TTL_MS = 8 * 60 * 1000;
const SEARCH_PAGES = 16;
const PAGE_SIZE = 12;
const CATALOG_BATCH_SIZE = 100;
const cache = new Map();

const CATEGORIES = {
  doostiha_movies: {
    type: 'movie',
    name: '\u0641\u06CC\u0644\u0645 \u062E\u0627\u0631\u062C\u06CC \u062F\u0648\u0628\u0644\u0647 \u0641\u0627\u0631\u0633\u06CC | \u062F\u0648\u0633\u062A\u06CC\u200C\u0647\u0627',
    path: '/topics/dl-film/dubing-movies'
  },
  doostiha_animation: {
    type: 'movie',
    name: '\u0627\u0646\u06CC\u0645\u06CC\u0634\u0646 \u062F\u0648\u0628\u0644\u0647 \u0641\u0627\u0631\u0633\u06CC | \u062F\u0648\u0633\u062A\u06CC\u200C\u0647\u0627',
    path: '/post/tag/%D8%A7%D9%86%DB%8C%D9%85%DB%8C%D8%B4%D9%86-%D8%AF%D9%88%D8%A8%D9%84%D9%87-%D9%81%D8%A7%D8%B1%D8%B3%DB%8C'
  }
};

const manifest = {
  id: 'org.persiandubhub.doostiha',
  version: '0.2.0',
  name: 'Persian Dub Hub - Doostiha',
  description: '\u06A9\u0627\u062A\u0627\u0644\u0648\u06AF \u0641\u06CC\u0644\u0645\u200C\u0647\u0627\u06CC \u062F\u0648\u0628\u0644\u0647 \u0641\u0627\u0631\u0633\u06CC \u0627\u0632 \u0622\u0631\u0634\u06CC\u0648 \u0639\u0645\u0648\u0645\u06CC \u062F\u0648\u0633\u062A\u06CC\u200C\u0647\u0627.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['doostiha:'],
  catalogs: Object.entries(CATEGORIES).map(([id, category]) => ({
    type: category.type,
    id,
    name: category.name,
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false }
    ]
  }))
};

const builder = new addonBuilder(manifest);

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function fetchHtml(url) {
  const cached = cacheGet(`html:${url}`);
  if (cached) return cached;
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'fa-IR,fa;q=0.9,en;q=0.7',
      referer: SITE_ORIGIN
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(18000)
  });
  if (!response.ok) throw new Error(`Doostiha returned HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (!['doostihaa.com', 'www.doostihaa.com'].includes(finalUrl.hostname)) {
    throw new Error('Unexpected redirect outside doostihaa.com');
  }
  const html = await response.text();
  if (!html || html.length < 500) throw new Error('Doostiha returned an empty or incomplete page');
  return cacheSet(`html:${url}`, html);
}

function categoryPageUrl(category, page) {
  const suffix = page > 1 ? `/page/${page}` : '';
  return `${SITE_ORIGIN}${category.path}${suffix}`;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function matchesSearch(meta, search) {
  if (!search) return true;
  const haystack = normalizeText(`${meta.name} ${meta.description || ''} ${meta.website || ''}`);
  return haystack.includes(normalizeText(search));
}

async function getCatalog(categoryId, search, skip) {
  const category = CATEGORIES[categoryId];
  if (!category) return [];
  const query = String(search || '').trim();
  const pageStart = query ? 1 : Math.floor(skip / PAGE_SIZE) + 1;
  const pageCount = query ? SEARCH_PAGES : Math.ceil(CATALOG_BATCH_SIZE / PAGE_SIZE) + 1;
  const pages = Array.from({ length: pageCount }, (_, index) => pageStart + index);
  const cacheKey = `catalog:${categoryId}:${normalizeText(query)}:${pageStart}:${skip}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const htmlPages = await mapLimit(pages, 3, async (page) => fetchHtml(categoryPageUrl(category, page)));
  const records = new Map();
  for (const html of htmlPages.filter(Boolean)) {
    for (const item of parseListing(html, category.path)) {
      if (!records.has(item.id)) records.set(item.id, item);
    }
  }

  let results = [...records.values()].filter((item) => matchesSearch(item, query));
  if (query) {
    results = results.slice(Math.max(0, skip), Math.max(0, skip) + CATALOG_BATCH_SIZE);
  } else {
    const offsetInSourcePage = skip % PAGE_SIZE;
    results = results.slice(offsetInSourcePage, offsetInSourcePage + CATALOG_BATCH_SIZE);
  }
  return cacheSet(cacheKey, results);
}

function publicMeta(record) {
  if (!record) return null;
  const meta = { ...record };
  delete meta._postUrl;
  delete meta._categoryPath;
  delete meta._isDubbed;
  return meta;
}

builder.defineCatalogHandler(async (args) => {
  const category = CATEGORIES[args.id];
  if (!category || args.type !== 'movie') return { metas: [] };
  const search = args.extra && args.extra.search ? String(args.extra.search) : '';
  const skip = Math.max(0, Number(args.extra && args.extra.skip) || 0);
  try {
    const metas = await getCatalog(args.id, search, skip);
    return { metas: metas.map(publicMeta), cacheMaxAge: 480 };
  } catch (error) {
    console.warn('Doostiha catalog request failed:', error.message);
    return { metas: [], cacheMaxAge: 60 };
  }
});

builder.defineMetaHandler(async (args) => {
  const postUrl = postUrlFromId(args.id);
  if (!postUrl) return { meta: null };
  try {
    const html = await fetchHtml(postUrl);
    const meta = parsePost(html, postUrl);
    return { meta: publicMeta(meta), cacheMaxAge: 480 };
  } catch (error) {
    console.warn('Doostiha metadata request failed:', error.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async (args) => {
  const postUrl = postUrlFromId(args.id);
  if (!postUrl) return { streams: [] };
  try {
    const html = await fetchHtml(postUrl);
    const meta = parsePost(html, postUrl);
    const links = meta._isDubbed ? extractVideoLinks(html, postUrl) : [];
    const streams = links.map((link) => ({
      name: 'Doostiha',
      description: `\u062F\u0648\u0628\u0644\u0647 \u0641\u0627\u0631\u0633\u06CC \u00B7 ${link.quality} \u00B7 ${link.extension}`,
      url: link.url,
      behaviorHints: {
        notWebReady: true,
        filename: link.filename || `${meta.name}-${link.quality}.${link.extension.toLowerCase()}`,
        proxyHeaders: {
          request: {
            'User-Agent': USER_AGENT,
            Referer: postUrl,
            Origin: SITE_ORIGIN,
            Accept: '*/*'
          }
        }
      }
    }));

    // Always offer the original public page as a fallback; Stremio opens it in a browser.
    streams.push({
      name: 'Doostiha',
      description: '\u067E\u062E\u0634 \u062F\u0631 \u0635\u0641\u062D\u0647 \u0627\u0635\u0644\u06CC \u062F\u0648\u0633\u062A\u06CC\u200C\u0647\u0627',
      externalUrl: postUrl
    });
    return { streams, cacheMaxAge: 300 };
  } catch (error) {
    console.warn('Doostiha stream request failed:', error.message);
    return {
      streams: [{ name: 'Doostiha', description: '\u0628\u0627\u0632 \u06A9\u0631\u062F\u0646 \u0635\u0641\u062D\u0647 \u0627\u0635\u0644\u06CC', externalUrl: postUrl }],
      cacheMaxAge: 60
    };
  }
});

serveHTTP(builder.getInterface(), { port: PORT, cacheMaxAge: 480 });
console.log(`Persian Dub Hub - Doostiha is running on port ${PORT}`);
console.log(`Install URL: http://127.0.0.1:${PORT}/manifest.json`);
