using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PhoneBox.Agent;
using Xunit;

public sealed class YouTubeEndpointTests
{
    [Fact]
    public async Task PairedExtensionPublishesVideoAndOnlyConfiguredWidgetCanReadOrControlIt()
    {
        var dir = Path.Combine(Path.GetTempPath(), "phonebox-youtube-http-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var configPath = Path.Combine(dir, "config.json");
            File.WriteAllText(configPath, """{"pages":[{"id":"p","enabled":true,"widgets":[{"id":"yt","type":"youtube"}]}]}""");
            var relay = new YouTubeRelay(Path.Combine(dir, "key.json"));
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, 0));
            builder.Services.AddSingleton(relay);
            builder.Services.AddSingleton(new ConfigStore(configPath));
            await using var app = builder.Build();
            app.Use(async (ctx, next) =>
            {
                if (YouTubeEndpoints.IsExtensionPath(ctx.Request.Path) && !YouTubeEndpoints.AllowExtension(ctx.Request, relay))
                { ctx.Response.StatusCode = 403; return; }
                await next();
            });
            app.MapYouTube();
            await app.StartAsync();
            using var phone = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
            using var extension = new HttpClient { BaseAddress = phone.BaseAddress };
            extension.DefaultRequestHeaders.Add("X-PhoneBox-Extension", new string('a', 32));
            var code = relay.BeginPairing().Code;
            using var claim = await extension.PostAsync("/api/youtube/extension/claim?code=" + code, null);
            Assert.Equal(HttpStatusCode.OK, claim.StatusCode);
            var token = (await claim.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
            extension.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var status = new YouTubeStatus(Guid.NewGuid().ToString(), 1, true, "Test", true, true, false, true, null);
            Assert.Equal(HttpStatusCode.OK, (await extension.PostAsJsonAsync("/api/youtube/extension/poll", status)).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await phone.GetAsync("/api/youtube/state?widget=p/missing")).StatusCode);
            var view = await phone.GetFromJsonAsync<JsonElement>("/api/youtube/state?widget=p/yt");
            Assert.Equal("streaming", view.GetProperty("state").GetString());
            using var frame = new ByteArrayContent([0xff, 0xd8, 1, 0xff, 0xd9]);
            frame.Headers.ContentType = new("image/jpeg");
            Assert.Equal(HttpStatusCode.OK, (await extension.PostAsync($"/api/youtube/extension/frame?session={status.Session}&revision=1", frame)).StatusCode);
            using var picture = await phone.GetAsync("/api/youtube/frame?widget=p/yt&after=0");
            Assert.Equal("image/jpeg", picture.Content.Headers.ContentType!.MediaType);
            Assert.Equal("1", Assert.Single(picture.Headers.GetValues("X-PhoneBox-Sequence")));
            Assert.Equal(HttpStatusCode.Conflict, (await phone.PostAsync("/api/youtube/command?widget=p/yt&action=previous", null)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await phone.PostAsync("/api/youtube/command?widget=p/yt&action=next", null)).StatusCode);
            var poll = await extension.PostAsJsonAsync("/api/youtube/extension/poll", status);
            Assert.Contains("next", await poll.Content.ReadAsStringAsync());
            await phone.PostAsync("/api/youtube/pair/revoke", null);
            Assert.Equal(HttpStatusCode.Forbidden, (await extension.PostAsJsonAsync("/api/youtube/extension/poll", status)).StatusCode);
            await app.StopAsync();
        }
        finally { Directory.Delete(dir, true); }
    }
}
