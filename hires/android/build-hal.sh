#!/bin/bash
# Builds Waydroid's audio HAL (audio.primary.waydroid.so) from upstream lineage-20 source,
# which opens output streams at the rate and format Android asks for (upstream commit 503d82229c,
# 2026-11-02). The published vendor image (2026-10-22) predates that commit and always opens 48 kHz S16.
#
# Usage: build-hal.sh <work-dir> <out-dir>. Run where Waydroid's images are mounted, because it
# links against the image's own liblog, libcutils and libasound. Needs about 2 GB for the NDK.
# The HAL service is 32-bit, so audio.primary.waydroid.32.so is the one Android loads; the
# 64-bit build is shipped too for completeness.
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
W=$1; OUT=$(mkdir -p "$2" && cd "$2" && pwd); R=/var/lib/waydroid/rootfs; B=refs/heads/android13-release
mkdir -p "$W" && cd "$W"

[ -x android-ndk-r27c/toolchains/llvm/prebuilt/linux-x86_64/bin/clang ] || { rm -rf android-ndk-r27c; curl -fsSL -o ndk.zip https://dl.google.com/android/repository/android-ndk-r27c-linux.zip && unzip -q ndk.zip && rm ndk.zip; }
[ -f alsa-lib/configure.ac ] || rm -rf alsa-lib; [ -d alsa-lib ] || git clone -q --depth 1 -b lineage-17.1 https://github.com/waydroid/android_external_alsa-lib alsa-lib

# alsa-lib generates asoundlib.h and version.h at build time; reproduce that here.
mkdir -p gen/alsa
ver=$(sed -n "/^AC_INIT.* \([0-9.]*\))/s//\1/p" alsa-lib/configure.ac); IFS=. read -r a b c <<< "$ver"
printf '#define SND_LIB_MAJOR %s\n#define SND_LIB_MINOR %s\n#define SND_LIB_SUBMINOR %s\n#define SND_LIB_EXTRAVER 1000000\n#define SND_LIB_VER(maj, min, sub) (((maj)<<16)|((min)<<8)|(sub))\n#define SND_LIB_VERSION SND_LIB_VER(SND_LIB_MAJOR, SND_LIB_MINOR, SND_LIB_SUBMINOR)\n#define SND_LIB_VERSION_STR "%s"\n' "$a" "$b" "$c" "$ver" > gen/alsa/version.h
{ cat alsa-lib/include/asoundlib-head.h; sed -n "/.*\(#include <[ae].*.h>\).*/s//\1/p" alsa-lib/configure.ac; cat alsa-lib/include/asoundlib-tail.h; } > gen/alsa/asoundlib.h

# Android 13 headers.
get() { mkdir -p "aosp/$1" && curl -sfL "https://android.googlesource.com/platform/$2/+archive/$B/$3.tar.gz" | tar xz -C "aosp/$1"; }
# A marker, so an interrupted download is retried instead of treated as complete.
[ -f aosp/.complete ] || { rm -rf aosp; get libhardware hardware/libhardware include; get audio system/media audio/include
  get audio_utils system/media audio_utils/include; get audio_effects system/media audio_effects/include
  get cutils system/core libcutils/include; get libsystem system/core libsystem/include
  get liblog system/logging liblog/include; get libutils system/core libutils/include; touch aosp/.complete; }

# Link against the image's own libraries so the HAL resolves exactly what the container provides.
mkdir -p libs32 libs64
cp $R/vendor/lib/libasound.so $R/system/lib/liblog.so $R/system/lib/libcutils.so libs32/
cp $R/vendor/lib64/libasound.so $R/system/lib64/liblog.so $R/system/lib64/libcutils.so libs64/

CC=android-ndk-r27c/toolchains/llvm/prebuilt/linux-x86_64/bin/clang
INC="-I gen -I alsa-lib/android -I aosp/libhardware -I aosp/audio -I aosp/audio_utils -I aosp/audio_effects -I aosp/cutils -I aosp/libsystem -I aosp/liblog -I aosp/libutils"
# NDEBUG turns liblog's ALOGV into dead code. Left in, the driver writes about 86 verbose lines a
# second while music plays and fills Android's 256 KiB main log in about 4 minutes, so the log
# no longer holds what happened before a fault. The driver has no assert, and LOG_ALWAYS_FATAL
# stays in with NDEBUG.
FLAGS="-shared -fPIC -O2 -DNDEBUG -Wno-unused-parameter -Wl,-soname,audio.primary.waydroid.so"
$CC --target=i686-linux-android33 $FLAGS $INC "$SRC/audio_hw.c" -L libs32 -llog -lcutils -lasound -o "$OUT/audio.primary.waydroid.32.so"
$CC --target=x86_64-linux-android33 $FLAGS $INC "$SRC/audio_hw.c" -L libs64 -llog -lcutils -lasound -o "$OUT/audio.primary.waydroid.64.so"
