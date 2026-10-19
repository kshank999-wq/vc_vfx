# Code signing and notarisation

Everything in this document needs credentials that have to be bought and tied
to a verified identity, so none of it can be done from a build container. What
*is* done: the pipeline expects these credentials, uses them when they are
present, and produces a clearly-marked unsigned build when they are not.

An unsigned build is not a broken build — it installs, with a warning — but it
must never be published to the `stable` channel. Windows shows SmartScreen's
"unrecognised app" panel and macOS refuses to open it at all without the user
right-clicking to bypass Gatekeeper.

## Windows

### What to obtain

Since June 2023 Windows code-signing certificates must have their private key
on hardware or in a cloud HSM, so the old "download a `.pfx` and put it in a
secret" flow no longer applies to newly issued certificates. Two workable
routes:

| Route | Suits | Notes |
| --- | --- | --- |
| **Azure Trusted Signing** | Most projects | Pay monthly, no hardware, no SmartScreen wait once the identity is validated. Requires an Azure subscription and a verified organisation or individual. |
| **OV certificate on a cloud HSM** | Existing CA relationships | DigiCert, Sectigo and others; the certificate lives in their KeyVault-style service and signing goes through their tool. |

An **EV** certificate buys immediate SmartScreen reputation; an **OV** one
earns reputation over time and downloads. Neither changes the code.

### What CI needs

For the file-based path (older certificates that still allow it), the workflow
already reads:

- `WINDOWS_CERTIFICATE` — the `.pfx`, base64 encoded, as a repository secret
- `WINDOWS_CERTIFICATE_PASSWORD`

Azure Artifact Signing (it was called Trusted Signing) is **already wired**.
The workflow signs with it as soon as these six secrets exist, and falls back
to `WINDOWS_CERTIFICATE`, and then to an unsigned build, when they do not:

| Secret | What it is |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID of the Entra app registration |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | A client secret on that registration |
| `AZURE_SIGNING_PROFILE` | The certificate profile's name |
| `AZURE_SIGNING_ACCOUNT` | The signing account's name (defaults to `vcvfx`) |
| `AZURE_SIGNING_ENDPOINT` | Regional endpoint (defaults to `https://wus2.codesigning.azure.net`, which is West US 2) |

The first four are checked together, because three of them are useless alone
and a half-configured Azure is the one case that would sign nothing and say
nothing. The last two only name the account rather than granting anything, and
are secrets purely so there is one place to set all of this.

### Getting the account ready

Only the account holder can do any of this; none of it can be scripted.

1. On the signing account, **Access control (IAM)**: assign yourself both
   **Trusted Signing Identity Verifier** and **Trusted Signing Certificate
   Profile Signer**.
2. **Identity validation** → *Individual* → **New identity → Public**. It hands
   over to a verification partner and finishes on a phone with ID documents.
   This is the long pole — days rather than minutes.
3. Once that reads **Completed**: **Certificate profiles** → a new **Public
   Trust** profile. This is the certificate, issued short-lived and renewed
   automatically; there is nothing to download and nothing to keep.
4. **Entra ID → App registrations** → a new registration, then a client
   secret, then give *that registration* the **Trusted Signing Certificate
   Profile Signer** role on the signing account. A registration that can
   authenticate but has not been given the role fails at signing time rather
   than at sign-in, which reads like a signing bug and is not one.

Nothing about this produces a file. That is the point of the June 2023 rule:
the private key never leaves Microsoft's HSM, so unlike the Apple half there is
no `.p12`, no export password and nothing on anybody's disk to lose.

### Verifying

```powershell
Get-AuthenticodeSignature .\VC VFX-Setup-1.0.0.exe | Format-List
```

`Status` must be `Valid` and `SignerCertificate` must name your organisation.

## macOS

### What to obtain

1. **Apple Developer Program membership** ($99/year). An individual membership
   is enough; an organisation membership needs a D-U-N-S number and takes
   longer.
2. A **Developer ID Application** certificate, created in the Apple Developer
   portal and installed in the signing machine's keychain — or exported as a
   `.p12` for CI.
3. An **app-specific password** for the Apple ID, generated at appleid.apple.com.
   Notarisation will not accept the account password.

### What CI needs

Repository secrets, all already read by the release workflow:

| Secret | What it is |
| --- | --- |
| `APPLE_ID` | The Apple ID email on the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password, not the account password |
| `APPLE_TEAM_ID` | The ten-character team identifier |
| `CSC_LINK` | The Developer ID `.p12`, base64 encoded |
| `CSC_KEY_PASSWORD` | Its export password |

### Making the `.p12` without a Mac

Apple's portal wants a certificate signing request and hands back a bare
certificate; the private key never leaves the machine that made the request.
Neither step needs macOS. With Git for Windows installed, in PowerShell:

**Paste these one line at a time.** PowerShell parses a pasted block as a
single line, and `&` at the head of the second command is then a reserved
operator rather than the call operator — the whole line fails to parse and
nothing runs, including the part that looked fine.

```powershell
mkdir $HOME\vcvfx-signing; cd $HOME\vcvfx-signing
$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
& $openssl req -new -newkey rsa:2048 -nodes -keyout vcvfx-mac.key -out vcvfx-mac.csr -subj "/CN=VC VFX/emailAddress=<apple id email>"
# Upload vcvfx-mac.csr at developer.apple.com → Certificates → Developer ID
# Application (G2 Sub-CA); download developerID_application.cer here, then:
& $openssl x509 -in developerID_application.cer -inform DER -out vcvfx-mac.pem
Invoke-WebRequest https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -OutFile DeveloperIDG2CA.cer
& $openssl x509 -in DeveloperIDG2CA.cer -inform DER -out DeveloperIDG2CA.pem
& $openssl pkcs12 -export -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 -inkey vcvfx-mac.key -in vcvfx-mac.pem -certfile DeveloperIDG2CA.pem -out vcvfx-mac.p12
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\vcvfx-signing\vcvfx-mac.p12")) | Set-Clipboard
```

The three `pkcs12` algorithm flags matter, and they are **not** `-legacy`.
OpenSSL 3 defaults to AES-256 with PBKDF2, which macOS's `security import`
rejects with "MAC verification failed (wrong password?)" — the same message a
genuinely wrong password produces, which is why the workflow checks the bundle
two ways. `-legacy` is the documented cure everywhere on the web and **Git for
Windows does not ship the legacy provider**, so it fails with "unable to load
provider legacy" and no `legacy.dll` on disk. The flags above ask for the same
old algorithms out of the *default* provider: 3DES is there, and only the RC2
that `-legacy` also selects is not.

`-certfile` puts Apple's G2 intermediate in the bundle. Without it the leaf
imports but chains to nothing, and `security find-identity -v -p codesigning`
lists no valid identity on a runner that lacks the intermediate.

The `.key` file is the only copy of the private key: keep it, and keep it out
of the repository. The base64 on the clipboard is the `CSC_LINK` secret, and
the export password typed at the `pkcs12` prompt is `CSC_KEY_PASSWORD`; both
go into GitHub ▸ Settings ▸ Secrets and nowhere else. Re-running the last line
regenerates the clipboard text from the file at any time.

The workflow only asks electron-builder to notarise when `APPLE_ID` and
`APPLE_TEAM_ID` are both present — requesting notarisation without credentials
fails the build, and a fork or a dry run should still produce something
installable.

The hardened runtime is already enabled, with entitlements in
`apps/desktop/build/entitlements.mac.plist` covering the two Electron needs
(JIT and unsigned executable memory), microphone access for dictation, and
user-selected file access for opening projects. Notarisation rejects a hardened
build that uses an entitlement it has not declared, so anything added to the
app later — camera, network server, disabled library validation — has to be
added there too.

### Verifying

```bash
codesign --verify --deep --strict --verbose=2 "VC VFX.app"
spctl --assess --type execute --verbose "VC VFX.app"
xcrun stapler validate "VC VFX.dmg"
```

`spctl` should say `accepted` and `source=Notarized Developer ID`. If it says
`source=Unnotarized Developer ID`, the build is signed but the notarisation
ticket was never stapled — customers on a fresh machine will be blocked.

## Publishing a signed build

Signing and publishing are separate on purpose (§17):

1. Tag the release. The workflow packages both platforms and prints the
   SHA-256 of each installer.
2. Upload the installer at `/admin/releases` with its version, minimum OS,
   release notes and that checksum. It arrives **inactive**.
3. Verify the artifact, then make it live. Only then can customers download it,
   and only through a signed URL minted after an entitlement check.

The checksum matters beyond bookkeeping: the in-app updater refuses an
installer that does not match the published one and discards it. A build
published without a checksum cannot be verified, so the updater will not offer
it.

## What is left before a first release

- [ ] Windows certificate obtained and its secrets set
- [ ] Apple Developer membership, Developer ID certificate and app-specific
      password obtained and their secrets set
- [ ] A tagged build packaged on both platforms
- [ ] `spctl` and `Get-AuthenticodeSignature` both clean
- [ ] Installers uploaded, checked and activated at `/admin/releases`
- [ ] One end-to-end purchase on live Stripe keys, download, install, activate
