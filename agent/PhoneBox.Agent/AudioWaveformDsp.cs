namespace PhoneBox.Agent;

public sealed record AudioWaveformFrame(string Key, long Sequence, long Timestamp, string State,
    string Device, string DeviceName, int SampleRate, int Channels, int IntervalMs, float[][] Min, float[][] Max);

/// <summary>Sample-timed envelope ring; every sample contributes, including one-sample peaks.</summary>
internal sealed class AudioWaveformDsp
{
    internal static int Interval(int value) => value is 10 or 50 or 100 or 500 or 1000 or 5000 or 10000 ? value : 1000;
    private readonly int _samples, _points;
    private readonly float[][] _min, _max;
    private readonly float[] _lo = new float[4], _hi = new float[4];
    private int _position, _phase, _inBucket;

    internal AudioWaveformDsp(int rate, int interval)
    {
        if (rate is < 8000 or > 384000) throw new ArgumentOutOfRangeException(nameof(rate));
        _samples = rate * Interval(interval) / 1000;
        _points = Math.Min(512, _samples);
        _min = Enumerable.Range(0, 4).Select(_ => new float[_points]).ToArray();
        _max = Enumerable.Range(0, 4).Select(_ => new float[_points]).ToArray();
    }

    internal void Add(float left, float right)
    {
        left = float.IsFinite(left) ? left : 0;
        right = float.IsFinite(right) ? right : 0;
        Span<float> values = stackalloc float[] { left, right, left / 2 + right / 2, left / 2 - right / 2 };
        for (var c = 0; c < 4; c++)
        {
            _lo[c] = _inBucket == 0 ? values[c] : Math.Min(_lo[c], values[c]);
            _hi[c] = _inBucket == 0 ? values[c] : Math.Max(_hi[c], values[c]);
        }
        _inBucket++;
        // Bucket lengths differ by at most one sample and repeat every complete window.
        var length = (int)((long)(_phase + 1) * _samples / _points - (long)_phase * _samples / _points);
        if (_inBucket < length) return;
        for (var c = 0; c < 4; c++) { _min[c][_position] = _lo[c]; _max[c][_position] = _hi[c]; }
        _position = (_position + 1) % _points;
        _phase = (_phase + 1) % _points;
        _inBucket = 0;
    }

    internal void AddSilence(int samples)
    {
        // At most one complete window is needed to retire all previous peaks.
        for (var i = 0; i < Math.Min(samples, _samples); i++) Add(0, 0);
    }

    internal (float[][] Min, float[][] Max) Snapshot()
    {
        float[][] Copy(float[][] source) => source.Select(channel => Enumerable.Range(0, _points)
            .Select(i => channel[(_position + i) % _points]).ToArray()).ToArray();
        return (Copy(_min), Copy(_max));
    }
}
