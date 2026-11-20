# Stereo field

Add **Stereo field** from Computer widgets, or select the **Stereo Field** page template.
The Windows agent uses the same output loopback capture as Audio spectrum and Audio waveform.
Choose the default output or a saved output device. Capture leases expire after five seconds without a visible widget.

The signed orientation is identical throughout the display:

- Mid = (L + R) / 2; Side = (L − R) / 2.
- Horizontal x = −Side; vertical up = +Mid.
- Mono is vertical, opposite polarity is horizontal.
- Left-only lies on the upper-left/lower-right diagonal; right-only on the upper-right/lower-left diagonal.
- The scale is fixed at ±1, without automatic gain. Points beyond full scale are clipped to the plot boundary.

Measurements use all samples in a rolling 100 ms window, independently of the display point reduction:

- Correlation = sum(L × R) / sqrt(sum(L²) × sum(R²)), bounded to −1…+1.
- L/R levels are RMS dBFS. The balance indicator shows channel energy shares L² / (L² + R²) and its complement.
- Mid/Side percentages are sum(M²) / sum(M² + S²) and its complement.
- Correlation is undefined (—) if either channel has no measurable energy. Silence shows −∞ channel levels and undefined energy shares.
- Mono capture duplicates its single channel into L/R.

Up to 512 paired points per frame show the most recent window at roughly 30 frames/s.
Afterglow lasts 250, 800 or 1500 ms and decays by elapsed time. Freeze holds the trace and measurements;
Resume clears the old trace. Expand and Escape open and close the full-screen view.
Hidden pages, inactive stack cards and night mode stop renewing capture.
The browser demo uses explicitly labelled synthetic stereo audio.

`GET /api/audio-stereo?widget=page/widget` requires an enabled saved `audio-stereo` widget.
SSE event `audio-stereo` and the polling fallback carry the same frame. Points are `[Side, Mid]` pairs;
`leftShare` and `midShare` are fractions, with null representing undefined measurements.

Validation: `AudioStereoTests` covers known signals, energy ratios, silence, invalid samples and request gating.
`tools/ui-tests/audio-stereo.spec.js` checks labels, axes, afterglow, freeze, stale frames, visibility and viewport sizes.
