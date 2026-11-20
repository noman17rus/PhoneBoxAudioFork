namespace PhoneBox.Agent;

public sealed record AudioStereoFrame(string Key, long Sequence, long Timestamp, string State,
    string Device, string DeviceName, int SampleRate, int Channels, int WindowMs, float[][] Points,
    double? Correlation, double? LeftDb, double? RightDb, double? LeftShare, double? MidShare);

/// <summary>Exact rolling 100 ms energy measurements; display coordinates are Side, Mid.</summary>
internal sealed class AudioStereoDsp
{
    private readonly float[] _left, _right;
    private int _position, _count;
    internal AudioStereoDsp(int rate)
    {
        if (rate is < 8000 or > 384000) throw new ArgumentOutOfRangeException(nameof(rate));
        _left = new float[rate / 10]; _right = new float[rate / 10];
    }

    internal void Add(float left, float right)
    {
        _left[_position] = float.IsFinite(left) ? left : 0;
        _right[_position] = float.IsFinite(right) ? right : 0;
        _position = (_position + 1) % _left.Length;
        _count = Math.Min(_count + 1, _left.Length);
    }

    internal void AddSilence(int samples)
    {
        for (var i = 0; i < Math.Min(samples, _left.Length); i++) Add(0, 0);
    }

    internal (float[][] Points, double? Correlation, double? LeftDb, double? RightDb, double? LeftShare, double? MidShare) Snapshot()
    {
        double l = 0, r = 0, cross = 0, mid = 0, side = 0;
        for (var i = 0; i < _left.Length; i++)
        {
            double a = _left[i], b = _right[i];
            l += a * a; r += b * b; cross += a * b;
            mid += Math.Pow((a + b) / 2, 2); side += Math.Pow((a - b) / 2, 2);
        }
        var count = Math.Min(512, _count);
        var points = new float[count][];
        for (var i = 0; i < count; i++)
        {
            var index = (_position - _count + i * _count / count + _left.Length) % _left.Length;
            points[i] = [_left[index] / 2 - _right[index] / 2, _left[index] / 2 + _right[index] / 2];
        }
        const double epsilon = 1e-20;
        return (points, l > epsilon && r > epsilon ? Math.Clamp(cross / Math.Sqrt(l * r), -1, 1) : null,
            l > epsilon ? 10 * Math.Log10(l / Math.Max(1, _count)) : null,
            r > epsilon ? 10 * Math.Log10(r / Math.Max(1, _count)) : null,
            l + r > epsilon ? l / (l + r) : null, mid + side > epsilon ? mid / (mid + side) : null);
    }
}
