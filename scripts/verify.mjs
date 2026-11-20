#!/usr/bin/env node
/**
 * iptv-clean / scripts/verify.mjs
 *
 * 干什么：拉第三方聚合表 -> 只留我们要的台 -> 逐台验收五条门槛 -> 写 out/。
 * 为什么：第三方表 339 台、地址天天变、混着假源（nosignal / 图片 / mp4 / 张冠李戴）。
 *         中心只要"确定的、能播的那几十台"，所以清洗放在这里做，中心只读结果。
 * 判据来源：接入方给的《第三方直连源接入说明》第三、四节。
 *
 * 不做的事：不代理视频字节；不猜台名（对不上就跳过并由 denylist 人工兜）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const STATE = path.join(ROOT, 'state');

const SRC = [
  'https://live.zbds.top/tv/iptv4.m3u',
  'https://live.zbds.top/tv/iptv4.txt',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000);
const PROBE_CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 4);
const SEG_SAMPLE_BYTES = Number(process.env.SEG_SAMPLE_BYTES || 262144);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 3);
const SRC_TIMEOUT_MS = Number(process.env.SRC_TIMEOUT_MS || 20000);
// 探测分片时带上的 Origin：用来顺便看 CORS 头（浏览器在 https 页面里拉分片，没有 ACAO 就是黑屏）。
// 默认用中性的 example.com；真实播放页域名走环境变量 PROBE_ORIGIN 传进来，不写进仓库。
const PROBE_ORIGIN = process.env.PROBE_ORIGIN || 'https://example.com';
// 逐帧比对（要 ffmpeg，本机没有就用不了；GitHub runner 有）。只对"已经验通"的台做，每台只取 2 个分片。
const FRAME_CHECK = process.env.FRAME_CHECK === '1';
// 礼貌间隔：探测之间随机停一下，别把人家源站打急（用户 2026-11-20：「你也别访问太勤，小心被人封了」）
const POLITE_MIN_MS = Number(process.env.POLITE_MIN_MS || 150);
const POLITE_MAX_MS = Number(process.env.POLITE_MAX_MS || 450);
// 逐帧比对要 ffmpeg，装没装一次问清楚（本机没有就自动跳过，不报错）
const CAN_FRAME = FRAME_CHECK && hasFfmpeg();

/** 名字归一：表里 "CCTV-1 综合 高清" 与白名单 "CCTV1" 要能对上 */
const STRIP_TOKENS = [
  '高清', '超清', '标清', '蓝光', '蓝光高清', '高清版', '测试', '备用', '频道',
  '综合', '财经', '综艺', '中文国际', '国际', '体育赛事', '体育', '电影', '国防军事',
  '军事', '电视剧', '纪录', '科教', '戏曲', '社会与法', '新闻', '少儿', '音乐',
];
function norm(s) {
  let t = String(s || '').toUpperCase();
  t = t.replace(/[\s　]+/g, '');
  t = t.replace(/[-－_·・]/g, '');
  t = t.replace(/[（）()【】\[\]]/g, '');
  t = t.replace(/＋/g, '+');
  for (const tok of STRIP_TOKENS) t = t.split(tok.toUpperCase()).join('');
  return t;
}

const BAD_URL = /nosignal|no[-_]?signal|\.jpg(\?|$)|\.jpeg(\?|$)|\.bmp(\?|$)|\.png(\?|$)|\.mp4(\?|$)|\.flv(\?|$)/i;
// 挂掉时常见的"占位"字样：无信号、台标、二维码、错误页、默认图
const PLACEHOLDER_URL = /nosignal|no[-_]?signal|placeholder|black[-_]?screen|logo|qrcode|qr[-_]?code|error\.m3u8|default\.m3u8/i;
const PLACEHOLDER_HOST = /nosignal|placeholder|logo|qr|static|error|default/i;

/**
 * 分组名单独归一：只去掉空白和结尾的"频道"。
 * ⛔ 不能复用 norm() —— 那套会删掉"体育""纪录""电影"这些词，
 *    分组"电影频道"就会被归一成空串，然后被空串匹配进来（2026-11-20 真踩到，129 条里混进 66 条电影）。
 */
function gnorm(s) {
  return String(s || '').replace(/[\s　]+/g, '').replace(/频道$/, '');
}

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** 拉表：m3u 优先，失败退 txt；两个都失败就抛，让上层保留上一轮结果 */
async function fetchSource() {
  const errs = [];
  for (const url of SRC) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(SRC_TIMEOUT_MS) });
      if (!r.ok) { errs.push(url + ' -> HTTP ' + r.status); continue; }
      const text = await r.text();
      const parsed = url.endsWith('.txt') ? parseTxt(text) : parseM3u(text);
      if (!parsed.entries.length) { errs.push(url + ' -> 解析出 0 台'); continue; }
      return { url, text, entries: parsed.entries, sourceUpdated: parsed.updated || '' };
    } catch (e) {
      errs.push(url + ' -> ' + (e.message || String(e)));
    }
  }
  throw new Error('拉表失败：' + errs.join(' | '));
}

function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  // 表里有一条 group-title="更新时间" 的假频道，地址是占位 mp4 —— 只从正文里找时间串，别把那条地址当时间
  const updated = (text.match(/更新时间[：:\s]*(\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2})/) || [])[1] || '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF') && /更新时间/.test(line)) continue;
    if (!line.startsWith('#EXTINF')) continue;
    const tvgName = (line.match(/tvg-name="([^"]*)"/) || [])[1] || '';
    const tvgId = (line.match(/tvg-id="([^"]*)"/) || [])[1] || '';
    const group = (line.match(/group-title="([^"]*)"/) || [])[1] || '';
    const afterComma = (line.split(',').slice(1).join(',') || '').trim();
    let url = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const nxt = lines[j].trim();
      if (!nxt || nxt.startsWith('#')) continue;
      url = nxt; break;
    }
    if (!url) continue;
    entries.push({ tvgName, tvgId, group, title: afterComma, url });
  }
  return { entries, updated };
}

function parseTxt(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let group = '';
  let updated = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#/.test(line)) continue;
    if (line.includes(',#genre#')) { group = line.split(',#genre#')[0].trim(); continue; }
    if (/更新时间/.test(line)) { updated = line.split(',')[1] || ''; continue; }
    const idx = line.lastIndexOf(',');
    if (idx <= 0) continue;
    const title = line.slice(0, idx).trim();
    const url = line.slice(idx + 1).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    entries.push({ tvgName: title, tvgId: '', group, title, url });
  }
  return { entries, updated };
}

/** 表里的一条 -> 我们要的哪个台（长别名优先，避免 CCTV5 抢走 CCTV5+） */
function buildMatcher(wanted) {
  const pairs = [];
  for (const ch of wanted.channels) {
    for (const alias of ch.match || []) {
      const a = norm(alias);
      if (a) pairs.push({ slug: ch.slug, alias: a });
    }
  }
  pairs.sort((x, y) => y.alias.length - x.alias.length);
  return function match(entry) {
    const cands = [entry.tvgName, entry.title, entry.tvgId].map(norm).filter(Boolean);
    for (const { slug, alias } of pairs) {
      for (const c of cands) {
        if (c === alias) return slug;
        // 前缀匹配只允许"别名后面不是数字"（否则 CCTV1 会吃掉 CCTV13）
        if (c.startsWith(alias)) {
          const next = c.slice(alias.length, alias.length + 1);
          if (!/[0-9]/.test(next)) return slug;
        }
      }
    }
    return null;
  };
}

async function fetchText(url, opts = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || PROBE_TIMEOUT_MS),
    redirect: 'follow',
  });
  const body = opts.head ? '' : await r.text();
  return { status: r.status, ok: r.ok, headers: r.headers, body, finalUrl: r.url };
}

function absUrl(base, rel) {
  try { return new URL(rel, base).toString(); } catch (e) { return rel; }
}

function segsOf(playlistText) {
  return playlistText.split(/\r?\n/).map(s => s.trim()).filter(l => l && !l.startsWith('#'));
}

/**
 * 清单快照：序列号 / 分片列表 / 窗口总时长。
 * 用来抓"不滚动的循环占位"——很多台挂掉时不是报错，而是循环播一段 2 秒的台标/二维码，
 * 清单看着完全正常、分片也 200，只有"隔一会儿再看它有没有往前走"才认得出来。
 */
function playlistSnapshot(text) {
  const s = String(text || '');
  const seq = (s.match(/#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i) || [])[1] || '';
  const lines = s.split(/\r?\n/).map(x => x.trim());
  const segs = lines.filter(l => l && !l.startsWith('#'));
  let win = 0;
  for (const l of lines) {
    const m = l.match(/^#EXTINF:\s*([0-9.]+)/i);
    if (m) win += Number(m[1]) || 0;
  }
  return { seq, segs, win: Math.round(win), count: segs.length };
}

function variantOf(playlistText, base) {  if (!/#EXT-X-STREAM-INF/i.test(playlistText)) return '';
  const lines = playlistText.split(/\r?\n/).map(s => s.trim());
  for (let i = 0; i < lines.length; i++) {
    if (/^#EXT-X-STREAM-INF/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j] || lines[j].startsWith('#')) continue;
        return absUrl(base, lines[j]);
      }
    }
  }
  return '';
}

/** 取首片前 N 字节，判定"是不是真视频"。带 Origin 是为了一起看 CORS 头：浏览器拉分片没有 ACAO 就是黑屏。 */
async function probeSegment(url, origin) {
  const t0 = Date.now();
  const headers = { 'User-Agent': UA, Range: 'bytes=0-' + (SEG_SAMPLE_BYTES - 1) };
  if (origin) headers.Origin = origin;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const acao = r.headers.get('access-control-allow-origin') || '';
  const cr = r.headers.get('content-range') || '';
  const total = Number((cr.match(/\/(\d+)/) || [])[1] || r.headers.get('content-length') || 0);
  let head = new Uint8Array(0);
  let got = 0;
  if (r.body) {
    const reader = r.body.getReader();
    const chunks = [];
    let want = Math.min(SEG_SAMPLE_BYTES, 65536);
    while (got < want) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.byteLength;
    }
    try { await reader.cancel(); } catch (e) {}
    const all = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    head = all.slice(0, Math.min(got, 4096));
  }
  return { status: r.status, ct, acao, total, head, got, ms: Date.now() - t0 };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function polite() { await sleep(POLITE_MIN_MS + Math.random() * Math.max(0, POLITE_MAX_MS - POLITE_MIN_MS)); }

/** 分片前 N 字节的指纹：两个不同分片指纹相同 = 内容一样 = 在循环播同一段 */
async function prefixHash(url, bytes = 131072) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-' + (bytes - 1) }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!(r.status === 200 || r.status === 206)) return '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 4096) return '';
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 8000 }); return true; } catch (e) { return false; }
}

/** 取一帧，缩成 32x32 灰度（1024 字节）：用来比"两个分片的画面是不是同一张图" */
function frameGray(file) {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1',
    '-vf', 'scale=32:32', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22, timeout: 25000 });
  if (!out || out.length < 1024) return null;
  return Buffer.from(out.subarray(0, 1024));
}

function meanAbsDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

async function downloadTo(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!(r.status === 200 || r.status === 206)) return 0;
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** 单台验收：返回 {ok, why, url, host, ms, segBytes} */
async function verifyChannel(ch, candidates, deny) {
  const tried = [];
  for (const cand of candidates.slice(0, MAX_CANDIDATES)) {
    await polite();   // 别把人家源站打急（用户 2026-11-20：「小心被人封了」）
    const url = cand.url;
    if (BAD_URL.test(url)) { tried.push({ url, why: '地址本身是占位/图片/mp4' }); continue; }
    if (deny.hit(ch.slug, url)) { tried.push({ url, why: '在 denylist 里' }); continue; }

    let host = '';
    try { host = new URL(url).host; } catch (e) { tried.push({ url, why: '地址不是合法 URL' }); continue; }

    const t0 = Date.now();
    try {
      // 1) 取清单（可能是 master，要再下钻一层）
      let pl = await fetchText(url);
      if (pl.status !== 200) { tried.push({ url, why: '清单 HTTP ' + pl.status }); continue; }
      let body = pl.body || '';
      if (!/^\s*#EXTM3U/.test(body)) { tried.push({ url, why: '不是 m3u8（前 40 字：' + body.slice(0, 40).replace(/\s+/g, ' ') + '）' }); continue; }
      // 挂掉时"跳转到自家台标/二维码/无信号页"的：落点域名或路径里会有这些字样
      const finalUrl = pl.finalUrl || url;
      if (PLACEHOLDER_URL.test(finalUrl) || (() => {
        try { return new URL(finalUrl).host !== new URL(url).host && PLACEHOLDER_HOST.test(new URL(finalUrl).host); } catch (e) { return false; }
      })()) {
        tried.push({ url, why: '清单被跳转到占位地址（' + finalUrl.slice(0, 90) + '）' });
        continue;
      }

      const variant = variantOf(body, url);
      if (variant) {
        if (BAD_URL.test(variant)) { tried.push({ url, why: 'master 指向 nosignal/占位' }); continue; }
        const pl2 = await fetchText(variant);
        if (pl2.status !== 200 || !/^\s*#EXTM3U/.test(pl2.body || '')) { tried.push({ url: variant, why: '变体清单 HTTP ' + pl2.status }); continue; }
        body = pl2.body;
        pl = pl2;
        host = (() => { try { return new URL(variant).host; } catch (e) { return host; } })();
      }

      let segs = segsOf(body);
      if (segs.length < 2) { tried.push({ url, why: '只解析出 ' + segs.length + ' 个分片' }); continue; }
      // 带 ENDLIST = 点播清单（固定一段循环播放）：直播台不会这么发，多半是台标/二维码占位
      if (/#EXT-X-ENDLIST/i.test(body)) { tried.push({ url, why: '清单带 #EXT-X-ENDLIST（点播式的固定片段，不是直播）' }); continue; }
      const base = host && variant ? variant : url;
      let first = absUrl(base, segs[0]);
      if (BAD_URL.test(first)) { tried.push({ url, why: '首个分片是 nosignal/占位' }); continue; }

      // 2) 分片必须走 https（网页是 https，明文分片会被浏览器拦）
      let rewritten = false;
      if (first.startsWith('http://')) {
        const alt = 'https://' + first.slice('http://'.length);
        let okHttps = false;
        try {
          const t = await probeSegment(alt, PROBE_ORIGIN);
          okHttps = (t.status === 200 || t.status === 206) && t.got > 0;
        } catch (e) { okHttps = false; }
        if (!okHttps) { tried.push({ url, why: '分片是明文 http，且该主机不支持 https' }); continue; }
        first = alt;
        rewritten = true;
      }

      // 3) 取首片
      const seg = await probeSegment(first, PROBE_ORIGIN);
      if (!(seg.status === 200 || seg.status === 206)) { tried.push({ url, why: '首片 HTTP ' + seg.status }); continue; }
      if (seg.got <= 0) { tried.push({ url, why: '首片 0 字节' }); continue; }

      const encrypted = /#EXT-X-KEY:[^\n]*METHOD=AES-128/i.test(body);
      const isTs = seg.head.length > 0 && seg.head[0] === 0x47;
      const ctTs = /mp2t|mpeg-?ts|octet-stream/.test(seg.ct);
      const looksHtml = /text\/html|application\/json/.test(seg.ct) || /^<(!doctype|html)/i.test(new TextDecoder().decode(seg.head.slice(0, 16)));
      if (looksHtml) { tried.push({ url, why: '首片是网页/JSON（假源）' + (seg.ct ? ' ct=' + seg.ct : '') }); continue; }
      if (!isTs && !ctTs && !encrypted) {
        tried.push({ url, why: '首片不像真视频（ct=' + (seg.ct || '无') + '，首字节=0x' + (seg.head[0] || 0).toString(16) + '）' });
        continue;
      }
      if (encrypted && seg.got < 3000) { tried.push({ url, why: '加密流首片太小（' + seg.got + ' B）' }); continue; }
      // 浏览器拉分片是跨域 XHR：没有 ACAO 头，服务器端能取也照样黑屏（2026-11-20 实测 6 个台都带，所以这条不会误杀）
      if (!seg.acao) { tried.push({ url, why: '分片没有 CORS 头（浏览器拉不了）' }); continue; }

      // 4) 同一清单里两个不同分片"内容一样" ⇒ 在循环播同一段（挂掉后播 2 秒台标/二维码就是这个形态）
      const allSegs = segs.map(s => {
        const u = absUrl(base, s);
        return rewritten && u.startsWith('http://') ? 'https://' + u.slice(7) : u;
      });
      const lastSeg = allSegs[allSegs.length - 1];
      if (lastSeg && lastSeg !== first) {
        let loopWhy = '';
        try {
          const h1 = await prefixHash(first);
          await polite();
          const h2 = await prefixHash(lastSeg);
          if (h1 && h2 && h1 === h2) loopWhy = '首尾两个分片的内容完全相同 ⇒ 循环播同一段（台标/二维码占位）';
        } catch (e) { /* 指纹取不到就不判这条 */ }
        if (loopWhy) { tried.push({ url, why: loopWhy }); continue; }
      }

      // 5) 逐帧比对（可选，要 ffmpeg）：两个分片的首帧几乎一样 ⇒ 画面是静止的
      let frameDiff = null;
      if (CAN_FRAME && !encrypted && lastSeg && lastSeg !== first) {
        const rnd = Math.random().toString(36).slice(2);
        const f1 = path.join(os.tmpdir(), 'iptv-f1-' + process.pid + '-' + rnd + '.ts');
        const f2 = path.join(os.tmpdir(), 'iptv-f2-' + process.pid + '-' + rnd + '.ts');
        try {
          const n1 = await downloadTo(first, f1);
          await polite();
          const n2 = await downloadTo(lastSeg, f2);
          if (n1 > 0 && n2 > 0) {
            const g1 = frameGray(f1);
            const g2 = frameGray(f2);
            if (g1 && g2) {
              frameDiff = Math.round(meanAbsDiff(g1, g2) * 100) / 100;
              if (frameDiff < 2) {
                tried.push({ url, why: '两个分片的画面几乎一模一样（灰度差 ' + frameDiff + '/255）⇒ 静止画面（台标/二维码占位）' });
                continue;
              }
            }
          }
        } catch (e) {
          // ffmpeg 解不出来（编码怪 / 分片不完整）就不拿它判死
        } finally {
          try { fs.unlinkSync(f1); } catch (e) {}
          try { fs.unlinkSync(f2); } catch (e) {}
        }
      }

      return {
        ok: true,
        url,
        host,
        ms: Date.now() - t0,
        segBytes: seg.got,
        segTotal: seg.total,
        ct: seg.ct,
        cors: seg.acao,
        ts: isTs,
        encrypted,
        rewritten,
        frameDiff,
        plBody: body,
        tried,
      };
    } catch (e) {
      tried.push({ url, why: (e && e.message) ? String(e.message).slice(0, 80) : '未知错误' });
    }
  }
  return { ok: false, tried };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function makeDeny(list) {
  const rows = (list && list.blocked) || [];
  return {
    hit(slug, url) {
      return rows.some(r => {
        if (r.slug && r.slug !== slug) return false;
        if (r.url_contains && !String(url).includes(r.url_contains)) return false;
        return true;
      });
    },
  };
}

async function main() {
  const wanted = readJson(path.join(ROOT, 'wanted.json'), null);
  if (!wanted || !Array.isArray(wanted.channels)) throw new Error('wanted.json 读不到或格式不对');
  const denyList = readJson(path.join(ROOT, 'denylist.json'), { blocked: [] });
  const deny = makeDeny(denyList);
  const history = readJson(path.join(STATE, 'history.json'), {});

  console.log('[1/4] 拉表 ...');
  let src;
  try {
    src = await fetchSource();
    console.log('      源：' + src.url + '，共 ' + src.entries.length + ' 条，表内更新时间：' + (src.sourceUpdated || '未标注'));
  } catch (e) {
    console.log('      拉表失败：' + e.message);
    const prev = readJson(path.join(OUT, 'channels.json'), null);
    if (prev && Array.isArray(prev.channels)) {
      prev.stale = true;
      prev.stale_since = prev.generated_at;
      prev.generated_at = new Date().toISOString();
      prev.last_error = e.message;
      writeJson(path.join(OUT, 'channels.json'), prev);
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'report.md'),
        '# 本轮没有拉到源表\n\n- 时间：' + new Date().toISOString() +
        '\n- 原因：' + e.message +
        '\n- 处理：保留上一轮结果（`channels.json` 已标 `stale: true`），不清空名单。\n', 'utf8');
      console.log('      已保留上一轮结果，报告写了 out/report.md');
      return;
    }
    throw e;
  }

  console.log('[2/4] 过滤分组 + 匹配白名单 ...');
  const keepGroups = (wanted.keepGroups || []).map(gnorm).filter(Boolean);
  const groupKept = (g) => {
    if (!keepGroups.length) return true;
    const gg = gnorm(g);
    if (!gg) return false;
    return keepGroups.some(k => gg === k || gg.includes(k));
  };
  const candidates = new Map();  // slug -> [{url, ...}]
  for (const ch of wanted.channels) candidates.set(ch.slug, []);
  const match = buildMatcher(wanted);
  let kept = 0;
  for (const entry of src.entries) {
    if (!groupKept(entry.group)) continue;
    kept++;
    const slug = match(entry);
    if (!slug) continue;
    const arr = candidates.get(slug);
    const preferHttps = entry.url.startsWith('https://') ? 0 : 1;
    arr.push({ url: entry.url, tvgName: entry.tvgName, title: entry.title, preferHttps });
  }
  let withCand = 0;
  for (const [, arr] of candidates) {
    if (arr.length) withCand++;
    arr.sort((a, b) => a.preferHttps - b.preferHttps);
  }
  console.log('      分组内 ' + kept + ' 条，能对上白名单的台 ' + withCand + ' / ' + wanted.channels.length);

  console.log('[3/4] 逐台验收（并发 ' + PROBE_CONCURRENCY + '）...  逐帧比对：' + (CAN_FRAME ? '开' : (FRAME_CHECK ? '关（没装 ffmpeg）' : '关')));  const list = [...candidates.entries()].filter(([, arr]) => arr.length).map(([slug, arr]) => ({ slug, arr }));
  const results = await pool(list, PROBE_CONCURRENCY, async ({ slug, arr }) => {
    const ch = wanted.channels.find(c => c.slug === slug);
    const r = await verifyChannel(ch, arr, deny);
    console.log('      ' + (r.ok ? 'OK  ' : '--  ') + slug.padEnd(9) + (r.ok ? (r.host + ' ' + r.ms + 'ms ' + r.segBytes + 'B' + (r.rewritten ? ' (分片已换 https)' : '')) : ((r.tried[0] && r.tried[0].why) || '')));
    return { slug, ch, r, arr };
  });

  // 复查：隔一会儿再取一次清单 —— 抓"挂掉时不报错、而是循环播一段 2 秒台标/二维码"的那种台。
  // 判据：分片序列和 MEDIA-SEQUENCE 完全没动、且窗口总长 < 60 秒 ⇒ 不是直播。
  const passedFirst = results.filter(x => x.r && x.r.ok);
  if (passedFirst.length) {
    const waitMs = Number(process.env.RECHECK_WAIT_MS || 30000);
    console.log('[3.5/4] ' + Math.round(waitMs / 1000) + ' 秒后复查（抓循环占位）...');
    await new Promise(r => setTimeout(r, waitMs));
    await pool(passedFirst, PROBE_CONCURRENCY, async (x) => {
      try {
        const again = await fetchText(x.r.url);
        if (again.status !== 200 || !/^\s*#EXTM3U/.test(again.body || '')) { x.r.recheck = '复查取不到清单'; return; }
        const a = playlistSnapshot(x.r.plBody);
        const b = playlistSnapshot(again.body);
        const sameSegs = a.segs.join('|') === b.segs.join('|');
        const sameSeq = a.seq === b.seq;
        if (sameSegs && sameSeq && a.win < 60) {
          x.r.ok = false;
          x.r.tried = [{
            url: x.r.url,
            why: '清单 ' + Math.round(waitMs / 1000) + ' 秒内没有任何前进（分片序列和 MEDIA-SEQUENCE 都没变、窗口只有 ' + a.win +
                 ' 秒 / ' + a.count + ' 段）⇒ 冻结或循环占位（台标/二维码那种），不能当直播',
          }];
        } else if (sameSegs && sameSeq) {
          x.r.suspect = '复查时清单未变（窗口 ' + a.win + ' 秒），留观';
        } else {
          x.r.live_ok = true;
        }
      } catch (e) {
        x.r.recheck = '复查失败：' + String(e.message || e).slice(0, 60);
      }
    });
    const killed = results.filter(x => x.r && !x.r.ok && x.r.tried && x.r.tried[0] && /循环占位/.test(String(x.r.tried[0].why)));
    if (killed.length) console.log('      抓到循环占位 ' + killed.length + ' 台：' + killed.map(x => x.slug).join(' '));
  }

  console.log('[4/4] 写结果 ...');  // 三档：ok（验通）/ unverified（只有网络层失败）/ blocked（假源或结构硬伤）
  const NET_FAIL = /fetch failed|aborted|timeout|timed out|ENOTFOUND|ECONN|socket|network|TLS|SSL/i;
  const isNetOnly = (r) => !r.ok && r.tried.length > 0 && r.tried.every(t => NET_FAIL.test(t.why || ''));

  const channels = [];
  const unverified = [];
  const missing = [];
  for (const ch of wanted.channels) {
    const hit = results.find(x => x.slug === ch.slug);
    if (!hit) { missing.push({ slug: ch.slug, name: ch.name, group: ch.group, why: '表里没有这一台（或分组被过滤）' }); continue; }
    if (hit.r.ok) {
      channels.push({
        slug: ch.slug, name: ch.name, group: ch.group, status: 'ok',
        url: hit.r.url, host: hit.r.host, seg_https: true, cors: true,
        rewritten: !!hit.r.rewritten, encrypted: !!hit.r.encrypted,
        live_ok: !!hit.r.live_ok, suspect: hit.r.suspect || '', frame_diff: hit.r.frameDiff,
        ms: hit.r.ms, seg_bytes: hit.r.segBytes,
      });
      continue;
    }
    if (isNetOnly(hit.r)) {
      // 网络层失败：以前一律算"验收机器在境外、国内多半能看"。2026-11-20 本地（家用宽带）实测过，
      // 这些台**本地也连不上** ⇒ 多半是真挂了。所以降级成"待定"，中心只把验通的标成直连。
      const firstUrl = (hit.arr && hit.arr[0] && hit.arr[0].url) || '';
      unverified.push({
        slug: ch.slug, name: ch.name, group: ch.group, status: 'unverified',
        url: firstUrl, host: (() => { try { return new URL(firstUrl).host; } catch (e) { return ''; } })(),
        why: (hit.r.tried[0] && hit.r.tried[0].why) || '网络层失败',
      });
      continue;
    }
    missing.push({ slug: ch.slug, name: ch.name, group: ch.group, why: (hit.r.tried[0] && hit.r.tried[0].why) || '验收没过', tried: hit.r.tried.slice(0, 3) });
  }

  const stamp = new Date().toISOString();
  writeJson(path.join(OUT, 'channels.json'), {
    generated_at: stamp,
    source: { url: src.url, entries: src.entries.length, updated: src.sourceUpdated || '' },
    stale: false,
    wanted: wanted.channels.length,
    count: channels.length,
    unverified_count: unverified.length,
    channels,
    unverified,
    missing,
    note: 'channels = 验通的（中心标成直连、不限并发）；unverified = 结构没问题但本轮验收机连不上（2026-11-20 本地实测：这类台多数是真的挂了）—— 中心不把它标成直连，仍走 IPTV 那一档；missing = 不上架。视频字节不经中心，播放器直连分片。',
  });

  // 盒子用的清单只放"验通的"，别把不确定的塞进去
  const m3u = ['#EXTM3U'];
  for (const c of channels) m3u.push('#EXTINF:-1 group-title="' + c.group + '",' + c.name, c.url);
  fs.writeFileSync(path.join(OUT, 'playlist.m3u'), m3u.join('\n') + '\n', 'utf8');

  const upSlugs = new Set([...channels, ...unverified].map(c => c.slug));
  for (const ch of wanted.channels) {
    const h = history[ch.slug] || { ok_run: 0, fail_run: 0 };
    if (upSlugs.has(ch.slug)) { h.ok_run = (h.ok_run || 0) + 1; h.fail_run = 0; h.last_ok = stamp; }
    else { h.fail_run = (h.fail_run || 0) + 1; h.ok_run = 0; const m = missing.find(x => x.slug === ch.slug); h.last_why = m ? m.why : ''; }
    history[ch.slug] = h;
  }
  writeJson(path.join(STATE, 'history.json'), history);

  const lines = [];
  lines.push('# iptv-clean 本轮报告');
  lines.push('');
  lines.push('- 时间：' + stamp);
  lines.push('- 源：' + src.url + '（表内更新 ' + (src.sourceUpdated || '未标注') + '）');
  lines.push('- 结果：**' + channels.length + ' 台验通 + ' + unverified.length + ' 台待定（验收机连不上） / ' + wanted.channels.length + ' 台**');
  lines.push('');
  lines.push('## 验通（上架）');
  lines.push('');
  lines.push('| 台 | 地址主机 | 耗时 | 首片 | 备注 |');
  lines.push('|---|---|---|---|---|');
  for (const c of channels) {
    lines.push('| ' + c.name + ' (`' + c.slug + '`) | `' + c.host + '` | ' + c.ms + ' ms | ' + Math.round(c.seg_bytes / 1024) + ' KB | ' +
      [c.rewritten ? '分片已换 https' : '', c.encrypted ? '加密流' : '', c.live_ok ? '确认在滚动' : '',
       (c.frame_diff != null ? '画面差 ' + c.frame_diff + '/255' : ''), c.suspect || ''].filter(Boolean).join('；') + ' |');
  }
  lines.push('');
  lines.push('## 待定（验收机连不上；中心不标直连，仍走 IPTV 那一档）');
  lines.push('');
  if (unverified.length) {
    lines.push('| 台 | 地址主机 | 这次的失败原因 |');
    lines.push('|---|---|---|');
    for (const c of unverified) lines.push('| ' + c.name + ' (`' + c.slug + '`) | `' + c.host + '` | ' + String(c.why || '').replace(/\|/g, '/') + ' |');
  } else {
    lines.push('（本轮没有）');
  }
  lines.push('');
  lines.push('## 没通过');
  lines.push('');
  lines.push('| 台 | 原因 |');
  lines.push('|---|---|');
  for (const m of missing) lines.push('| ' + m.name + ' (`' + m.slug + '`) | ' + String(m.why || '').replace(/\|/g, '/') + ' |');
  lines.push('');
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'), 'utf8');

  console.log('');
  console.log('验通 ' + channels.length + ' 台、待定 ' + unverified.length + ' 台 / 共 ' + wanted.channels.length + ' 台');
  console.log('写入 out/channels.json、out/playlist.m3u、out/report.md');
}

main().catch(e => {
  console.error('失败：' + (e && e.stack || e));
  process.exit(1);
});
