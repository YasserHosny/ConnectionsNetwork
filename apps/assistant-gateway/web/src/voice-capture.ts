/**
 * <ag-voice-capture>: a framework-free voice input button.
 *
 * Browser mode uses the Web Speech API and emits text. Server mode records audio with
 * MediaRecorder and emits a Blob for the host app to upload through its own server. The widget
 * never touches the network itself.
 */

export type VoiceCaptureState = 'idle' | 'listening' | 'recording' | 'unavailable';
export type UnavailableReason = 'unsupported' | 'denied' | 'error';

export interface InterimDetail {
  text: string;
}
export interface TranscriptDetail {
  text: string;
}
export interface AudioDetail {
  blob: Blob;
  mimeType: string;
  seconds: number;
}
export interface UnavailableDetail {
  reason: UnavailableReason;
}

// Minimal local typings: SpeechRecognition is not in lib.dom for every TypeScript version.
interface AgRecognitionAlternative {
  readonly transcript: string;
}
interface AgRecognitionResult {
  readonly isFinal: boolean;
  readonly [index: number]: AgRecognitionAlternative;
}
interface AgRecognitionResultEvent {
  readonly results: ArrayLike<AgRecognitionResult>;
}
interface AgRecognitionErrorEvent {
  readonly error: string;
}
interface AgRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: AgRecognitionResultEvent) => void) | null;
  onerror: ((event: AgRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type AgRecognitionCtor = new () => AgRecognition;

interface AgRecorder {
  readonly mimeType: string;
  readonly state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
interface AgRecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string }): AgRecorder;
  isTypeSupported?(type: string): boolean;
}

interface AgGlobals {
  SpeechRecognition?: AgRecognitionCtor;
  webkitSpeechRecognition?: AgRecognitionCtor;
  MediaRecorder?: AgRecorderCtor;
}

const TAG = 'ag-voice-capture';
const RECORDER_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4'];
const DEFAULT_LABELS = {
  start: 'Start voice input',
  stop: 'Stop voice input',
  unavailable: 'Voice input unavailable',
};

const STYLE = `
  :host { display: inline-flex; align-items: center; gap: 0.5rem; }
  :host([data-state="unavailable"]:not([label-unavailable])) { display: none; }
  button {
    display: inline-flex; align-items: center; justify-content: center;
    inline-size: 2.75rem; block-size: 2.75rem; padding: 0;
    border: 1px solid currentColor; border-radius: 50%;
    background: transparent; color: inherit; cursor: pointer; font: inherit;
  }
  button[hidden] { display: none; }
  button[aria-pressed="true"] { background: currentColor; }
  button[aria-pressed="true"] svg { filter: invert(1); }
  button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: 0.5; }
  svg { inline-size: 1.25rem; block-size: 1.25rem; fill: currentColor; }
  [aria-live] { min-inline-size: 0; }
  time { font-variant-numeric: tabular-nums; }
  time[hidden] { display: none; }
`;

const MIC_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>';

function globals(): AgGlobals {
  return globalThis as unknown as AgGlobals;
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function joinText(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

export class VoiceCaptureElement extends HTMLElement {
  static readonly observedAttributes = [
    'mode',
    'language',
    'max-seconds',
    'label-start',
    'label-stop',
    'label-unavailable',
  ];

  #state: VoiceCaptureState = 'idle';
  #connected = false;
  /** Bumped whenever a pending or running session is cancelled, so late callbacks can tell. */
  #session = 0;
  #starting = false;

  #button: HTMLButtonElement;
  #live: HTMLSpanElement;
  #clock: HTMLTimeElement;

  // Browser mode
  #recognition: AgRecognition | null = null;
  #finalText = '';
  #interimText = '';

  // Server mode
  #recorder: AgRecorder | null = null;
  #stream: MediaStream | null = null;
  #mimeType = '';
  #chunks: Blob[] = [];
  #startedAt = 0;
  #stoppedAt: number | null = null;

  #limitTimer: ReturnType<typeof setTimeout> | null = null;
  #clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style><button type="button" aria-pressed="false">${MIC_ICON}</button><span aria-live="polite" part="interim"></span><time part="timer" aria-hidden="true" hidden></time>`;
    this.#button = root.querySelector('button')!;
    this.#live = root.querySelector('span')!;
    this.#clock = root.querySelector('time')!;
    this.#button.addEventListener('click', () => this.#onClick());
    // No #render() here: a custom element constructor must not add attributes to its host.
  }

  get state(): VoiceCaptureState {
    return this.#state;
  }

  connectedCallback(): void {
    this.#connected = true;
    this.#checkSupport();
    this.#render();
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#cancelSession();
    if (this.#state !== 'unavailable') this.#setState('idle');
  }

  attributeChangedCallback(name: string): void {
    if (name === 'mode' && this.#connected && !this.#isActive() && !this.#starting) {
      this.#state = 'idle';
      this.#checkSupport();
    }
    this.#render();
  }

  // --- Attributes ---------------------------------------------------------------------------

  get #mode(): 'browser' | 'server' {
    return this.getAttribute('mode') === 'server' ? 'server' : 'browser';
  }

  get #language(): string {
    return this.getAttribute('language') || 'ar-EG';
  }

  get #maxMs(): number {
    const seconds = Number(this.getAttribute('max-seconds') ?? '60');
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
  }

  // --- State and rendering ------------------------------------------------------------------

  #isActive(): boolean {
    return this.#state === 'listening' || this.#state === 'recording';
  }

  #setState(state: VoiceCaptureState): void {
    this.#state = state;
    this.#render();
  }

  #render(): void {
    const state = this.#state;
    const active = this.#isActive();
    const unavailable = state === 'unavailable';
    const label = unavailable
      ? (this.getAttribute('label-unavailable') ?? DEFAULT_LABELS.unavailable)
      : active
        ? (this.getAttribute('label-stop') ?? DEFAULT_LABELS.stop)
        : (this.getAttribute('label-start') ?? DEFAULT_LABELS.start);

    this.#button.setAttribute('aria-pressed', String(active));
    this.#button.setAttribute('aria-label', label);
    this.#button.title = label;
    this.#button.disabled = unavailable;
    this.#button.hidden = unavailable && !this.hasAttribute('label-unavailable');
    this.#clock.hidden = state !== 'recording';
    if (state === 'idle' || unavailable) this.#live.textContent = '';
    this.dataset['state'] = state;
  }

  #emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  #setUnavailable(reason: UnavailableReason): void {
    this.#cancelSession();
    this.#setState('unavailable');
    this.#emit<UnavailableDetail>('unavailable', { reason });
  }

  #supported(): boolean {
    if (this.#mode === 'server') {
      return Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(globals().MediaRecorder);
    }
    const g = globals();
    return Boolean(g.SpeechRecognition ?? g.webkitSpeechRecognition);
  }

  #checkSupport(): void {
    if (this.#supported()) {
      if (this.#state === 'unavailable') this.#setState('idle');
      return;
    }
    this.#setState('unavailable');
    // Deferred so a host that attaches its listener right after insertion still hears it. A
    // host that attaches later can read `state`.
    queueMicrotask(() => {
      if (this.#state === 'unavailable' && this.#connected) {
        this.#emit<UnavailableDetail>('unavailable', { reason: 'unsupported' });
      }
    });
  }

  // --- Clicks and limits --------------------------------------------------------------------

  #onClick(): void {
    if (this.#starting) return;
    if (this.#state === 'idle') {
      if (this.#mode === 'server') void this.#startServer();
      else this.#startBrowser();
    } else if (this.#isActive()) {
      this.#requestStop();
    }
  }

  #requestStop(): void {
    this.#stoppedAt ??= Date.now();
    if (this.#recognition) this.#recognition.stop();
    else if (this.#recorder && this.#recorder.state !== 'inactive') this.#recorder.stop();
  }

  #armTimers(): void {
    this.#limitTimer = setTimeout(() => this.#requestStop(), this.#maxMs);
  }

  #clearTimers(): void {
    if (this.#limitTimer !== null) clearTimeout(this.#limitTimer);
    if (this.#clockTimer !== null) clearInterval(this.#clockTimer);
    this.#limitTimer = null;
    this.#clockTimer = null;
  }

  /** Drops whatever is pending or running without emitting anything. */
  #cancelSession(): void {
    this.#session++;
    this.#starting = false;
    this.#clearTimers();

    const recognition = this.#recognition;
    this.#recognition = null;
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    }

    const recorder = this.#recorder;
    this.#recorder = null;
    if (recorder) {
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    this.#releaseStream();

    this.#finalText = this.#interimText = '';
    this.#chunks = [];
    this.#stoppedAt = null;
  }

  #releaseStream(): void {
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
  }

  // --- Browser mode -------------------------------------------------------------------------

  #startBrowser(): void {
    const g = globals();
    const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
    if (!Ctor) {
      this.#setUnavailable('unsupported');
      return;
    }
    this.#cancelSession();
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.#language;
    recognition.onresult = (event) => {
      if (this.#recognition !== recognition) return;
      this.#onRecognitionResult(event);
    };
    recognition.onerror = (event) => {
      if (this.#recognition !== recognition) return;
      this.#onRecognitionError(event.error);
    };
    recognition.onend = () => {
      if (this.#recognition !== recognition) return;
      this.#finishBrowser();
    };
    this.#recognition = recognition;
    try {
      recognition.start();
    } catch {
      this.#setUnavailable('error');
      return;
    }
    this.#stoppedAt = null;
    this.#setState('listening');
    this.#armTimers();
  }

  #onRecognitionResult(event: AgRecognitionResultEvent): void {
    const finals: string[] = [];
    const interims: string[] = [];
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      (result.isFinal ? finals : interims).push(result[0].transcript);
    }
    this.#finalText = joinText(...finals);
    this.#interimText = joinText(...interims);
    const text = joinText(this.#finalText, this.#interimText);
    this.#live.textContent = text;
    this.#emit<InterimDetail>('interim', { text });
  }

  #onRecognitionError(error: string): void {
    switch (error) {
      case 'not-allowed':
      case 'service-not-allowed':
        this.#setUnavailable('denied');
        break;
      case 'no-speech':
      case 'aborted':
        this.#finishBrowser();
        break;
      default:
        this.#setUnavailable('error');
    }
  }

  /** The recognizer is done (stopped, timed out or ended on its own): hand over what it heard. */
  #finishBrowser(): void {
    const text = joinText(this.#finalText, this.#interimText);
    this.#cancelSession();
    this.#setState('idle');
    if (text) this.#emit<TranscriptDetail>('transcript', { text });
  }

  // --- Server mode --------------------------------------------------------------------------

  async #startServer(): Promise<void> {
    const mediaDevices = navigator.mediaDevices;
    const Recorder = globals().MediaRecorder;
    if (!mediaDevices?.getUserMedia || !Recorder) {
      this.#setUnavailable('unsupported');
      return;
    }
    this.#cancelSession();
    const session = this.#session;
    this.#starting = true;

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (session !== this.#session) return;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.#setUnavailable(denied ? 'denied' : 'error');
      return;
    }
    if (session !== this.#session) {
      // Removed or restarted while the permission prompt was open: give the microphone back.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.#starting = false;
    this.#stream = stream;

    const mimeType =
      RECORDER_MIME_TYPES.find((type) => Recorder.isTypeSupported?.(type) === true) ?? '';
    let recorder: AgRecorder;
    try {
      recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream);
    } catch {
      this.#setUnavailable('error');
      return;
    }
    this.#recorder = recorder;
    this.#mimeType = mimeType;
    this.#chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.#chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (this.#recorder === recorder) this.#setUnavailable('error');
    };
    recorder.onstop = () => {
      if (this.#recorder === recorder) this.#finishServer(recorder);
    };

    try {
      recorder.start();
    } catch {
      this.#setUnavailable('error');
      return;
    }
    this.#startedAt = Date.now();
    this.#stoppedAt = null;
    this.#clock.textContent = formatClock(0);
    this.#setState('recording');
    this.#armTimers();
    this.#clockTimer = setInterval(() => {
      this.#clock.textContent = formatClock(Date.now() - this.#startedAt);
    }, 1000);
  }

  #finishServer(recorder: AgRecorder): void {
    const mimeType = this.#mimeType || recorder.mimeType;
    const blob = new Blob(this.#chunks, { type: mimeType });
    const elapsedMs = (this.#stoppedAt ?? Date.now()) - this.#startedAt;
    this.#cancelSession();
    this.#setState('idle');
    if (blob.size === 0) return;
    this.#emit<AudioDetail>('audio', { blob, mimeType, seconds: Math.round(elapsedMs) / 1000 });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ag-voice-capture': VoiceCaptureElement;
  }
}

if (!customElements.get(TAG)) {
  customElements.define(TAG, VoiceCaptureElement);
}
