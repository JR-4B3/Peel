// Switches the rate Android mixes at, so a song plays at its own rate instead of being resampled
// to 192 kHz. Android 13 lets only the audioserver user change a mixer's rate (AudioFlinger's
// filterReservedParameters), so the root helper starts this from the release image as audioserver
// (peel-hires-root rate-helper). It listens on the abstract local socket "peel-rate" and accepts
// only the shell user, where Peel's controller runs, and root. A request is one line: the mixer
// output's I/O handle and a rate in Hz. The answer is the rate that output mixes at afterwards.
// The controller finds the handle in AudioFlinger's dump, which audioserver may not read.
//
// AudioFlinger then asks Peel's audio driver to reopen the device at that rate (sampling_rate in
// out_set_parameters) and mixes at it from then on.
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

public final class RateServe {
  // Transaction numbers follow IAudioFlingerService.aidl in Android 13, counted from
  // FIRST_CALL_TRANSACTION (1): sampleRate is method 2, setParameters method 20.
  static final int SAMPLE_RATE = 1 + 2, SET_PARAMETERS = 1 + 20;
  static final int SHELL = 2000, ROOT = 0;
  static final int[] RATES = { 44100, 48000, 88200, 96000, 176400, 192000 };

  public static void main(String[] args) throws Exception {
    Class<?> serverClass = Class.forName("android.net.LocalServerSocket");
    Object server = serverClass.getConstructor(String.class).newInstance("peel-rate");
    System.out.println("listening on @peel-rate");
    while (true) {
      Object socket = call(server, "accept");
      try { serve(socket); } catch (Exception error) { System.out.println("request failed: " + error); }
      finally { try { call(socket, "close"); } catch (Exception ignored) {} }
    }
  }

  static void serve(Object socket) throws Exception {
    Object credentials = call(socket, "getPeerCredentials");
    int uid = (Integer) call(credentials, "getUid");
    if (uid != SHELL && uid != ROOT) return;
    call(socket, "setSoTimeout", 2000);
    InputStream in = (InputStream) call(socket, "getInputStream");
    StringBuilder line = new StringBuilder();
    for (int b; (b = in.read()) >= 0 && b != '\n' && line.length() < 32; ) line.append((char) b);
    String[] parts = line.toString().trim().split(" ");
    int io = Integer.parseInt(parts[0]), wanted = Integer.parseInt(parts[1]);
    boolean known = false;
    for (int r : RATES) known |= r == wanted;
    if (known && flinger(SAMPLE_RATE, io, null) != wanted) flinger(SET_PARAMETERS, io, "sampling_rate=" + wanted);
    int rate = flinger(SAMPLE_RATE, io, null);
    OutputStream out = (OutputStream) call(socket, "getOutputStream");
    out.write((rate + "\n").getBytes(StandardCharsets.UTF_8));
    out.flush();
  }

  // One AudioFlinger call with an I/O handle and an optional text. Returns the int it answers.
  static int flinger(int code, int io, String text) throws Exception {
    Class<?> parcel = Class.forName("android.os.Parcel");
    Object data = parcel.getMethod("obtain").invoke(null), reply = parcel.getMethod("obtain").invoke(null);
    try {
      Object binder = Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, "media.audio_flinger");
      call(data, "writeInterfaceToken", "android.media.IAudioFlingerService");
      call(data, "writeInt", io);
      if (text != null) call(data, "writeString", text);
      call(binder, "transact", code, data, reply, 0);
      int status = (Integer) call(reply, "readInt");
      if (status != 0) throw new IllegalStateException("AudioFlinger refused the call: " + status);
      return text == null ? (Integer) call(reply, "readInt") : 0;
    } finally { call(data, "recycle"); call(reply, "recycle"); }
  }

  static Object call(Object target, String name, Object... args) throws Exception {
    for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
      for (Method method : type.getDeclaredMethods()) {
        if (method.getName().equals(name) && method.getParameterCount() == args.length) {
          method.setAccessible(true);
          return method.invoke(target, args);
        }
      }
    }
    throw new NoSuchMethodException(target.getClass().getName() + "." + name + "/" + args.length);
  }
}
