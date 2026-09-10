#!/usr/bin/env bash
#
# Generates the Android scaffolding both apps need, and adds the permissions
# they use. Run once, on a machine that has Flutter.
#
# This script has never been run — Flutter is not installed in the environment
# it was written in. Read it before trusting it, and check the manifest
# afterwards.
#
#   ./tools/setup_apps.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

command -v flutter >/dev/null || { echo "flutter is not on PATH"; exit 1; }

patch_manifest() {
  local app="$1" permissions="$2"
  local manifest="apps/$app/android/app/src/main/AndroidManifest.xml"

  [ -f "$manifest" ] || { echo "no manifest at $manifest"; exit 1; }
  grep -q 'android.permission.INTERNET' "$manifest" && { echo "  $app manifest already patched"; return; }

  # Insert the permissions just after the opening <manifest> tag.
  python3 - "$manifest" "$permissions" <<'PY'
import sys
manifest, permissions = sys.argv[1], sys.argv[2]
with open(manifest, encoding='utf-8') as f:
    xml = f.read()

block = '\n' + '\n'.join(
    f'    <uses-permission android:name="android.permission.{p}"/>'
    for p in permissions.split(',')
) + '\n'

marker = '>'
i = xml.index('<manifest')
j = xml.index(marker, i) + 1
with open(manifest, 'w', encoding='utf-8') as f:
    f.write(xml[:j] + block + xml[j:])
PY
  echo "  $app manifest patched"
}

for app in driver passenger; do
  echo "generating android scaffolding for $app"
  (cd "apps/$app" && flutter create --platforms=android --project-name "mowasalat_$app" .)
done

# The driver tracks only while a trip runs, under a visible foreground service.
# ACCESS_BACKGROUND_LOCATION is deliberately NOT requested: the app has no
# business knowing where a driver is when he is not driving.
patch_manifest driver "INTERNET,ACCESS_FINE_LOCATION,ACCESS_COARSE_LOCATION,FOREGROUND_SERVICE,FOREGROUND_SERVICE_LOCATION,WAKE_LOCK"

# A passenger is never tracked: one fix, in the foreground, when she asks.
patch_manifest passenger "INTERNET,ACCESS_FINE_LOCATION,ACCESS_COARSE_LOCATION"

for app in driver passenger; do
  (cd "apps/$app" && flutter pub get)
done

cat <<'NOTE'

Done. Two things to check by hand before building:

  1. If you are testing against a plain http:// backend (a laptop on the same
     WiFi), Android blocks cleartext by default. Add to the <application> tag
     in both manifests:

         android:usesCleartextTraffic="true"

     Take it out again before any build that leaves your desk.

  2. On Android 14+ a foreground service must declare its type. Check that
     apps/driver/android/app/src/main/AndroidManifest.xml has, inside
     <application>, a <service> entry for the geolocator service with
     android:foregroundServiceType="location". The plugin normally declares
     this itself; verify rather than assume.
NOTE
