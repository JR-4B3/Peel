// aaplay FILE RATE: plays raw interleaved float32 stereo through AAudio (shared mode, normal latency).
#include <aaudio/AAudio.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: aaplay FILE RATE\n"); return 2; }
    FILE *f = fopen(argv[1], "rb"); if (!f) { perror("open"); return 1; }
    AAudioStreamBuilder *b; AAudio_createStreamBuilder(&b);
    AAudioStreamBuilder_setFormat(b, AAUDIO_FORMAT_PCM_FLOAT);
    AAudioStreamBuilder_setChannelCount(b, 2);
    AAudioStreamBuilder_setSampleRate(b, atoi(argv[2]));
    AAudioStreamBuilder_setUsage(b, AAUDIO_USAGE_MEDIA);
    AAudioStreamBuilder_setContentType(b, AAUDIO_CONTENT_TYPE_MUSIC);
    AAudioStreamBuilder_setPerformanceMode(b, AAUDIO_PERFORMANCE_MODE_NONE);
    AAudioStream *s; aaudio_result_t r = AAudioStreamBuilder_openStream(b, &s);
    if (r != AAUDIO_OK) { fprintf(stderr, "open: %s\n", AAudio_convertResultToText(r)); return 1; }
    printf("rate=%d format=%d frames/burst=%d\n", AAudioStream_getSampleRate(s), AAudioStream_getFormat(s), AAudioStream_getFramesPerBurst(s));
    AAudioStream_requestStart(s);
    float buf[2 * 4096]; size_t n;
    while ((n = fread(buf, sizeof(float) * 2, 4096, f)) > 0) AAudioStream_write(s, buf, n, 2000000000LL);
    AAudioStream_requestStop(s); AAudioStream_close(s); return 0;
}
