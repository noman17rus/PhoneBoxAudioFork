using Microsoft.AspNetCore.Http;
using PhoneBox.Agent;
using Xunit;

public sealed class YouTubeRelayTests : IDisposable
{
    private const string Extension = "abcdefghijklmnopabcdefghijklmnop";
    private readonly string dir = Path.Combine(Path.GetTempPath(), "phonebox-youtube-" + Guid.NewGuid().ToString("N"));
    private readonly TestClock clock = new();
    private readonly YouTubeRelay relay;
    private readonly string token;
    private static readonly byte[] Jpeg = [0xff, 0xd8, 1, 0xff, 0xd9];
    private readonly string session = Guid.NewGuid().ToString();
    public YouTubeRelayTests()
    {
        Directory.CreateDirectory(dir);
        relay = new(Path.Combine(dir, "extension.json"), clock);
        token = relay.Claim(Extension, relay.BeginPairing().Code)!;
    }
    private YouTubeStatus Status(bool hidden = true, long revision = 1, string? id = null) =>
        new(id ?? session, revision, hidden, "Video", true, true, false, true, null);

    [Fact]
    public void PairingIsOneUseExpiresAndLimitsGuesses()
    {
        var code = relay.BeginPairing().Code;
        for (var i = 0; i < 5; i++) Assert.Null(relay.Claim(Extension, "wrong"));
        Assert.Null(relay.Claim(Extension, code));
        code = relay.BeginPairing().Code;
        clock.Advance(121);
        Assert.Null(relay.Claim(Extension, code));
        code = relay.BeginPairing().Code;
        Assert.NotNull(relay.Claim(Extension, code));
        Assert.Null(relay.Claim(Extension, code));
    }

    [Fact]
    public void CredentialsPersistAreScopedAndCanBeRevoked()
    {
        var reloaded = new YouTubeRelay(Path.Combine(dir, "extension.json"), clock);
        Assert.True(reloaded.Authorize(Extension, "Bearer " + token));
        Assert.False(reloaded.Authorize(new string('a', 32), "Bearer " + token));
        Assert.False(reloaded.Authorize(Extension, "Bearer incorrect"));
        Assert.DoesNotContain(token, File.ReadAllText(Path.Combine(dir, "extension.json")));
        reloaded.Revoke();
        Assert.False(reloaded.Authorize(Extension, "Bearer " + token));
        Assert.False(new YouTubeRelay(Path.Combine(dir, "extension.json")).Paired);
    }

    [Fact]
    public void ExtensionCannotImpersonateAPageOrUseAPhoneKey()
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Path = "/api/youtube/extension/poll";
        ctx.Request.Headers["X-PhoneBox-Extension"] = Extension;
        ctx.Request.Headers.Authorization = "Bearer " + token;
        Assert.True(YouTubeEndpoints.AllowExtension(ctx.Request, relay));
        ctx.Request.Headers.Origin = "https://www.youtube.com";
        Assert.False(YouTubeEndpoints.AllowExtension(ctx.Request, relay));
        ctx.Request.Headers.Origin = "chrome-extension://" + Extension;
        Assert.True(YouTubeEndpoints.AllowExtension(ctx.Request, relay));
        ctx.Request.Headers.Authorization = "Bearer phone-token";
        Assert.False(YouTubeEndpoints.AllowExtension(ctx.Request, relay));
        Assert.False(Lan.AllowedOverLan("/api/youtube/extension/poll"));
        Assert.False(Lan.AllowedOverLan("/api/youtube/pair/start"));
        Assert.True(Lan.AllowedOverLan("/api/youtube/frame"));
        Assert.False(YouTubeRelay.ValidExtension("../../settings"));
    }

    [Fact]
    public async Task LatestFrameWinsAndReturningToTabInvalidatesInFlightFrames()
    {
        relay.Poll(Status());
        Assert.False(relay.PutFrame(session, 1, Jpeg)); // No visible phone viewer.
        relay.Snapshot(viewer: true);
        Assert.True(relay.PutFrame(session, 1, Jpeg));
        byte[] newer = [0xff, 0xd8, 2, 0xff, 0xd9];
        Assert.True(relay.PutFrame(session, 1, newer));
        var picture = await relay.ReadFrame(0, default);
        Assert.Equal(2, picture!.Sequence);
        Assert.Same(newer, picture.Bytes);
        relay.Poll(Status(hidden: false, revision: 2));
        Assert.Equal("pc", relay.Snapshot().State);
        Assert.False(relay.PutFrame(session, 1, Jpeg));
        Assert.Null(await relay.ReadFrame(0, default));
        relay.Poll(Status(revision: 3));
        Assert.False(relay.PutFrame(session, 1, Jpeg));
        Assert.True(relay.PutFrame(session, 3, Jpeg));
    }

    [Fact]
    public async Task DisconnectAndSessionReplacementNeverExposeOldPicturesOrCommands()
    {
        relay.Snapshot(viewer: true);
        relay.Poll(Status());
        Assert.True(relay.PutFrame(session, 1, Jpeg));
        Assert.True(relay.Command("next"));
        var next = Guid.NewGuid().ToString();
        var result = System.Text.Json.JsonSerializer.Serialize(relay.Poll(Status(id: next)));
        Assert.Contains("\"commands\":[]", result);
        Assert.False(relay.PutFrame(session, 1, Jpeg));
        Assert.Null(await relay.ReadFrame(0, default));
        Assert.True(relay.PutFrame(next, 1, Jpeg));
        clock.Advance(4);
        Assert.Equal("disconnected", relay.Snapshot().State);
        Assert.False(relay.Command("playpause"));
        Assert.Null(await relay.ReadFrame(0, default));
    }

    [Fact]
    public void CommandsAreBoundedExpireAndAreNeverReplayed()
    {
        relay.Poll(Status());
        Assert.False(relay.Command("previous"));
        Assert.False(relay.Command("run-shell"));
        Assert.True(relay.Command("playpause"));
        var first = System.Text.Json.JsonSerializer.Serialize(relay.Poll(Status()));
        Assert.Contains("playpause", first);
        Assert.DoesNotContain("playpause", System.Text.Json.JsonSerializer.Serialize(relay.Poll(Status())));
        for (var i = 0; i < 8; i++) Assert.True(relay.Command("next"));
        Assert.False(relay.Command("next"));
        clock.Advance(2.1);
        Assert.DoesNotContain("\"Action\"", System.Text.Json.JsonSerializer.Serialize(relay.Poll(Status())));
    }

    [Fact]
    public async Task FrameWaitWakesOnNewPictureAndSupportsCancellation()
    {
        relay.Poll(Status());
        var waiting = relay.ReadFrame(0, default);
        Assert.False(waiting.IsCompleted);
        Assert.True(relay.PutFrame(session, 1, Jpeg));
        Assert.Equal(1, (await waiting)!.Sequence);
        using var cancelled = new CancellationTokenSource();
        var pending = relay.ReadFrame(1, cancelled.Token);
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
    }

    [Fact]
    public void InvalidOrOversizedFramesAndExpiredViewersAreRejected()
    {
        relay.Poll(Status()); relay.Snapshot(viewer: true);
        Assert.False(relay.PutFrame(session, 1, [1, 2, 3, 4]));
        Assert.False(relay.PutFrame(session, 1, new byte[YouTubeRelay.MaxFrameBytes + 1]));
        clock.Advance(2.1);
        Assert.False(relay.PutFrame(session, 1, Jpeg));
    }

    public void Dispose() { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(double seconds) => now = now.AddSeconds(seconds);
    }
}
