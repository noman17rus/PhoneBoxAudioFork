using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using PhoneBox.Agent;
using Xunit;

public sealed class AudioStereoTests
{
    [Theory]
    [InlineData(1, 1, 1.0, 1, .5)]
    [InlineData(1, -1, -1.0, 0, .5)]
    [InlineData(1, 0, null, .5, 1)]
    [InlineData(0, 1, null, .5, 0)]
    [InlineData(1, .5, 1.0, .9, .8)]
    public void KnownSignalsHaveCorrectAxesAndEnergy(double left, double right, double? correlation, double mid, double balance)
    {
        var dsp = new AudioStereoDsp(48000);
        for (var i = 0; i < 4800; i++)
        {
            var signal = (float)Math.Sin(i * 2 * Math.PI / 48);
            dsp.Add(signal * (float)left, signal * (float)right);
        }
        var data = dsp.Snapshot();
        if (correlation is null) Assert.Null(data.Correlation);
        else Assert.Equal(correlation.Value, data.Correlation!.Value, 6);
        Assert.Equal(mid, data.MidShare!.Value, 6);
        Assert.Equal(balance, data.LeftShare!.Value, 6);
        Assert.Equal(512, data.Points.Length);
        if (left == right) Assert.All(data.Points, p => Assert.Equal(0, p[0]));
        if (left == -right) Assert.All(data.Points, p => Assert.Equal(0, p[1]));
        if (left == 1) Assert.Equal(-3.0103, data.LeftDb!.Value, 4);
        if (right == 0) Assert.All(data.Points, p => Assert.Equal(p[0], p[1]));
        if (left == 0) Assert.All(data.Points, p => Assert.Equal(-p[0], p[1]));
    }

    [Theory]
    [InlineData(44100)] [InlineData(48000)] [InlineData(96000)]
    public void OrthogonalSignalsAndSilenceAreWellDefined(int rate)
    {
        var dsp = new AudioStereoDsp(rate);
        for (var i = 0; i < rate / 10; i++)
        {
            var phase = i * 2 * Math.PI * 1000 / rate;
            dsp.Add((float)Math.Sin(phase), (float)Math.Cos(phase));
        }
        var data = dsp.Snapshot();
        Assert.Equal(0, data.Correlation!.Value, 6);
        Assert.Equal(.5, data.MidShare!.Value, 6);
        dsp.AddSilence(rate / 10);
        data = dsp.Snapshot();
        Assert.Null(data.Correlation); Assert.Null(data.LeftShare); Assert.Null(data.MidShare);
        Assert.Null(data.LeftDb); Assert.Null(data.RightDb);
        Assert.All(data.Points, p => Assert.All(p, v => Assert.Equal(0, v)));
        dsp.Add(float.NaN, float.PositiveInfinity);
        Assert.Null(dsp.Snapshot().Correlation);
    }

    [Fact]
    public void RequestsRequireAnEnabledSavedStereoWidget()
    {
        var directory = Path.Combine(Path.GetTempPath(), "phonebox-stereo-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "config.json");
            File.WriteAllText(path, """{"pages":[{"id":"p","widgets":[{"id":"w","type":"audio-stereo"},{"id":"s","type":"audio-spectrum"}]},{"id":"off","enabled":false,"widgets":[{"id":"w","type":"audio-stereo"}]}]}""");
            using var service = new AudioSpectrum(new ConfigStore(path), NullLogger<AudioSpectrum>.Instance);
            JsonElement Ask(string key) => JsonSerializer.SerializeToElement(service.RequestStereo(null, key));
            Assert.False(Ask("p/s").GetProperty("shown").GetBoolean());
            Assert.False(Ask("off/w").GetProperty("shown").GetBoolean());
            Assert.False(Ask("p/missing").GetProperty("shown").GetBoolean());
            Assert.Equal("stereo:", Ask("p/w").GetProperty("key").GetString());
            Assert.Empty(service.Frames()); Assert.Empty(service.WaveformFrames());
            Assert.True(Lan.AllowedOverLan(new PathString("/api/audio-stereo")));
            Assert.False(Lan.AllowedOverLan(new PathString("/api/audio-stereo/raw")));
        }
        finally { Directory.Delete(directory, true); }
    }
}
