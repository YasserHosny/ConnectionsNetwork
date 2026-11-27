# `<ag-voice-capture>`

A framework-free voice input button for the Assistant Gateway. One element, no dependencies,
and **no network access of its own**: the host app decides what happens to the text or audio.

- **Browser mode** (default) uses the Web Speech API and emits text.
- **Server mode** records audio with `MediaRecorder` and emits a `Blob`. The host uploads it
  through its own server, which calls the gateway.

Browser-only: import it from client code (not during server-side rendering).

## Install and register

```ts
import '@assistant-gateway/voice-capture'; // registers <ag-voice-capture> once
```

Importing the module twice is safe. `VoiceCaptureElement` is also a named export.

## Attributes

All attributes are observed: changing a label or the mode re-renders the element.

| Attribute | Default | Meaning |
|---|---|---|
| `mode` | `browser` | `browser` (Web Speech, emits text) or `server` (records audio). |
| `language` | `ar-EG` | BCP 47 tag for speech recognition (browser mode). |
| `max-seconds` | `60` | The widget stops by itself after this long, in both modes. |
| `label-start` | `Start voice input` | Accessible name while idle. Supply translated text. |
| `label-stop` | `Stop voice input` | Accessible name while listening or recording. |
| `label-unavailable` | none | Accessible name when unavailable. If absent, the element hides itself. If present, it shows a disabled button with this name. |

### `max-seconds` and the gateway's limit

The widget stops at exactly `max-seconds`. The gateway measures audio length rounded up, so a
recording of exactly `max_audio_seconds` is refused with 413. **Set `max-seconds` at least 1 s
below the gateway's `max_audio_seconds`** (for example `max-seconds="59"` against a limit of 60).

## Events

All events are `CustomEvent`s with `bubbles: true` and `composed: true`, so they cross the shadow
boundary.

| Event | `detail` | When |
|---|---|---|
| `interim` | `{ text }` | Browser mode, while speaking. `text` is everything heard so far, including words not yet final. |
| `transcript` | `{ text }` | Browser mode, when listening ends: the user pressed stop, `max-seconds` was reached, or the recognizer ended by itself (Chrome on Android does this after silence). Not emitted when nothing was heard. |
| `audio` | `{ blob: Blob, mimeType: string, seconds: number }` | Server mode, when recording ends. `seconds` is the elapsed recording time. Not emitted for an empty recording. |
| `unavailable` | `{ reason: 'unsupported' \| 'denied' \| 'error' }` | Voice input cannot be used. |

`unavailable` reasons:

- `unsupported`: no Web Speech API (for example Firefox), or no `MediaRecorder` / `mediaDevices`.
  Emitted when the element connects.
- `denied`: the microphone or speech service was refused.
- `error`: any other failure.

An `unsupported` event is emitted right after the element connects. A listener attached later
misses it, so also read `state` once after connecting.

## Property

`state` is read-only: `'idle' | 'listening' | 'recording' | 'unavailable'`. The element also
mirrors it in a `data-state` attribute for styling.

## Accessibility

The shadow root holds a real `<button type="button">` with `aria-pressed` (true while listening
or recording) and an accessible name from the `label-*` attributes. Interim text goes into a
`<span aria-live="polite">`. In server mode, while the browser's microphone permission prompt is open the button carries `aria-busy="true"` and stays enabled: pressing it again cancels the attempt (a dismissed Firefox prompt never settles). In server mode a visual elapsed-time clock is `aria-hidden`, so a
screen reader is not interrupted every second. The `part` names `interim` and `timer` are
available for styling with `::part()`.

## Plain HTML

```html
<script type="module" src="/voice-capture.js"></script>

<textarea id="note"></textarea>
<ag-voice-capture
  language="ar-EG"
  max-seconds="59"
  label-start="ابدأ التسجيل"
  label-stop="أوقف التسجيل"
></ag-voice-capture>

<script type="module">
  const mic = document.querySelector('ag-voice-capture');
  const note = document.querySelector('#note');
  mic.addEventListener('interim', (e) => (note.value = e.detail.text));
  mic.addEventListener('transcript', (e) => (note.value = e.detail.text));
  mic.addEventListener('unavailable', (e) => console.info('voice off:', e.detail.reason));
</script>
```

## Angular

Import the module once (for example in `main.ts`) and allow the custom element in the component
that uses it:

```ts
import '@assistant-gateway/voice-capture';
import { CUSTOM_ELEMENTS_SCHEMA, Component, signal } from '@angular/core';

@Component({
  selector: 'app-voice-box',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <textarea [value]="text()"></textarea>
    <ag-voice-capture
      language="ar-EG"
      max-seconds="59"
      [attr.label-start]="'voice.start' | translate"
      [attr.label-stop]="'voice.stop' | translate"
      (interim)="text.set($any($event).detail.text)"
      (transcript)="text.set($any($event).detail.text)"
      (unavailable)="voiceOff.set(true)"
    ></ag-voice-capture>
  `,
})
export class VoiceBoxComponent {
  text = signal('');
  voiceOff = signal(false);
}
```

Use `[attr.…]` for the label attributes: they are HTML attributes, not element properties.

### Server mode

```html
<ag-voice-capture mode="server" max-seconds="59" (audio)="upload($any($event).detail)">
</ag-voice-capture>
```

```ts
import { firstValueFrom } from 'rxjs';

async upload({ blob, mimeType, seconds }: { blob: Blob; mimeType: string; seconds: number }) {
  // Send to YOUR server, which calls the gateway. The widget never does.
  // HttpClient sends nothing until subscribed: firstValueFrom subscribes and awaits the reply.
  await firstValueFrom(
    this.http.post('/api/voice', blob, { headers: { 'Content-Type': mimeType } }),
  );
}
```

The recorded type is the first supported of `audio/webm;codecs=opus` and `audio/mp4` (Safari).

## Development

```bash
pnpm --filter @assistant-gateway/voice-capture test    # vitest, jsdom
pnpm --filter @assistant-gateway/voice-capture lint    # tsc --noEmit
pnpm --filter @assistant-gateway/voice-capture build   # dist/voice-capture.js + .d.ts
```
