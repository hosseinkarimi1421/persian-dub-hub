'use strict';

const SITE_ORIGIN = 'https://www.doostihaa.com';
const POST_PATH_RE = /^\/post\/\d{4}\/\d{2}\/\d{2}\/[^/]+\.html$/i;
const VIDEO_EXT_RE = /\.(mp4|m4v|m3u8|webm|mov|mkv|ts)(?:$|[?#])/i;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

function findTagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function parseHTML(input) {
  const html = String(input || '').replace(/<!--[\s\S]*?-->/g, '');
  const root = { tag: '#root', attrs: {}, children: [], parent: null, type: 'element' };
  const stack = [root];
  let index = 0;

  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) {
      stack[stack.length - 1].children.push({ type: 'text', text: html.slice(index), parent: stack[stack.length - 1] });
      break;
    }
    if (open > index) {
      stack[stack.length - 1].children.push({ type: 'text', text: html.slice(index, open), parent: stack[stack.length - 1] });
    }
    if (html.startsWith('<!', open) || html.startsWith('<?', open)) {
      const declarationEnd = html.indexOf('>', open + 2);
      index = declarationEnd < 0 ? html.length : declarationEnd + 1;
      continue;
    }

    const end = findTagEnd(html, open + 1);
    if (end < 0) {
      stack[stack.length - 1].children.push({ type: 'text', text: html.slice(open), parent: stack[stack.length - 1] });
      break;
    }

    const token = html.slice(open + 1, end);
    const closing = /^\s*\//.test(token);
    const nameMatch = token.match(/^\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!nameMatch) {
      index = end + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();

    if (closing) {
      for (let stackIndex = stack.length - 1; stackIndex > 0; stackIndex -= 1) {
        if (stack[stackIndex].tag === tag) {
          stack.length = stackIndex;
          break;
        }
      }
      index = end + 1;
      continue;
    }

    const attrsSource = token.slice(nameMatch[0].length).replace(/\/\s*$/, '');
    const node = {
      type: 'element',
      tag,
      attrs: parseAttributes(attrsSource),
      children: [],
      parent: stack[stack.length - 1]
    };
    node.parent.children.push(node);

    if (tag === 'script' || tag === 'style') {
      const closePattern = new RegExp(`<\\/${tag}\\s*>`, 'ig');
      closePattern.lastIndex = end + 1;
      const closeMatch = closePattern.exec(html);
      const rawEnd = closeMatch ? closeMatch.index : html.length;
      if (rawEnd > end + 1) {
        node.children.push({ type: 'text', text: html.slice(end + 1, rawEnd), parent: node });
      }
      index = closeMatch ? closePattern.lastIndex : html.length;
      continue;
    }

    if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(token)) stack.push(node);
    index = end + 1;
  }
  return root;
}

function allNodes(node, predicate = () => true, output = []) {
  if (predicate(node)) output.push(node);
  for (const child of node.children || []) allNodes(child, predicate, output);
  return output;
}

function visibleText(node) {
  if (!node) return '';
  if (node.type === 'text') return decodeEntities(node.text);
  if (node.tag === 'script' || node.tag === 'style') return '';
  if (node.tag === 'img') return node.attrs.alt || '';
  return (node.children || []).map(visibleText).join(' ');
}

function normalizeText(value) {
  return decodeEntities(value)
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function toLatinDigits(value) {
  return String(value || '').replace(/[\u06F0-\u06F9\u0660-\u0669]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 && code <= 0x06f9 ? code - 0x06f0 : code - 0x0660);
  });
}

function absoluteUrl(value, base = SITE_ORIGIN) {
  if (!value || /^\s*(javascript:|data:|mailto:|#)/i.test(value)) return '';
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.href;
  } catch {
    return '';
  }
}

function isDoostihaPostUrl(value) {
  try {
    const url = new URL(value);
    const hostOk = url.hostname === 'doostihaa.com' || url.hostname === 'www.doostihaa.com';
    return hostOk && POST_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function makeId(postUrl) {
  return `doostiha:${Buffer.from(postUrl).toString('base64url')}`;
}

function postUrlFromId(id) {
  const value = String(id || '');
  if (!value.startsWith('doostiha:')) return '';
  try {
    const decoded = Buffer.from(value.slice('doostiha:'.length), 'base64url').toString('utf8');
    return isDoostihaPostUrl(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

function firstImage(node) {
  const images = allNodes(node, (entry) => entry.tag === 'img');
  for (const image of images) {
    const attrs = image.attrs || {};
    const candidate = attrs['data-lazy-src'] || attrs['data-src'] || attrs['data-original'] || attrs.src || '';
    const url = absoluteUrl(candidate);
    if (url && !url.startsWith('data:')) return { url, alt: attrs.alt || '' };
  }
  return null;
}

function cleanTitle(value) {
  return decodeEntities(value)
    .replace(/^\s*image:\s*/i, '')
    .replace(/^\s*(?:\u062F\u0627\u0646\u0644\u0648\u062F\s*)?(?:\u0641\u06CC\u0644\u0645|\u0627\u0646\u06CC\u0645\u06CC\u0634\u0646|\u06A9\u0627\u0631\u062A\u0648\u0646)\s*/i, '')
    .replace(/\s*[|–-]\s*\u062F\u0648\u0633\u062A\u06CC\s*\u0647\u0627\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCardNode(anchor) {
  let current = anchor.parent;
  for (let depth = 0; current && depth < 9; depth += 1, current = current.parent) {
    const postAnchors = allNodes(current, (entry) => entry.tag === 'a' && isDoostihaPostUrl(absoluteUrl(entry.attrs.href))).length;
    const images = allNodes(current, (entry) => entry.tag === 'img').length;
    const textLength = visibleText(current).trim().length;
    if (images > 0 && postAnchors <= 2 && textLength >= 8 && textLength < 3500) return current;
  }
  return anchor.parent || anchor;
}

function yearFrom(value) {
  const text = toLatinDigits(value);
  const match = text.match(/\b(?:19|20)\d{2}\b/);
  return match ? match[0] : '';
}

function parseListing(html, categoryPath) {
  const root = parseHTML(html);
  const anchors = allNodes(root, (node) => node.tag === 'a' && isDoostihaPostUrl(absoluteUrl(node.attrs.href)));
  const records = new Map();

  for (const anchor of anchors) {
    const postUrl = absoluteUrl(anchor.attrs.href);
    if (!postUrl) continue;
    const card = findCardNode(anchor);
    const image = firstImage(card) || firstImage(anchor);
    const headings = allNodes(card, (node) => ['h1', 'h2', 'h3', 'h4'].includes(node.tag));
    const title = cleanTitle(
      (headings.map(visibleText).find(Boolean)) ||
      anchor.attrs.title ||
      (image && image.alt) ||
      visibleText(anchor) ||
      decodeURIComponent(new URL(postUrl).pathname.split('/').pop().replace(/\.html$/i, '').replace(/-/g, ' '))
    );
    if (!title) continue;

    const cardText = visibleText(card).replace(/\s+/g, ' ').trim();
    const record = {
      id: makeId(postUrl),
      type: 'movie',
      name: title,
      poster: image ? image.url : undefined,
      posterShape: 'poster',
      releaseInfo: yearFrom(`${title} ${cardText}`),
      description: cardText.slice(0, 700),
      website: postUrl,
      _postUrl: postUrl,
      _categoryPath: categoryPath
    };
    const existing = records.get(postUrl);
    if (!existing || (!existing.poster && record.poster) || (existing.name.length < record.name.length && record.name.length > 4)) {
      records.set(postUrl, record);
    }
  }

  return [...records.values()];
}

function metaContent(root, key, attr = 'property') {
  const match = allNodes(root, (node) => node.tag === 'meta' && String(node.attrs[attr] || '').toLowerCase() === key.toLowerCase())[0];
  return match ? match.attrs.content || '' : '';
}

function parsePost(html, postUrl) {
  const root = parseHTML(html);
  const body = allNodes(root, (node) => node.tag === 'body')[0] || root;
  const text = visibleText(body).replace(/\s+/g, ' ').trim();
  const headings = allNodes(root, (node) => node.tag === 'h1');
  const metaTitle = metaContent(root, 'og:title') || metaContent(root, 'twitter:title', 'name');
  const title = cleanTitle(headings.map(visibleText).find(Boolean) || metaTitle || 'Doostiha movie');
  const poster = absoluteUrl(metaContent(root, 'og:image') || metaContent(root, 'twitter:image', 'name')) || (firstImage(body) || {}).url || '';
  const metaDescription = metaContent(root, 'og:description') || metaContent(root, 'description', 'name');

  let description = metaDescription;
  const summaryIndex = text.indexOf('\u062E\u0644\u0627\u0635\u0647 \u062F\u0627\u0633\u062A\u0627\u0646');
  if (!description && summaryIndex >= 0) {
    const start = text.indexOf(':', summaryIndex) + 1;
    const tail = text.slice(start > 0 ? start : summaryIndex + 12);
    const stops = ['\u0633\u062A\u0627\u0631\u06AF\u0627\u0646', '\u0698\u0627\u0646\u0631:', '\u06A9\u0627\u0631\u06AF\u0631\u062F\u0627\u0646:', '\u06A9\u06CC\u0641\u06CC\u062A \u062A\u0635\u0648\u06CC\u0631:'];
    let end = tail.length;
    for (const stop of stops) {
      const position = tail.indexOf(stop);
      if (position >= 0 && position < end) end = position;
    }
    description = tail.slice(0, end).trim();
  }
  description = String(description || text).replace(/\s+/g, ' ').trim().slice(0, 1800);

  const yearMatch = text.match(/\u0633\u0627\u0644 \u0627\u0646\u062A\u0634\u0627\u0631\s*:\s*([0-9\u06F0-\u06F9\u0660-\u0669]{4})/);
  const year = yearMatch ? toLatinDigits(yearMatch[1]) : yearFrom(title);
  const ratingMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*\/\s*10\s*IMDb/i);
  const runtimeMatch = text.match(/\u0645\u062F\u062A \u0632\u0645\u0627\u0646\s*:\s*([0-9\u06F0-\u06F9\u0660-\u0669]+)\s*\u062F\u0642\u06CC\u0642\u0647/);
  const genreMatch = text.match(/\u0698\u0627\u0646\u0631\s*:\s*(.+?)(?:\u06A9\u0627\u0631\u06AF\u0631\u062F\u0627\u0646:|\u0645\u062D\u0635\u0648\u0644:|\u0633\u0627\u0644 \u0627\u0646\u062A\u0634\u0627\u0631:|\u0632\u0628\u0627\u0646:|\u0645\u062F\u062A \u0632\u0645\u0627\u0646:)/);
  const genres = genreMatch ? genreMatch[1].split(/[،,]/).map((item) => item.trim()).filter(Boolean).slice(0, 8) : [];
  const isDubbed = /\u062F\u0648\u0628\u0644\u0647 \u0641\u0627\u0631\u0633\u06CC|\u0632\u0628\u0627\u0646\s*:\s*\u0641\u0627\u0631\u0633\u06CC|\u0641\u0627\u0631\u0633\u06CC[\u2022\u00B7]/i.test(text);

  return {
    id: makeId(postUrl),
    type: 'movie',
    name: title,
    poster: poster || undefined,
    posterShape: 'poster',
    description,
    releaseInfo: year || undefined,
    imdbRating: ratingMatch ? ratingMatch[1] : undefined,
    runtime: runtimeMatch ? `${toLatinDigits(runtimeMatch[1])}m` : undefined,
    genres,
    language: isDubbed ? '\u0641\u0627\u0631\u0633\u06CC' : undefined,
    website: postUrl,
    _isDubbed: isDubbed
  };
}

function allowedVideoHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'doostihaa.upera.tv' || host === 'doostihaa.com' || host === 'www.doostihaa.com' || host.endsWith('.doostihaa.com');
}

function normalizeEscapedUrl(value) {
  return decodeEntities(String(value || ''))
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/\\x26/gi, '&')
    .trim();
}

function extractVideoLinks(html, pageUrl) {
  const root = parseHTML(html);
  const candidates = [];
  const attrNames = ['href', 'src', 'data-src', 'data-hls', 'data-video', 'data-url', 'data-file'];

  for (const node of allNodes(root, (entry) => entry.type === 'element')) {
    for (const attrName of attrNames) {
      const raw = node.attrs && node.attrs[attrName];
      if (!raw) continue;
      const url = absoluteUrl(normalizeEscapedUrl(raw), pageUrl);
      if (!url) continue;
      let parsed;
      try { parsed = new URL(url); } catch { continue; }
      if (!allowedVideoHost(parsed.hostname) || !VIDEO_EXT_RE.test(parsed.pathname)) continue;
      candidates.push({ url, label: visibleText(node) || '', filename: parsed.pathname.split('/').pop() || '' });
    }
  }

  const scripts = allNodes(root, (node) => node.tag === 'script');
  const scriptUrlPattern = /https?:\\?\/\\?\/[a-zA-Z0-9._:-]+\/[^\s"'<>\\]+?\.(?:mp4|m4v|m3u8|webm|mov|mkv|ts)(?:\?[^\s"'<>\\]*)?/gi;
  for (const script of scripts) {
    const raw = (script.children || []).map((child) => child.text || '').join(' ');
    let match;
    while ((match = scriptUrlPattern.exec(raw))) {
      const url = absoluteUrl(normalizeEscapedUrl(match[0]), pageUrl);
      if (!url) continue;
      let parsed;
      try { parsed = new URL(url); } catch { continue; }
      if (allowedVideoHost(parsed.hostname) && VIDEO_EXT_RE.test(parsed.pathname)) {
        candidates.push({ url, label: raw.slice(Math.max(0, match.index - 80), match.index), filename: parsed.pathname.split('/').pop() || '' });
      }
    }
  }

  const unique = new Map();
  for (const item of candidates) {
    if (!unique.has(item.url)) unique.set(item.url, item);
  }
  return [...unique.values()].map((item) => {
    const qualityMatch = `${item.label} ${item.filename}`.match(/(2160|1440|1080|720|480|360)\s*p|\b4k\b/i);
    const quality = qualityMatch ? (qualityMatch[0].toLowerCase() === '4k' ? '4K' : `${qualityMatch[1]}p`) : 'Auto';
    const extension = (item.filename.match(/\.([a-z0-9]+)$/i) || [])[1] || 'mp4';
    return { ...item, quality, extension: extension.toUpperCase() };
  }).sort((a, b) => {
    const score = (value) => ({ '4K': 2160, '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, Auto: 0 })[value] || 0;
    return score(b.quality) - score(a.quality);
  });
}

module.exports = {
  SITE_ORIGIN,
  parseHTML,
  parseListing,
  parsePost,
  extractVideoLinks,
  makeId,
  postUrlFromId,
  isDoostihaPostUrl,
  normalizeText,
  toLatinDigits
};
