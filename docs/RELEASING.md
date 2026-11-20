# Releasing PhoneBoxAudioFork

This public fork of [PhoneBox by Ersin KOÇ](https://github.com/ersinkoc/phonebox) distributes Windows x64 and Android packages. The original MIT license remains in force.

## Prepare

1. Increase the numeric agent version and Android versionName together; increase Android versionCode on every release. Use tag v<version> (first fork release: v0.9.22, code 43).
2. Add a dated CHANGELOG entry and update documentation and catalog counts.
3. Run `python tools/check-release.py`, `dotnet test agent/PhoneBox.Agent.Tests`, Android `lintDebug assembleDebug`, and `npm test` in tools/ui-tests. Resolve failures before publishing.
4. Commit and push main. Enable GitHub Actions in the fork if GitHub requests it. The build workflow must pass.
5. Run `scripts/release.ps1 -Draft` (GitHub CLI required), or Actions > release > Run workflow with draft enabled. Release dispatch is restricted to main, and tags must not already exist.

## Permanent Android signing

Configure repository secrets PHONEBOX_KEYSTORE_BASE64, PHONEBOX_STORE_PASSWORD, PHONEBOX_KEY_ALIAS and PHONEBOX_KEY_PASSWORD. Keep an additional protected local backup of the keystore and passwords outside the repository. Never commit them. A release fails if signing credentials are absent; public APKs must never fall back to a debug key.

An APK installed with a different signing key cannot be updated in place. Back up settings and manually reinstall only after understanding that uninstalling removes phone-local data and pairings. No installer automatically uninstalls. Later fork releases use the same permanent key and update in place. Keep the application ID unchanged.

Windows agents are unsigned and self-contained. This fork does not use the upstream author's SignPath credentials, macOS certificate, Scoop publication or winget publication.

## Artifact contract and publication

The release workflow builds the APK and Windows agent from the selected commit after reusable build checks. `tools/package-fork.py` creates:

- PhoneBoxAgent-<version>-win-x64.zip
- PhoneBox-<version>.apk
- PhoneBoxYouTube-<version>.zip (the same agent and APK, Chrome extension, MIT license and instructions)
- PhoneBoxYouTubeExtension-<version>.zip
- SHA256SUMS-<version>.txt

The updater depends on the agent/APK/checksum naming; preserve it. The extension is updated manually through Chrome; the agent does not replace an installed browser extension.

The workflow creates a draft, downloads all assets again, verifies hashes and package contents, and smoke-tests the downloaded Windows agent. With draft disabled it publishes only after these checks pass. For the first release, download the draft locally, run `python tools/package-fork.py --verify --out <download-directory>`, verify the APK signature with Android apksigner, and smoke-test the extracted agent. Verify the release tag resolves to the intended commit before publishing with `gh release edit v<version> --draft=false --latest --repo noman17rus/PhoneBoxAudioFork`.

After publication check the public Releases page and asset links. Preserve the signing backup for all future updates. Hardware validation on a physical phone over USB/Wi-Fi is reported separately from CI and desktop checks.
