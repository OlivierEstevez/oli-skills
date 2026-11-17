# Build and PiPL

## What gets built

| Platform | Output | Architectures |
|---|---|---|
| macOS | `<Name>.plugin` bundle, PiPL in `Contents/Resources/<Name>PiPL.rsrc` | x86_64 + arm64, one universal binary |
| Windows | `<Name>.aex` (a DLL), PiPL embedded as a resource | x64, and ARM64 as a separate build |

Only natively compiled effects load in a native host: an Apple Silicon After Effects ignores an Intel-only plugin, and Windows on Arm ignores an x64-only one.

## Commands

```bash
# macOS (Xcode command line tools: clang, Rez, codesign)
cmake --preset debug -DAE_SDK_ROOT="<SDK>/Examples"
cmake --build --preset debug
```

```powershell
# Windows (Visual Studio Build Tools, MSVC)
cmake -S . -B build/release -A x64   -DAE_SDK_ROOT="<SDK>/Examples"
cmake --build build/release --config Release
cmake -S . -B build/arm64   -A ARM64 -DAE_SDK_ROOT="<SDK>/Examples"   # needs VS 17.4+
cmake --build build/arm64 --config Release
```

`PiPLtool.exe` ships in the SDK under `Examples/Resources`.

The template's macOS build was compiled and inspected. Its Windows branch follows the SDK's sample build steps but has not been built from this template: verify it on a Windows machine before relying on it.

## Install for testing

| Platform | Folder |
|---|---|
| macOS | `/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/` |
| Windows | `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\` |

`7.0` is fixed for every CC version. Both need admin rights. On macOS a symlink to the build output works for After Effects (Premiere Pro does not follow aliases). After Effects loads plugins at launch: restart it after every build.

macOS 15 and later refuse unsigned plugins. The template ad-hoc signs after every build (`codesign --force --deep --sign -`). Nothing inside the bundle may change after signing.

If frames look stale after changing render code, empty the disk cache (Preferences > Media & Disk Cache) or bump the effect version.

## Signing for distribution

The ad-hoc signature (`--sign -`) is valid only on the machine that built the plugin. A plugin copied or downloaded to another Mac is quarantined, and Gatekeeper blocks it unless it is signed with a Developer ID and notarized. This needs a paid Apple Developer account. Never commit certificates, passwords or signing identities: read them from the keychain or environment variables.

```bash
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: <Name> (<TEAM_ID>)" <Name>.plugin
codesign --verify --strict --verbose=2 <Name>.plugin
ditto -c -k --keepParent <Name>.plugin notarize.zip
xcrun notarytool submit notarize.zip --keychain-profile <profile> --wait
xcrun stapler staple <Name>.plugin && xcrun stapler validate <Name>.plugin
```

- Create `<profile>` once with `xcrun notarytool store-credentials <profile>` (Apple ID, team ID, app-specific password).
- The `.plugin` bundle is stapled directly, so it opens offline. Sign last: nothing in the bundle may change afterwards.
- Ship it as a zip made with `ditto -c -k --keepParent`. Plain `zip` can break the signature.

Windows: After Effects loads unsigned `.aex` files. Authenticode signing (`signtool`) only removes SmartScreen warnings from installers.

## The PiPL

A resource After Effects reads without running the plugin. One `.r` file serves both platforms. It must agree with the code:

| PiPL property | Must equal |
|---|---|
| `AE_Effect_Global_OutFlags` | `out_data->out_flags` in `GlobalSetup` |
| `AE_Effect_Global_OutFlags_2` | `out_data->out_flags2` in `GlobalSetup` |
| `AE_Effect_Version` | `out_data->my_version` (`PF_VERSION(...)`) |
| `AE_Effect_Match_Name` | match name in `PF_REGISTER_EFFECT_EXT2` |
| `Name`, `Category` | the same strings in the registration call |
| Entry points | the exported function name, `"EffectMain"` |

A mismatch gives a load-time warning dialog, or a plugin that silently behaves as if a flag were missing.

The template keeps names and flags in `src/Plugin_Config.h`, included by both the `.r` and the C++, and `static_assert`s the flag values against the SDK enums. To add a flag:

1. Add the enum to the `static_assert` in `Plugin.cpp`.
2. Compute the new hex value and update `PLUGIN_OUT_FLAGS` or `PLUGIN_OUT_FLAGS2`. The build fails until both agree.

Flag bit positions are in `AE_Effect.h` (`PF_OutFlag_*`, `PF_OutFlag2_*`).

Entry points, one per platform and architecture:

```
CodeMacIntel64 {"EffectMain"}, CodeMacARM64 {"EffectMain"},
CodeWin64X86 {"EffectMain"},   CodeWinARM64 {"EffectMain"},
```

Packed version: `(major >> 3) << 26 | (major & 7) << 19 | minor << 15 | bug << 11 | stage << 9 | build`, with major 0..127, minor 0..15, bug 0..15, stage 0 develop, 3 release. The template computes it in CMake and passes it to both the PiPL and the code.

Rez limits a source line to 1023 bytes.

## Naming

- Match name: unique, permanent, prefixed with the vendor, never `ADBE ` (After Effects excludes unknown `ADBE ` effects from GPU rendering and the prefix belongs to Adobe).
- Display name: up to 47 characters in the PiPL, 31 in parameter names.
- Category: the submenu under Effect.
- Bundle identifier: the vendor's reverse-DNS, not `com.adobe.*`.

## Symbols

Export only `EffectMain` and `PluginDataEntryFunction2`. The template sets hidden visibility by default, and `DllExport` from the SDK's `entry.h` marks the two entry points. Exported C++ symbols (STL, Boost, the SDK utility classes) can bind to a different copy inside the host and crash it. Check with `nm -gU <binary>` on macOS.

## Compiler settings worth keeping

- C++17, no compiler extensions.
- Release builds with the default optimization of the Release config. Do not add `-ffast-math` without measuring and checking NaN and infinity handling in 32 bpc.
- `NOMINMAX` on Windows, so `std::min` and `std::max` work after `Windows.h`.
- Do not define `AE_OS_MAC` or `AE_OS_WIN` by hand: `AEConfig.h` derives them.

## SDK files compiled into the plugin

From `Examples/Util`: `AEGP_SuiteHandler.cpp`, `MissingSuiteError.cpp`, `Smart_Utils.cpp`. Add `AEFX_SuiteHelper.c` for Drawbot, and `AEFX_ArbParseHelper.c` for arbitrary data text parsing. Include paths: `Headers`, `Headers/SP`, `Util`, `Resources`, plus `Headers/Win` on Windows.

## Debugging

- macOS: attach lldb or Xcode to After Effects. Release builds of After Effects may need a re-signed development copy or developer mode to allow attaching.
- Windows: set After Effects as the debug command, or attach to the process.
- `out_data->return_msg` plus `PF_OutFlag_DISPLAY_ERROR_MESSAGE` shows a dialog. Good for a first diagnosis, never in a render loop.
- Hold Cmd-Opt-Shift (Ctrl-Alt-Shift) at launch to reset After Effects preferences.
