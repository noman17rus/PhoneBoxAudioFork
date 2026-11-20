from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
v=re.search(r'<Version>([^<]+)</Version>',(root/'agent/PhoneBox.Agent/PhoneBox.Agent.csproj').read_text())[1]
changelog=(root/'CHANGELOG.md').read_text(encoding='utf-8')
section=re.search(r'^## '+re.escape(v)+r' — [^\n]+\n(.*?)(?=^## |\Z)',changelog,re.M|re.S)
assert section, 'Missing release notes'
print(section[1].strip())
print('\nDownloads: Windows x64 agent, signed Android APK, complete YouTube bundle, Chrome extension and SHA-256 checksums.')
print('\nAndroid: back up settings before manually reinstalling an APK signed with a different key. Subsequent fork releases update in place. Windows binaries are unsigned. The Chrome extension updates manually.')
print('\nPhysical-phone USB/Wi-Fi latency and real YouTube playback require separate hardware validation.')
