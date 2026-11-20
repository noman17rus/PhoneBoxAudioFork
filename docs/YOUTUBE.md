# YouTube on PhoneBox

The YouTube widget shows video from one selected Chrome tab when you leave that tab. Playback and sound stay on the PC. Switching to another tab, focusing another application, or minimizing Chrome shows the video on the phone. Returning to the selected YouTube tab hides the phone picture without stopping playback or releasing capture permission.

## Set up

1. Update both the PhoneBox desktop agent and Android app to this build. Connect the phone over USB or pair it over Wi-Fi as usual.
2. In Chrome 116 or newer, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extensions/phonebox-youtube` from this repository (or `extension` in the portable YouTube bundle).
3. Open the agent settings, **General → YouTube**, and click **Create pairing code**. In the extension's **Options**, enter the local agent address (normally `http://127.0.0.1:8765`) and the six-digit code. Codes expire after two minutes and allow five attempts.
4. Add a **YouTube** widget to an enabled PhoneBox page and **Save**. Open that page on the phone.
5. Open a normal YouTube video at `https://www.youtube.com/watch?...`, keep the entire video player within the tab's viewport, and click the extension's toolbar icon. Pinning the icon in Chrome makes it easier to find. **ON** means capture is armed.
6. Leave the tab. Its video appears in the widget. Sound continues from the PC. Return to the tab to hide the phone picture.

The toolbar icon starts/stops capture; it does not need to be pressed again for every focus change. Closing the selected tab, restarting Chrome, or stopping capture ends the session. Chrome requires another toolbar click to start a new capture. You can select another YouTube tab by clicking the extension on that tab.

**Previous / Play–Pause / Next** control this specific tab. Previous and Next follow YouTube's own available buttons and playlist/recommendation behavior; PhoneBox does not invent a separate queue. Controls that YouTube does not offer are disabled. Navigation to another website stops capture.

## Connection and troubleshooting

- Both USB and paired Wi-Fi use the existing PhoneBox connection. Wi-Fi retains its token authentication and pinned TLS. No WebRTC/UDP ports, external relay, account login, or YouTube API key are required.
- Chrome and the PC must stay running. PhoneBox does not move playback off a sleeping or disconnected PC.
- The phone receives only video, with no audio track. Image delivery pauses while the widget, its page, or the Android app is hidden. Capture remains armed on the PC so resuming does not need another gesture.
- Start with a regular YouTube watch page. Shorts and YouTube Music have different player layouts and are not supported in this first version. If the player is partly scrolled offscreen, the widget asks you to make it fully visible.
- Protected video may appear black or be unavailable. Capture does not bypass content protection.
- **Open YouTube in Chrome and start PhoneBox capture** also appears if the extension disconnects. Check the agent address in extension Options. After an agent/network interruption, an existing browser capture can reconnect automatically. If the extension was revoked, pair it again and restart capture.
- **General → YouTube → Disconnect extension** revokes the saved key and ends capture. **Forget connection** in extension Options removes its local copy; use the agent's disconnect button to revoke the agent-side key as well.

## Implementation and limits

The extension uses Manifest V3, a video-only `tabCapture` stream in an offscreen document, `MediaStreamTrackProcessor` with a one-frame buffer, and a dedicated worker for JPEG encoding. The worker crops the player while accounting for letterboxing of the captured viewport. Frames are limited to 854 × 480, 24 fps, JPEG quality 0.7, and 1 MiB per frame. Slow receivers skip frames rather than accumulate a playback backlog. JPEG uses more bandwidth than a video codec.

The agent retains one frame in RAM, rejects stale session/focus revisions, and expires disconnected/stale pictures. Phone commands are bounded, expire after two seconds, and are not replayed after a lost response. The extension's separately scoped, hashed key is stored beside the agent configuration in `youtube-extension.json`. Only a one-time pairing code can provision a new key; pairing/revocation and extension uploads are unavailable on the Wi-Fi listener.

Automated validation covers the relay, HTTP endpoints, widget lifecycle, and actual Chromium extension/tab capture against a synthetic player: tab changes, minimized windows, playlist commands, fresh images, and cleanup. A timestamp encoded in the synthetic video measures browser capture/encoding/upload latency; it excludes transport and rendering on a physical phone. The target for full PC-to-phone image delay is 250 ms, but that target and unchanged physical PC audio must still be checked on the user's actual USB/Wi-Fi setup. No phone-hardware latency claim is made by these tests.

Run checks from the repository root:

```powershell
dotnet test agent/PhoneBox.Agent.Tests --filter FullyQualifiedName~YouTube
node tools/ui-tests/node_modules/@playwright/test/cli.js test youtube.spec.js youtube-extension.spec.js --config tools/ui-tests/playwright.config.js --workers 1
```

The extension test uses an isolated temporary Chromium profile and a local synthetic YouTube page; it never opens the user's Chrome profile or YouTube account.
