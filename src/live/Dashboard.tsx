import { useEffect, useState, type ReactNode } from 'react';
import type { LiveStatus } from './types';
import { emitTest, sendControl } from './page';

const FAKE_NAMES = ['Lan Anh', 'Minh Tuấn', 'Bé Na 🌸', 'Hoàng Long', 'Thu Trang', 'Quốc Bảo', 'duyanh99', '𝑵𝒈𝒐̣𝒄 𝑨𝒏𝒉'];
const pick = () => {
  const nickname = FAKE_NAMES[Math.floor(Math.random() * FAKE_NAMES.length)];
  return { nickname, username: nickname.normalize('NFKD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'khach' };
};

/**
 * Trang điều khiển (http://localhost:3006). Im lặng, không phát tiếng.
 * - Kết nối phòng live
 * - Gõ câu cho giọng đọc trên stage
 * - Nút giả lập sự kiện để test khi chưa live
 * `preview`: bản xem trước của stage (im lặng)
 */
export function Dashboard({
  status,
  channelName,
  preview,
  extra,
}: {
  status: LiveStatus | null;
  channelName: string;
  preview: ReactNode;
  extra?: ReactNode;
}) {
  const [user, setUser] = useState(() => localStorageGet('tiktokUser'));
  const [nameText, setNameText] = useState('');
  const [msg, setMsg] = useState('');
  const [speakText, setSpeakText] = useState('');
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setMsg('');
    localStorageSet('tiktokUser', user);
    try {
      const r = await fetch('/api/tiktok/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user }),
      }).then((x) => x.json());
      setMsg(r.success ? 'Đã kết nối' : r.error);
    } catch (e) {
      setMsg(String(e));
    }
    setBusy(false);
  };

  const disconnect = () => fetch('/api/tiktok/disconnect', { method: 'POST' });

  const speak = async () => {
    const r = await sendControl('speak', speakText);
    setMsg(r.pages > 1 ? `Đã gửi (đang mở ${r.pages} trang)` : 'Đã gửi');
    setSpeakText('');
  };

  const saveName = async () => {
    const r = await sendControl('setName', nameText);
    setMsg(r.success ? `Đã lưu tên lớp: ${nameText.trim()}` : r.error);
    if (r.success) setNameText('');
  };

  return (
    // Gọn trong 1 màn hình: cột trái là nút (tự cuộn nếu thiếu chỗ), cột phải là bản xem trước cao bằng màn hình
    <div className="h-screen overflow-hidden bg-slate-950 p-3 text-sm text-slate-100">
      <div className="mx-auto flex h-full max-w-[1500px] gap-3">
        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <Card title="Kết nối TikTok LIVE">
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg bg-slate-800 px-3 py-1.5"
                placeholder="username TikTok (không cần @)"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && user.trim() && connect()}
              />
              <Btn onClick={connect} disabled={busy || !user.trim()}>
                {busy ? 'Đang nối...' : 'Kết nối'}
              </Btn>
              <Btn onClick={disconnect} tone="ghost">
                Ngắt
              </Btn>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 text-xs">
              {status?.isConnected ? (
                <span className="text-emerald-400">
                  ● Đang live @{status.username} · {status.viewerCount} người xem · {status.totalLikes} tim
                </span>
              ) : status?.isConnecting ? (
                <span className="text-amber-400">● Đang kết nối...</span>
              ) : (
                <span className="text-slate-400">● Chưa kết nối</span>
              )}
              <span className="text-slate-500">
                LIVE Studio: <b className="text-slate-300">http://lvh.me:{window.location.port || 80}/?view=stage</b> · 1080×1920
              </span>
            </div>
            {(msg || status?.error) && <div className="mt-1 text-xs text-amber-300">{msg || status?.error}</div>}
          </Card>

          <Card title="Giọng đọc trên stage">
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg bg-slate-800 px-3 py-1.5"
                placeholder="Gõ câu muốn MC đọc ngay..."
                value={speakText}
                onChange={(e) => setSpeakText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && speakText.trim() && speak()}
              />
              <Btn onClick={speak} disabled={!speakText.trim()}>
                Đọc ngay
              </Btn>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <RateSlider />
              <span className="ml-2 text-slate-400">Tên lớp</span>
              <input
                className="w-32 rounded-lg bg-slate-800 px-2 py-1"
                placeholder={channelName}
                maxLength={40}
                value={nameText}
                onChange={(e) => setNameText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && nameText.trim() && saveName()}
              />
              <Btn tone="ghost" onClick={saveName} disabled={!nameText.trim()}>
                Lưu
              </Btn>
              <span className="flex-1" />
              <Btn tone="danger" onClick={() => confirmReset()}>
                Reset game
              </Btn>
            </div>
          </Card>

          <AudioCard />

          {extra}

          <UpdateCard />

          <details className="rounded-2xl bg-slate-900 p-3 ring-1 ring-slate-800">
            <summary className="cursor-pointer font-semibold">Giả lập chung (người vào, follow, combo quà...)</summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Btn tone="ghost" onClick={() => emitTest('member', pick())}>
                👋 Người vào
              </Btn>
              <Btn tone="ghost" onClick={() => emitTest('chat', { ...pick(), comment: 'Live hay quá' })}>
                💬 Comment
              </Btn>
              <Btn tone="ghost" onClick={() => emitTest('chat', { ...pick(), comment: 'mong mai thi được điểm cao' })}>
                🙏 Cầu chúc
              </Btn>
              <Btn tone="ghost" onClick={() => comboSameUser()}>
                🔁 1 người tặng 3 lần liền
              </Btn>
              <Btn tone="ghost" onClick={() => emitTest('follow', pick())}>
                ➕ Follow
              </Btn>
            </div>
            <p className="mt-2 text-xs text-slate-500">Sự kiện giả đi tới mọi trang đang mở, kể cả stage trong LIVE Studio.</p>
          </details>
        </div>

        <div className="flex flex-none flex-col items-center">
          <div className="mb-1 text-xs text-slate-400">Xem trước (im lặng)</div>
          <div className="overflow-hidden rounded-2xl ring-1 ring-slate-700">{preview}</div>
        </div>
      </div>
    </div>
  );
}

// Cùng 1 người tặng 3 lần cách nhau 1 giây: chỉ được cảm ơn 1 lần
function comboSameUser() {
  const who = pick();
  for (let i = 0; i < 3; i++) {
    setTimeout(() => emitTest('gift', { ...who, giftName: 'Hoa hồng', giftId: 5655, diamondCount: 1, repeatCount: 1 }), i * 1000);
  }
}

function confirmReset() {
  // không dùng window.confirm để tránh hộp thoại chặn
  void sendControl('reset');
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-slate-900 p-3 ring-1 ring-slate-800">
      <h2 className="mb-2 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  tone = 'primary',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'ghost' | 'danger';
}) {
  const cls = {
    primary: 'bg-amber-500 text-slate-950 hover:bg-amber-400',
    ghost: 'bg-slate-800 hover:bg-slate-700',
    danger: 'bg-rose-700 hover:bg-rose-600',
  }[tone];
  return (
    <button onClick={onClick} disabled={disabled} className={`rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 ${cls}`}>
      {children}
    </button>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // bỏ qua
  }
}

// Tốc độ giọng MC: kéo là gửi sang trang stage, stage nhớ mức đã chỉnh
function RateSlider() {
  const [rate, setRate] = useState(() => {
    try {
      return Number(localStorage.getItem('voice-rate')) || 1.0;
    } catch {
      return 1.0;
    }
  });
  const change = (r: number) => {
    setRate(r);
    try {
      localStorage.setItem('voice-rate', String(r));
    } catch {
      // bỏ qua
    }
    void sendControl('setRate', String(r));
  };
  return (
    <label className="flex items-center gap-1.5 text-slate-400">
      Tốc độ giọng
      <input type="range" min={0.8} max={1.5} step={0.05} value={rate} onChange={(e) => change(Number(e.target.value))} className="w-28 accent-amber-500" />
      <b className="w-10 text-slate-200">{rate.toFixed(2)}×</b>
    </label>
  );
}

// Nghe 1 loại sự kiện từ server (kết nối riêng, tự nối lại khi server khởi động lại)
function useServerEvent<T>(name: string) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let src: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      src = new EventSource('/api/tiktok/events');
      src.addEventListener(name, (e) => {
        try {
          setData(JSON.parse((e as MessageEvent).data));
        } catch {
          // bỏ qua
        }
      });
      src.onerror = () => {
        src?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      src?.close();
    };
  }, [name]);
  return data;
}

const post = (url: string) => fetch(url, { method: 'POST' }).then((r) => r.json()).catch(() => ({ success: false, error: 'Không gọi được server' }));

// Loa / VB-Cable: chọn nơi trang stage phát tiếng (giống game Chánh Điện)
function AudioCard() {
  const a = useServerEvent<{ want: string; outs: string[]; sink: string; at: number; secure?: boolean; host?: string; stages: number }>('audio');
  const [msg, setMsg] = useState('');
  const want = a?.want || '';
  // thiết bị đã lưu vẫn nằm trong danh sách dù stage chưa thấy (vd chưa cắm cáp ảo)
  const names = [...new Set([...(a?.outs || []), ...(want ? [want] : [])])];
  const hasCable = names.some((n) => /cable input/i.test(n));
  const choose = (v: string) => void sendControl('setAudioOut', v);
  const openStage = async () => {
    const r = await post('/api/open-stage');
    setMsg(r.success ? 'Đã mở cửa sổ stage (Edge). Trong LIVE Studio thêm nguồn "Window capture" chọn cửa sổ đó.' : r.error);
  };
  const scan = () => {
    void sendControl('scanAudio');
    setMsg('Đang tìm thiết bị trên trang stage…');
  };
  let info: ReactNode;
  if (!a?.stages) info = <>Chưa mở trang stage nào. Mở stage trước rồi chọn loa.</>;
  else if (a.secure === false)
    info = (
      <span className="text-amber-300">
        ⚠️ Trang stage đang phát tiếng mở bằng “{a.host || 'lvh.me'}” (nguồn Link của LIVE Studio): trình duyệt không cho trang này thấy hay đổi loa, nên không tìm được VB-Cable. Bấm
        “Mở cửa sổ stage (Edge)” (mở bằng localhost), trong LIVE Studio thay nguồn Link bằng <b>Window capture</b> chọn cửa sổ đó, rồi bấm Tìm thiết bị.
      </span>
    );
  else if (want && a.sink === want) info = <span className="text-emerald-400">✅ Stage đang phát ra “{a.sink}”. Trong LIVE Studio: tắt âm thanh máy tính, chỉ giữ mic <b>CABLE Output</b>.</span>;
  else if (want) info = <span className="text-amber-300">⚠️ Stage chưa phát ra “{want}” được (chưa thấy thiết bị này). Dùng cửa sổ stage mở bằng nút bên dưới, cài VB-Cable rồi bấm Tìm thiết bị.</span>;
  else info = <>Đang phát ra loa mặc định của máy.</>;
  return (
    <Card title="Âm thanh stage (VB-Cable)">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 text-slate-400">
          Phát tiếng ra
          <select className="min-w-0 flex-1 rounded-lg bg-slate-800 px-2 py-1.5 text-slate-100" value={want} onChange={(e) => choose(e.target.value)}>
            <option value="">Loa mặc định của máy</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Btn tone="ghost" onClick={scan}>
          🔎 Tìm thiết bị
        </Btn>
        <Btn tone="ghost" onClick={openStage}>
          🪟 Mở cửa sổ stage (Edge)
        </Btn>
      </div>
      <p className="mt-2 text-xs text-slate-400">{info}</p>
      {msg && <p className="mt-1 text-xs text-amber-300">{msg}</p>}
      <p className="mt-1 text-xs text-slate-500">
        Chọn <b>CABLE Input</b> để LIVE Studio chỉ thu tiếng lớp học (xem video khác không lọt vào live). Cách dùng: bấm “Mở cửa sổ stage (Edge)”, trong LIVE Studio thêm{' '}
        <b>Window capture</b> chọn cửa sổ đó và mic <b>CABLE Output</b>, tắt âm thanh máy tính, bỏ nguồn Link cũ (2 stage = 2 giọng cô).
        {!hasCable && a?.outs?.length ? ' Chưa thấy VB-Cable: tải miễn phí ở vb-audio.com/Cable, cài xong khởi động lại máy.' : ''}
      </p>
    </Card>
  );
}

// Kiểm tra và cài bản mới ngay trong trang điều khiển (bản Windows đóng gói)
function UpdateCard() {
  const u = useServerEvent<{ current: string; latest: string | null; notes: string; available: boolean; canInstall: boolean; updating: boolean; message: string }>('update');
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 6000);
    return () => clearTimeout(t);
  }, [sure]);
  const install = () => {
    if (!sure) return setSure(true); // bấm 2 lần cho chắc, không dùng hộp thoại confirm
    setSure(false);
    void post('/api/update/install');
  };
  return (
    <Card title="Cập nhật">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">
          Đang dùng <b className="text-slate-200">{u?.current === 'dev' ? 'mã nguồn (dev)' : u?.current || '…'}</b>
          {u?.latest && <> · mới nhất trên GitHub <b className="text-slate-200">{u.latest}</b></>}
        </span>
        <span className="flex-1" />
        <Btn tone="ghost" onClick={() => void post('/api/update/check')} disabled={u?.updating}>
          🔄 Kiểm tra cập nhật
        </Btn>
        {u?.available && u.canInstall && (
          <Btn tone={sure ? 'danger' : 'primary'} onClick={install} disabled={u.updating}>
            {u.updating ? 'Đang cập nhật…' : sure ? 'Bấm lần nữa để cài' : `⬇️ Cập nhật lên ${u.latest}`}
          </Btn>
        )}
      </div>
      {u?.available && !u.canInstall && <p className="mt-2 text-xs text-amber-300">Có bản mới nhưng bản này không tự cập nhật được: tải zip mới trên GitHub.</p>}
      {u?.message && <p className="mt-2 text-xs text-amber-300">{u.message}</p>}
      {u?.available && <p className="mt-1 text-xs text-slate-500">Cài xong game tự khởi động lại vài giây, sổ lớp và cài đặt giữ nguyên, tự kết nối lại TikTok. Nên cập nhật lúc không live (tiết đang học sẽ bắt đầu lại).</p>}
      {u?.available && u.notes && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-800 p-2 text-[11px] text-slate-300">{u.notes}</pre>}
    </Card>
  );
}
