# Audio spectrum validation

Checked on Windows, 2026-11-19. Local upstream checkout plus this fork's changes; not a published GitHub release.

| Check | Result |
|---|---|
| Windows .NET 10 agent build | Passed, no build warnings/errors |
| New DSP/service tests plus original Spectrum bars tests | 29 passed |
| Full .NET suite | Four existing `ListeningPortsTests` fail on this host; the new analyzer tests pass |
| Suite excluding `ListeningPortsTests` | 1547 passed |
| Browser: new analyzer and original Spectrum bars | 19 tests passed across targeted runs, including raw values unaffected by tilt |
| Source release/catalog metadata | Passed: 125 widgets, 31 templates |
| Android `lintDebug assembleDebug` | Passed; debug-signed APK generated |
| Actual Windows WASAPI loopback | Passed: live stereo, 44.1 kHz, five 512-point curves; capture lease expires |
| Published agent HTTP/embedded JS/SSE | Passed on isolated port 18765; JS HTTP 200, live spectral events received |
| Real Android USB and paired Wi-Fi | Not tested on a physical phone |

The initial .NET run needed permission for local testhost sockets. A browser cold-start run encountered transient
connection refusals on the static test server; subsequent serial runs succeeded. The failing network-port tests
are in unchanged upstream code and were left unchanged. Browser pictures use explicitly marked synthetic demo data.

Build prerequisites: .NET 10 SDK, JDK 17 or compatible later JDK, Android SDK 35, Node.js and Python 3.
On Windows with a non-ASCII checkout path, pass `-Pandroid.overridePathCheck=true` to Gradle.

```powershell
dotnet test agent/PhoneBox.Agent.Tests --filter 'FullyQualifiedName~AudioSpectrumTests|FullyQualifiedName~SpectrumAnalyzerTests'
dotnet publish agent/PhoneBox.Agent -c Release -f net10.0-windows10.0.19041.0 -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist/PhoneBoxAudio/agent
python tools/check-release.py
cd tools/ui-tests
npm ci
npx playwright install chromium
npx playwright test audio-spectrum.spec.js spectrum.spec.js --workers=1
cd ../../android
./gradlew.bat '-Pandroid.overridePathCheck=true' lintDebug assembleDebug
```

The binary is self-contained and does not require the SDK on the user's machine. The launcher uses a separate
configuration file and disables upstream automatic updates so they cannot silently replace this fork.

## Waveform addition — 2026-11-19

| Check | Result |
|---|---|
| DSP/service: waveform, spectrum and original bars | 44 passed |
| Browser: waveform, spectrum and original bars | 25 passed |
| Windows .NET 10 build and self-contained publish | Passed, no build warnings/errors |
| Android lintDebug and assembleDebug | Passed; portable bundle APK updated |
| Source release/catalog metadata | Passed: 126 widgets, 32 templates |
| Actual WASAPI shared waveform/spectrum capture | Passed: live stereo 44.1 kHz, 1 s and 10 s profiles, lease expiry |
| Published waveform HTTP / embedded JS / SSE | Passed on isolated port 18766; live waveform events received |
| Portrait/landscape visual inspection | Passed with explicitly synthetic demo signal |
| Real Android USB / paired Wi-Fi | Still requires physical-phone validation |

Waveform DSP tests cover one-sample overs and negative full-scale peaks at 44.1/48/96 kHz,
10 ms–10 s windows, chronological wrap, expiry through silence, Mid/Side cancellation before
envelope reduction, non-finite input, immutable snapshots, bounded intervals and saved-widget/LAN gating.
Browser tests cover all seven intervals, both modes, freeze through pushed errors, stale/unrelated
frames, hidden pages/cards, time labels, red full-scale marks and expansion in both orientations.

The .NET testhost and local browser/Gradle servers required execution outside the restricted sandbox
to communicate over loopback. This section records only the targeted waveform validation; the
full .NET suite was not repeated for this addition.


## Stereo field addition — 2026-11-19

| Check | Result |
|---|---|
| Stereo DSP/service plus waveform and spectrum tests | 39 passed |
| Browser stereo, waveform and spectrum tests | All 21 passed across targeted runs |
| Windows build and self-contained publish | Passed |
| Android lintDebug and assembleDebug | Passed; debug-signed APK generated |
| Catalog metadata | Passed: 127 widgets, 33 templates |
| Real WASAPI shared stereo/waveform/spectrum capture | Passed: live 44.1 kHz stereo, 512 vectorscope points; all leases expire |
| New portable agent catalog / embedded JS / HTTP / SSE | Passed on isolated port 18767 |
| Physical Android USB and Wi-Fi | Not tested on a physical phone |

New portable bundle: `dist/PhoneBoxAudioStereo`. Its launcher creates three analysis pages for a fresh configuration.
The already running original portable agent was left running; its executable could not be replaced while in use.
Stereo axes: x = −Side, vertical up = +Mid. Tests cover mono vertical, antiphase horizontal, single-channel diagonals,
correlation and energy ratios, silent/invalid samples, afterglow fading, freeze, stale frames and portrait/landscape layouts.
Browser validation required a server and browser outside the network sandbox; .NET testhost and Gradle also required
local process/socket access. Screenshots use explicitly labelled synthetic data. NuGet's online vulnerability lookup was
unavailable during the first publish; the final publish used cached packages with the online audit disabled.

## Loudness addition — 2026-11-19

| Check | Result |
|---|---|
| All four analyzers plus original Spectrum bars: DSP/service tests | 82 passed, none skipped |
| EBU Tech 3341 stereo reference material | 60 original WAVs; cases 1–5 and 7–23 passed within their specified tolerances |
| Browser loudness tests | 5 passed, including server reset and delayed pre-reset GET rejection |
| Browser regression: spectrum, waveform and stereo field | 21 passed |
| Windows build / self-contained publish | Passed; Windows build had no warnings/errors |
| Android lintDebug / assembleDebug | Passed; new debug APK included in portable bundle |
| Catalog metadata | Passed: 128 widgets, 34 templates |
| Real WASAPI shared capture | Passed: 44.1 kHz stereo, all four analyzers together, independent loudness sessions, reset/restart, lease expiry |
| Published agent catalog / embedded JS / HTTP / SSE | Passed on isolated port 18768; reset affected only the named session |
| Portrait / landscape visual inspection | Passed, explicitly synthetic demo data |
| Physical Android USB / Wi-Fi | Not tested on a physical phone |

New portable bundle: `dist/PhoneBoxAudioLoudness`. A fresh configuration gets four analysis pages; an existing
configuration is preserved. Previous portable distributions were not changed. See [the loudness guide](AUDIO-LOUDNESS.md)
for exact measurement windows, lifecycle, EBU archive checksum, reproduction commands and compliance scope.
The EBU multichannel case 6 and BS.2217 suite are outside this validation; LRA/full EBU Mode are not claimed.

Reference and capture tests use the same loudness DSP. Reference tests decode WAV data independently of WASAPI.
The official EBU download was blocked by Cloudflare; v05 was downloaded from the Gentoo Erlangen mirror and is not
redistributed. Initial sandbox runs could not reach the .NET testhost, installed browser or Gradle daemon; successful
runs used local process/socket access outside the restricted sandbox. The full non-audio .NET suite was not repeated.
