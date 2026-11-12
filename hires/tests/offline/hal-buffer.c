/* Checks the driver's ALSA buffer size at every rate it opens (out_alsa_buffer_frames).
 * run.sh copies the function and the constants it reads from android/audio_hw.c into
 * buffer_frames.c beside the build. The expected sizes below do not use those constants.
 *
 * PipeWire feeds a device that stays at 48 kHz in steps of its quantum, at most 2048 frames by
 * default, scaled to the stream's rate. The buffer must hold two such steps, or the write waits
 * for room PipeWire never makes. A buffer of 1024 frames stalled every song above 54 kHz. */
#include <stdint.h>
#include <stdio.h>

typedef unsigned long snd_pcm_uframes_t;
#include "buffer_frames.c"

int main(void)
{
    const unsigned int rates[] = { 44100, 48000, 88200, 96000, 176400, 192000 };
    int failed = 0;
    for (unsigned int i = 0; i < sizeof rates / sizeof rates[0]; i++) {
        unsigned int rate = rates[i];
        snd_pcm_uframes_t frames = out_alsa_buffer_frames(rate);
        double step = 2048.0 * rate / 48000;
        double ms = frames * 1000.0 / rate;
        if (frames < 2 * step) { printf("FAIL %u Hz: a buffer of %lu frames holds less than two steps of %.0f\n", rate, frames, step); failed = 1; }
        else if (frames % 256) { printf("FAIL %u Hz: %lu frames is not a multiple of 256\n", rate, frames); failed = 1; }
        else if (ms > 100) { printf("FAIL %u Hz: %lu frames delay the sound by %.0f ms\n", rate, frames, ms); failed = 1; }
        else printf("pass the buffer holds two PipeWire steps at %u Hz (%lu frames, %.0f ms)\n", rate, frames, ms);
    }
    return failed;
}
