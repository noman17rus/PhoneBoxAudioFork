using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using PhoneBox.Agent;
using Xunit;

public sealed class AudioWaveformTests
{
    [Theory]
    [InlineData(44100, 10)]
    [InlineData(48000, 1000)]
    [InlineData(96000, 10000)]
    public void SingleSamplePeaksSurviveWholeWindowAndExpire(int rate, int interval)
    {
        var dsp = new AudioWaveformDsp(rate, interval);
        var samples = rate * interval / 1000;
        for (var i = 0; i < samples; i++) dsp.Add(i == 7 ? 1.1f : 0, i == samples - 1 ? -1 : 0);
        var frame = dsp.Snapshot();
        Assert.Equal(Math.Min(512, samples), frame.Min[0].Length);
        Assert.Equal(1.1f, frame.Max[0].Max());
        Assert.Equal(-1, frame.Min[1].Min());
        dsp.AddSilence(samples);
        Assert.All(dsp.Snapshot().Min.Concat(dsp.Snapshot().Max), c => Assert.All(c, v => Assert.Equal(0, v)));
    }

    [Fact]
    public void MidSideIsComputedBeforeExtremaAndRingRemainsChronological()
    {
        var dsp = new AudioWaveformDsp(48000, 1000);
        for (var i = 0; i < 48000; i++) dsp.Add(i % 2 == 0 ? 1 : -1, i % 2 == 0 ? -1 : 1);
        var frame = dsp.Snapshot();
        Assert.All(frame.Min[2].Concat(frame.Max[2]), v => Assert.Equal(0, v));
        Assert.All(frame.Min[3], v => Assert.Equal(-1, v));
        Assert.All(frame.Max[3], v => Assert.Equal(1, v));
        dsp.AddSilence(24000);
        frame = dsp.Snapshot();
        Assert.All(frame.Max[0].Take(256), v => Assert.Equal(1, v));
        Assert.All(frame.Max[0].Skip(256), v => Assert.Equal(0, v));
    }

    [Fact]
    public void NonFiniteSamplesAreSanitizedAndSnapshotsAreIndependent()
    {
        var dsp = new AudioWaveformDsp(48000, 10);
        dsp.Add(float.NaN, float.PositiveInfinity);
        var frozen = dsp.Snapshot();
        dsp.Add(1, 1);
        Assert.All(frozen.Min.Concat(frozen.Max), c => Assert.All(c, v => Assert.Equal(0, v)));
        Assert.Equal(1, dsp.Snapshot().Max[2].Max());
    }

    [Theory]
    [InlineData(10, 10)] [InlineData(50, 50)] [InlineData(100, 100)] [InlineData(500, 500)]
    [InlineData(1000, 1000)] [InlineData(5000, 5000)] [InlineData(10000, 10000)]
    [InlineData(-1, 1000)] [InlineData(int.MaxValue, 1000)]
    public void IntervalIsBounded(int input, int expected) => Assert.Equal(expected, AudioWaveformDsp.Interval(input));

    [Fact]
    public void WaveformRequestsAreGatedBySavedTypeAndEnabledPage()
    {
        var directory = Path.Combine(Path.GetTempPath(), "phonebox-wave-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "config.json");
            File.WriteAllText(path, """{"pages":[{"id":"p","widgets":[{"id":"w","type":"audio-waveform","options":{"interval":"5000"}},{"id":"s","type":"audio-spectrum"}]},{"id":"off","enabled":false,"widgets":[{"id":"w","type":"audio-waveform"}]}]}""");
            using var service = new AudioSpectrum(new ConfigStore(path), NullLogger<AudioSpectrum>.Instance);
            JsonElement Ask(string widget, int? interval = null) => JsonSerializer.SerializeToElement(service.RequestWaveform(null, widget, interval));
            Assert.False(Ask("p/s").GetProperty("shown").GetBoolean());
            Assert.False(Ask("off/w").GetProperty("shown").GetBoolean());
            Assert.False(Ask("p/missing").GetProperty("shown").GetBoolean());
            Assert.Equal("wave:5000:", Ask("p/w").GetProperty("key").GetString());
            Assert.Equal("wave:10:", Ask("p/w", 10).GetProperty("key").GetString());
            Assert.Equal("wave:1000:", Ask("p/w", int.MaxValue).GetProperty("key").GetString());
            Assert.Empty(service.Frames());
            Assert.True(Lan.AllowedOverLan(new PathString("/api/audio-waveform")));
            Assert.False(Lan.AllowedOverLan(new PathString("/api/audio-waveform/raw")));
        }
        finally { Directory.Delete(directory, true); }
    }
}
