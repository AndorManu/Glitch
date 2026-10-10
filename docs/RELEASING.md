# Releasing Glitch

How a version gets from this repo to people's computers, and what only the
owner can do (keys, secrets, money). Nothing here has been run yet: no secret
is uploaded, no tag pushed, no release created.

## How it fits together

```
node scripts/bump-version.mjs 0.2.0   -> versions + CHANGELOG section
git tag v0.2.0 && git push ...         -> .github/workflows/release.yml
  draft job   checks versions match the tag, the updater key exists,
              creates a DRAFT release with the CHANGELOG section as notes
  build jobs  Windows NSIS installer, macOS universal .app + .dmg,
              updater bundles signed with the updater key, latest.json
              (tauri-apps/tauri-action), code signing if its secrets exist
you         check the draft, press "Publish release"
installed Glitch  checks .../releases/latest/download/latest.json daily,
              verifies the signature, asks "Install / Later" in his bubble
```

Drafts are never "latest", so users only get a version after you publish it.

## 1. The updater key (required, once)

A keypair was generated on this machine on 2026-10-08:

| File | What |
|---|---|
| `C:\Users\andor\.glitch-keys\glitch-updater.key` | private key (password-protected), **never commit** |
| `C:\Users\andor\.glitch-keys\glitch-updater.password.txt` | its password |
| `C:\Users\andor\.glitch-keys\glitch-updater.key.pub` | public key, already in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`, key id `D748BA5D4E7B05FC`) |

The folder is readable by your Windows user only. Do this now:

1. Put the private key and the password in your password manager. **If the key
   is lost, installed copies of Glitch can never be updated again** (they only
   accept updates signed with it); you would have to ship a new key in a
   release people install by hand.
2. Delete `glitch-updater.password.txt` once it is in the password manager.
3. Add both as GitHub Actions secrets (repo Settings > Secrets and variables >
   Actions > New repository secret), or with the GitHub CLI from a terminal:

   ```powershell
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo AndorManu/Glitch < C:\Users\andor\.glitch-keys\glitch-updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo AndorManu/Glitch   # paste the password when asked
   ```

To sign by hand (not normally needed): `npx tauri signer sign -f <key file> -p <password> <file>`.

Rotating the key: generate a new pair (`npx tauri signer generate -w <file>`),
put the new public key in `tauri.conf.json`, ship that release **signed with
the old key**, and only then switch the secret to the new key.

## 2. Windows code signing (optional, costs money)

Without it the installer works, but SmartScreen shows "Windows protected your
PC" until the file builds reputation, and some antivirus tools are twitchy
about unsigned apps. The updater does not need it (it checks its own
signature). Options, cheapest first for a small app:

| Option | Cost (2026) | Notes |
|---|---|---|
| **SignPath Foundation** | free for open source | The repo must be public with an OSI licence (Glitch is MIT) and be accepted by SignPath. Signs as "SignPath Foundation", via their GitHub Action (`signpath/github-action-submit-signing-request`) after the build. Not wired yet: needs their project/policy slugs once accepted. |
| **Azure Trusted Signing** (now also called Azure Artifact Signing) | about 10 USD/month (Basic) | Microsoft-managed certificate, no hardware token. Identity validation: organisations, and individuals in a limited set of countries (check the current list). **Wired**: set the secrets below. |
| **OV code-signing certificate** (Sectigo, DigiCert, SSL.com...) | about 200 to 500 USD/year | Since 2023 the key must live on a hardware token or a cloud HSM, so most new certificates are *not* a .pfx file. A cloud HSM (e.g. SSL.com eSigner, DigiCert KeyLocker) is used through its own signing tool as a `signCommand`. **Wired** only for the classic .pfx case below. |

EV certificates no longer skip SmartScreen (Microsoft changed that in 2024),
so they are not worth the extra money here.

Secrets the workflow looks for (it skips signing, with a warning, when they're missing):

- Azure Trusted Signing: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
  (an app registration with the "Trusted Signing Certificate Profile Signer" role),
  `AZURE_SIGNING_ENDPOINT` (e.g. `https://weu.codesigning.azure.net`),
  `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`. The build installs
  `trusted-signing-cli` and sets Tauri's `bundle.windows.signCommand`.
- A .pfx certificate: `WINDOWS_CERTIFICATE` (the .pfx as base64:
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) and
  `WINDOWS_CERTIFICATE_PASSWORD`. Imported on the runner, used by thumbprint, timestamped.

## 3. macOS signing and notarization (optional, 99 USD/year)

Without it, macOS says the app "can't be opened because Apple cannot check it";
people have to right-click > Open the first time (or allow it in System
Settings > Privacy & Security). With it, it opens normally.

1. Join the Apple Developer Program (99 USD/year).
2. Create a **Developer ID Application** certificate (Xcode > Settings >
   Accounts > Manage Certificates, or developer.apple.com), export it from
   Keychain Access as a .p12 with a password.
3. Make an app-specific password at account.apple.com (Sign-In and Security).
4. Secrets: `APPLE_CERTIFICATE` (the .p12 as base64: `base64 -i cert.p12 | pbcopy`),
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
   (`Developer ID Application: Your Name (TEAMID)`), and for notarization
   `APPLE_ID`, `APPLE_PASSWORD` (the app-specific password), `APPLE_TEAM_ID`.

The workflow passes them to Tauri only when they are set (Tauri tries to sign
when the variables exist at all, even empty).

## 4. Cutting a release

```powershell
node scripts/bump-version.mjs 0.2.0      # package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json, CHANGELOG.md
# read CHANGELOG.md, tidy the new section by hand (it becomes the release notes)
git add -A; git commit -m "Glitch 0.2.0"
git tag v0.2.0
git push origin HEAD v0.2.0
```

Then on GitHub: Actions > Release (about 15 to 25 minutes) > Releases > the
draft. Check it has the Windows `*-setup.exe` (+ `.sig`), the macOS `.dmg`,
`.app.tar.gz` (+ `.sig`) and `latest.json`. Try the installer, then **Publish
release**. Installed copies offer the update within a day (or on "Check now").

`node scripts/changelog.mjs <version> --dry-run` previews a section without
writing. The very first release is 0.1.0 (the current version), so for it just
tag `v0.1.0`: its CHANGELOG section is already there.

If a release goes wrong: delete the draft (or unpublish it back to draft) and
the tag (`git push --delete origin v0.2.0`), fix, tag again. A published
release that is broken: publish a newer fixed version, the updater only moves
forward.

## 5. The repo must be public (or releases must live somewhere public)

The updater and any download link fetch from
`github.com/AndorManu/Glitch/releases`. GitHub only serves release files to
everyone from a **public** repository. The vault note says the repo isn't
pushed yet. Options:

- make `AndorManu/Glitch` public (also needed for SignPath's free signing), or
- keep the code private and publish releases from a small public repo (e.g.
  `AndorManu/glitch-releases`): change the endpoint in `tauri.conf.json` and
  `glitch_core::autoupdate::ENDPOINT` (a test keeps them equal), and give the
  workflow a token with write access to that repo.

## 6. The website's download buttons

There is a "Desktop Pet" site at desktoppet.app, but no project for it was
found on this machine (searched all of `C:\Users\andor\CodingProjects` for
"desktoppet" and "desktop pet" on 2026-10-08; the vault doesn't list it
either), so nothing there was changed. Wherever it lives, point its buttons at
the stable-name copies the release workflow uploads to every release:

| Button | Link |
|---|---|
| Download for Windows | `https://github.com/AndorManu/Glitch/releases/latest/download/Glitch-windows-x64-setup.exe` |
| Download for macOS | `https://github.com/AndorManu/Glitch/releases/latest/download/Glitch-macos-universal.dmg` |
| All versions / release notes | `https://github.com/AndorManu/Glitch/releases` |

`releases/latest` always means the newest *published* (not draft, not
pre-release) release, so the links never need editing. Don't link the
versioned file names (`Glitch_0.2.0_x64-setup.exe`): they change every
release. If the site wants to show the version number, read it from
`https://github.com/AndorManu/Glitch/releases/latest/download/latest.json`
(`"version"`) or the GitHub API (`/repos/AndorManu/Glitch/releases/latest`,
`tag_name`). Add a small note under the buttons for unsigned builds ("Windows
may say it protected your PC: More info > Run anyway"; "Mac: right-click >
Open the first time") until code signing is set up.

## 7. What the app does (for reviewers)

- `src-tauri/src/autoupdate.rs`: check 45 s after start and every 24 h while
  Settings > Features > Updates > "Check for updates" is on (default on).
  The only endpoint is `https://github.com/AndorManu/Glitch/releases/latest/download/latest.json`
  (pinned, HTTPS; a unit test checks `tauri.conf.json` matches
  `glitch_core::autoupdate::ENDPOINT` and has no insecure-transport option).
- A new version: "update-available" event, the bubble says "Psst! There's a
  new me" with **Install** / **Later** (focus starts on Later). Later hides
  that version for a day.
- Install: `download_and_install` verifies the minisign signature against the
  public key before running anything, then Glitch saves the chat and restarts.
  On Windows the NSIS installer runs in passive mode (progress bar, no questions).
- No webview gets updater plugin permissions; the pages only call the five
  `update_*` commands.
