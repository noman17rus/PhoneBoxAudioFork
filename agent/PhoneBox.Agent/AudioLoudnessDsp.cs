namespace PhoneBox.Agent;

public sealed record AudioLoudnessValues(double?[] SamplePeak, double?[] Rms, double?[] TruePeak,
    double?[] MaxSamplePeak, double?[] MaxRms, double?[] MaxTruePeak,
    double? Momentary, double? ShortTerm, double? Integrated, double? MaxMomentary, double? MaxShortTerm,
    double Seconds);

public sealed record AudioLoudnessFrame(string Key, long Sequence, long Timestamp, string State,
    string Device, string DeviceName, int SampleRate, int Channels, AudioLoudnessValues? Values);

/// <summary>BS.1770 K-weighting and EBU rectangular windows/gating, for mono or stereo PCM.
/// Sample peak / true peak cover each publication interval; RMS uses a 400 ms window.
/// All maxima cover the session. Null denotes digital silence or an incomplete loudness window.</summary>
internal sealed class AudioLoudnessDsp
{
    private readonly int _rate, _channels, _moment, _short, _hop;
    private readonly double[] _weighted, _rawL, _rawR;
    private readonly KFilter[] _filters;
    private readonly TruePeakFilter[] _tp = [new(), new()];
    private readonly double[] _peak = new double[2], _truePeak = new double[2],
        _maxPeak = new double[2], _maxRms = new double[2], _maxTp = new double[2];
    // Exact block energies, not a quantized histogram. 288 KB per hour, discarded on reset/lease expiry.
    private readonly List<double> _blocks = [];
    private double _mSum, _sSum, _lSum, _rSum, _maxM, _maxS, _absoluteSum;
    private long _samples, _integratedAt = -1;
    private double? _integrated;
    private int _position;

    internal AudioLoudnessDsp(int rate, int channels = 2)
    {
        if (rate is < 8000 or > 384000) throw new ArgumentOutOfRangeException(nameof(rate));
        if (channels is < 1 or > 2) throw new ArgumentOutOfRangeException(nameof(channels));
        _rate = rate; _channels = channels;
        _moment = (int)Math.Round(rate * .4); _short = rate * 3; _hop = (int)Math.Round(rate * .1);
        _weighted = new double[_short]; _rawL = new double[_moment]; _rawR = new double[_moment];
        _filters = [new(rate), new(rate)];
    }

    internal void Add(float left, float right)
    {
        double l = float.IsFinite(left) ? left : 0, r = _channels == 1 ? 0 : float.IsFinite(right) ? right : 0;
        var rawIndex = (int)(_samples % _moment);
        _lSum += l * l - _rawL[rawIndex]; _rawL[rawIndex] = l * l;
        _rSum += r * r - _rawR[rawIndex]; _rawR[rawIndex] = r * r;
        var kl = _filters[0].Add(l); var kr = _filters[1].Add(r);
        var energy = kl * kl + kr * kr;
        _mSum += energy - _weighted[(_position - _moment + _short) % _short];
        _sSum += energy - _weighted[_position];
        _weighted[_position] = energy; _position = (_position + 1) % _short;
        _samples++;
        _peak[0] = Math.Max(_peak[0], Math.Abs(l)); _peak[1] = Math.Max(_peak[1], Math.Abs(r));
        for (var c = 0; c < 2; c++)
        {
            _truePeak[c] = Math.Max(_truePeak[c], _tp[c].Add(c == 0 ? l : r));
            _maxPeak[c] = Math.Max(_maxPeak[c], _peak[c]); _maxTp[c] = Math.Max(_maxTp[c], _truePeak[c]);
        }
        if (_samples >= _moment)
        {
            _maxM = Math.Max(_maxM, _mSum / _moment);
            _maxRms[0] = Math.Max(_maxRms[0], _lSum / _moment); _maxRms[1] = Math.Max(_maxRms[1], _rSum / _moment);
            if ((_samples - _moment) % _hop == 0)
            {
                var block = Math.Max(0, _mSum / _moment);
                if (Lufs(block) is > -70) { _blocks.Add(block); _absoluteSum += block; }
            }
        }
        if (_samples >= _short) _maxS = Math.Max(_maxS, _sSum / _short);
    }

    internal void AddSilence(int samples) { for (var i = 0; i < samples; i++) Add(0, 0); }

    // Drain only the interpolator's 24-sample latency at the end of an offline reference signal.
    internal void FinishTruePeak()
    {
        for (var i = 0; i < 48; i++) for (var c = 0; c < 2; c++)
        {
            _truePeak[c] = Math.Max(_truePeak[c], _tp[c].Add(0));
            _maxTp[c] = Math.Max(_maxTp[c], _truePeak[c]);
        }
    }

    internal AudioLoudnessValues Snapshot()
    {
        // Re-evaluate the relative gate from ALL absolute-gated blocks, at least once per second.
        if (_integratedAt < 0 || _samples - _integratedAt >= _rate)
        {
            _integratedAt = _samples;
            if (_blocks.Count > 0)
            {
                var threshold = _absoluteSum / _blocks.Count * .1;
                double sum = 0; var count = 0;
                foreach (var block in _blocks) if (block > threshold) { sum += block; count++; }
                _integrated = count > 0 ? Lufs(sum / count) : null;
            }
        }
        var countRaw = Math.Min(_samples, _moment);
        var values = new AudioLoudnessValues(_peak.Select(AmplitudeDb).ToArray(),
            [PowerDb(countRaw > 0 ? _lSum / countRaw : 0), PowerDb(countRaw > 0 ? _rSum / countRaw : 0)],
            _truePeak.Select(AmplitudeDb).ToArray(), _maxPeak.Select(AmplitudeDb).ToArray(),
            _maxRms.Select(PowerDb).ToArray(), _maxTp.Select(AmplitudeDb).ToArray(),
            _samples >= _moment ? Lufs(_mSum / _moment) : null,
            _samples >= _short ? Lufs(_sSum / _short) : null, _integrated, Lufs(_maxM), Lufs(_maxS), (double)_samples / _rate);
        Array.Clear(_peak); Array.Clear(_truePeak);
        return values;
    }

    private static double? PowerDb(double value) => value > 1e-24 ? 10 * Math.Log10(value) : null;
    private static double? AmplitudeDb(double value) => value > 1e-12 ? 20 * Math.Log10(value) : null;
    private static double? Lufs(double value) => PowerDb(value) is { } db ? db - .691 : null;

    private sealed class Biquad(double b0, double b1, double b2, double a1, double a2)
    {
        private double _z1, _z2;
        internal double Add(double x)
        {
            var y = b0 * x + _z1; _z1 = b1 * x - a1 * y + _z2; _z2 = b2 * x - a2 * y;
            return y;
        }
    }

    private sealed class KFilter
    {
        private readonly Biquad _shelf, _highPass;
        internal KFilter(int rate)
        {
            // Bilinear transform of the BS.1770 shelf and RLB prototypes, including non-48 kHz rates.
            var k = Math.Tan(Math.PI * 1681.974450955533 / rate);
            var vh = Math.Pow(10, 3.999843853973347 / 20); var vb = Math.Pow(vh, .4996667741545416);
            var q = .7071752369554196; var a = 1 + k / q + k * k;
            _shelf = new((vh + vb * k / q + k * k) / a, 2 * (k * k - vh) / a,
                (vh - vb * k / q + k * k) / a, 2 * (k * k - 1) / a, (1 - k / q + k * k) / a);
            k = Math.Tan(Math.PI * 38.13547087602444 / rate); q = .5003270373238773; a = 1 + k / q + k * k;
            // RLB numerator is [1, -2, 1], as specified, with no DC normalization factor.
            _highPass = new(1, -2, 1, 2 * (k * k - 1) / a, (1 - k / q + k * k) / a);
        }
        internal double Add(double x) => _highPass.Add(_shelf.Add(x));
    }

    private sealed class TruePeakFilter
    {
        // 4x reconstruction: 48-tap Blackman-windowed sinc per fractional phase.
        // Unity gain per phase; original samples also participate. Delay: 24 input samples.
        private static readonly double[][] Coefficients = Enumerable.Range(1, 3).Select(phase =>
        {
            var taps = Enumerable.Range(0, 48).Select(i =>
            {
                var x = i - 24 + phase / 4.0;
                return Math.Sin(Math.PI * x) / (Math.PI * x) * (.42 + .5 * Math.Cos(Math.PI * x / 24) + .08 * Math.Cos(2 * Math.PI * x / 24));
            }).ToArray();
            var sum = taps.Sum(); return taps.Select(v => v / sum).ToArray();
        }).ToArray();
        private readonly double[] _history = new double[96];
        private int _position;
        internal double Add(double x)
        {
            _position = (_position + 47) % 48; _history[_position] = _history[_position + 48] = x;
            var peak = Math.Abs(x);
            foreach (var phase in Coefficients)
            {
                double y = 0;
                for (var i = 0; i < 48; i++) y += _history[_position + i] * phase[i];
                peak = Math.Max(peak, Math.Abs(y));
            }
            return peak;
        }
    }
}
