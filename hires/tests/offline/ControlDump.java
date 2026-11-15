// Checks how Peel's controller reads AudioFlinger's dump (Control.Rates.parse) against
// audio-flinger.txt, a dump with the track rows Android 13 writes.
import java.io.BufferedReader;
import java.io.FileReader;
import java.util.Arrays;

public final class ControlDump {
  static int failures;

  static void expect(String what, Object got, Object wanted) {
    boolean same = got instanceof int[] && wanted instanceof int[] ? Arrays.equals((int[]) got, (int[]) wanted) : String.valueOf(got).equals(String.valueOf(wanted));
    if (same) return;
    failures++;
    System.out.println("FAIL " + what + ": got " + (got instanceof int[] ? Arrays.toString((int[]) got) : got) + ", wanted " + (wanted instanceof int[] ? Arrays.toString((int[]) wanted) : wanted));
  }

  public static void main(String[] args) throws Exception {
    Control.Rates.Mixer mixer = Control.Rates.parse(new BufferedReader(new FileReader(args[0])));
    // The first mixer, not the direct output before it or the mixer after it.
    expect("I/O handle", mixer.io, 13);
    // Every track but the patch track, and none from the local log.
    int[] ids = mixer.tracks.stream().mapToInt(t -> t[0]).toArray();
    expect("track IDs", ids, new int[] { 60, 59, 62, 63, 58, 71 });
    // { id, active, static, session, rate, ending }
    expect("an active track", mixer.tracks.get(0), new int[] { 60, 1, 0, 107905, 44100, 0 });
    expect("a terminated track", mixer.tracks.get(1), new int[] { 59, 0, 0, 107905, 192000, 1 });
    expect("a stopping track", mixer.tracks.get(3), new int[] { 63, 0, 0, 107929, 48000, 1 });
    expect("a static fast track", mixer.tracks.get(5), new int[] { 71, 0, 1, 107937, 4000, 0 });
    expect("sessions", mixer.sessions(), "[107905, 107913, 107929, 107937]");
    // The song that plays is on the active track. Right after a song change, while the track of the
    // song before (60) still plays, the new song's prepared track counts instead.
    expect("the active track", mixer.apple(-1, false)[4], 44100);
    expect("the new song's track", mixer.apple(60, false)[4], 96000);
    expect("the old track once stale", mixer.apple(60, true)[4], 44100);
    if (failures > 0) System.exit(1);
    System.out.println("ok   the controller reads AudioFlinger's dump");
  }
}
