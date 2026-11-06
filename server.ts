/**
 * Server chung cho mọi game live TikTok. Game riêng KHÔNG cần sửa file này,
 * trừ khi cần thêm API mới (thêm vào cuối, chỗ "API riêng của game").
 *
 * - Kết nối phòng live TikTok (tiktok-live-connector 2.x, proto v3)
 * - Đẩy sự kiện xuống trình duyệt qua SSE: /api/tiktok/events
 * - Lệnh từ trang điều khiển -> trang stage: /api/control
 * - Giọng đọc tiếng Việt: /api/tts (Edge TTS, lỗi thì Google)
 * - Giả lập sự kiện để test không cần live: /api/test/emit
 * - Chọn loa / VB-Cable cho trang stage: /api/audio/state, /api/open-stage
 * - Kiểm tra và cài bản cập nhật (bản Windows đóng gói): /api/update/*
 */
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3006; // cổng riêng của Lớp Học Chữ

// Giọng đọc mặc định: cô Ngân giọng nữ HoaiMy cho mọi câu, kể cả câu chủ kênh gõ cho cô đọc (chủ kênh chốt 2026-11-04).
// Muốn giọng nam thì đặt biến môi trường TTS_VOICE=vi-VN-NamMinhNeural
const TTS_VOICE = process.env.TTS_VOICE || 'vi-VN-HoaiMyNeural';
// Giọng cô giáo: cao hơn một chút cho tươi
const TTS_PITCH = process.env.TTS_PITCH || '+6%';

// Chặn DNS rebinding: trang web lạ trỏ tên miền của nó về 127.0.0.1 thì Host/Origin sẽ khác các tên dưới đây
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'lvh.me']);
const hostOk = (h?: string) => !!h && LOCAL_HOSTS.has(h.replace(/:\d+$/, '').toLowerCase());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!hostOk(req.headers.host) || (origin && !hostOk(origin.replace(/^https?:\/\//, '')))) return res.status(403).end();
  next();
});

app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// ---------- SSE ----------
interface LiveStats {
  isConnected: boolean;
  isConnecting: boolean;
  username: string;
  roomId: string;
  viewerCount: number;
  totalLikes: number;
  error?: string;
}

const emptyStats = (): LiveStats => ({
  isConnected: false,
  isConnecting: false,
  username: '',
  roomId: '',
  viewerCount: 0,
  totalLikes: 0,
  error: '',
});

let liveStats = emptyStats();
let sseClients: express.Response[] = [];
// Các trang stage đang mở (theo thứ tự mở). Chỉ trang mở SAU CÙNG được phát tiếng, tránh 2 giọng đọc đè nhau
// khi lỡ có 2 nguồn Link trong LIVE Studio hoặc mở thêm ?view=stage ở trình duyệt khác.
let stageIds: string[] = [];
const announceSpeaker = () => broadcast('speaker', { id: stageIds[stageIds.length - 1] ?? null, count: stageIds.length });
let activeConn: InstanceType<typeof TikTokLiveConnection> | null = null;
let lastRateControl: { action: string; text: string } | null = null;

// Tên kênh (giọng đọc + tiêu đề) lưu ở settings.json cạnh file này, tắt server mở lại vẫn còn
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let lastNameControl: { action: string; text: string } | null = null;
// tài khoản TikTok đang cần giữ kết nối: rớt thì tự kết nối lại, tắt server bật lại cũng tự kết nối
let wantUser = '';
// audioOut: tên thiết bị phát tiếng của trang stage, vd "CABLE Input" của VB-Cable ('' = loa mặc định)
let settings: { channelName?: string; tiktokUser?: string; audioOut?: string } = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (typeof settings.channelName === 'string' && settings.channelName.trim()) {
    lastNameControl = { action: 'setName', text: settings.channelName.trim() };
  }
  if (typeof settings.tiktokUser === 'string') wantUser = settings.tiktokUser;
} catch {
  // chưa lưu tên nào: dùng tên mặc định trong config.ts
}
const saveSettings = (patch: typeof settings) => {
  settings = { ...settings, ...patch };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Không lưu được settings.json:', err);
  }
};

function broadcast(eventType: string, data: unknown) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      // trình duyệt đã đóng
    }
  }
}

app.get('/api/tiktok/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: status\ndata: ${JSON.stringify(liveStats)}\n\n`);
  if (lastRateControl) res.write(`event: control\ndata: ${JSON.stringify(lastRateControl)}\n\n`);
  if (lastNameControl) res.write(`event: control\ndata: ${JSON.stringify(lastNameControl)}\n\n`);
  if (settings.audioOut) res.write(`event: control\ndata: ${JSON.stringify({ action: 'setAudioOut', text: settings.audioOut })}\n\n`);
  // trang nào thấy phiên bản server khác lần trước (vừa cập nhật xong) thì tự tải lại
  res.write(`event: version\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
  res.write(`event: audio\ndata: ${JSON.stringify(audioStatus())}\n\n`);
  res.write(`event: update\ndata: ${JSON.stringify(updateStatus())}\n\n`);
  sseClients.push(res);
  const stageId = typeof req.query.stage === 'string' ? req.query.stage.slice(0, 40) : '';
  if (stageId) {
    stageIds = [...stageIds.filter((x) => x !== stageId), stageId];
    announceSpeaker();
  } else res.write(`event: speaker\ndata: ${JSON.stringify({ id: stageIds[stageIds.length - 1] ?? null, count: stageIds.length })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter((c) => c !== res);
    if (stageId) {
      stageIds = stageIds.filter((x) => x !== stageId);
      announceSpeaker();
    }
  });
});

app.get('/api/tiktok/status', (_req, res) => res.json({ success: true, data: liveStats }));

// ---------- Đọc dữ liệu TikTok (proto v3) ----------
const userOf = (data: any) => data?.user?.displayId || data?.user?.uniqueId || data?.uniqueId || 'nguoi-xem';
const nickOf = (data: any) => data?.user?.nickname || data?.nickname || data?.uniqueId || 'Bạn';
const avatarOf = (data: any) => data?.user?.avatarThumb?.urlList?.[0] || '';

// ---------- Tự kết nối lại (treo live cả ngày) ----------
// Rớt kết nối / hết phiên live / chưa live: thử lại sau 15 giây, rồi 30, 60, tối đa 2 phút một lần, cho tới khi được.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTries = 0;
function scheduleReconnect(why: string) {
  if (!wantUser || reconnectTimer) return;
  const delay = Math.min(120_000, 15_000 * 2 ** reconnectTries);
  reconnectTries++;
  console.log(`[TikTok] ${why}. Tự kết nối lại @${wantUser} sau ${delay / 1000} giây`);
  liveStats = { ...liveStats, isConnected: false, isConnecting: false, error: `${why}. Tự kết nối lại sau ${delay / 1000} giây` };
  broadcast('status', liveStats);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTikTok(wantUser).catch((err) => scheduleReconnect(`Chưa kết nối lại được (${err instanceof Error ? err.message : err})`));
  }, delay);
}
const stopReconnect = () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectTries = 0;
};

app.post('/api/tiktok/connect', async (req, res) => {
  const cleanUser = String(req.body?.username || '').replace(/^@/, '').trim();
  if (!cleanUser) return res.status(400).json({ success: false, error: 'Chưa nhập username TikTok' });
  stopReconnect();
  wantUser = cleanUser;
  saveSettings({ tiktokUser: cleanUser });
  try {
    const state = await connectTikTok(cleanUser);
    return res.json({ success: true, roomId: state?.roomId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    scheduleReconnect(`Không kết nối được: ${msg}`);
    return res.status(400).json({
      success: false,
      error: `Không kết nối được @${cleanUser}: ${msg}. Tài khoản phải đang LIVE trên TikTok. Server sẽ tự thử lại.`,
    });
  }
});

async function connectTikTok(cleanUser: string) {
  if (activeConn) {
    try {
      activeConn.disconnect();
    } catch {
      // bỏ qua
    }
    activeConn = null;
  }

  liveStats = { ...emptyStats(), isConnecting: true, username: cleanUser };
  broadcast('status', liveStats);

  const conn = new TikTokLiveConnection(cleanUser, {
    processInitialData: true,
    // Lấy danh sách quà cần gói trả phí Euler Stream; sự kiện quà đã có tên và kim cương
    enableExtendedGiftInfo: false,
  });

  conn.on(ControlEvent.CONNECTED, (state: { roomId?: string }) => {
    console.log(`[TikTok] Đã kết nối @${cleanUser}, room ${state?.roomId}`);
    liveStats = { ...liveStats, isConnected: true, isConnecting: false, roomId: state?.roomId || '', error: '' };
    newLiveRoom(state?.roomId || '');
    broadcast('status', liveStats);
    reconnectTries = 0;
  });

  // kết nối cũ bị thay bằng kết nối mới thì không tự nối lại (activeConn đã khác)
  conn.on(ControlEvent.DISCONNECTED, () => {
    console.log(`[TikTok] Mất kết nối @${cleanUser}`);
    if (activeConn !== conn) return;
    liveStats = { ...liveStats, isConnected: false, isConnecting: false };
    broadcast('status', liveStats);
    scheduleReconnect('Mất kết nối TikTok');
  });

  conn.on(WebcastEvent.STREAM_END, () => {
    if (activeConn !== conn) return;
    liveStats = { ...liveStats, isConnected: false, isConnecting: false, error: 'Phiên live đã kết thúc' };
    broadcast('status', liveStats);
    scheduleReconnect('Phiên live đã kết thúc');
  });

  conn.on(WebcastEvent.CHAT, (data: any) => {
    broadcast('chat', {
      username: userOf(data),
      nickname: nickOf(data),
      comment: data?.content || data?.comment || '', // proto v3: chữ nằm ở `content`
      avatar: avatarOf(data),
      timestamp: Date.now(),
      // giờ TikTok gắn lúc người xem gửi (ms): xếp ai trả lời nhanh nhất theo giờ này, không theo lúc bot nhận
      createTime: Number(data?.common?.createTime) || Date.now(),
    });
  });

  // TikTok gửi lại quà combo với repeatCount cộng dồn; chỉ chuyển phần mới
  const streakCounts = new Map<string, number>();
  conn.on(WebcastEvent.GIFT, (data: any) => {
    const username = userOf(data);
    const giftId = data?.giftId || 0;
    const key = `${username}_${giftId}`;
    const total = data?.repeatCount || 1;
    const delta = total - (streakCounts.get(key) || 0);
    const isStreakable = (data?.gift?.type ?? data?.giftDetails?.giftType ?? data?.giftType) === 1;
    if (isStreakable && !data?.repeatEnd) streakCounts.set(key, total);
    else streakCounts.delete(key);
    if (delta <= 0) return;

    broadcast('gift', {
      username,
      nickname: nickOf(data),
      giftName: data?.gift?.name || data?.giftDetails?.giftName || data?.giftName || 'Quà',
      giftId,
      diamondCount: data?.gift?.diamondCount || data?.diamondCount || data?.giftDetails?.diamondCount || 1,
      repeatCount: delta,
      avatar: avatarOf(data),
      timestamp: Date.now(),
    });
  });

  conn.on(WebcastEvent.MEMBER, (data: any) => {
    broadcast('member', { username: userOf(data), nickname: nickOf(data), avatar: avatarOf(data), timestamp: Date.now() });
  });

  conn.on(WebcastEvent.FOLLOW, (data: any) => {
    broadcast('follow', { username: userOf(data), nickname: nickOf(data), avatar: avatarOf(data), timestamp: Date.now() });
  });

  conn.on(WebcastEvent.SHARE, (data: any) => {
    broadcast('share', { username: userOf(data), nickname: nickOf(data), avatar: avatarOf(data), timestamp: Date.now() });
  });

  conn.on(WebcastEvent.ROOM_USER, (data: any) => {
    if (typeof data?.viewerCount === 'number') {
      liveStats.viewerCount = data.viewerCount;
      broadcast('roomUser', { viewerCount: data.viewerCount });
    }
  });

  conn.on(WebcastEvent.LIKE, (data: any) => {
    if (typeof data?.totalLikeCount === 'number') liveStats.totalLikes = data.totalLikeCount;
    broadcast('like', {
      username: userOf(data),
      nickname: nickOf(data),
      likeCount: data?.likeCount || 1,
      totalLikes: liveStats.totalLikes,
    });
  });

  conn.on(ControlEvent.ERROR, (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TikTok] Lỗi @${cleanUser}:`, msg);
    liveStats.error = msg;
    broadcast('status', liveStats);
  });

  activeConn = conn;

  try {
    // Chưa LIVE thì thư viện có thể treo mãi ở "Đang kết nối": hỏi TikTok trước, báo lỗi ngay
    const live = await conn.fetchIsLive().catch(() => true); // hỏi lỗi thì cứ thử kết nối
    if (!live) throw new Error('TikTok báo tài khoản này CHƯA LIVE. Bấm Phát trực tiếp trong LIVE Studio trước rồi mới kết nối');
    return await Promise.race([
      conn.connect(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('quá 30 giây không vào được phòng live')), 30_000)),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    liveStats = { ...liveStats, isConnected: false, isConnecting: false, error: msg };
    broadcast('status', liveStats);
    if (activeConn === conn) {
      try {
        conn.disconnect();
      } catch {
        // bỏ qua
      }
      activeConn = null;
    }
    throw err;
  }
}

app.post('/api/tiktok/disconnect', (_req, res) => {
  // chủ kênh tự ngắt: thôi tự kết nối lại, bật server lại cũng không tự kết nối
  stopReconnect();
  wantUser = '';
  saveSettings({ tiktokUser: '' });
  try {
    activeConn?.disconnect();
  } catch {
    // bỏ qua
  }
  activeConn = null;
  liveStats = emptyStats();
  broadcast('status', liveStats);
  res.json({ success: true });
});

// ---------- Lệnh từ trang điều khiển (chỉ trang stage làm theo) ----------
const CONTROL_ACTIONS = ['speak', 'setRate', 'reset', 'setName', 'custom', 'setAudioOut', 'scanAudio'];
app.post('/api/control', (req, res) => {
  const { action, text } = req.body || {};
  if (!CONTROL_ACTIONS.includes(action)) return res.status(400).json({ success: false, error: 'Lệnh không hợp lệ' });
  if (action === 'speak' && (typeof text !== 'string' || !text.trim())) {
    return res.status(400).json({ success: false, error: 'Chưa nhập nội dung cần đọc' });
  }
  const payload = { action, text: typeof text === 'string' ? text.trim().slice(0, 1000) : undefined };
  if (action === 'setRate' && payload.text) lastRateControl = { action, text: payload.text };
  if (action === 'setName') {
    // Chỉ chữ thường, tối đa 40 ký tự
    const name = (payload.text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ success: false, error: 'Chưa nhập tên kênh' });
    payload.text = name;
    lastNameControl = { action, text: name };
    saveSettings({ channelName: name });
  }
  if (action === 'setAudioOut') {
    // '' = loa mặc định của máy
    payload.text = (typeof text === 'string' ? text : '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
    saveSettings({ audioOut: payload.text });
    broadcast('audio', audioStatus());
  }
  broadcast('control', payload);
  res.json({ success: true, pages: sseClients.length });
});

// ---------- Giả lập sự kiện (test không cần live) ----------
const TEST_EVENTS = ['chat', 'gift', 'member', 'follow', 'share', 'like'];
app.post('/api/test/emit', (req, res) => {
  const { type, data } = req.body || {};
  if (!TEST_EVENTS.includes(type)) return res.status(400).json({ success: false, error: 'Loại sự kiện không hợp lệ' });
  const event = { timestamp: Date.now(), avatar: '', ...(data || {}) };
  if (type === 'like') {
    liveStats.totalLikes += Number(event.likeCount) || 1;
    event.totalLikes = liveStats.totalLikes;
  }
  broadcast(type, event);
  res.json({ success: true });
});

// ---------- Giọng đọc ----------
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function splitText(text: string, max = 190): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const win = rest.slice(0, max + 1);
    let cut = Math.max(win.lastIndexOf('. '), win.lastIndexOf('! '), win.lastIndexOf('? '));
    if (cut < max / 2) cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '));
    if (cut < max / 2) cut = win.lastIndexOf(' ');
    if (cut <= 0) cut = max - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// hype = câu hô của MC ("Hoan hô!", "Ối dồi ôi!"): chỉ to hơn, giữ nguyên cao độ (đổi cao độ nghe như người khác nói)
// Edge chặn (lỗi 429) khi mở nhiều kết nối một lúc: cho đi từng câu một, câu giống nhau đang tạo thì dùng chung,
// bị chặn thì chờ rồi thử lại, hết cách mới sang giọng dự phòng.
let edgeChain: Promise<unknown> = Promise.resolve();
const edgeInflight = new Map<string, Promise<Buffer>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function edgeTts(text: string, rate: number, hype = false, voiceName = TTS_VOICE): Promise<Buffer> {
  const key = `${voiceName}|${rate}|${hype}|${text}`;
  const running = edgeInflight.get(key);
  if (running) return running;
  const job = edgeChain.then(async () => {
    let last: unknown;
    for (const wait of [0, 2000, 5000, 10000]) {
      if (wait) await sleep(wait);
      try {
        return await edgeTtsOnce(text, rate, hype, voiceName);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  });
  edgeChain = job.catch(() => {});
  edgeInflight.set(key, job);
  job.finally(() => edgeInflight.delete(key)).catch(() => {});
  return job;
}

async function edgeTtsOnce(text: string, rate: number, hype = false, voiceName = TTS_VOICE): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text), {
      rate: `${rate >= 1 ? '+' : ''}${Math.round((rate - 1) * 100)}%`,
      pitch: TTS_PITCH,
      volume: hype ? '+40%' : '+0%',
    });
    const chunks: Buffer[] = [];
    const read = (async () => {
      for await (const c of audioStream) chunks.push(c as Buffer);
    })();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Edge TTS timeout')), 20000));
    await Promise.race([read, timeout]);
    if (chunks.length === 0) throw new Error('Edge TTS không trả âm thanh');
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
}

async function googleTts(text: string, lang = 'vi'): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const chunk of splitText(text)) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://translate.google.com/',
      },
    });
    if (!r.ok) throw new Error(`Google TTS lỗi ${r.status}`);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

const ttsCache = new Map<string, Buffer>();
app.get('/api/tts', async (req, res) => {
  try {
    const text = String(req.query.text || '').trim().slice(0, 1500);
    if (!text) return res.status(400).send('Thiếu text');
    const rate = Math.min(1.5, Math.max(0.5, Number(req.query.rate) || 1));
    const hype = req.query.hype === '1';
    // 2 MC: nam (mặc định) và nữ, thêm giọng tiếng Anh để đọc từ tiếng Anh cho chuẩn.
    // Chỉ nhận các giọng này, không cho truyền tên giọng tuỳ ý.
    const voiceName = req.query.v === 'f' ? 'vi-VN-HoaiMyNeural' : req.query.v === 'en' ? 'en-US-AnaNeural' : TTS_VOICE;
    const key = `${voiceName}|${rate}|${hype}|${text}`;
    let audio = ttsCache.get(key);
    let fallback = false;
    if (!audio) {
      const english = req.query.v === 'en';
      try {
        audio = await edgeTts(text, rate, hype, voiceName); // đã tự thử lại 4 lần bên trong
      } catch (err) {
        // giọng dự phòng phải ĐÚNG ngôn ngữ: từ tiếng Anh dùng Google tiếng Anh, Google cũng lỗi thì bỏ câu (không đọc sai)
        console.warn(`[giọng dự phòng] Edge lỗi 4 lần (${voiceName}), đọc bằng Google ${english ? 'tiếng Anh' : 'tiếng Việt'}: "${text.slice(0, 60)}"`, err instanceof Error ? err.message : err);
        audio = await googleTts(text, english ? 'en' : 'vi');
        fallback = true;
      }
      // giọng dự phòng không lưu: lần sau đọc lại câu này thì thử Edge trước
      if (!fallback) ttsCache.set(key, audio);
      if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value!);
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', fallback ? 'no-store' : 'public, max-age=86400');
    res.send(audio);
  } catch (err) {
    console.error('TTS lỗi:', err);
    res.status(500).json({ error: 'TTS failed' });
  }
});

// ---------- API riêng của game: thêm bên dưới ----------

// Trang stage (nơi chạy game thật) gửi ảnh chụp trạng thái lên; trang điều khiển xem trước đúng y như vậy
app.post('/api/game/state', (req, res) => {
  broadcast('gamestate', req.body);
  if (typeof req.body?.phase === 'string') stagePhase = req.body.phase.slice(0, 20);
  res.json({ success: true });
});

// Sổ lớp lưu ra file (tắt máy vẫn còn): câu nào hỏi lúc nào + bảng vàng tuần
// DATA_DIR: chạy thử ở thư mục khác để khỏi lẫn tên giả vào sổ lớp thật
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'so-lop.json');
interface SoLop {
  used: Record<string, number>; // id câu -> lần hỏi gần nhất (ms)
  week: string; // tuần đang tính, vd "2026-W45"
  scores: Record<string, { nickname: string; points: number }>;
  // câu chủ kênh bấm "Bỏ câu này": không hỏi lại. Sửa câu trong file (đổi đáp án) là thành câu mới, tự hết bị bỏ
  banned: Record<string, { answer: string; clue: string; at: number }>;
  // chuyên cần: ngày gần nhất vào lớp, số ngày liền, tổng số ngày
  attend: Record<string, { nickname: string; last: string; streak: number; total: number }>;
  // điểm hôm nay (cho báo cáo buổi live) + tương tác hôm nay (bảng Top tương tác)
  today: { date: string; scores: Record<string, { nickname: string; points: number }>; talk?: Record<string, { nickname: string; points: number }>; flowers?: number; talkRoom?: string };
  // học bạ cả đời: điểm cộng dồn mãi (lên lớp) + số câu đúng từng loại (huy hiệu)
  life: Record<string, LifeRow>;
}
type LifeRow = { nickname: string; points: number; total: number; toan: number; su: number; meo: number; anh: number };
const LIFE_KEYS = ['points', 'total', 'toan', 'su', 'meo', 'anh'] as const;
// ngày theo giờ máy (Việt Nam), vd "2026-11-04"
const dayKey = (d = new Date()) => d.toLocaleDateString('sv');
const weekKey = (d = new Date()) => {
  // tuần ISO (bắt đầu thứ hai)
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
};
let soLop: SoLop = { used: {}, week: weekKey(), scores: {}, banned: {}, attend: {}, today: { date: dayKey(), scores: {} }, life: {} };
try {
  soLop = { ...soLop, ...JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')) };
} catch {
  // chưa có sổ: bắt đầu mới
}
const weekTop = () => {
  if (soLop.week !== weekKey()) soLop = { ...soLop, week: weekKey(), scores: {} }; // sang tuần mới: xoá điểm tuần cũ
  return Object.entries(soLop.scores)
    .map(([username, v]) => ({ username, ...v }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
};
// tên TikTok có thể là "__proto__": không cho làm khoá, tránh phá object sổ lớp
const safeKey = (k: string) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
const writeSoLop = () => {
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(soLop));
  } catch (err) {
    console.error('Không lưu được sổ lớp:', err);
  }
};
// nhiều bạn vào lớp cùng lúc: gom lại 2 giây mới ghi file 1 lần
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const saveSoon = () => {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    writeSoLop();
  }, 2000);
};
const todayScores = () => {
  if (soLop.today.date !== dayKey()) soLop.today = { date: dayKey(), scores: {}, talk: {}, flowers: 0 };
  return soLop.today.scores;
};
// Top tương tác làm lại mỗi phiên live mới (chủ kênh chốt 2026-11-05): mỗi buổi live TikTok có mã phòng riêng,
// mã phòng đổi thì xoá điểm tương tác. Rớt mạng tự nối lại vào cùng buổi live (cùng mã phòng) thì giữ nguyên.
function newLiveRoom(roomId: string) {
  if (!roomId) return;
  todayScores();
  if (soLop.today.talkRoom === roomId) return;
  soLop.today.talkRoom = roomId;
  soLop.today.talk = {};
  console.log(`[Top tương tác] phiên live mới ${roomId}: làm lại bảng`);
  writeSoLop();
}
const todayTalk = () => {
  todayScores(); // sang ngày mới thì xoá cả tương tác
  return (soLop.today.talk ??= {});
};
const addScore = (book: Record<string, { nickname: string; points: number }>, key: string, nickname: unknown, points: number) => {
  const cur = Object.hasOwn(book, key) ? book[key] : { nickname: '', points: 0 };
  cur.nickname = String(nickname || cur.nickname).slice(0, 60);
  cur.points += points;
  book[key] = cur;
};

// Báo cáo buổi live: mỗi ngày 1 file data/bao-cao/<ngày>.json, ghi từng câu đã hỏi
const REPORT_DIR = path.join(DATA_DIR, 'bao-cao');
type ReportRow = { id: string; answer: string; category: string; attempts: number; correct: number; at: number };
const readReport = (day: string): ReportRow[] => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${day}.json`), 'utf8'));
  } catch {
    return [];
  }
};

// top điểm hôm nay (bảng Học sinh xuất sắc hôm nay ở góc trái stage)
const topOf = (book: Record<string, { nickname: string; points: number }>) =>
  Object.entries(book)
    .map(([username, v]) => ({ username, ...v }))
    .sort((x, y) => y.points - x.points)
    .slice(0, 10);
const todayTop = () => topOf(todayScores());
// top tương tác hôm nay (bảng Top tương tác bên phải stage)
const talkTop = () => topOf(todayTalk());
// quỹ hoa của cô hôm nay (số bông, mỗi xu quà = 1 bông)
const flowersToday = () => {
  todayScores();
  return soLop.today.flowers ?? 0;
};
const lifeOf = (key: string): LifeRow => (Object.hasOwn(soLop.life, key) ? soLop.life[key] : { nickname: '', points: 0, total: 0, toan: 0, su: 0, meo: 0, anh: 0 });
app.get('/api/game/save', (_req, res) =>
  res.json({ used: soLop.used, banned: Object.keys(soLop.banned), weekTop: weekTop(), todayTop: todayTop(), talkTop: talkTop(), flowersToday: flowersToday() }),
);
app.post('/api/game/save', (req, res) => {
  const { used, week, banned, report, life, talk, flowers } = req.body || {};
  if (typeof flowers === 'number' && Number.isFinite(flowers) && flowers > 0) {
    todayScores();
    soLop.today.flowers = (soLop.today.flowers ?? 0) + Math.min(1_000_000, Math.round(flowers));
  }
  // học bạ cả đời: cộng phần mới
  if (Array.isArray(life)) {
    for (const e of life.slice(0, 2000)) {
      if (!e || typeof e.username !== 'string') continue;
      const key = e.username.slice(0, 100);
      if (!safeKey(key)) continue;
      const cur = lifeOf(key);
      cur.nickname = String(e.nickname || cur.nickname).slice(0, 60);
      for (const k of LIFE_KEYS) cur[k] += Math.max(0, Math.min(5000, Math.round(Number(e[k]) || 0)));
      soLop.life[key] = cur;
    }
  }
  // tương tác hôm nay
  if (Array.isArray(talk)) {
    for (const e of talk.slice(0, 5000)) {
      if (!e || typeof e.username !== 'string' || !safeKey(e.username.slice(0, 100))) continue;
      addScore(todayTalk(), e.username.slice(0, 100), e.nickname, Math.max(0, Math.min(10_000, Math.round(Number(e.points) || 0))));
    }
  }
  weekTop();
  if (Array.isArray(used)) for (const id of used.slice(0, 500)) if (typeof id === 'string' && safeKey(id)) soLop.used[id.slice(0, 200)] = Date.now();
  if (Array.isArray(week)) {
    for (const e of week.slice(0, 2000)) {
      if (!e || typeof e.username !== 'string' || typeof e.points !== 'number' || !Number.isFinite(e.points)) continue;
      const key = e.username.slice(0, 100);
      if (!safeKey(key)) continue;
      const pts = Math.max(0, Math.min(1000, Math.round(e.points)));
      addScore(soLop.scores, key, e.nickname, pts);
      addScore(todayScores(), key, e.nickname, pts);
    }
  }
  if (Array.isArray(banned)) {
    for (const b of banned.slice(0, 50)) {
      if (!b || typeof b.id !== 'string' || !safeKey(b.id)) continue;
      soLop.banned[b.id.slice(0, 200)] = { answer: String(b.answer ?? '').slice(0, 60), clue: String(b.clue ?? '').slice(0, 300), at: Date.now() };
    }
  }
  if (Array.isArray(report) && report.length) {
    const rows: ReportRow[] = report
      .slice(0, 200)
      .filter((r) => r && typeof r.id === 'string')
      .map((r) => ({
        id: r.id.slice(0, 200),
        answer: String(r.answer ?? '').slice(0, 60),
        category: String(r.category ?? '').slice(0, 80),
        attempts: Math.max(0, Number(r.attempts) || 0),
        correct: Math.max(0, Number(r.correct) || 0),
        at: Number(r.at) || Date.now(),
      }));
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(REPORT_DIR, `${dayKey()}.json`), JSON.stringify([...readReport(dayKey()), ...rows]));
    } catch (err) {
      console.error('Không lưu được báo cáo:', err);
    }
  }
  writeSoLop();
  res.json({ weekTop: weekTop(), todayTop: todayTop(), talkTop: talkTop(), flowersToday: flowersToday() });
});

// Chuyên cần: trang stage báo mỗi bạn lần đầu bình luận trong buổi, server trả về số ngày đi học liền
app.post('/api/game/attend', (req, res) => {
  const { username, nickname } = req.body || {};
  if (typeof username !== 'string' || !safeKey(username.slice(0, 100))) return res.status(400).json({ days: 0 });
  const key = username.slice(0, 100);
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  const cur = Object.hasOwn(soLop.attend, key) ? soLop.attend[key] : { nickname: '', last: '', streak: 0, total: 0 };
  if (cur.last !== today) {
    cur.streak = cur.last === yesterday ? cur.streak + 1 : 1;
    cur.total++;
    cur.last = today;
  }
  cur.nickname = String(nickname || cur.nickname).slice(0, 60);
  soLop.attend[key] = cur;
  saveSoon();
  // kèm học bạ cả đời để game biết bạn này đang học lớp mấy
  const { nickname: _n, ...life } = lifeOf(key);
  res.json({ days: cur.streak, total: cur.total, life });
});

// Người xem theo từng phần của game: cứ 15 giây ghi (giờ, phần đang chạy, số người xem) vào data/bao-cao/<ngày>-xem.json.
// Trang báo cáo tính mỗi phần người xem tăng hay giảm bao nhiêu mỗi phút, để biết phần nào làm khách rời live.
let stagePhase = '';
type ViewSample = { at: number; phase: string; viewers: number };
const viewFile = (day: string) => path.join(REPORT_DIR, `${day}-xem.json`);
const readViews = (day: string): ViewSample[] => {
  try {
    return JSON.parse(fs.readFileSync(viewFile(day), 'utf8'));
  } catch {
    return [];
  }
};
let viewSamples: { day: string; rows: ViewSample[] } = { day: '', rows: [] };
setInterval(() => {
  if (!stagePhase || liveStats.viewerCount <= 0) return;
  const day = dayKey();
  if (viewSamples.day !== day) viewSamples = { day, rows: readViews(day) };
  viewSamples.rows.push({ at: Date.now(), phase: stagePhase, viewers: liveStats.viewerCount });
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(viewFile(day), JSON.stringify(viewSamples.rows));
  } catch (err) {
    console.error('Không lưu được số người xem:', err);
  }
}, 15_000);
const PHASE_NAME: Record<string, string> = {
  team: 'Chọn tổ', intro: 'Giới thiệu tiết', question: 'Đang trả lời', bonus: 'Thêm giờ (mở chữ)', reveal: 'Hiện đáp án',
  praise: 'Điểm danh giữa tiết', results: 'Tổng kết tiết', recess: 'Ra chơi', vote: 'Bình chọn chủ đề', show: 'Game lớn',
};
/** mỗi phần: tổng thời gian, người xem trung bình, người xem thay đổi mỗi phút (âm = khách rời đi) */
const viewStats = (rows: ViewSample[]) => {
  const by = new Map<string, { n: number; sum: number; delta: number; ms: number }>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const b = by.get(r.phase) ?? { n: 0, sum: 0, delta: 0, ms: 0 };
    b.n++;
    b.sum += r.viewers;
    const next = rows[i + 1];
    // chỉ tính khoảng liền nhau (dưới 1 phút), tắt live rồi bật lại thì bỏ
    if (next && next.at - r.at < 60_000) {
      b.delta += next.viewers - r.viewers;
      b.ms += next.at - r.at;
    }
    by.set(r.phase, b);
  }
  return [...by].map(([phase, b]) => ({ phase, minutes: b.ms / 60_000, avg: b.sum / b.n, perMin: b.ms ? (b.delta / b.ms) * 60_000 : 0 })).sort((a, b) => a.perMin - b.perMin);
};

// Trang báo cáo sau buổi live: http://localhost:3006/bao-cao (thêm ?ngay=2026-11-04 để xem ngày khác)
app.get('/bao-cao', (req, res) => {
  const day = typeof req.query.ngay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ngay) ? req.query.ngay : dayKey();
  const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = readReport(day);
  const words = rows.filter((r) => r.category !== 'Toán nhẩm');
  // ít nhất 3 bạn thử mà không ai đúng (câu bị bấm qua, không ai gõ thì không tính)
  const hard = words.filter((r) => r.correct === 0 && r.attempts >= 3).sort((a, b) => b.attempts - a.attempts);
  const easy = words.filter((r) => r.attempts >= 5 && r.correct / r.attempts >= 0.9);
  const attended = Object.entries(soLop.attend).filter(([, a]) => a.last === day);
  const top = day === soLop.today.date ? Object.entries(soLop.today.scores).sort((a, b) => b[1].points - a[1].points).slice(0, 15) : [];
  const loyal = attended.sort((a, b) => b[1].streak - a[1].streak).slice(0, 15);
  const banned = Object.entries(soLop.banned).sort((a, b) => b[1].at - a[1].at);
  const views = viewStats(day === viewSamples.day ? viewSamples.rows : readViews(day));
  const list = (items: string[], empty: string) => (items.length ? `<ol>${items.map((i) => `<li>${i}</li>`).join('')}</ol>` : `<p class="muted">${empty}</p>`);
  res.type('html').send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Báo cáo Lớp Học Chữ ${esc(day)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px;background:#fdf8ec;color:#3b2a14}
h1{margin:0 0 4px}h2{margin-top:28px;border-bottom:2px solid #e9d8a6;padding-bottom:4px}.muted{color:#8a7350}
.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{background:#fff;border-radius:12px;padding:10px 16px;box-shadow:0 1px 3px #0002}
.stat b{display:block;font-size:28px}li{margin:4px 0}code{background:#f3e9cf;padding:1px 5px;border-radius:4px}</style></head><body>
<h1>📊 Báo cáo buổi live</h1><div class="muted">Ngày ${esc(day)} · đổi ngày: thêm <code>?ngay=YYYY-MM-DD</code> vào link</div>
<div class="stats" style="margin-top:12px">
<div class="stat"><b>${rows.length}</b>câu đã hỏi</div>
<div class="stat"><b>${attended.length}</b>bạn vào lớp</div>
<div class="stat"><b>${hard.length}</b>câu không ai đúng</div>
<div class="stat"><b>${easy.length}</b>câu quá dễ</div></div>
<h2>👀 Người xem theo từng phần</h2><p class="muted">Số người xem tăng (+) hay giảm (−) trung bình mỗi phút trong từng phần. Phần giảm nhiều nhất ở trên cùng: đó là chỗ khách rời live. Cứ 15 giây ghi 1 lần, chỉ lúc đã kết nối TikTok.</p>
${views.length ? `<table style="border-collapse:collapse;width:100%;background:#fff;border-radius:12px"><tr style="text-align:left"><th style="padding:6px">Phần</th><th>Thời gian</th><th>Xem TB</th><th>Thay đổi / phút</th></tr>${views
  .map((r) => `<tr style="border-top:1px solid #eee"><td style="padding:6px">${esc(PHASE_NAME[r.phase] ?? r.phase)}</td><td>${r.minutes.toFixed(0)} phút</td><td>${r.avg.toFixed(0)}</td><td style="color:${r.perMin < 0 ? '#b91c1c' : '#15803d'};font-weight:700">${r.perMin > 0 ? '+' : ''}${r.perMin.toFixed(1)}</td></tr>`)
  .join('')}</table>` : '<p class="muted">Chưa có số liệu (chưa kết nối TikTok hôm nay).</p>'}
<h2>❌ Câu không ai trả lời đúng</h2><p class="muted">Có nhiều bạn thử mà vẫn sai: có thể câu quá khó hoặc gợi ý chưa rõ, nên xem lại.</p>
${list(hard.map((r) => `<b>${esc(r.answer)}</b> · ${esc(r.category)} · ${r.attempts} bạn thử <code>${esc(r.id)}</code>`), 'Không có câu nào.')}
<h2>✅ Câu quá dễ (90% trở lên trả lời đúng)</h2>
${list(easy.map((r) => `<b>${esc(r.answer)}</b> · ${esc(r.category)} · ${r.correct}/${r.attempts} đúng`), 'Không có câu nào.')}
<h2>🏆 Điểm cao hôm nay</h2>
${list(top.map(([, s]) => `${esc(s.nickname)} · ${s.points} điểm`), 'Chưa có điểm (hoặc không phải hôm nay).')}
<h2>🎒 Chuyên cần (đi học nhiều ngày liền)</h2>
${list(loyal.map(([, a]) => `${esc(a.nickname)} · ${a.streak} ngày liền · tổng ${a.total} ngày`), 'Chưa có ai.')}
<h2>🚫 Câu đã bấm "Bỏ câu này"</h2><p class="muted">Sửa câu trong file <code>src/game/cau-hoi/</code> (đổi đáp án hoặc xoá dòng). Đổi đáp án là thành câu mới, game sẽ hỏi lại.</p>
${list(banned.map(([id, b]) => `<b>${esc(b.answer)}</b> · ${esc(b.clue)} <code>${esc(id)}</code>`), 'Chưa bỏ câu nào.')}
</body></html>`);
});

// ---------- Loa / VB-Cable của trang stage ----------
// Trang stage (đang được phát tiếng) báo lên: máy có những thiết bị phát nào, đang phát ra đâu.
// Trang điều khiển hiện danh sách để chọn; chọn xong gửi lệnh setAudioOut, lưu settings.json, mở lại vẫn nhớ.
let stageAudio: { outs: string[]; sink: string; at: number; secure: boolean; host: string } = { outs: [], sink: '', at: 0, secure: true, host: '' };
const audioStatus = () => ({ want: settings.audioOut || '', outs: stageAudio.outs, sink: stageAudio.sink, at: stageAudio.at, secure: stageAudio.secure, host: stageAudio.host, stages: stageIds.length });
app.post('/api/audio/state', (req, res) => {
  const b = req.body || {};
  const clean = (x: unknown) => String(x ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
  stageAudio = { outs: Array.isArray(b.outs) ? b.outs.slice(0, 40).map(clean).filter(Boolean) : [], sink: clean(b.sink), at: Date.now(), secure: b.secure !== false, host: clean(b.host).slice(0, 60) };
  broadcast('audio', audioStatus());
  res.json({ success: true });
});

// Mở trang stage thành cửa sổ Edge riêng (chỉ Windows): không thanh địa chỉ, khổ 9:16 cao bằng màn hình,
// tự phát tiếng không cần bấm, được quyền đọc tên loa (để chọn CABLE Input) mà không hiện hộp hỏi.
// Dùng cách này thì trong LIVE Studio thêm nguồn "Window capture" chọn cửa sổ này, KHÔNG thêm nguồn Link nữa.
const winStart = (...args: string[]) =>
  spawn('cmd.exe', ['/d', '/s', '/c', `"start "" ${args.map((a) => `"${a}"`).join(' ')}"`], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  }).unref();
app.post('/api/open-stage', (_req, res) => {
  if (process.platform !== 'win32') return res.json({ success: false, error: 'Chỉ mở tự động được trên Windows. Mở tay: http://localhost:' + PORT + '/?view=stage' });
  const ps = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height';
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 8000 }, (_err, out) => {
    const h = Math.max(480, Math.min(4000, parseInt(String(out), 10) || 960));
    const w = Math.round((h * 9) / 16);
    const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'LopHocChu', 'edge-stage');
    winStart('msedge', `--app=http://localhost:${PORT}/?view=stage`, `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required',
      // cấp quyền đọc tên loa không cần hỏi (trang stage chỉ đọc tên thiết bị, không thu âm)
      '--use-fake-ui-for-media-stream',
      '--no-first-run', '--disable-features=Translate', `--window-size=${w},${h}`, '--window-position=0,0');
  });
  res.json({ success: true });
});

// ---------- Cập nhật (bản Windows đóng gói) ----------
// version.txt do pack/build-windows.sh ghi cạnh server.mjs; chạy từ mã nguồn thì không có -> 'dev', không tự cập nhật.
// Bấm "Cập nhật ngay": tải zip mới nhất trên GitHub Releases, kiểm SHA-256, giải nén bằng PowerShell, chép đè
// dist/, public/assets/, server.mjs, version.txt rồi thoát mã 42 để Mo-Lop-Hoc-Chu.bat bật server mới ngay.
// Giữ nguyên: node/, file .bat (cmd đang đọc dở), data/ (sổ lớp), settings.json, nhạc nền trong public/assets/audio.
const VERSION = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
})();
const UPDATE_REPO = process.env.UPDATE_REPO || 'tobi1008/lop-hoc-chu';
let latest: { version: string; url: string; sha256: string; notes: string } | null = null;
let updating = false;
let updateMsg = '';
const isNewer = (a: string, b: string) => {
  const n = (v: string) => String(v).replace(/^v/, '').split(/[.-]/).map((x) => +x || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const updateStatus = () => ({
  current: VERSION,
  latest: latest?.version || null,
  notes: latest?.notes || '',
  available: !!latest && VERSION !== 'dev' && isNewer(latest.version, VERSION),
  canInstall: process.platform === 'win32' && VERSION !== 'dev',
  updating,
  message: updateMsg,
});
const sendUpdate = (message?: string) => {
  if (message !== undefined) updateMsg = message;
  broadcast('update', updateStatus());
};
async function checkUpdate() {
  sendUpdate('Đang kiểm tra…');
  try {
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'lop-hoc-chu-live', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(r.status === 404 ? 'chưa có bản phát hành nào' : 'GitHub trả về ' + r.status);
    const rel = (await r.json()) as { tag_name: string; body?: string; assets?: { name: string; browser_download_url: string; digest?: string }[] };
    const asset = rel.assets?.find((a) => /windows-x64\.zip$/.test(a.name));
    if (!asset) throw new Error('bản phát hành không có file zip Windows');
    latest = {
      version: rel.tag_name.replace(/^v/, ''),
      url: asset.browser_download_url,
      sha256: asset.digest?.replace(/^sha256:/, '') || '',
      notes: String(rel.body || '').slice(0, 2000),
    };
    const st = updateStatus();
    sendUpdate(st.available ? '' : VERSION === 'dev' ? 'Đang chạy từ mã nguồn: cập nhật bằng git pull' : 'Đang dùng bản mới nhất');
  } catch (e) {
    sendUpdate('Không kiểm tra được cập nhật: ' + (e instanceof Error ? e.message : e));
  }
}
async function installUpdate() {
  if (updating) return;
  if (process.platform !== 'win32' || VERSION === 'dev') return sendUpdate('Chỉ tự cập nhật được trên bản Windows đóng gói');
  if (!latest || !isNewer(latest.version, VERSION)) return sendUpdate('Đang dùng bản mới nhất');
  updating = true;
  sendUpdate(`Đang tải bản ${latest.version}…`);
  console.log(`[cập nhật] Đang tải bản ${latest.version}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lophocchu-'));
  try {
    const r = await fetch(latest.url, { headers: { 'User-Agent': 'lop-hoc-chu-live' }, signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error('tải về lỗi ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (latest.sha256 && createHash('sha256').update(buf).digest('hex') !== latest.sha256) throw new Error('file tải về bị lỗi (SHA-256 không khớp)');
    const zip = path.join(tmp, 'update.zip');
    fs.writeFileSync(zip, buf);
    sendUpdate('Đang giải nén…');
    await new Promise<void>((ok, fail) =>
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:LHC_ZIP -DestinationPath $env:LHC_OUT -Force'],
        { windowsHide: true, timeout: 180_000, env: { ...process.env, LHC_ZIP: zip, LHC_OUT: path.join(tmp, 'x') } },
        (e) => (e ? fail(new Error('giải nén lỗi: ' + e.message)) : ok()),
      ),
    );
    const src = path.join(tmp, 'x', 'LopHocChu');
    if (!fs.existsSync(path.join(src, 'server.mjs')) || !fs.existsSync(path.join(src, 'dist', 'index.html'))) throw new Error('file zip không đúng cấu trúc');
    // dist: xoá bản cũ (tên file js có mã băm, không xoá thì rác dồn mãi)
    fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true });
    fs.cpSync(path.join(src, 'dist'), path.join(__dirname, 'dist'), { recursive: true, force: true });
    fs.cpSync(path.join(src, 'public', 'assets'), path.join(__dirname, 'public', 'assets'), { recursive: true, force: true });
    for (const f of ['server.mjs', 'version.txt', 'HUONG-DAN.txt', 'LICENSE.txt', 'THIRD-PARTY-LICENSES.txt'])
      if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(__dirname, f));
    writeSoLop();
    sendUpdate(`Đã cập nhật lên bản ${latest.version}, đang khởi động lại…`);
    console.log(`[cập nhật] Xong bản ${latest.version}, khởi động lại`);
    setTimeout(() => process.exit(42), 500);
  } catch (e) {
    updating = false;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[cập nhật] Thất bại:', msg);
    sendUpdate('Cập nhật thất bại: ' + msg);
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}
app.post('/api/update/check', (_req, res) => {
  void checkUpdate();
  res.json({ success: true });
});
app.post('/api/update/install', (_req, res) => {
  void installUpdate();
  res.json({ success: true });
});

// ---------- Khởi động ----------
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      // LIVE_MODE=1 (BAT-LIVE.bat): tắt tự tải lại, sửa code không làm trang stage reset giữa live
      // Live: tắt hẳn kênh tự tải lại (ws) để không đụng cổng 24678 của game khác đang chạy.
      // Lúc sửa code: cổng riêng 24682 cho kênh tự tải lại (Đi Chùa 24678, Cưới Liền Tay 24680).
      server:
        process.env.LIVE_MODE === '1'
          ? { middlewareMode: true, hmr: false, ws: false }
          : { middlewareMode: true, hmr: { port: 24682 } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
  }

  // Chỉ nghe trên máy này: API không có đăng nhập, người cùng Wi-Fi không được điều khiển giọng đọc
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server chạy ở http://localhost:${PORT}  |  Link LIVE Studio: http://lvh.me:${PORT}/?view=stage  |  Phiên bản ${VERSION}`);
    if (VERSION !== 'dev') setTimeout(() => void checkUpdate(), 5000);
    // lần trước đang kết nối mà server bị tắt / bật lại: tự kết nối lại tài khoản đó
    if (wantUser && !process.env.DATA_DIR) {
      console.log(`[TikTok] Tự kết nối lại @${wantUser} (lần trước đang kết nối)`);
      connectTikTok(wantUser).catch((err) => scheduleReconnect(`Chưa kết nối được (${err instanceof Error ? err.message : err})`));
    }
  });
}

start();
