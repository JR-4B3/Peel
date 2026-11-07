/* Runs the audio driver's real out_write against a simulated ALSA device (issue #15).
 * run.sh copies out_write from android/audio_hw.c into out_write.c beside the build. */
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>

#define ALOGE(...) ((void)0)
struct audio_stream { int unused; };
struct audio_stream_out { struct audio_stream common; };
struct alsa_audio_device { pthread_mutex_t lock; };
struct alsa_stream_out { struct audio_stream_out stream; struct alsa_audio_device *dev; pthread_mutex_t lock; int standby; void *pcm; unsigned long written; };
typedef unsigned long snd_pcm_uframes_t;
typedef long snd_pcm_sframes_t;

static struct { int starts, standbys, waits, recovers, writes; bool locked_standby; } seen;
static snd_pcm_sframes_t (*device)(snd_pcm_uframes_t frames);
static int wait_result, recover_result;

static size_t audio_stream_out_frame_size(const struct audio_stream_out *stream) { (void)stream; return 8; }
static uint32_t out_get_sample_rate(const struct audio_stream *stream) { (void)stream; return 192000; }
static int start_output_stream(struct alsa_stream_out *out) { seen.starts++; out->pcm = (void *)1; return 0; }
static snd_pcm_sframes_t snd_pcm_writei(void *pcm, const void *data, snd_pcm_uframes_t frames) {
    (void)pcm; (void)data;
    if (++seen.writes > 10000) { printf("FAIL out_write never stops writing\n"); exit(1); }
    return device(frames);
}
static int snd_pcm_wait(void *pcm, int ms) { (void)pcm; (void)ms; seen.waits++; return wait_result; }
static int snd_pcm_recover(void *pcm, int error, int silent) { (void)pcm; (void)error; (void)silent; seen.recovers++; return recover_result; }
/* out_standby takes the device lock, then the stream lock. out_write must not hold the stream lock. */
static int out_standby(struct audio_stream *stream) {
    struct alsa_stream_out *out = (struct alsa_stream_out *)stream;
    if (pthread_mutex_trylock(&out->lock) != 0) seen.locked_standby = true; else pthread_mutex_unlock(&out->lock);
    seen.standbys++; out->standby = 1; out->pcm = NULL;
    return 0;
}
#define usleep(us) ((void)(us))
#include "out_write.c"

static snd_pcm_sframes_t stalls(snd_pcm_uframes_t frames) { (void)frames; return -EAGAIN; }
static snd_pcm_sframes_t fails(snd_pcm_uframes_t frames) { (void)frames; return -EIO; }
static snd_pcm_sframes_t accepts_all(snd_pcm_uframes_t frames) { return (snd_pcm_sframes_t)frames; }
static snd_pcm_sframes_t accepts_one(snd_pcm_uframes_t frames) { (void)frames; return 1; }
static int underruns_left;
static snd_pcm_sframes_t underruns_once(snd_pcm_uframes_t frames) { return underruns_left-- > 0 ? -EPIPE : (snd_pcm_sframes_t)frames; }

static struct alsa_audio_device dev = { .lock = PTHREAD_MUTEX_INITIALIZER };
static struct alsa_stream_out out = { .dev = &dev, .lock = PTHREAD_MUTEX_INITIALIZER };
static char buffer[64]; /* 8 frames */
static int failures;

static void reset(void) {
    seen = (typeof(seen)){0};
    out.standby = 0; out.pcm = (void *)1; out.written = 0;
    wait_result = 0; recover_result = 0; underruns_left = 0;
}
static void expect(const char *name, bool ok) {
    printf("%s %s\n", ok ? "pass" : "FAIL", name);
    if (!ok) failures++;
}

int main(void) {
    reset(); device = stalls; wait_result = -ENODEV; recover_result = -ENODEV;
    out_write(&out.stream, buffer, sizeof buffer);
    expect("a failed wait on a stalled device ends the write and closes the stream", out.standby == 1 && seen.standbys == 1 && !seen.locked_standby);

    reset(); device = stalls; wait_result = 0;
    out_write(&out.stream, buffer, sizeof buffer);
    expect("a device that accepts nothing for about a second is closed", out.standby == 1 && seen.waits == 11);

    reset(); device = fails; recover_result = -EIO;
    out_write(&out.stream, buffer, sizeof buffer);
    expect("an unrecoverable error closes the stream", out.standby == 1 && seen.standbys == 1);
    device = accepts_all;
    out_write(&out.stream, buffer, sizeof buffer);
    expect("the next write reopens the device and writes every frame", seen.starts == 1 && out.standby == 0 && out.written == 8);

    reset(); device = accepts_one;
    out_write(&out.stream, buffer, sizeof buffer);
    expect("short writes continue until every frame is written", out.written == 8 && seen.standbys == 0);

    reset(); device = underruns_once; underruns_left = 1; recover_result = 0;
    out_write(&out.stream, buffer, sizeof buffer);
    expect("a recovered underrun keeps the stream open", out.written == 8 && seen.recovers == 1 && seen.standbys == 0);

    return failures ? 1 : 0;
}
