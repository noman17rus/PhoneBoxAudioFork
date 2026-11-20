param([ValidateRange(1024, 65535)][int]$Port = 8765)
$ErrorActionPreference = 'Stop'

# Works both from the source checkout and from the portable distribution.
$candidates = @(
    (Join-Path $PSScriptRoot 'agent/PhoneBoxAgent.exe'),
    (Join-Path $PSScriptRoot '../dist/PhoneBoxAudioLoudness/agent/PhoneBoxAgent.exe')
)
$agent = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$agent) { throw 'Build the Windows agent into dist/PhoneBoxAudioLoudness/agent first.' }
$agent = (Resolve-Path -LiteralPath $agent).Path
$folder = Split-Path (Split-Path $agent)
$config = Join-Path $folder 'audio-config.json'

$probe = [Net.Sockets.TcpClient]::new()
try { $probe.Connect('127.0.0.1', $Port); $occupied = $true } catch { $occupied = $false } finally { $probe.Dispose() }
if ($occupied) { throw "Port $Port is already in use. Close the running PhoneBox agent, or pass -Port 18765 for an isolated run. Do not connect the same phone to two agents." }

if (!(Test-Path -LiteralPath $config)) {
    $settings = @{
        updates = @{ auto = $false }
        night = @{ enabled = $false }
        display = @{ orientation = 'landscape'; idleReturnSec = 0 }
        pages = @(@{ id = 'audio'; title = 'Audio Analysis'; enabled = $true; widgets = @(
            @{ id = 'fft'; type = 'audio-spectrum'; x = 0; y = 0; w = 12; h = 6; options = @{
                fft = '8192'; average = '300'; slope = 3; mode = 'power'; peaks = $true
            } }
        ) }, @{ id = 'waveform'; title = 'Audio Waveform'; enabled = $true; widgets = @(
            @{ id = 'wave'; type = 'audio-waveform'; x = 0; y = 0; w = 12; h = 6; options = @{
                interval = '1000'; mode = 'lr'
            } }
        ) }, @{ id = 'stereo'; title = 'Stereo Field'; enabled = $true; widgets = @(
            @{ id = 'stereo'; type = 'audio-stereo'; x = 0; y = 0; w = 12; h = 6; options = @{
                afterglow = '800'
            } }
        ) }, @{ id = 'loudness'; title = 'Loudness'; enabled = $true; widgets = @(
            @{ id = 'loud'; type = 'audio-loudness'; x = 0; y = 0; w = 12; h = 6; options = @{} }
        ) })
        rules = @(); shortcuts = @()
    }
    $settings | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $config -Encoding UTF8
}
$started = Start-Process -FilePath $agent -ArgumentList @('--config', ('"' + $config + '"'), '--port', $Port) -WindowStyle Hidden -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($started.HasExited) { throw 'The agent exited before opening its settings. Check the PhoneBox log.' }
    $probe = [Net.Sockets.TcpClient]::new()
    try { $probe.Connect('127.0.0.1', $Port); $ready = $true } catch { } finally { $probe.Dispose() }
    if ($ready) { break }
    Start-Sleep -Milliseconds 150
}
if (!$ready) { throw "The agent did not open port $Port in time. Check the PhoneBox log." }
Start-Process "http://127.0.0.1:$Port/"
