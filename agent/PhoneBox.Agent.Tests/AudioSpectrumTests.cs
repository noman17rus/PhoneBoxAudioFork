using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using PhoneBox.Agent;
using Xunit;

public sealed class AudioSpectrumTests
{
    private static float[] Tone(int size, int bin, float amplitude = .5f) =>
        Enumerable.Range(0, size).Select(i => amplitude * (float)Math.Sin(2 * Math.PI * bin * i / size)).ToArray();

    [Theory]
    [InlineData(4096, 44100)]
    [InlineData(8192, 48000)]
    [InlineData(16384, 96000)]
    public void CoherentToneHasCalibratedAmplitudeAndFrequency(int size, int rate)
    {
        var dsp = new AudioSpectrumDsp(size, rate, 0);
        var signal = Tone(size, 128);
        var curves = dsp.Analyze(signal, signal, rate / 30);
        Assert.Equal(5, curves.Length);
        Assert.InRange(curves[0].Max(), -6.12, -5.92);
        var frequency = dsp.Frequencies[Array.IndexOf(curves[0], curves[0].Max())];
        Assert.InRange(frequency, rate * 128.0 / size / 1.025, rate * 128.0 / size * 1.025);
        Assert.Equal(curves[0], curves[1]);
        Assert.Equal(curves[0], curves[2]);
        Assert.Equal(curves[0], curves[3]);
        Assert.All(curves[4], x => Assert.Equal(-140, x));
    }

    [Fact]
    public void AntiphaseDoesNotCancelPowerSpectrum()
    {
        var dsp = new AudioSpectrumDsp(8192, 48000, 0);
        var l = Tone(8192, 170);
        var r = l.Select(v => -v).ToArray();
        var curves = dsp.Analyze(l, r, 1600);
        Assert.InRange(curves[2].Max(), -6.12, -5.92);
        Assert.All(curves[3], x => Assert.Equal(-140, x));
        Assert.Equal(curves[0], curves[4]);
    }

    [Fact]
    public void SingleChannelHasHalfTheAveragePower()
    {
        var dsp = new AudioSpectrumDsp(8192, 48000, 0);
        var curves = dsp.Analyze(Tone(8192, 100), new float[8192], 1600);
        Assert.InRange(curves[2].Max() - curves[0].Max(), -3.11, -2.91);
        Assert.InRange(curves[3].Max() - curves[0].Max(), -6.12, -5.92);
        Assert.All(curves[1], x => Assert.Equal(-140, x));
    }

    [Fact]
    public void PowerAveragingUsesElapsedSamplesInsteadOfDisplayFrames()
    {
        var dsp = new AudioSpectrumDsp(8192, 48000, 1000);
        var tone = Tone(8192, 100);
        var initial = dsp.Analyze(tone, tone, 1600)[0].Max();
        var after = dsp.Analyze(new float[8192], new float[8192], 4800)[0].Max();
        Assert.InRange(after - initial, -.54, -.33); // 10 log10(exp(-0.1)) = -0.434 dB
    }

    [Theory]
    [InlineData(8000)]
    [InlineData(44100)]
    [InlineData(48000)]
    [InlineData(96000)]
    public void SilenceIsFiniteAndFrequencyAxisStopsAtNyquist(int rate)
    {
        var dsp = new AudioSpectrumDsp(4096, rate, 300);
        var signal = new float[4096]; signal[2] = float.NaN; signal[3] = float.PositiveInfinity;
        Assert.All(dsp.Analyze(signal, signal, rate / 30), curve => Assert.All(curve, v => Assert.Equal(-140, v)));
        Assert.Equal(20, dsp.Frequencies[0]);
        Assert.InRange(dsp.Frequencies[^1], Math.Min(20000, rate / 2.0) - .001, Math.Min(20000, rate / 2.0) + .001);
    }

    [Theory]
    [InlineData("{\"fft\":\"16384\",\"average\":\"0\"}", 16384, 0)]
    [InlineData("{\"fft\":4096,\"average\":1000}", 4096, 1000)]
    [InlineData("{\"fft\":123456,\"average\":-1}", 8192, 300)]
    [InlineData("{}", 8192, 300)]
    public void SavedOptionsAcceptEditorStringsAndBoundImportedValues(string json, int fft, int average)
    {
        var widget = new WidgetConfig { Options = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json) };
        Assert.Equal((fft, average), AudioSpectrum.Options(widget));
    }

    [Fact]
    public void RequestsRequireAnEnabledSavedWidgetAndLanPathsAreExact()
    {
        var directory = Path.Combine(Path.GetTempPath(), "phonebox-audio-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "config.json");
            File.WriteAllText(path, """{"pages":[{"id":"p","enabled":false,"widgets":[{"id":"s","type":"audio-spectrum"}]},{"id":"home","enabled":true,"widgets":[]}]}""");
            using var service = new AudioSpectrum(new ConfigStore(path), NullLogger<AudioSpectrum>.Instance);
            var response = JsonSerializer.SerializeToElement(service.Request(null, "p/s"));
            Assert.False(response.GetProperty("shown").GetBoolean());
            Assert.Empty(service.Frames());
            Assert.True(Lan.AllowedOverLan(new PathString("/api/audio-spectrum")));
            Assert.False(Lan.AllowedOverLan(new PathString("/api/audio-spectrum/raw")));
        }
        finally { Directory.Delete(directory, true); }
    }
}
