#pragma warning disable CS0618 // Same loopback API as the original Spectrum bars widget.
#if WINDOWS
using NAudio.CoreAudioApi;
using NAudio.Wave;
#endif

namespace PhoneBox.Agent;

public sealed record AudioSpectrumFrame(string Key, long Sequence, long Timestamp, string State,
    string Device, string DeviceName, int SampleRate, int Channels, int FftSize, int AverageMs,
    double ResolutionHz, double[] Frequencies, float[][] Curves);

/// <summary>One loopback capture per requested output; multiple FFT/averaging profiles share its stereo samples.</summary>
public sealed class AudioSpectrum : IDisposable
{
    public const string WidgetType = "audio-spectrum";
    private readonly ConfigStore _config;
    private readonly ILogger<AudioSpectrum> _log;
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Feed> _feeds = new(StringComparer.Ordinal);
    private readonly System.Threading.Timer _timer;
    private bool _disposed;
    private long _sequence;

    public AudioSpectrum(ConfigStore config, ILogger<AudioSpectrum> log)
    {
        _config = config; _log = log;
        _timer = new System.Threading.Timer(_ => Maintain(), null, 100, 100);
    }

    // Options are read from the saved widget. A phone can name a widget, never an arbitrary output or FFT allocation.
    public object Request(string? deviceId, string? widgetKey) => RequestCore(deviceId, widgetKey, false, null);

    public object RequestWaveform(string? deviceId, string? widgetKey, int? interval) => RequestCore(deviceId, widgetKey, true, interval);

    public object RequestStereo(string? deviceId, string? widgetKey) => RequestCore(deviceId, widgetKey, false, null, true);

    public object RequestLoudness(string? deviceId, string? widgetKey, bool reset = false) =>
        RequestCore(deviceId, widgetKey, false, null, loudness: true, reset: reset);

    private object RequestCore(string? deviceId, string? widgetKey, bool waveform, int? interval, bool stereo = false, bool loudness = false, bool reset = false)
    {
        lock (_gate)
        {
            var widget = PanelWidgets.Find(_config.Get(), deviceId, widgetKey, loudness ? "audio-loudness" : stereo ? "audio-stereo" : waveform ? "audio-waveform" : WidgetType);
            if (widget is null || _disposed) return new { shown = false, key = "", frame = (AudioSpectrumFrame?)null };
            var device = widget.Str("device") ?? "";
            var (fft, average) = Options(widget);
            var duration = AudioWaveformDsp.Interval(interval ?? (int.TryParse(widget.Opt("interval")?.ToString(), out var saved) ? saved : 1000));
            var key = loudness ? $"loud:{deviceId}:{widgetKey}:{device}" : stereo ? $"stereo:{device}" : waveform ? $"wave:{duration}:{device}" : $"{fft}:{average}:{device}";
            object EmptyFrame(string state) => loudness ? EmptyLoudness(key, state, device) : stereo ? EmptyStereo(key, state, device) : waveform ? EmptyWave(key, state, device, duration) : Empty(key, state, device, fft, average);
            if (!_feeds.TryGetValue(device, out var feed))
            {
                if (_feeds.Count >= 4) return new { shown = true, key, frame = EmptyFrame("busy") };
                _feeds[device] = feed = new Feed(this, device);
            }
            lock (feed.Gate)
            {
                if (!feed.Profiles.TryGetValue(key, out var profile))
                {
                    if (feed.Profiles.Count >= 8) return new { shown = true, key, frame = EmptyFrame("busy") };
                    feed.Profiles[key] = profile = new Profile(key, fft, average, waveform ? duration : 0, stereo, loudness);
                }
                if (reset && loudness)
                {
#if WINDOWS
                    profile.Meter = null; profile.NextSample = 0;
#endif
                    profile.LoudnessFrame = EmptyLoudness(key, feed.State, device);
                }
                profile.WantedUntil = Environment.TickCount64 + 5000;
            }
            feed.EnsureStarted();
            lock (feed.Gate) return new { shown = true, key, frame = loudness
                ? (object?)feed.Profiles[key].LoudnessFrame ?? EmptyFrame(feed.State) : stereo
                ? (object?)feed.Profiles[key].StereoFrame ?? EmptyFrame(feed.State) : waveform
                ? (object?)feed.Profiles[key].WaveFrame ?? EmptyFrame(feed.State)
                : feed.Profiles[key].Frame ?? EmptyFrame(feed.State) };
        }
    }

    internal static (int Fft, int Average) Options(WidgetConfig widget)
    {
        // Editor selects store strings; imported layouts may contain numbers.
        int.TryParse(widget.Opt("fft")?.ToString(), out var fft);
        var hasAverage = int.TryParse(widget.Opt("average")?.ToString(), out var average);
        return (fft is 4096 or 8192 or 16384 ? fft : 8192,
            hasAverage && average is 0 or 100 or 300 or 1000 ? average : 300);
    }

    public AudioSpectrumFrame[] Frames()
    {
        lock (_gate)
            return _feeds.Values.SelectMany(f =>
            {
                lock (f.Gate) return f.Profiles.Values.Where(p => p.WantedUntil > Environment.TickCount64)
                    .Select(p => p.Frame).OfType<AudioSpectrumFrame>().ToArray();
            }).ToArray();
    }

    public AudioWaveformFrame[] WaveformFrames()
    {
        lock (_gate) return _feeds.Values.SelectMany(f =>
        {
            lock (f.Gate) return f.Profiles.Values.Where(p => p.WantedUntil > Environment.TickCount64)
                .Select(p => p.WaveFrame).OfType<AudioWaveformFrame>().ToArray();
        }).ToArray();
    }

    public AudioStereoFrame[] StereoFrames()
    {
        lock (_gate) return _feeds.Values.SelectMany(f =>
        {
            lock (f.Gate) return f.Profiles.Values.Where(p => p.WantedUntil > Environment.TickCount64)
                .Select(p => p.StereoFrame).OfType<AudioStereoFrame>().ToArray();
        }).ToArray();
    }

    public AudioLoudnessFrame[] LoudnessFrames()
    {
        lock (_gate) return _feeds.Values.SelectMany(f =>
        {
            lock (f.Gate) return f.Profiles.Values.Where(p => p.WantedUntil > Environment.TickCount64)
                .Select(p => p.LoudnessFrame).OfType<AudioLoudnessFrame>().ToArray();
        }).ToArray();
    }

    private AudioLoudnessFrame EmptyLoudness(string key, string state, string device) =>
        new(key, Interlocked.Increment(ref _sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state, device, "", 0, 0, null);

    private AudioStereoFrame EmptyStereo(string key, string state, string device) =>
        new(key, Interlocked.Increment(ref _sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state,
            device, "", 0, 0, 100, [], null, null, null, null, null);

    private AudioWaveformFrame EmptyWave(string key, string state, string device, int interval) =>
        new(key, Interlocked.Increment(ref _sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state,
            device, "", 0, 0, interval, [], []);

    private AudioSpectrumFrame Empty(string key, string state, string device, int fft, int average) =>
        new(key, Interlocked.Increment(ref _sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state,
            device, "", 0, 0, fft, average, 0, [], []);

    private void Maintain()
    {
        lock (_gate)
        {
            if (_disposed) return;
            foreach (var (key, feed) in _feeds.ToArray())
            {
                lock (feed.Gate)
                {
                    foreach (var stale in feed.Profiles.Where(p => p.Value.WantedUntil <= Environment.TickCount64).Select(p => p.Key).ToArray())
                        feed.Profiles.Remove(stale);
                    if (feed.Profiles.Count == 0) { feed.Stop(); _feeds.Remove(key); continue; }
                }
                try { feed.Maintain(); }
                catch (Exception ex) { _log.LogDebug("audio spectrum: {Message}", ex.Message); }
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true; _timer.Dispose();
            foreach (var f in _feeds.Values) f.Stop();
            _feeds.Clear();
        }
    }

    private sealed class Profile(string key, int fft, int average, int interval, bool stereo, bool loudness)
    {
        public readonly string Key = key;
        public readonly int Fft = fft, Average = average, Interval = interval;
        public AudioWaveformFrame? WaveFrame;
        public readonly bool Stereo = stereo, Loudness = loudness;
        public AudioLoudnessFrame? LoudnessFrame;
        public AudioStereoFrame? StereoFrame;
        public long WantedUntil;
        public AudioSpectrumFrame? Frame;
#if WINDOWS
        public AudioSpectrumDsp? Dsp;
        public AudioWaveformDsp? Wave;
        public AudioStereoDsp? Field;
        public AudioLoudnessDsp? Meter;
        public long NextSample;
#endif
    }

    private sealed class Feed(AudioSpectrum owner, string device)
    {
        public readonly Lock Gate = new();
        public readonly Dictionary<string, Profile> Profiles = new();
        public string State = "unsupported";
#if WINDOWS
        private WasapiLoopbackCapture? _capture;
        private string _actualDevice = "", _name = "";
        private int _rate, _channels, _position;
        private long _samples, _lastAudio, _waveTime, _retryAt, _checkAt;
        private readonly float[] _left = new float[16384], _right = new float[16384];
        private readonly float[] _workL = new float[16384], _workR = new float[16384];

        public void EnsureStarted()
        {
            lock (Gate)
            {
                if (_capture is not null || Environment.TickCount64 < _retryAt) return;
                _retryAt = Environment.TickCount64 + 2000;
                MMDevice? endpoint = null;
                WasapiLoopbackCapture? capture = null;
                try
                {
                    using var devices = new MMDeviceEnumerator();
                    endpoint = device.Length == 0 ? devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia) : devices.GetDevice(device);
                    _actualDevice = endpoint.ID; _name = endpoint.FriendlyName;
                    capture = new WasapiLoopbackCapture(endpoint);
                    var format = capture.WaveFormat;
                    var encoding = (format is WaveFormatExtensible ext ? ext.ToStandardWaveFormat() : format).Encoding;
                    if (format.Channels is < 1 or > 2) throw new NotSupportedException("Select a mono or stereo output");
                    if (!(encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32)
                        && !(encoding == WaveFormatEncoding.Pcm && format.BitsPerSample is 16 or 24 or 32))
                        throw new NotSupportedException("Unsupported sample format");
                    _rate = format.SampleRate; _channels = format.Channels;
                    _position = 0; _samples = 0; _lastAudio = _waveTime = Environment.TickCount64;
                    Array.Clear(_left); Array.Clear(_right);
                    foreach (var p in Profiles.Values) { p.Dsp = null; p.Wave = null; p.Field = null; p.Meter = null; p.LoudnessFrame = null; p.StereoFrame = null; p.NextSample = p.Interval > 0 || p.Stereo || p.Loudness ? 0 : p.Fft; p.Frame = null; p.WaveFrame = null; }
                    var started = capture; var startedOn = endpoint;
                    capture.DataAvailable += (_, e) =>
                    {
                        lock (Gate)
                        {
                            if (_capture != started) return;
                            var sampleBytes = format.BitsPerSample / 8;
                            float Read(int offset) => encoding == WaveFormatEncoding.IeeeFloat ? BitConverter.ToSingle(e.Buffer, offset)
                                : sampleBytes == 2 ? BitConverter.ToInt16(e.Buffer, offset) / 32768f
                                : sampleBytes == 3 ? ((e.Buffer[offset] | e.Buffer[offset + 1] << 8 | e.Buffer[offset + 2] << 16) << 8 >> 8) / 8388608f
                                : BitConverter.ToInt32(e.Buffer, offset) / 2147483648f;
                            for (var offset = 0; offset + format.BlockAlign <= e.BytesRecorded; offset += format.BlockAlign)
                            {
                                _left[_position] = Read(offset);
                                _right[_position] = _channels == 1 ? _left[_position] : Read(offset + sampleBytes);
                                _position = (_position + 1) % _left.Length; _samples++;
                                foreach (var p in Profiles.Values)
                                {
                                    if (p.WantedUntil <= Environment.TickCount64) continue;
                                    if (p.Loudness)
                                    {
                                        p.Meter ??= new AudioLoudnessDsp(_rate, _channels);
                                        var previous = (_position - 1 + _left.Length) % _left.Length;
                                        p.Meter.Add(_left[previous], _right[previous]);
                                        if (_samples >= p.NextSample)
                                        {
                                            p.NextSample = _samples + Math.Max(1, _rate / 10);
                                            p.LoudnessFrame = MakeLoudnessFrame(p, "live");
                                        }
                                        continue;
                                    }
                                    if (p.Stereo)
                                    {
                                        p.Field ??= new AudioStereoDsp(_rate);
                                        var previous = (_position - 1 + _left.Length) % _left.Length;
                                        p.Field.Add(_left[previous], _right[previous]);
                                        if (_samples >= p.NextSample)
                                        {
                                            p.NextSample = _samples + Math.Max(1, _rate / 30);
                                            p.StereoFrame = MakeStereoFrame(p, "live");
                                        }
                                        continue;
                                    }
                                    if (p.Interval > 0)
                                    {
                                        p.Wave ??= new AudioWaveformDsp(_rate, p.Interval);
                                        var previous = (_position - 1 + _left.Length) % _left.Length;
                                        p.Wave.Add(_left[previous], _right[previous]);
                                        if (_samples >= p.NextSample)
                                        {
                                            p.NextSample = _samples + Math.Max(1, _rate / 30);
                                            p.WaveFrame = MakeWaveFrame(p, "live");
                                        }
                                        continue;
                                    }
                                    if (p.NextSample == 0) p.NextSample = _samples + p.Fft;
                                    if (_samples < p.NextSample) continue;
                                    var hop = Math.Max(1, _rate / 30);
                                    p.NextSample = _samples + hop;
                                    var start = (_position - p.Fft + _left.Length) % _left.Length;
                                    for (var i = 0; i < p.Fft; i++) { _workL[i] = _left[(start + i) % _left.Length]; _workR[i] = _right[(start + i) % _right.Length]; }
                                    p.Dsp ??= new AudioSpectrumDsp(p.Fft, _rate, p.Average);
                                    var curves = p.Dsp.Analyze(_workL.AsSpan(0, p.Fft), _workR.AsSpan(0, p.Fft), hop);
                                    p.Frame = MakeFrame(p, "live", curves);
                                }
                            }
                            if (e.BytesRecorded > 0) _lastAudio = _waveTime = Environment.TickCount64;
                            State = "live";
                        }
                    };
                    capture.RecordingStopped += (_, e) =>
                    {
                        lock (Gate)
                        {
                            if (_capture == started) { _capture = null; SetState("unavailable"); }
                        }
                        started.Dispose(); startedOn.Dispose();
                    };
                    _capture = capture;
                    SetState("starting");
                    capture.StartRecording();
                }
                catch (Exception e)
                {
                    _capture = null; capture?.Dispose(); endpoint?.Dispose();
                    SetState(e is NotSupportedException ? "unsupported-format" : "unavailable");
                    owner._log.LogDebug("audio spectrum: cannot open output: {Message}", e.Message);
                }
            }
        }

        private AudioSpectrumFrame MakeFrame(Profile p, string state, float[][] curves) =>
            new(p.Key, Interlocked.Increment(ref owner._sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state,
                _actualDevice, _name, _rate, _channels, p.Fft, p.Average, (double)_rate / p.Fft,
                p.Dsp?.Frequencies ?? [], curves);

        private AudioLoudnessFrame MakeLoudnessFrame(Profile p, string state) =>
            new(p.Key, Interlocked.Increment(ref owner._sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state,
                _actualDevice, _name, _rate, _channels, p.Meter?.Snapshot());

        private AudioStereoFrame MakeStereoFrame(Profile p, string state)
        {
            var data = p.Field?.Snapshot();
            return new(p.Key, Interlocked.Increment(ref owner._sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state,
                _actualDevice, _name, _rate, _channels, 100, data?.Points ?? [], data?.Correlation,
                data?.LeftDb, data?.RightDb, data?.LeftShare, data?.MidShare);
        }

        private AudioWaveformFrame MakeWaveFrame(Profile p, string state)
        {
            var envelope = p.Wave?.Snapshot();
            return new(p.Key, Interlocked.Increment(ref owner._sequence), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state,
                _actualDevice, _name, _rate, _channels, p.Interval, envelope?.Min ?? [], envelope?.Max ?? []);
        }

        private void SetState(string state)
        {
            State = state;
            foreach (var p in Profiles.Values)
                if (p.Loudness) { p.Meter = null; p.LoudnessFrame = MakeLoudnessFrame(p, state); }
                else if (p.Stereo) { p.Field = null; p.StereoFrame = MakeStereoFrame(p, state); }
                else if (p.Interval > 0) p.WaveFrame = MakeWaveFrame(p, state); else p.Frame = MakeFrame(p, state, []);
        }

        public void Maintain()
        {
            lock (Gate)
            {
                if (_capture is not null && Environment.TickCount64 >= _checkAt)
                {
                    _checkAt = Environment.TickCount64 + 1000;
                    try
                    {
                        using var devices = new MMDeviceEnumerator();
                        using var endpoint = device.Length == 0 ? devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia) : devices.GetDevice(device);
                        if (endpoint.ID != _actualDevice || endpoint.State != DeviceState.Active) Stop();
                    }
                    catch { Stop(); }
                }
                if (_capture is not null && Environment.TickCount64 - _lastAudio > 250)
                {
                    var silentSamples = (int)Math.Min(10L * _rate, Math.Max(0, Environment.TickCount64 - _waveTime) * _rate / 1000);
                    foreach (var p in Profiles.Values.Where(p => p.Interval > 0))
                    {
                        p.Wave ??= new AudioWaveformDsp(_rate, p.Interval);
                        p.Wave.AddSilence(silentSamples);
                        p.WaveFrame = MakeWaveFrame(p, "silent");
                    }
                    foreach (var p in Profiles.Values.Where(p => p.Stereo))
                    {
                        p.Field ??= new AudioStereoDsp(_rate);
                        p.Field.AddSilence(silentSamples);
                        p.StereoFrame = MakeStereoFrame(p, "silent");
                    }
                    foreach (var p in Profiles.Values.Where(p => p.Loudness))
                    {
                        p.Meter ??= new AudioLoudnessDsp(_rate, _channels);
                        p.Meter.AddSilence(silentSamples);
                        p.LoudnessFrame = MakeLoudnessFrame(p, "silent");
                    }
                    _waveTime = Environment.TickCount64;
                    // WASAPI may deliver no callbacks in silence. Discard old samples before the next sound begins.
                    if (State != "silent")
                    {
                        Array.Clear(_left); Array.Clear(_right); _samples = 0; _position = 0;
                        foreach (var p in Profiles.Values) { p.Dsp = null; p.NextSample = p.Interval > 0 || p.Stereo || p.Loudness ? 0 : p.Fft; }
                    }
                    State = "silent";
                    foreach (var p in Profiles.Values.Where(p => p.Interval == 0 && !p.Stereo && !p.Loudness))
                    {
                        p.Dsp ??= new AudioSpectrumDsp(p.Fft, _rate, p.Average);
                        if (p.Frame?.State != "silent") p.Frame = MakeFrame(p, "silent", Enumerable.Range(0, 5)
                            .Select(_ => Enumerable.Repeat(AudioSpectrumDsp.FloorDb, AudioSpectrumDsp.Points).ToArray()).ToArray());
                    }
                }
                EnsureStarted();
            }
        }

        public void Stop()
        {
            lock (Gate)
            {
                var capture = _capture; _capture = null;
                SetState("stopped");
                // StopRecording only signals the worker; RecordingStopped releases its COM endpoint after the worker exits.
                capture?.StopRecording();
            }
        }
#else
        public void EnsureStarted()
        {
            lock (Gate) foreach (var p in Profiles.Values)
                if (p.Loudness) p.LoudnessFrame ??= owner.EmptyLoudness(p.Key, "unsupported", device);
                else if (p.Stereo) p.StereoFrame ??= owner.EmptyStereo(p.Key, "unsupported", device);
                else if (p.Interval > 0) p.WaveFrame ??= owner.EmptyWave(p.Key, "unsupported", device, p.Interval);
                else p.Frame ??= owner.Empty(p.Key, "unsupported", device, p.Fft, p.Average);
        }
        public void Maintain() { }
        public void Stop() { }
#endif
    }
}
