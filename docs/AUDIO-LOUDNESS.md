# Loudness analyzer

Add the **Loudness** template, or **Computer → Loudness**, in the layout editor and save.
Select a mono/stereo Windows output; an empty Output follows the default multimedia output.
The agent measures the digital WASAPI loopback signal, after Windows playback processing.

| Reading | Measurement |
|---|---|
| Sample Peak L/R | Maximum absolute PCM sample in each publication interval, dBFS |
| RMS L/R | Unweighted rectangular 400 ms mean-square window, dBFS; a full-scale sine reads −3.01 dBFS |
| True Peak L/R | 4× oversampled reconstruction, dBTP; values may exceed 0 dBTP |
| Momentary | K-weighted summed channel energy over a rectangular 400 ms window, LUFS; no gate |
| Short-term | K-weighted summed channel energy over a rectangular 3 s window, LUFS; no gate |
| Integrated | Complete 400 ms blocks every 100 ms; absolute gate −70 LUFS, then relative gate −10 LU |

Sample Peak, RMS and True Peak have independent held maxima per channel. Momentary and Short-term
also hold maxima, evaluated at every input sample so the display cadence cannot miss a window maximum.
Integrated is recalculated from all absolute-gated block energies at least once per second. Live M/S and
level frames are published at 10 Hz. Partial final Integrated blocks are discarded.

**Reset session** clears elapsed time, filter and window history, all held maxima and Integrated blocks
on the agent. It does not change another loudness widget's session. The session is associated with the
saved widget and requesting phone, while all analyzers share one capture per output. Reset does not
depend on keeping the browser open long enough to clear a local display buffer.

Loudness windows remain unavailable until 400 ms / 3 s of input have arrived. Null measurements are
displayed as −∞; unavailable output/capture clears readings to a dash. A mono output is counted once
for LUFS and shown in L; the R column displays a dash. Silence advances the windows and session clock,
including when WASAPI supplies no callbacks. Held maxima remain until reset or session termination.

Capture and session storage expire about five seconds after the last request from the visible widget.
Changing output, losing/reopening capture, restarting the agent or returning after lease expiry starts
a new session. Measurements are not persisted to disk. Hidden pages, inactive stack cards, the night
screen and background documents do not renew requests. This is a visible-widget measurement session,
not unattended continuous recording. **Expand** and Escape control the full-screen view.

Implementation: `AudioLoudnessDsp.cs`, connected to the existing `AudioSpectrum` capture service.
K-weighting uses a shelving stage and RLB high-pass, with coefficients calculated for the actual sample
rate. True Peak uses a 48-tap Blackman-windowed sinc per fractional phase with unity DC gain and
24 input samples of delay; raw samples also participate in the peak search. No PCM is sent to the phone.
Memory holds three seconds of weighted energy, 400 ms of raw energy, and about 288 KB of Integrated
block energies per hour per session. Long sessions recompute the relative gate over the full history.

## Reference validation

Validated on Windows on 2026-11-19 against **60 original WAV files** from the
[EBU Loudness Test Set v05](https://tech.ebu.ch/publications/ebu_loudness_test_set), using the tolerances in
[EBU Tech 3341, Table 1](https://tech.ebu.ch/publications/tech3341).

| EBU cases | Result |
|---|---|
| 1–2: calibration, M/S/I | Passed, ±0.1 LU |
| 3–5: absolute/relative gating | Passed, ±0.1 LU |
| 7–8: authentic stereo programmes | Passed, ±0.1 LU |
| 9, 12: constant S/M windows on alternating tones | Passed, ±0.1 LU at every 100 ms observation after settling |
| 10, 13: all 20 offsets for each window maximum | Passed, ±0.1 LU |
| 11, 14: all 20 successive live maximum levels | Passed, ±0.1 LU |
| 15–23: True Peak, including transient/inter-sample peaks and +3 dBTP | Passed, +0.2/−0.4 dBTP, both channels |

Case 6 is multichannel and is outside the mono/stereo capture scope. LRA, measurement pause and EBU
scale selection are not implemented; this widget implements the requested BS.1770/EBU R128 loudness
measurements and does not claim full “EBU Mode” certification. BS.2217 compliance material was not run.
The current algorithm specification is [ITU-R BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I/en).

The official ZIP download was blocked by Cloudflare on this host. The v05 archive was obtained
from the [Gentoo mirror at Erlangen](https://ftp.uni-erlangen.de/gentoo/distfiles/de/ebu-loudness-test-setv05.zip).
Archive SHA-256: `9cc500b4df83f7c21855c74dce795ef5209a752bf884253ae57d0ce512efb062`.
Reference files are used only for technical testing, ignored by Git and excluded from the portable bundle.

To reproduce, extract the EBU ZIP without renaming its files (some names end in `.wav.wav`):

```powershell
$env:PHONEBOX_EBU_TEST_DIR = 'C:\path\to\extracted-ebu-v05'
dotnet test agent/PhoneBox.Agent.Tests --filter 'FullyQualifiedName~AudioLoudness'
```

Without that environment variable the reference tests are explicitly skipped; synthetic and service tests
still run. The WAV reader is independent of the Windows capture decoder. Additional tests cover
44.1/48/96/192 kHz calibration, L/R differences, mono channel counting, partial blocks, non-finite samples,
inter-sample overs, silence, held maxima, saved-widget gating, session isolation and reset.

Browser tests in `tools/ui-tests/audio-loudness.spec.js` cover values/units, POST reset, delayed pre-reset
responses, stale/unrelated frames, overs, unavailable output, hidden pages and portrait/landscape expansion.
The web demo is explicitly marked synthetic; it does not calculate LUFS from a browser audio signal.
