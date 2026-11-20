using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using PhoneBox.Agent;
using Xunit;

public sealed class AudioLoudnessTests
{
    [Theory]
    [InlineData(44100)] [InlineData(48000)] [InlineData(96000)] [InlineData(192000)]
    public void CalibrationAndIndependentChannels(int rate)
    {
        var dsp = new AudioLoudnessDsp(rate);
        for (var i = 0; i < rate * 4; i++)
        {
            var s = (float)(Math.Sin(2 * Math.PI * 1000 * i / rate) * Math.Pow(10, -23 / 20.0));
            dsp.Add(s, s * .5f);
        }
        var v = dsp.Snapshot();
        Assert.InRange(v.SamplePeak[0]!.Value, -23.02, -22.999);
        Assert.InRange(v.Rms[0]!.Value, -26.011, -26.010);
        Assert.InRange(v.Rms[1]!.Value, -32.032, -32.030);
        Assert.InRange(v.Integrated!.Value, -25.15, -24.95); // stereo power = .625 of equal L/R
        Assert.InRange(v.ShortTerm!.Value, -25.15, -24.95);
        Assert.Equal(4, v.Seconds);
        Assert.InRange(v.MaxTruePeak[0]!.Value, -23.05, -22.95);
    }

    [Fact]
    public void InterSamplePeakAndSessionHoldsSurviveSilence()
    {
        var dsp = new AudioLoudnessDsp(48000);
        for (var i = 0; i < 48000 * 4; i++)
        {
            var fade = Math.Min(1, Math.Min(i, 48000 * 4 - 1 - i) / 480.0);
            var s = (float)(.5 * fade * Math.Sin(i * Math.PI / 2 + Math.PI / 4));
            dsp.Add(s, s * .5f);
        }
        var v = dsp.Snapshot();
        Assert.InRange(v.MaxSamplePeak[0]!.Value, -9.04, -9.02);
        Assert.InRange(v.MaxTruePeak[0]!.Value, -6.05, -5.99);
        var peak = v.MaxTruePeak[0]; var integrated = v.Integrated;
        dsp.AddSilence(48000 * 4);
        v = dsp.Snapshot();
        Assert.Equal(peak, v.MaxTruePeak[0]);
        Assert.InRange(v.Integrated!.Value, integrated!.Value - .5, integrated.Value + .1);
        Assert.True(v.Momentary is null or < -120);
        Assert.True(v.ShortTerm is null or < -120);
        var empty = new AudioLoudnessDsp(48000).Snapshot();
        Assert.Null(empty.Integrated); Assert.All(empty.MaxTruePeak, x => Assert.Null(x));
    }

    [Fact]
    public void MonoIsNotDuplicatedAndIncompleteBlocksAreDiscarded()
    {
        var dsp = new AudioLoudnessDsp(48000, 1);
        for (var i = 0; i < 19199; i++) dsp.Add(.1f, 100);
        var v = dsp.Snapshot(); Assert.Null(v.Integrated); Assert.Null(v.Momentary);
        Assert.Null(v.SamplePeak[1]);
        dsp.Add(float.NaN, float.PositiveInfinity);
        Assert.All(dsp.Snapshot().Rms, x => Assert.True(x is null || double.IsFinite(x.Value)));
        var mono = new AudioLoudnessDsp(48000, 1);
        for (var i = 0; i < 48000 * 4; i++) mono.Add((float)(.1 * Math.Sin(i * Math.PI / 24)), 1);
        Assert.InRange(mono.Snapshot().Integrated!.Value, -23.06, -22.96);
    }

    [Fact]
    public void SavedWidgetGatingSessionIsolationAndReset()
    {
        var directory = Path.Combine(Path.GetTempPath(), "phonebox-loudness-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "config.json");
            File.WriteAllText(path, """{"pages":[{"id":"p","widgets":[{"id":"a","type":"audio-loudness"},{"id":"b","type":"audio-loudness"},{"id":"s","type":"audio-stereo"}]},{"id":"off","enabled":false,"widgets":[{"id":"a","type":"audio-loudness"}]}]}""");
            using var service = new AudioSpectrum(new ConfigStore(path), NullLogger<AudioSpectrum>.Instance);
            JsonElement Ask(string key, bool reset = false) => JsonSerializer.SerializeToElement(service.RequestLoudness(null, key, reset));
            Assert.False(Ask("p/s", true).GetProperty("shown").GetBoolean());
            Assert.False(Ask("off/a").GetProperty("shown").GetBoolean());
            Assert.False(Ask("p/missing").GetProperty("shown").GetBoolean());
            var a = Ask("p/a"); var b = Ask("p/b");
            Assert.NotEqual(a.GetProperty("key").GetString(), b.GetProperty("key").GetString());
            var reset = Ask("p/a", true);
            Assert.True(reset.GetProperty("frame").GetProperty("Sequence").GetInt64() > a.GetProperty("frame").GetProperty("Sequence").GetInt64());
            Assert.Equal(b.GetProperty("frame").GetProperty("Sequence").GetInt64(), Ask("p/b").GetProperty("frame").GetProperty("Sequence").GetInt64());
            Assert.Empty(service.Frames()); Assert.Empty(service.WaveformFrames()); Assert.Empty(service.StereoFrames());
            Assert.True(Lan.AllowedOverLan(new PathString("/api/audio-loudness/reset")));
            Assert.False(Lan.AllowedOverLan(new PathString("/api/audio-loudness/raw")));
        }
        finally { Directory.Delete(directory, true); }
    }
}

// Reference WAVs are deliberately not redistributed. Set PHONEBOX_EBU_TEST_DIR to extracted EBU v05.
public sealed class EbuTheoryAttribute : TheoryAttribute
{
    public EbuTheoryAttribute()
    {
        if (!Directory.Exists(Environment.GetEnvironmentVariable("PHONEBOX_EBU_TEST_DIR")))
            Skip = "Set PHONEBOX_EBU_TEST_DIR to the official EBU loudness test set v05";
    }
}

public sealed class AudioLoudnessEbuTests
{
    [EbuTheory]
    [InlineData("seq-3341-1-16bit.wav", -23)]
    [InlineData("seq-3341-2-16bit.wav", -33)]
    [InlineData("seq-3341-3-16bit-v02.wav", -23)]
    [InlineData("seq-3341-4-16bit-v02.wav", -23)]
    [InlineData("seq-3341-5-16bit-v02.wav", -23)]
    [InlineData("seq-3341-7_seq-3342-5-24bit.wav", -23)]
    [InlineData("seq-3341-2011-8_seq-3342-6-24bit-v02.wav", -23)]
    public void IntegratedReference(string file, double expected)
    {
        var v = Analyze(file);
        Near(v.Integrated, expected, .1);
        if (file.StartsWith("seq-3341-1-") || file.StartsWith("seq-3341-2-"))
        { Near(v.Momentary, expected, .1); Near(v.ShortTerm, expected, .1); }
    }

    [EbuTheory]
    [InlineData(9, 3.0, false)] [InlineData(12, 1.0, true)]
    public void SlidingWindowsStayConstant(int test, double afterSeconds, bool momentary)
    {
        Analyze($"seq-3341-{test}-24bit.wav", (samples, rate, dsp) =>
        {
            if (samples >= afterSeconds * rate && samples % (rate / 10) == 0)
            { var v = dsp.Snapshot(); Near(momentary ? v.Momentary : v.ShortTerm, -23, .1); }
        });
    }

    [EbuTheory]
    [InlineData(10, false)] [InlineData(13, true)]
    public void AllTwentyOffsetsCaptureWindowMaximum(int test, bool momentary)
    {
        var directory = Environment.GetEnvironmentVariable("PHONEBOX_EBU_TEST_DIR")!;
        var files = Directory.GetFiles(directory, $"seq-3341-{test}-*-24bit.wav*");
        Assert.Equal(20, files.Length);
        foreach (var file in files)
        { var v = Analyze(Path.GetFileName(file)); Near(momentary ? v.MaxMomentary : v.MaxShortTerm, -23, .1); }
    }

    [EbuTheory]
    [InlineData("seq-3341-11-24bit.wav", 6, false)]
    [InlineData("seq-3341-14-24bit.wav.wav", .8, true)]
    public void LiveMaximaFollowAllTwentySuccessiveLevels(string file, double cycle, bool momentary)
    {
        var checkedLevels = 0;
        Analyze(file, (samples, rate, dsp) =>
        {
            var length = (int)Math.Round(cycle * rate);
            if (samples % length != 0) return;
            var v = dsp.Snapshot();
            Near(momentary ? v.MaxMomentary : v.MaxShortTerm, -38 + checkedLevels, .1);
            checkedLevels++;
        });
        Assert.Equal(20, checkedLevels);
    }

    [EbuTheory]
    [InlineData(15, -6)] [InlineData(16, -6)] [InlineData(17, -6)] [InlineData(18, -6)]
    [InlineData(19, 3)] [InlineData(20, 0)] [InlineData(21, 0)] [InlineData(22, 0)] [InlineData(23, 0)]
    public void TruePeakReferences(int test, double expected)
    {
        var v = Analyze($"seq-3341-{test}-24bit.wav.wav");
        foreach (var peak in v.MaxTruePeak) { Assert.NotNull(peak); Assert.InRange(peak.Value, expected - .4, expected + .2); }
    }

    private static void Near(double? actual, double expected, double tolerance)
    { Assert.NotNull(actual); Assert.InRange(actual.Value, expected - tolerance, expected + tolerance); }

    // Minimal chunk-aware PCM WAV reader, independent of the Windows capture decoder.
    private static AudioLoudnessValues Analyze(string file, Action<long, int, AudioLoudnessDsp>? observe = null, float gain = 1)
    {
        using var reader = new BinaryReader(File.OpenRead(Path.Combine(Environment.GetEnvironmentVariable("PHONEBOX_EBU_TEST_DIR")!, file)));
        Assert.Equal("RIFF", new string(reader.ReadChars(4))); reader.ReadUInt32(); Assert.Equal("WAVE", new string(reader.ReadChars(4)));
        int channels = 0, rate = 0, bits = 0;
        while (reader.BaseStream.Position + 8 <= reader.BaseStream.Length)
        {
            var chunk = new string(reader.ReadChars(4)); var length = reader.ReadUInt32(); var end = reader.BaseStream.Position + length;
            if (chunk == "fmt ")
            {
                Assert.Equal(1, reader.ReadUInt16()); channels = reader.ReadUInt16(); rate = reader.ReadInt32();
                reader.ReadUInt32(); reader.ReadUInt16(); bits = reader.ReadUInt16();
            }
            else if (chunk == "data")
            {
                Assert.Equal(2, channels); Assert.True(bits is 16 or 24);
                var dsp = new AudioLoudnessDsp(rate, channels); long samples = 0;
                float Read() => gain * (bits == 16 ? reader.ReadInt16() / 32768f
                    : ((reader.ReadByte() | reader.ReadByte() << 8 | reader.ReadByte() << 16) << 8 >> 8) / 8388608f);
                while (reader.BaseStream.Position < end) { dsp.Add(Read(), Read()); observe?.Invoke(++samples, rate, dsp); }
                dsp.FinishTruePeak(); return dsp.Snapshot();
            }
            reader.BaseStream.Position = end + (length & 1);
        }
        throw new InvalidDataException("No PCM data chunk");
    }
}
