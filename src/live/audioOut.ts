/**
 * Thiết bị phát tiếng của trang stage (giọng cô, hiệu ứng, nhạc nền), giống game Chánh Điện.
 * Chọn "CABLE Input" (VB-Cable) thì LIVE Studio chỉ thu tiếng lớp học qua mic "CABLE Output",
 * xem video / nghe nhạc khác trên máy cũng không lọt vào live.
 *
 * Trình duyệt giấu tên thiết bị cho tới khi trang có quyền micro: mở micro 1 lần rồi tắt ngay, KHÔNG thu âm.
 * Cửa sổ stage mở bằng nút "Mở cửa sổ stage (Edge)" được cấp quyền này tự động.
 * Chỉ thử mở micro khi chủ kênh đã chọn thiết bị hoặc bấm "Tìm thiết bị" (để trình duyệt thường không hỏi quyền vô cớ).
 */
type Sinkable = { setSinkId?: (id: string) => Promise<void> };

class AudioOut {
  /** tên thiết bị chủ kênh chọn ('' = loa mặc định) */
  want = '';
  /** tên thiết bị đang phát thật ('' = mặc định) */
  sink = '';
  private outs: MediaDeviceInfo[] = [];
  private scanned = false;
  private ctxs = new Set<AudioContext>();
  private els = new Set<HTMLMediaElement>();
  private onChange?: () => void;

  /** gọi mỗi khi danh sách thiết bị / thiết bị đang dùng đổi (để báo về trang điều khiển) */
  listen(fn: () => void) {
    this.onChange = fn;
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.scan(this.scanned).then(() => this.apply()));
  }

  get names() {
    return this.outs.map((d) => d.label);
  }

  /** Lấy danh sách loa / thiết bị phát. askPermission: được mở micro 1 lần để đọc tên thiết bị */
  async scan(askPermission: boolean) {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    const named = async () => (await md.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.label);
    try {
      let list = await named();
      if (!list.length && askPermission && md.getUserMedia) {
        // LIVE Studio có thể không trả lời: quá 4 giây thì thôi
        const s = await Promise.race([md.getUserMedia({ audio: true }), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
        s?.getTracks().forEach((t) => t.stop());
        list = await named();
      }
      this.outs = list.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
      if (askPermission) this.scanned = true;
    } catch {
      this.outs = [];
    }
    this.onChange?.();
  }

  /** Chủ kênh chọn thiết bị (tên, '' = loa mặc định) */
  async set(name: string) {
    this.want = name;
    if (name && !this.outs.some((d) => d.label === name)) await this.scan(true);
    await this.apply();
  }

  private deviceId() {
    const d = this.want ? this.outs.find((o) => o.label === this.want) : undefined;
    return d ? d.deviceId : '';
  }

  private async apply() {
    const id = this.deviceId();
    const all: Sinkable[] = [...this.ctxs, ...this.els] as unknown as Sinkable[];
    let ok = true;
    for (const x of all) {
      try {
        await x.setSinkId?.(id);
      } catch {
        ok = false;
      }
    }
    this.sink = id && ok ? this.want : '';
    this.onChange?.();
  }

  /** AudioContext của hiệu ứng / nhạc: phát ra thiết bị đã chọn */
  ctx(c: AudioContext) {
    if (!this.ctxs.has(c)) {
      this.ctxs.add(c);
      const id = this.deviceId();
      if (id) void (c as unknown as Sinkable).setSinkId?.(id).catch(() => {});
    }
    return c;
  }

  /** Thẻ <audio> (giọng cô, file mp3 hiệu ứng): chờ đổi xong thiết bị rồi mới phát, để câu đầu không lọt ra loa */
  async el(a: HTMLMediaElement) {
    this.els.add(a);
    a.addEventListener('ended', () => this.els.delete(a), { once: true });
    a.addEventListener('error', () => this.els.delete(a), { once: true });
    if (this.els.size > 50) this.els.delete(this.els.values().next().value!);
    const id = this.deviceId();
    if (!id) return;
    try {
      await (a as unknown as Sinkable).setSinkId?.(id);
    } catch {
      // thiết bị vừa bị rút: phát ra loa mặc định
    }
  }
}

export const audioOut = new AudioOut();
