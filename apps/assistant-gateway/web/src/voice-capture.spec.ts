import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './voice-capture';
import type { VoiceCaptureElement } from './voice-capture';

// --- Test doubles -----------------------------------------------------------------------------

interface FakeResult {
  isFinal: boolean;
  0: { transcript: string };
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  started = false;
  onresult: ((e: { resultIndex: number; results: FakeResult[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
    this.onend?.();
  }
  abort(): void {
    this.started = false;
  }
  // Test helpers
  emit(results: Array<[string, boolean]>): void {
    this.onresult?.({
      resultIndex: 0,
      results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })),
    });
  }
  fail(error: string): void {
    this.onerror?.({ error });
  }
  endByItself(): void {
    this.started = false;
    this.onend?.();
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static supported = new Set<string>(['audio/webm;codecs=opus', 'audio/mp4']);
  static isTypeSupported(type: string): boolean {
    return FakeRecorder.supported.has(type);
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public stream: unknown,
    public options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? '';
    FakeRecorder.instances.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['abc'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const w = window as unknown as Record<string, unknown>;
const nav = navigator as unknown as Record<string, unknown>;

function make(attrs: Record<string, string> = {}): VoiceCaptureElement {
  const el = document.createElement('ag-voice-capture') as VoiceCaptureElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function mount(el: VoiceCaptureElement): VoiceCaptureElement {
  document.body.appendChild(el);
  return el;
}

function button(el: VoiceCaptureElement): HTMLButtonElement {
  return el.shadowRoot!.querySelector('button')!;
}

function liveText(el: VoiceCaptureElement): string {
  return el.shadowRoot!.querySelector('span[aria-live="polite"]')!.textContent ?? '';
}

function events(el: VoiceCaptureElement, name: string): CustomEvent[] {
  const seen: CustomEvent[] = [];
  el.addEventListener(name, (e) => seen.push(e as CustomEvent));
  return seen;
}

function stubStream() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  return { track, stream };
}

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecorder.instances = [];
  FakeRecorder.supported = new Set(['audio/webm;codecs=opus', 'audio/mp4']);
});

afterEach(() => {
  document.body.innerHTML = '';
  delete w['SpeechRecognition'];
  delete w['webkitSpeechRecognition'];
  delete w['MediaRecorder'];
  delete nav['mediaDevices'];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Browser mode -----------------------------------------------------------------------------

describe('browser mode', () => {
  beforeEach(() => {
    w['SpeechRecognition'] = FakeRecognition;
  });

  it('emits unavailable when speech recognition is missing', () => {
    delete w['SpeechRecognition'];
    const el = make();
    const seen = events(el, 'unavailable');
    mount(el);
    return Promise.resolve().then(() => {
      expect(el.state).toBe('unavailable');
      expect(seen).toHaveLength(1);
      expect(seen[0].detail).toEqual({ reason: 'unsupported' });
    });
  });

  it('falls back to webkitSpeechRecognition', () => {
    delete w['SpeechRecognition'];
    w['webkitSpeechRecognition'] = FakeRecognition;
    const el = mount(make());
    button(el).click();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(el.state).toBe('listening');
  });

  it('configures the recognizer from the attributes', () => {
    const el = mount(make({ language: 'en-GB' }));
    button(el).click();
    const rec = FakeRecognition.instances[0];
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe('en-GB');
    expect(rec.started).toBe(true);
  });

  it('defaults the language to ar-EG', () => {
    const el = mount(make());
    button(el).click();
    expect(FakeRecognition.instances[0].lang).toBe('ar-EG');
  });

  it('streams interim text and emits the final transcript on stop', () => {
    const el = mount(make());
    const interim = events(el, 'interim');
    const transcript = events(el, 'transcript');
    button(el).click();
    const rec = FakeRecognition.instances[0];

    rec.emit([['ده أحمد', false]]);
    expect(interim.at(-1)?.detail).toEqual({ text: 'ده أحمد' });
    expect(liveText(el)).toBe('ده أحمد');

    rec.emit([['ده أحمد سمير', true]]);
    button(el).click(); // stop
    expect(transcript).toHaveLength(1);
    expect(transcript[0].detail).toEqual({ text: 'ده أحمد سمير' });
    expect(el.state).toBe('idle');
    expect(liveText(el)).toBe('');
  });

  it('accumulates several final results into one transcript', () => {
    const el = mount(make());
    const transcript = events(el, 'transcript');
    button(el).click();
    const rec = FakeRecognition.instances[0];
    rec.emit([['one', true], ['two', false]]);
    rec.emit([['one', true], ['two', true], ['three', false]]);
    button(el).click();
    expect(transcript[0].detail).toEqual({ text: 'one two three' });
  });

  it('returns to idle and emits transcript when recognition ends by itself', () => {
    const el = mount(make());
    const transcript = events(el, 'transcript');
    button(el).click();
    const rec = FakeRecognition.instances[0];
    rec.emit([['ده أحمد سمير', true]]);
    rec.endByItself();
    expect(transcript).toHaveLength(1);
    expect(transcript[0].detail).toEqual({ text: 'ده أحمد سمير' });
    expect(el.state).toBe('idle');
    expect(button(el).getAttribute('aria-pressed')).toBe('false');
  });

  it('does not emit an empty transcript', () => {
    const el = mount(make());
    const transcript = events(el, 'transcript');
    button(el).click();
    FakeRecognition.instances[0].endByItself();
    expect(transcript).toHaveLength(0);
    expect(el.state).toBe('idle');
  });

  it('maps not-allowed to unavailable denied', () => {
    const el = mount(make());
    const unavailable = events(el, 'unavailable');
    const transcript = events(el, 'transcript');
    button(el).click();
    const rec = FakeRecognition.instances[0];
    rec.fail('not-allowed');
    rec.endByItself();
    expect(el.state).toBe('unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].detail).toEqual({ reason: 'denied' });
    expect(transcript).toHaveLength(0);
  });

  it('maps service-not-allowed to unavailable denied', () => {
    const el = mount(make());
    const unavailable = events(el, 'unavailable');
    button(el).click();
    FakeRecognition.instances[0].fail('service-not-allowed');
    expect(unavailable[0].detail).toEqual({ reason: 'denied' });
  });

  it.each(['no-speech', 'aborted'])('returns to idle on %s without unavailable', (error) => {
    const el = mount(make());
    const unavailable = events(el, 'unavailable');
    button(el).click();
    const rec = FakeRecognition.instances[0];
    rec.fail(error);
    rec.endByItself();
    expect(el.state).toBe('idle');
    expect(unavailable).toHaveLength(0);
  });

  it('maps other errors to unavailable error', () => {
    const el = mount(make());
    const unavailable = events(el, 'unavailable');
    button(el).click();
    FakeRecognition.instances[0].fail('network');
    expect(el.state).toBe('unavailable');
    expect(unavailable[0].detail).toEqual({ reason: 'error' });
  });

  it('reflects aria-pressed while listening', () => {
    const el = mount(make());
    expect(button(el).getAttribute('aria-pressed')).toBe('false');
    button(el).click();
    expect(button(el).getAttribute('aria-pressed')).toBe('true');
    button(el).click();
    expect(button(el).getAttribute('aria-pressed')).toBe('false');
  });

  it('stops listening at max-seconds', () => {
    vi.useFakeTimers();
    const el = mount(make({ 'max-seconds': '3' }));
    const transcript = events(el, 'transcript');
    button(el).click();
    const rec = FakeRecognition.instances[0];
    rec.emit([['hello', true]]);
    vi.advanceTimersByTime(2999);
    expect(el.state).toBe('listening');
    vi.advanceTimersByTime(1);
    expect(el.state).toBe('idle');
    expect(transcript[0].detail).toEqual({ text: 'hello' });
  });

  it('emits events that bubble across the shadow boundary', () => {
    const el = mount(make());
    const onDoc = vi.fn();
    document.addEventListener('transcript', onDoc);
    button(el).click();
    FakeRecognition.instances[0].emit([['x', true]]);
    button(el).click();
    document.removeEventListener('transcript', onDoc);
    expect(onDoc).toHaveBeenCalledTimes(1);
    const event = onDoc.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });

  it('aborts the recognizer without emitting when removed mid-listen', () => {
    const el = mount(make());
    const transcript = events(el, 'transcript');
    button(el).click();
    const rec = FakeRecognition.instances[0];
    const abort = vi.spyOn(rec, 'abort');
    rec.emit([['bye', true]]);
    el.remove();
    expect(abort).toHaveBeenCalled();
    rec.endByItself();
    expect(transcript).toHaveLength(0);
  });
});

// --- Attributes and accessibility ----------------------------------------------------------------

describe('labels and accessibility', () => {
  beforeEach(() => {
    w['SpeechRecognition'] = FakeRecognition;
  });

  it('uses label-start and label-stop as the accessible name and re-renders on change', () => {
    const el = mount(make({ 'label-start': 'ابدأ', 'label-stop': 'أوقف' }));
    expect(button(el).getAttribute('aria-label')).toBe('ابدأ');
    button(el).click();
    expect(button(el).getAttribute('aria-label')).toBe('أوقف');
    el.setAttribute('label-stop', 'Stop now');
    expect(button(el).getAttribute('aria-label')).toBe('Stop now');
  });

  it('has a real button and one polite live region', () => {
    const el = mount(make());
    expect(button(el).tagName).toBe('BUTTON');
    expect(button(el).getAttribute('type')).toBe('button');
    expect(el.shadowRoot!.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it('shows a disabled button with label-unavailable when unavailable', async () => {
    delete w['SpeechRecognition'];
    const el = mount(make({ 'label-unavailable': 'غير متاح' }));
    await Promise.resolve();
    expect(button(el).disabled).toBe(true);
    expect(button(el).hidden).toBe(false);
    expect(button(el).getAttribute('aria-label')).toBe('غير متاح');
  });

  it('hides itself when unavailable and no label-unavailable is given', async () => {
    delete w['SpeechRecognition'];
    const el = mount(make());
    await Promise.resolve();
    expect(button(el).hidden).toBe(true);
  });

  it('exposes state as a read-only property', () => {
    const el = mount(make());
    expect(() => {
      (el as unknown as { state: string }).state = 'recording';
    }).toThrow();
    expect(el.state).toBe('idle');
  });
});

// --- Server mode ------------------------------------------------------------------------------

describe('server mode', () => {
  let track: { stop: ReturnType<typeof vi.fn> };
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const s = stubStream();
    track = s.track;
    getUserMedia = vi.fn().mockResolvedValue(s.stream);
    nav['mediaDevices'] = { getUserMedia };
    w['MediaRecorder'] = FakeRecorder;
  });

  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('records in server mode and stops itself at max-seconds', async () => {
    vi.useFakeTimers();
    const el = mount(make({ mode: 'server', 'max-seconds': '2' }));
    const audio = events(el, 'audio');
    button(el).click();
    await flush();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(el.state).toBe('recording');
    expect(button(el).getAttribute('aria-pressed')).toBe('true');

    await vi.advanceTimersByTimeAsync(2000);
    expect(el.state).toBe('idle');
    expect(audio).toHaveLength(1);
    const detail = audio[0].detail as { blob: Blob; mimeType: string; seconds: number };
    expect(detail.seconds).toBe(2);
    expect(detail.blob).toBeInstanceOf(Blob);
    expect(detail.blob.size).toBeGreaterThan(0);
    expect(detail.mimeType).toBe('audio/webm;codecs=opus');
    expect(track.stop).toHaveBeenCalled();
  });

  it('reports elapsed seconds when the user stops early', async () => {
    vi.useFakeTimers();
    const el = mount(make({ mode: 'server' }));
    const audio = events(el, 'audio');
    button(el).click();
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    button(el).click();
    expect((audio[0].detail as { seconds: number }).seconds).toBe(4);
    expect(el.state).toBe('idle');
    expect(track.stop).toHaveBeenCalled();
  });

  it('picks audio/mp4 when webm is unsupported', async () => {
    FakeRecorder.supported = new Set(['audio/mp4']);
    const el = mount(make({ mode: 'server' }));
    const audio = events(el, 'audio');
    button(el).click();
    await vi.waitFor(() => expect(el.state).toBe('recording'));
    expect(FakeRecorder.instances[0].options?.mimeType).toBe('audio/mp4');
    button(el).click();
    expect((audio[0].detail as { mimeType: string }).mimeType).toBe('audio/mp4');
  });

  it('maps a NotAllowedError to unavailable denied', async () => {
    getUserMedia.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    const el = mount(make({ mode: 'server' }));
    const unavailable = events(el, 'unavailable');
    button(el).click();
    await vi.waitFor(() => expect(el.state).toBe('unavailable'));
    expect(unavailable[0].detail).toEqual({ reason: 'denied' });
  });

  it('maps other getUserMedia failures to unavailable error', async () => {
    getUserMedia.mockRejectedValue(new DOMException('no mic', 'NotFoundError'));
    const el = mount(make({ mode: 'server' }));
    const unavailable = events(el, 'unavailable');
    button(el).click();
    await vi.waitFor(() => expect(el.state).toBe('unavailable'));
    expect(unavailable[0].detail).toEqual({ reason: 'error' });
  });

  it('emits unavailable unsupported without MediaRecorder', async () => {
    delete w['MediaRecorder'];
    const el = make({ mode: 'server' });
    const unavailable = events(el, 'unavailable');
    mount(el);
    await Promise.resolve();
    expect(el.state).toBe('unavailable');
    expect(unavailable[0].detail).toEqual({ reason: 'unsupported' });
  });

  it('emits unavailable unsupported without mediaDevices', async () => {
    delete nav['mediaDevices'];
    const el = make({ mode: 'server' });
    const unavailable = events(el, 'unavailable');
    mount(el);
    await Promise.resolve();
    expect(unavailable[0].detail).toEqual({ reason: 'unsupported' });
  });

  it('stops the microphone and emits nothing when removed mid-recording', async () => {
    const el = mount(make({ mode: 'server' }));
    const audio = events(el, 'audio');
    button(el).click();
    await vi.waitFor(() => expect(el.state).toBe('recording'));
    el.remove();
    expect(track.stop).toHaveBeenCalled();
    expect(audio).toHaveLength(0);
  });

  it('releases the microphone if removed while the permission prompt is open', async () => {
    let resolve!: (s: unknown) => void;
    const { track: t, stream } = stubStream();
    getUserMedia.mockReturnValue(new Promise((r) => (resolve = r)));
    const el = mount(make({ mode: 'server' }));
    button(el).click();
    el.remove();
    resolve(stream);
    await vi.waitFor(() => expect(t.stop).toHaveBeenCalled());
    expect(FakeRecorder.instances).toHaveLength(0);
  });
});

// --- Network ----------------------------------------------------------------------------------

describe('network', () => {
  it('never calls fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    w['SpeechRecognition'] = FakeRecognition;
    const { stream } = stubStream();
    nav['mediaDevices'] = { getUserMedia: vi.fn().mockResolvedValue(stream) };
    w['MediaRecorder'] = FakeRecorder;

    const browser = mount(make());
    button(browser).click();
    FakeRecognition.instances[0].emit([['x', true]]);
    button(browser).click();

    const server = mount(make({ mode: 'server' }));
    button(server).click();
    await vi.waitFor(() => expect(server.state).toBe('recording'));
    button(server).click();

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('registration', () => {
  it('survives being imported twice', async () => {
    vi.resetModules();
    await expect(import('./voice-capture')).resolves.toBeDefined();
    expect(customElements.get('ag-voice-capture')).toBeDefined();
  });
});
