# PhoneBox Audio — spectrum analyzer

This fork adds **Audio spectrum** alongside **Spectrum bars**. Waveform, stereo field and loudness analyzers are
deferred. In the layout editor add the **Audio Analysis** template, or **Computer → Audio spectrum**, then save.

The ready-to-run Windows bundle is in `dist/PhoneBoxAudio/`: launch `Start-PhoneBoxAudio.cmd` and install
`PhoneBoxAudio-debug.apk` on Android. The launcher creates an isolated `audio-config.json`, disables upstream
automatic updates and preloads the analyzer page. It refuses to start on a port already occupied by another agent.
The APK uses the upstream application ID and a debug signing key; an installed release with a different key cannot
be updated in place. Export existing PhoneBox settings before replacing an existing phone installation.

Select an output in widget options, or leave it automatic to follow the default multimedia output. Choose FFT
4096/8192/16384 and power averaging off/100/300/1000 ms. The graph offers channel modes, tilt, peak hold/reset,
freeze and expand. Display adjustments on the phone last until the widget is rebuilt; editor options are the defaults.
Hover or touch the plot to read raw frequency/level values. Tilt never changes the numeric measurement.

Build/install both this fork's desktop agent and APK: the phone's WebView assets are bundled in the APK. Disable
upstream automatic updates in Settings, since an upstream release does not contain the new analyzer. Keep the
MIT license and upstream copyright when distributing builds. No GitHub-hosted fork has been published by this change.

## Measurement conventions

- Hann window, exact coherent gain `sum(window)`, one-sided amplitude `2|FFT|/sum(window)`. DC/Nyquist omit the
  factor of two. A coherent full-scale sine reads 0 dBFS; half amplitude reads approximately −6.02 dBFS. No automatic
  gain. Off-bin tones exhibit Hann scalloping. This is peak-bin amplitude, not power spectral density.
- 512 logarithmic display points from 20 Hz to `min(20 kHz, Nyquist)`; each interval retains its strongest FFT bin.
  Below FFT resolution, display points share bins. Actual bin spacing `sampleRate / FFT size` appears below the graph.
- Curves: L, R, average channel power `(power(L)+power(R))/2`, Mid `(L+R)/2`, Side `(L−R)/2`. Stereo power does
  not cancel antiphase signals. Averaging operates on linear bin powers with a sample-timed exponential coefficient.
- Tilt: −6…+6 dB/oct, step 0.5, default +3, pivot 1 kHz. Positive tilt raises high frequencies on the graph. The
  vertical scale explicitly says “dBFS + tilt” when compensation is active. Held peaks also retain raw values.

## Capture and protocol

Windows WASAPI loopback captures mono/stereo system mix at the actual output sample rate. Float32 and PCM16/24/32
are supported. Multichannel outputs show an explicit unsupported-format state. ASIO, analog output measurement and
DAW integration are outside this version.

`GET /api/audio-spectrum?widget=pageId/widgetId` (stack card: `pageId/stackId:cardId`) resolves the saved widget
using the existing phone identity header. Only enabled pages/cards can request capture; device and FFT settings
come from saved configuration. The exact endpoint is allowed over paired Wi-Fi using existing TLS/pairing rules.

Response: `{shown, key, frame}`. Frames contain sequence/time, state, device/name, sample rate, channels, FFT size,
averaging interval, bin resolution, 512 frequencies and five raw dBFS curves. SSE `/api/stream` pushes the same
frame as `audio-spectrum`; polling is the fallback. Only the newest frame is retained. Like the original spectrum,
active measurements are broadcast to connected paired panel streams.

One capture per configured output selector serves multiple FFT/averaging profiles. Limits: four output selectors,
eight profiles each, shared with waveform intervals. Requests renew a five-second lease. Hidden pages/cards, background documents and the night
screen do not renew it. Capture stops when leases expire. Reopening an output resets DSP and display peak state.
Default-device changes are checked once a second. When WASAPI delivers no callbacks for 250 ms, an explicit silent
frame replaces stale audio and clears the input window. 30 display updates/s is a target, not a latency guarantee.

Only derived spectrum values leave the PC; PCM is neither stored nor transmitted. No new internet service is used.
Desktop live preview also captures while the saved widget is visible. USB and Wi-Fi carry the same measurements.

## Checks

`AudioSpectrumTests` checks calibrated tones at 44.1/48/96 kHz, phase cancellation, single-channel power, sample-timed
averaging, silence/non-finite input, Nyquist limits, bounded options and widget/LAN gating. Browser tests check
polling, pushed states, controls, independent profiles, visibility, Smart Stack and portrait/landscape layouts.
Real Android USB/Wi-Fi and end-to-end latency still need hardware validation. This is not a certified instrument.
