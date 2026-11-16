// Checks how Peel's controller reads AudioFlinger's dump (Control.Rates.parse) against
// audio-flinger.txt, a dump with the track rows Android 13 writes, and audio-flinger-other-app.txt,
// where another app opened a newer track than Apple Music's.
import java.io.BufferedReader;
import java.io.FileReader;
import java.util.Arrays;
import java.util.Set;

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
    // { id, active, static, session, rate, ending, client }
    expect("an active track", mixer.tracks.get(0), new int[] { 60, 1, 0, 107905, 44100, 0, 1583 });
    expect("a terminated track", mixer.tracks.get(1), new int[] { 59, 0, 0, 107905, 192000, 1, 1583 });
    expect("a stopping track", mixer.tracks.get(3), new int[] { 63, 0, 0, 107929, 48000, 1, 1583 });
    expect("a static fast track", mixer.tracks.get(5), new int[] { 71, 0, 1, 107937, 4000, 0, 1583 });
    expect("sessions", mixer.sessions(), "[107905, 107913, 107929, 107937]");
    // The song that plays is on the active track. Right after a song change, while the track of the
    // song before (60) still plays, the new song's prepared track counts instead.
    Set<Integer> apple = Set.of(1583);
    expect("the active track", mixer.apple(apple, -1, false)[4], 44100);
    expect("the new song's track", mixer.apple(apple, 60, false)[4], 96000);
    expect("the old track once stale", mixer.apple(apple, 60, true)[4], 44100);
    expect("no track while Apple Music does not run", mixer.apple(Set.of(), -1, false), null);

    // Another app (process 1290) plays a sound at 48 kHz on a newer track while Apple Music's song
    // plays at 96 kHz. The song's rate stays 96 kHz, and both apps' sessions are held through a
    // switch.
    Control.Rates.Mixer other = Control.Rates.parse(new BufferedReader(new FileReader(args[1])));
    expect("the other app's track", other.tracks.get(1), new int[] { 66, 1, 0, 108001, 48000, 0, 1290 });
    expect("Apple Music's track beside a newer one", other.apple(apple, -1, false), new int[] { 60, 1, 0, 107905, 96000, 0, 1583 });
    // Right after a song change, while Apple Music's new track is not open yet, no track is found,
    // rather than the other app's.
    expect("no track of the next song yet", other.apple(apple, 60, false), null);
    expect("the other app's newest track", other.apple(Set.of(1290), -1, false)[4], 48000);
    expect("sessions of both apps", other.sessions(), "[107905, 108001, 108009]");
    if (failures > 0) System.exit(1);
    System.out.println("ok   the controller reads AudioFlinger's dump");
  }
}
