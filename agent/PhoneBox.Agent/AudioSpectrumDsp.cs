namespace PhoneBox.Agent;

/// <summary>Calibrated, fixed-scale spectra. No slope, automatic gain or display scaling enters these measurements.</summary>
internal sealed class AudioSpectrumDsp
{
    internal const int Points = 512;
    internal const float FloorDb = -140;
    private readonly int _size, _rate;
    private readonly double _averageMs, _scale;
    private readonly double[] _window, _lr, _li, _rr, _ri;
    private readonly double[][] _power;
    private bool _initialized;
    internal readonly double[] Frequencies;

    internal AudioSpectrumDsp(int size, int rate, double averageMs)
    {
        if (size is not (4096 or 8192 or 16384)) throw new ArgumentOutOfRangeException(nameof(size));
        if (rate < 8000 || rate > 384000) throw new ArgumentOutOfRangeException(nameof(rate));
        _size = size; _rate = rate; _averageMs = Math.Clamp(averageMs, 0, 5000);
        _window = Enumerable.Range(0, size).Select(i => .5 * (1 - Math.Cos(2 * Math.PI * i / (size - 1)))).ToArray();
        _scale = 4 / Math.Pow(_window.Sum(), 2); // sine peak amplitude squared: (2 |X| / sum(Hann))²
        _lr = new double[size]; _li = new double[size]; _rr = new double[size]; _ri = new double[size];
        _power = Enumerable.Range(0, 5).Select(_ => new double[size / 2 + 1]).ToArray();
        var top = Math.Min(20000, rate / 2.0);
        Frequencies = Enumerable.Range(0, Points).Select(i => 20 * Math.Pow(top / 20, i / (double)(Points - 1))).ToArray();
    }

    // L, R, average channel power, Mid=(L+R)/2, Side=(L-R)/2. Average powers before converting to decibels.
    internal float[][] Analyze(ReadOnlySpan<float> left, ReadOnlySpan<float> right, int elapsedSamples)
    {
        if (left.Length != _size || right.Length != _size) throw new ArgumentException("A full stereo FFT window is required");
        for (var i = 0; i < _size; i++)
        {
            _lr[i] = (float.IsFinite(left[i]) ? left[i] : 0) * _window[i];
            _rr[i] = (float.IsFinite(right[i]) ? right[i] : 0) * _window[i];
        }
        Array.Clear(_li); Array.Clear(_ri);
        SpectrumAnalyzer.Fft(_lr, _li); SpectrumAnalyzer.Fft(_rr, _ri);
        var alpha = !_initialized || _averageMs <= 0 ? 1 : 1 - Math.Exp(-1000.0 * elapsedSamples / (_rate * _averageMs));
        for (var i = 0; i <= _size / 2; i++)
        {
            var scale = i == 0 || i == _size / 2 ? _scale / 4 : _scale;
            var l = (_lr[i] * _lr[i] + _li[i] * _li[i]) * scale;
            var r = (_rr[i] * _rr[i] + _ri[i] * _ri[i]) * scale;
            var m = (Math.Pow(_lr[i] + _rr[i], 2) + Math.Pow(_li[i] + _ri[i], 2)) * scale / 4;
            var s = (Math.Pow(_lr[i] - _rr[i], 2) + Math.Pow(_li[i] - _ri[i], 2)) * scale / 4;
            _power[0][i] += alpha * (l - _power[0][i]);
            _power[1][i] += alpha * (r - _power[1][i]);
            _power[2][i] += alpha * ((l + r) / 2 - _power[2][i]);
            _power[3][i] += alpha * (m - _power[3][i]);
            _power[4][i] += alpha * (s - _power[4][i]);
        }
        _initialized = true;
        var result = Enumerable.Range(0, 5).Select(_ => new float[Points]).ToArray();
        for (var b = 0; b < Points; b++)
        {
            // Peak-bin reduction preserves narrow tones; below the FFT resolution neighbouring display points share a bin.
            var lo = b == 0 ? 20 : Math.Sqrt(Frequencies[b - 1] * Frequencies[b]);
            var hi = b == Points - 1 ? Frequencies[b] : Math.Sqrt(Frequencies[b] * Frequencies[b + 1]);
            var first = Math.Clamp((int)Math.Ceiling(lo * _size / _rate), 1, _size / 2);
            var last = Math.Clamp((int)Math.Floor(hi * _size / _rate), 1, _size / 2);
            if (first > last) first = last = Math.Clamp((int)Math.Round(Frequencies[b] * _size / _rate), 1, _size / 2);
            for (var c = 0; c < 5; c++)
            {
                double peak = 0;
                for (var i = first; i <= last; i++) peak = Math.Max(peak, _power[c][i]);
                result[c][b] = (float)Math.Round(Math.Max(FloorDb, 10 * Math.Log10(Math.Max(1e-14, peak))), 1);
            }
        }
        return result;
    }
}
