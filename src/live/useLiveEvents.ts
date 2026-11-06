import { useEffect, useRef } from 'react';
import type { LiveHandlers } from './types';
import { IS_STAGE, STAGE_ID } from './page';
import { voice } from './voice';
import { audioOut } from './audioOut';

// Trang stage báo trang điều khiển: có những loa nào, đang phát ra đâu. Chỉ trang stage đang được phát tiếng mới báo.
const reportAudio = () => {
  if (!IS_STAGE || !voice.enabled) return;
  void fetch('/api/audio/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outs: audioOut.names, sink: audioOut.sink, want: audioOut.want, secure: audioOut.secure, host: location.host }),
  }).catch(() => {});
};
if (IS_STAGE) audioOut.listen(reportAudio);

/**
 * Nghe sự kiện live từ server. Handler luôn là bản mới nhất (không lo state cũ),
 * tự kết nối lại khi rớt mạng.
 */
export function useLiveEvents(handlers: LiveHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let seenVersion = '';

    const on = (name: string, fn: (data: any) => void) =>
      source!.addEventListener(name, (e) => {
        try {
          fn(JSON.parse((e as MessageEvent).data));
        } catch (err) {
          console.warn(`Lỗi xử lý sự kiện ${name}:`, err);
        }
      });

    const connect = () => {
      source = new EventSource(IS_STAGE ? `/api/tiktok/events?stage=${STAGE_ID}` : '/api/tiktok/events');
      on('status', (d) => ref.current.onStatus?.(d));
      on('chat', (d) => ref.current.onChat?.(d));
      on('gift', (d) => ref.current.onGift?.(d));
      on('member', (d) => ref.current.onMember?.(d));
      on('follow', (d) => ref.current.onFollow?.(d));
      on('share', (d) => ref.current.onShare?.(d));
      on('like', (d) => ref.current.onLike?.(d));
      on('roomUser', (d) => ref.current.onViewers?.(d.viewerCount));
      on('control', (d) => {
        if (IS_STAGE && d.action === 'setAudioOut') void audioOut.set(d.text || '');
        if (IS_STAGE && d.action === 'scanAudio') void audioOut.scan(true).then(reportAudio);
        ref.current.onControl?.(d);
      });
      on('gamestate', (d) => ref.current.onGameState?.(d));
      // server vừa cập nhật lên bản khác: tải lại trang để chạy code mới
      on('version', (d) => {
        if (seenVersion && d.version && d.version !== seenVersion) window.location.reload();
        seenVersion = d.version || seenVersion;
      });
      on('speaker', (d) => {
        // trang stage bị trang mới hơn thay chỗ: im lặng hẳn (cả giọng lẫn nhạc)
        if (IS_STAGE) {
          const mine = d.id === STAGE_ID;
          if (!mine && voice.enabled) voice.stop();
          voice.enabled = mine;
          if (mine) reportAudio();
        }
        ref.current.onSpeaker?.(d);
      });
      source.onerror = () => {
        source?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);
}
