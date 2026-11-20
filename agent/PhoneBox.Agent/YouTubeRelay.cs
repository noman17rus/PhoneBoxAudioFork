using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PhoneBox.Agent;

// Only the latest picture is retained. Audio never enters this relay.
public sealed class YouTubeRelay
{
    public const int MaxFrameBytes = 1024 * 1024;
    private readonly object gate = new();
    private readonly string credentialsPath;
    private readonly TimeProvider clock;
    private Credentials? credentials;
    private string? code;
    private DateTimeOffset codeExpires, lastSeen, lastFrame, viewerUntil;
    private int attempts;
    private YouTubeStatus? status;
    private byte[]? frame;
    private long sequence;
    private TaskCompletionSource changed = NewSignal();
    private readonly Queue<YouTubeCommand> commands = new();
    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private DateTimeOffset Now => clock.GetUtcNow();

    public YouTubeRelay(string credentialsPath, TimeProvider? clock = null)
    {
        this.credentialsPath = credentialsPath;
        this.clock = clock ?? TimeProvider.System;
        if (File.Exists(credentialsPath))
        {
            AppPaths.RestrictToOwner(credentialsPath);
            try { credentials = JsonSerializer.Deserialize<Credentials>(File.ReadAllText(credentialsPath)); }
            catch (Exception ex) when (ex is IOException or JsonException) { }
        }
    }

    public sealed record Credentials(string Extension, string Hash);
    public sealed record PairCode(string Code, DateTimeOffset Expires);
    public sealed record View(string State, string Title, bool Playing, bool CanPrevious, bool CanNext, long Sequence);
    public sealed record Picture(long Sequence, byte[] Bytes);

    public PairCode BeginPairing()
    {
        lock (gate)
        {
            code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
            codeExpires = Now.AddMinutes(2);
            attempts = 0;
            return new(code, codeExpires);
        }
    }

    public static bool ValidExtension(string? id) => id is not null && Regex.IsMatch(id, "\\A[a-p]{32}\\z");
    public static bool ExtensionOriginAllowed(string? origin, string? id) =>
        ValidExtension(id) && (string.IsNullOrEmpty(origin) || origin == "chrome-extension://" + id);

    public string? Claim(string extension, string? given)
    {
        lock (gate)
        {
            if (!ValidExtension(extension) || code is null || Now >= codeExpires || ++attempts > 5
                || !Lan.MatchesQuery(given, code)) return null;
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var next = new Credentials(extension, Hash(token));
            // Persist before replacing the live credentials, so a failed write does not half-pair.
            AppPaths.WriteAllTextPrivate(credentialsPath, JsonSerializer.Serialize(next));
            credentials = next;
            code = null;
            Reset();
            return token;
        }
    }

    private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    public bool Authorize(string extension, string? bearer)
    {
        lock (gate) return credentials?.Extension == extension && bearer is { Length: < 256 }
            && bearer.StartsWith("Bearer ", StringComparison.Ordinal) && Lan.MatchesQuery(Hash(bearer[7..]), credentials.Hash);
    }

    public bool Paired { get { lock (gate) return credentials is not null; } }
    public void Revoke()
    {
        lock (gate)
        {
            File.Delete(credentialsPath);
            credentials = null;
            code = null;
            Reset();
        }
    }

    private void Pulse() { var old = changed; changed = NewSignal(); old.TrySetResult(); }
    private void Reset() { status = null; frame = null; commands.Clear(); lastSeen = default; Pulse(); }
    public void Stop(string? session)
    {
        lock (gate) { if (status?.Session == session) Reset(); }
    }

    public object Poll(YouTubeStatus next)
    {
        lock (gate)
        {
            if (status?.Session != next.Session || status.Revision != next.Revision
                || !next.Hidden || !next.HasVideo || next.Error is not null)
            {
                frame = null;
                if (status?.Session != next.Session) commands.Clear();
                Pulse();
            }
            status = next;
            lastSeen = Now;
            var pending = commands.Where(c => c.Session == next.Session && c.Expires > Now).ToArray();
            commands.Clear(); // Never replay a toggle when a response is lost.
            return new { capture = next.Hidden && next.HasVideo && next.Error is null && viewerUntil > Now, commands = pending };
        }
    }

    public View Snapshot(bool viewer = false)
    {
        lock (gate)
        {
            if (viewer) viewerUntil = Now.AddSeconds(2);
            var connected = status is not null && Now - lastSeen < TimeSpan.FromSeconds(3);
            var state = !Paired ? "unpaired" : !connected ? "disconnected" : status!.Error is not null ? "capture-error"
                : !status.HasVideo ? "no-video" : !status.Hidden ? "pc" : "streaming";
            return new(state, connected ? status!.Title : "", connected && status!.Playing,
                connected && status!.CanPrevious, connected && status!.CanNext, sequence);
        }
    }

    public bool PutFrame(string session, long revision, byte[] bytes)
    {
        if (bytes.Length is < 4 or > MaxFrameBytes || bytes[0] != 0xff || bytes[1] != 0xd8
            || bytes[^2] != 0xff || bytes[^1] != 0xd9) return false;
        lock (gate)
        {
            if (status?.Session != session || status.Revision != revision || !status.Hidden || !status.HasVideo
                || status.Error is not null || Now - lastSeen >= TimeSpan.FromSeconds(3) || viewerUntil <= Now) return false;
            frame = bytes;
            sequence++;
            lastFrame = Now;
            Pulse();
            return true;
        }
    }

    public async Task<Picture?> ReadFrame(long after, CancellationToken ct)
    {
        Task signal;
        lock (gate)
        {
            viewerUntil = Now.AddSeconds(2);
            if (CurrentPicture(after) is { } picture) return picture;
            signal = changed.Task;
        }
        try { await signal.WaitAsync(TimeSpan.FromMilliseconds(750), ct); }
        catch (TimeoutException) { }
        lock (gate) return CurrentPicture(after);
    }

    private Picture? CurrentPicture(long after) => frame is not null && sequence > after
        && status is { Hidden: true, HasVideo: true, Error: null }
        && Now - lastSeen < TimeSpan.FromSeconds(3) && Now - lastFrame < TimeSpan.FromSeconds(1)
        ? new(sequence, frame) : null;

    public bool Command(string action)
    {
        lock (gate)
        {
            if (status is null || Now - lastSeen >= TimeSpan.FromSeconds(3) || !status.HasVideo || commands.Count >= 8
                || !(action == "playpause" || action == "previous" && status.CanPrevious || action == "next" && status.CanNext)) return false;
            commands.Enqueue(new(status.Session, action, Now.AddSeconds(2)));
            return true;
        }
    }
}

public sealed record YouTubeStatus(string Session, long Revision, bool Hidden, string Title, bool Playing,
    bool HasVideo, bool CanPrevious, bool CanNext, string? Error);
public sealed record YouTubeCommand(string Session, string Action, DateTimeOffset Expires);

public static class YouTubeEndpoints
{
    public static bool IsExtensionPath(PathString path) => path.StartsWithSegments("/api/youtube/extension");
    public static bool IsPhonePath(PathString path) => path == "/api/youtube/state" || path == "/api/youtube/frame" || path == "/api/youtube/command";

    // Called only on the loopback listener. The extension's key is deliberately scoped to these routes.
    public static bool AllowExtension(HttpRequest req, YouTubeRelay relay)
    {
        var id = req.Headers["X-PhoneBox-Extension"].ToString();
        return YouTubeRelay.ExtensionOriginAllowed(req.Headers.Origin, id)
            && (req.Method == "POST" && req.Path == "/api/youtube/extension/claim" || relay.Authorize(id, req.Headers.Authorization));
    }

    public static void MapYouTube(this WebApplication app)
    {
        app.MapPost("/api/youtube/pair/start", (YouTubeRelay relay) => Results.Json(relay.BeginPairing()));
        app.MapGet("/api/youtube/pair/status", (YouTubeRelay relay) => Results.Json(new { paired = relay.Paired }));
        app.MapPost("/api/youtube/pair/revoke", (YouTubeRelay relay) => { relay.Revoke(); return Results.Ok(); });
        app.MapPost("/api/youtube/extension/claim", (HttpRequest req, string? code, YouTubeRelay relay) =>
            relay.Claim(req.Headers["X-PhoneBox-Extension"].ToString(), code) is { } token ? Results.Json(new { token }) : Results.StatusCode(403));
        app.MapPost("/api/youtube/extension/poll", async (HttpRequest req, YouTubeRelay relay, CancellationToken ct) =>
        {
            var body = await req.ReadFromJsonAsync<YouTubeStatus>(ct);
            if (body is null || !Guid.TryParse(body.Session, out _) || body.Title is null || body.Title.Length > 512
                || body.Revision < 0 || body.Error is { Length: > 100 }) return Results.BadRequest();
            return Results.Json(relay.Poll(body));
        });
        app.MapPost("/api/youtube/extension/stop", (string? session, YouTubeRelay relay) => { relay.Stop(session); return Results.Ok(); });
        app.MapPost("/api/youtube/extension/frame", async (string session, long revision, HttpRequest req, YouTubeRelay relay, CancellationToken ct) =>
        {
            if (req.ContentType != "image/jpeg") return Results.StatusCode(415);
            using var bytes = new MemoryStream();
            var buffer = new byte[16 * 1024];
            int count;
            while ((count = await req.Body.ReadAsync(buffer, ct)) > 0)
            {
                if (bytes.Length + count > YouTubeRelay.MaxFrameBytes) return Results.StatusCode(413);
                bytes.Write(buffer, 0, count);
            }
            return relay.PutFrame(session, revision, bytes.ToArray()) ? Results.Ok() : Results.StatusCode(409);
        });

        bool Widget(HttpRequest req, ConfigStore cfg, string? widget) =>
            PanelWidgets.Find(cfg.Get(), req.Headers["X-PhoneBox-Device"], widget, "youtube") is not null;
        app.MapGet("/api/youtube/state", (string? widget, HttpRequest req, ConfigStore cfg, YouTubeRelay relay) =>
            Widget(req, cfg, widget) ? Results.Json(relay.Snapshot(viewer: true)) : Results.NotFound());
        app.MapGet("/api/youtube/frame", async (string? widget, long? after, HttpContext ctx, ConfigStore cfg, YouTubeRelay relay, CancellationToken ct) =>
        {
            if (!Widget(ctx.Request, cfg, widget)) return Results.NotFound();
            var frame = await relay.ReadFrame(after ?? 0, ct);
            if (frame is null) return Results.NoContent();
            ctx.Response.Headers["X-PhoneBox-Sequence"] = frame.Sequence.ToString();
            return Results.Bytes(frame.Bytes, "image/jpeg");
        });
        app.MapPost("/api/youtube/command", (string? widget, string? action, HttpRequest req, ConfigStore cfg, YouTubeRelay relay) =>
            !Widget(req, cfg, widget) ? Results.NotFound() : relay.Command(action ?? "") ? Results.Ok() : Results.StatusCode(409));
    }
}
