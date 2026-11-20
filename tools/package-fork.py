"""Package and verify the Windows/Android fork release from fresh build outputs."""
import argparse
import hashlib
import json
import pathlib
import re
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def names(version):
    return [f'PhoneBoxAgent-{version}-win-x64.zip', f'PhoneBox-{version}.apk',
            f'PhoneBoxYouTube-{version}.zip', f'PhoneBoxYouTubeExtension-{version}.zip']


def tree(folder, prefix=''):
    return {prefix + p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob('*')) if p.is_file()}


def write_zip(path, files):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            archive.writestr(name, data)


def verify(out, version):
    expected = names(version)
    sums = out / f'SHA256SUMS-{version}.txt'
    listed = dict((name, sha) for sha, name in
                  (line.split('  ', 1) for line in sums.read_text().splitlines()))
    assert set(listed) == set(expected), 'Unexpected/missing checksum entries'
    assert {p.name for p in out.iterdir()} == set(expected + [sums.name]), 'Unexpected release files'
    for name in expected:
        assert digest((out / name).read_bytes()) == listed[name], f'Checksum mismatch: {name}'
    with zipfile.ZipFile(out / expected[0]) as agent, zipfile.ZipFile(out / expected[2]) as bundle, \
            zipfile.ZipFile(out / expected[3]) as extension:
        assert 'PhoneBoxAgent.exe' in agent.namelist()
        assert not any(p.endswith(('.pdb', '.jks', '.keystore')) for p in agent.namelist())
        for name in agent.namelist():
            assert agent.read(name) == bundle.read('agent/' + name), name
        assert (out / expected[1]).read_bytes() == bundle.read(expected[1])
        assert json.loads(extension.read('manifest.json'))['manifest_version'] == 3
        for name in extension.namelist():
            assert extension.read(name) == bundle.read('extension/' + name), name
        assert b'noman17rus/PhoneBoxAudioFork' in bundle.read('README.md')
    with zipfile.ZipFile(out / expected[1]) as apk:
        assert 'AndroidManifest.xml' in apk.namelist()
    print(f'PASS: {version}: hashes, four assets, identical agent/APK/extension in bundle')


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--agent', type=pathlib.Path)
    parser.add_argument('--apk', type=pathlib.Path)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    version = re.search(r'<Version>([^<]+)</Version>',
                        (ROOT / 'agent/PhoneBox.Agent/PhoneBox.Agent.csproj').read_text())[1]
    if args.verify:
        return verify(args.out, version)
    assert args.agent and args.apk, '--agent and --apk are required'
    assert not args.out.exists() or not any(args.out.iterdir()), 'Use an empty output directory'
    args.out.mkdir(parents=True, exist_ok=True)
    agent = {n: data for n, data in tree(args.agent).items() if not n.endswith('.pdb')}
    assert 'PhoneBoxAgent.exe' in agent
    extension = tree(ROOT / 'extensions/phonebox-youtube')
    agent['LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    extension['LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    asset = names(version)
    write_zip(args.out / asset[0], agent)
    (args.out / asset[1]).write_bytes(args.apk.read_bytes())
    write_zip(args.out / asset[3], extension)
    readme = f'''# PhoneBoxAudioFork {version}: Windows + Android + YouTube

Fork of PhoneBox by Ersin KOÇ (MIT): https://github.com/ersinkoc/phonebox
Releases and updates: https://github.com/noman17rus/PhoneBoxAudioFork/releases

1. Extract the complete archive. Close any older PhoneBox agent, then run agent/PhoneBoxAgent.exe.
2. Install {asset[1]} on Android and connect over USB or paired Wi-Fi.
3. If Android reports an incompatible signature, back up your settings before manually reinstalling.
   Uninstalling may remove phone-local settings/pairings. No script uninstalls automatically.
   Future fork APKs use the same permanent signing key and update in place.
4. In Chrome, open chrome://extensions, enable Developer mode and Load unpacked: extension/.
5. Open http://127.0.0.1:8765, General > YouTube, create a pairing code, and enter it in extension Options.
6. Add a YouTube widget, open a normal YouTube watch page, and click the extension icon once.
   Leave the tab to see video on the phone; sound stays on the PC. See YOUTUBE.md.

Audio spectrum, waveform, stereo and loudness widgets use Windows output audio.
The agent is self-contained and does not need a separate .NET installation. It is unsigned.
USB requires Android platform-tools/ADB and authorized USB debugging; Wi-Fi uses pairing.
Layouts and connection settings are configured in the browser. This package contains no personal settings.
The extension is installed manually; newer extension releases must also be installed manually.
'''
    bundle = {'agent/' + n: data for n, data in agent.items()}
    bundle.update({'extension/' + n: data for n, data in extension.items()})
    bundle[asset[1]] = args.apk.read_bytes()
    bundle['README.md'] = readme.encode()
    bundle['LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    for name in ['YOUTUBE', 'AUDIO-SPECTRUM', 'AUDIO-WAVEFORM', 'AUDIO-STEREO', 'AUDIO-LOUDNESS']:
        bundle[name + '.md'] = (ROOT / 'docs' / (name + '.md')).read_bytes()
    write_zip(args.out / asset[2], bundle)
    (args.out / f'SHA256SUMS-{version}.txt').write_text(''.join(
        f'{digest((args.out / name).read_bytes())}  {name}\n' for name in asset))
    verify(args.out, version)


if __name__ == '__main__':
    main()
