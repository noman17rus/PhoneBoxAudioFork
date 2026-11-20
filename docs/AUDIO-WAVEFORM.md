# PhoneBox Audio — waveform analyzer

Add **Computer → Audio waveform** or the **Audio Waveform** template in the layout editor and save.
The output selector follows the default Windows multimedia output when empty. The widget shares WASAPI capture
with Audio spectrum for the same output selector. Install updated desktop agent and Android APK together.

- Two separate lanes: **L / R** (default) or **Mid / Side**, where Mid = `(L+R)/2`, Side = `(L−R)/2`.
- Visible intervals: **10, 50, 100, 500 ms, 1, 5, 10 s**, default **1 s**. Select in the editor or on the graph.
  Graph selections last until the widget is rebuilt. Changing interval starts a fresh history for that profile.
- **Freeze / Resume** holds the displayed frame, including through incoming error states. Channel selection and
  expansion remain available while frozen. Selecting another interval resumes acquisition.
- The horizontal scale shows time relative to the newest envelope bucket: oldest at left, zero at right.
  Each channel uses a fixed ±1 digital full-scale amplitude. Red marks indicate any sample reaching or exceeding
  +1 or −1 (0 dBFS), including overs. These are sample-peak markers, not intersample true-peak detection.
- **Expand** fills the display; **Close** or Escape restores the layout.

## Peak preservation

The agent aggregates **every sample** into up to 512 chronological min/max buckets for L, R, Mid and Side.
M/S conversion occurs before aggregation, so antiphase cancellation is represented correctly. Bucket lengths
differ by at most one sample; a complete ring covers the requested interval to sample precision. Frames contain
completed buckets; the newest bucket can trail capture by up to one bucket (about 19.6 ms for a 10 s window).
History initially contains silence until enough samples arrive. Non-finite input samples become zero.

No averaging or sample skipping is used for the envelope. A one-sample transient survives even in a 10 s window.
The renderer merges buckets with min/max again when the screen has fewer columns than the envelope, preserving
brief peaks and 0 dBFS markers on small screens. Peaks scroll out with their time bucket. WASAPI silence advances
the history rather than replacing the whole long window immediately.

## Capture and protocol

`GET /api/audio-waveform?widget=pageId/widgetId&interval=1000` resolves an enabled saved waveform widget
(including Smart Stack cards) using the existing phone identity header. Output selection comes from the saved
widget; the optional interval override is bounded to the seven supported values. Invalid values use 1 s.
The same pairing/TLS rules apply over Wi-Fi. Unknown widgets cannot start capture.

Response: `{shown, key, frame}`. The profile key is `wave:intervalMs:outputSelector`. Frames include sequence,
timestamp, state, actual device/name, sample rate, source channel count, intervalMs and four `min`/`max` arrays
ordered L, R, Mid, Side. SSE `/api/stream` emits `audio-waveform`; polling is the fallback. Only the latest frame
per profile is retained. Derived envelopes are sent to paired panels and the desktop preview; PCM is not stored
or transmitted. These envelopes disclose the shape of the system audio signal.

Four output selectors and eight combined spectrum/waveform profiles per selector are allowed. Visible widgets
renew a five-second lease. Hidden pages/cards, background documents and the night screen stop renewing leases.
Mono capture duplicates L into R, producing a zero Side channel. Multichannel/unsupported formats show an
explicit status. Default-device changes reset history. Capture targets roughly 30 display frames/s; end-to-end
latency and real Android USB/Wi-Fi behavior still need hardware validation.
