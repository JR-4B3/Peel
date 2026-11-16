// Peel's controller for Apple Music inside Android. It runs through app_process as the shell
// user, which may read and control media sessions, and talks to Apple Music's media session
// directly: play a song by its link, pause, seek, and report what plays. Peel connects over TCP
// and sends one command per line, starting with the key it passed on the command line.
//
// Compiled without android.jar, so every Android class is reached through reflection. The hidden
// interfaces it uses (ISessionManager, ISessionController) are stable from Android 11 to 14.
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;

public final class Control {
  static final String APPLE = "com.apple.android.music";
  static final String CALLER = "com.android.shell";
  static final String PLAYBACK = "com.apple.android.music.playback.";
  static Object controller;
  static ClassLoader apple;
  static String applePath;

  // serve <port> <key file> <Apple Music APK>: the key arrives in a file only the shell user can
  // read, because process arguments are visible to every user.
  public static void main(String[] args) throws Exception {
    if (args.length >= 1 && !args[0].equals("serve")) {
      applePath = System.getenv("APPLE_APK");
      System.out.println(run(String.join(" ", args)));
      return;
    }
    int port = Integer.parseInt(args[1]);
    String key = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[2])), StandardCharsets.UTF_8).trim();
    applePath = args.length > 3 ? args[3] : null;
    follow();
    // A Looper-less process still receives binder replies, so no main loop is needed.
    try (ServerSocket server = new ServerSocket(port, 4, InetAddress.getByName("0.0.0.0"))) {
      System.out.println("listening " + port);
      while (true) {
        Socket socket = server.accept();
        // Peel needs one connection. A few more cover a reconnect while the old one closes.
        if (connections.incrementAndGet() > 4) { connections.decrementAndGet(); socket.close(); continue; }
        Thread thread = new Thread(() -> { try { serve(socket, key); } finally { connections.decrementAndGet(); } });
        thread.setDaemon(true);
        thread.start();
      }
    }
  }

  static final java.util.concurrent.atomic.AtomicInteger connections = new java.util.concurrent.atomic.AtomicInteger();
  // The longest command is a queue of a few hundred song IDs.
  static final int MAX_LINE = 256 * 1024;

  // One line, or null at the end. A longer line than MAX_LINE, or one still incomplete at the
  // deadline (0 for none), ends the connection.
  static String line(java.io.InputStream in, long deadline) throws java.io.IOException {
    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
    for (int b; (b = in.read()) != '\n'; ) {
      if (b < 0) return bytes.size() > 0 ? bytes.toString("UTF-8") : null;
      if (bytes.size() >= MAX_LINE) throw new java.io.IOException("line too long");
      if (deadline > 0 && System.currentTimeMillis() > deadline) throw new java.io.IOException("too slow");
      bytes.write(b);
    }
    return bytes.toString("UTF-8");
  }

  static void serve(Socket socket, String key) {
    try (Socket s = socket) {
      s.setTcpNoDelay(true);
      // A client has five seconds to send its first, keyed line. Peel's own stays open.
      s.setSoTimeout(5000);
      java.io.InputStream in = new java.io.BufferedInputStream(s.getInputStream());
      OutputStream out = s.getOutputStream();
      String line;
      long deadline = System.currentTimeMillis() + 5000;
      while ((line = line(in, deadline)) != null) {
        int space = line.indexOf(' ');
        if (space < 0 || !java.security.MessageDigest.isEqual(line.substring(0, space).getBytes(StandardCharsets.UTF_8), key.getBytes(StandardCharsets.UTF_8))) {
          out.write("{\"error\":\"key\"}\n".getBytes(StandardCharsets.UTF_8));
          return;
        }
        s.setSoTimeout(0);
        deadline = 0;
        String reply;
        try { reply = run(line.substring(space + 1)); }
        catch (Throwable error) { Throwable cause = error.getCause() != null ? error.getCause() : error; reply = "{\"error\":" + quote(String.valueOf(cause)) + "}"; }
        out.write((reply + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
      }
    } catch (Exception ignored) {}
  }

  static synchronized String run(String command) throws Exception {
    String[] parts = command.trim().split(" ", 2);
    String name = parts[0], arg = parts.length > 1 ? parts[1] : "";
    if (name.equals("ping")) return "{\"ok\":true}";
    // rate [hz]: switches the rate Android mixes at, through Peel's rate helper, and answers the
    // rate it mixes at. Without the helper the rate stays as it is.
    if (name.equals("rate")) return "{\"rate\":" + (arg.isEmpty() ? Rates.mixer() : Rates.set(Integer.parseInt(arg))) + "}";
    // rebind: moves every track on the mixer to its current buffer, as a switch does, for a song
    // that stays silent after a switch. Answers how many sessions it reached.
    if (name.equals("rebind")) return "{\"sessions\":" + Rates.rebind() + "}";
    // restart: stops Apple Music, for a player that no longer streams or went silent. The next
    // command finds no session, and the host starts Apple Music's playback service again. The
    // stopped app's session stays listed for a moment, and commands sent to it then are lost, so
    // the answer comes once it is gone, or after 5 seconds.
    if (name.equals("restart")) {
      Runtime.getRuntime().exec(new String[] { "am", "force-stop", APPLE }).waitFor();
      for (int i = 0; i < 50 && session(true) != null; i++) Thread.sleep(100);
      controller = null;
      return "{\"ok\":true}";
    }
    // Every command looks Apple Music's session up again. The state, which the host reads many
    // times a second, uses one at most a second old.
    Object c = session(!name.equals("state"));
    if (c == null) return "{\"error\":\"no-session\"}";
    try { return apply(c, name, arg); }
    catch (java.lang.reflect.InvocationTargetException dead) {
      // Apple Music restarted, so its old session is gone. Look it up once more.
      c = session(true);
      if (c == null) return "{\"error\":\"no-session\"}";
      return apply(c, name, arg);
    }
  }

  static String apply(Object c, String name, String arg) throws Exception {
    switch (name) {
      case "state": return state(c);
      case "play": call(c, "play", CALLER); break;
      case "pause": call(c, "pause", CALLER); break;
      case "stop": call(c, "stop", CALLER); break;
      case "next": call(c, "next", CALLER); break;
      case "previous": call(c, "previous", CALLER); break;
      case "seek": call(c, "seekTo", CALLER, Long.parseLong(arg)); break;
      // volume <0..1>: Android's media volume as a share of its steps. Only 1 leaves the samples
      // unchanged.
      case "volume": {
        int max = (Integer) call(call(c, "getVolumeAttributes"), "getMaxVolume");
        call(c, "setVolumeTo", CALLER, CALLER, (int) Math.round(Math.min(1, Math.max(0, Double.parseDouble(arg))) * max), 0);
        break;
      }
      case "uri": call(c, "playFromUri", CALLER, Class.forName("android.net.Uri").getMethod("parse", String.class).invoke(null, arg), null); break;
      case "prepare-uri": call(c, "prepareFromUri", CALLER, Class.forName("android.net.Uri").getMethod("parse", String.class).invoke(null, arg), null); break;
      case "id": call(c, "playFromMediaId", CALLER, arg, null); break;
      case "custom": call(c, "sendCustomAction", CALLER, arg, null); break;
      // list <start index> <id,id,...>: replaces the queue with these catalog songs and plays the
      // one at the index, as Apple's own screens do.
      case "list": {
        String[] p = arg.split(" ", 2);
        Object bundle = bundle();
        put(bundle, "putParcelable", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_ITEM_PROVIDER", provider(p[1].split(","), Integer.parseInt(p[0])));
        // Clear and replace (5). Plain replace (1) is ignored when Apple considers the queue unchanged.
        put(bundle, "putInt", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_INSERTION_TYPE", 5);
        call(c, "sendCommand", CALLER, PLAYBACK + "command.ADD_QUEUE_ITEMS", bundle, null);
        break;
      }
      // add <next|end> <id,id,...>: inserts songs after the playing one or at the end.
      case "add": {
        String[] p = arg.split(" ", 2);
        Object bundle = bundle();
        put(bundle, "putParcelable", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_ITEM_PROVIDER", provider(p[1].split(","), 0));
        put(bundle, "putInt", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_INSERTION_TYPE", p[0].equals("next") ? 3 : p[0].equals("end") ? 2 : Integer.parseInt(p[0]));
        call(c, "sendCommand", CALLER, PLAYBACK + "command.ADD_QUEUE_ITEMS", bundle, null);
        break;
      }
      case "remove": {
        Object bundle = bundle();
        put(bundle, "putLong", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_ID", Long.parseLong(arg));
        call(c, "sendCommand", CALLER, PLAYBACK + "command.REMOVE_QUEUE_ITEM", bundle, null);
        break;
      }
      case "skip": call(c, "skipToQueueItem", CALLER, Long.parseLong(arg)); break;
      // shuffle <0|1> and repeat <0 none|1 one|2 all> set the mode, through the compat
      // library's own actions, which Apple Music handles as setters.
      case "shuffle": {
        Object bundle = bundle();
        put(bundle, "putInt", "android.support.v4.media.session.action.ARGUMENT_SHUFFLE_MODE", Integer.parseInt(arg));
        call(c, "sendCustomAction", CALLER, "android.support.v4.media.session.action.SET_SHUFFLE_MODE", bundle);
        break;
      }
      case "repeat": {
        Object bundle = bundle();
        put(bundle, "putInt", "android.support.v4.media.session.action.ARGUMENT_REPEAT_MODE", Integer.parseInt(arg));
        call(c, "sendCustomAction", CALLER, "android.support.v4.media.session.action.SET_REPEAT_MODE", bundle);
        break;
      }
      // move <queue id> <target queue id> <1 after|2 before>
      case "move": {
        String[] p = arg.split(" ");
        Object bundle = bundle();
        put(bundle, "putLong", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_ID", Long.parseLong(p[0]));
        put(bundle, "putLong", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_ID_TARGET", Long.parseLong(p[1]));
        put(bundle, "putInt", PLAYBACK + "command.ARGUMENT_PLAYBACK_QUEUE_MOVE_TARGET_TYPE", Integer.parseInt(p[2]));
        call(c, "sendCommand", CALLER, PLAYBACK + "command.MOVE_QUEUE_ITEM", bundle, null);
        break;
      }
      // autoplay <true|false>: whether Apple plays similar songs after the queue ends.
      case "autoplay": {
        Object bundle = bundle();
        put(bundle, "putBoolean", PLAYBACK + "action.ACTION_ENABLE_CONTINUOUS_PLAYBACK_ARG_ENABLED", Boolean.parseBoolean(arg));
        call(c, "sendCustomAction", CALLER, PLAYBACK + "action.ACTION_ENABLE_CONTINUOUS_PLAYBACK", bundle);
        break;
      }
      case "queue": return queue(c);
      default: return "{\"error\":\"unknown command\"}";
    }
    return state(c);
  }

  static Object bundle() throws Exception { return Class.forName("android.os.Bundle").getConstructor().newInstance(); }
  static void put(Object bundle, String method, String key, Object value) throws Exception { call(bundle, method, key, value); }

  // Apple's own queue description, built with Apple's classes loaded from its APK. Apple Music
  // reads it back with the same classes, so the parcel matches whatever this version expects.
  static Object provider(String[] ids, int start) throws Exception {
    if (apple == null) {
      if (applePath == null) throw new IllegalStateException("Apple Music's APK path was not given");
      apple = (ClassLoader) Class.forName("dalvik.system.PathClassLoader").getConstructor(String.class, ClassLoader.class).newInstance(applePath, Control.class.getClassLoader());
    }
    Class<?> builder = apple.loadClass(PLAYBACK + "queue.StorePlaybackQueueItemProvider$Builder");
    Object b = builder.getConstructor(String[].class).newInstance((Object) ids);
    builder.getMethod("startItemIndex", int.class).invoke(b, start);
    return builder.getMethod("build").invoke(b);
  }

  static String queue(Object c) throws Exception {
    Object slice = call(c, "getQueue");
    StringBuilder json = new StringBuilder("{\"queue\":[");
    if (slice != null) {
      List<?> items = (List<?>) call(slice, "getList");
      for (int i = 0; i < items.size(); i++) {
        Object item = items.get(i), description = call(item, "getDescription");
        Object id = call(description, "getMediaId"), title = call(description, "getTitle");
        json.append(i > 0 ? "," : "").append("{\"queueId\":").append(call(item, "getQueueId"))
          .append(",\"id\":").append(quote(String.valueOf(id))).append(",\"title\":").append(quote(String.valueOf(title))).append("}");
      }
    }
    return json.append("]}").toString();
  }

  // The session's controller binder. Apple Music creates its session when its playback service
  // starts, so a missing session is started with a media button.
  // A session kept from an Apple Music that was stopped since still answers through system_server,
  // with its last state, while commands to it go nowhere. So a kept session is at most a second old.
  static long checked;
  static synchronized Object session(boolean refresh) throws Exception {
    long now = System.currentTimeMillis();
    if (controller != null && !refresh && now - checked < 1000) return controller;
    controller = null; checked = now;
    Object manager = Class.forName("android.media.session.ISessionManager$Stub").getMethod("asInterface", Class.forName("android.os.IBinder"))
      .invoke(null, Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, "media_session"));
    List<?> tokens = (List<?>) call(manager, "getSessions", null, 0);
    for (Object token : tokens) {
      Object binder = token.getClass().getMethod("getBinder").invoke(token);
      if (APPLE.equals(call(binder, "getPackageName"))) return controller = binder;
    }
    return null;
  }

  static String state(Object c) throws Exception {
    Object state = call(c, "getPlaybackState");
    Object meta = call(c, "getMetadata");
    StringBuilder json = new StringBuilder("{");
    if (state != null) {
      long now = (Long) Class.forName("android.os.SystemClock").getMethod("elapsedRealtime").invoke(null);
      int code = (Integer) call(state, "getState");
      long position = (Long) call(state, "getPosition"), updated = (Long) call(state, "getLastPositionUpdateTime");
      float speed = (Float) call(state, "getPlaybackSpeed");
      if (code == 3 && updated > 0) position += (long) ((now - updated) * speed);
      json.append("\"state\":").append(code).append(",\"position\":").append(position)
        .append(",\"item\":").append(call(state, "getActiveQueueItemId"));
      Object error = call(state, "getErrorMessage");
      if (error != null) json.append(",\"error\":").append(quote(error.toString()));
    }
    if (meta != null) {
      for (String[] key : new String[][] { { "title", "android.media.metadata.TITLE" }, { "artist", "android.media.metadata.ARTIST" },
          { "album", "android.media.metadata.ALBUM" }, { "id", "android.media.metadata.MEDIA_ID" } }) {
        Object value = call(meta, "getString", key[1]);
        if (value != null) json.append(json.length() > 1 ? "," : "").append(quote(key[0])).append(":").append(quote(value.toString()));
      }
      json.append(json.length() > 1 ? "," : "").append("\"duration\":").append(call(meta, "getLong", "android.media.metadata.DURATION"));
    }
    // The rate Android mixes at, and the rate of the playing song's audio track once known, with
    // the entry it belongs to.
    if (Rates.known > 0) json.append(json.length() > 1 ? "," : "").append("\"mixerRate\":").append(Rates.known);
    if (songRate > 0) json.append(json.length() > 1 ? "," : "").append("\"songRate\":").append(songRate).append(",\"rateItem\":").append(rateItem);
    return json.append("}").toString();
  }

  // Calls the public or hidden method with this name and number of arguments.
  static Object call(Object target, String name, Object... args) throws Exception {
    for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
      for (Method method : type.getDeclaredMethods()) {
        if (method.getName().equals(name) && method.getParameterCount() == args.length) {
          method.setAccessible(true);
          return method.invoke(target, args);
        }
      }
    }
    for (Class<?> type : target.getClass().getInterfaces()) {
      for (Method method : type.getMethods()) {
        if (method.getName().equals(name) && method.getParameterCount() == args.length) return method.invoke(target, args);
      }
    }
    throw new NoSuchMethodException(target.getClass().getName() + "." + name + "/" + args.length);
  }

  static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (char ch : text.toCharArray()) {
      if (ch == '"' || ch == '\\') out.append('\\').append(ch);
      else if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
      else out.append(ch);
    }
    return out.append('"').toString();
  }

  // Makes Android mix at the playing song's own rate. Two signs give the song's rate. Apple Music
  // logs a song's decoded format when it prepares the song, from about a second ahead to just
  // after the song change, which is early but says nothing about which song it belongs to. Apple
  // Music also opens an audio track at the song's own rate when it prepares the song, and
  // AudioFlinger's dump lists that track. The track is the song's rate, so it decides, and the
  // logged format only lets the mixer switch before the track starts. Without the rate helper,
  // Rates.set changes nothing, and the state reports the song's rate beside the mixer's.
  static final java.util.ArrayDeque<long[]> decoded = new java.util.ArrayDeque<>();
  // The playing entry and the rate of its newest audio track, for the state. 0 while unknown.
  static volatile long rateItem = Long.MIN_VALUE;
  static volatile int songRate;

  static void follow() {
    Thread reader = new Thread(() -> {
      java.util.regex.Pattern format = java.util.regex.Pattern.compile("Decoder output format: .*SampleRate:(\\d+)");
      while (true) {
        try {
          Process logcat = Runtime.getRuntime().exec(new String[] { "logcat", "-v", "brief", "-T", "1", "SVAudioRendererNative:D", "*:S" });
          try (java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(logcat.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = in.readLine()) != null; ) {
              java.util.regex.Matcher m = format.matcher(line);
              if (!m.find()) continue;
              synchronized (decoded) {
                decoded.addLast(new long[] { System.currentTimeMillis(), Long.parseLong(m.group(1)) });
                while (decoded.size() > 8) decoded.removeFirst();
              }
            }
          } finally { logcat.destroy(); }
        } catch (Exception ignored) {}
        try { Thread.sleep(2000); } catch (InterruptedException stop) { return; }
      }
    });
    reader.setDaemon(true);
    reader.start();
    Thread switcher = new Thread(() -> {
      // The playing entry and when it started, when a switch last failed, and when AudioFlinger's
      // tracks are read next. The rate the entry should mix at: 0 while looking, -1 when no logged
      // format came within a second and no track was found yet. How often the tracks were read.
      long item = Long.MIN_VALUE, changed = 0, failed = 0, next = 0;
      int rate = 0, checks = 0;
      // The track the song plays on, once found, and the one the song before played on. That one
      // still plays for a moment after the change, while Apple Music opens the new song's track
      // after a skip, or it plays on when the next song has the same format.
      int own = -1, old = -1;
      while (true) {
        try {
          Thread.sleep(40);
          Object c = session(false);
          Object state = c == null ? null : call(c, "getPlaybackState");
          if (state == null) continue;
          long now = System.currentTimeMillis(), current = (Long) call(state, "getActiveQueueItemId");
          int code = (Integer) call(state, "getState");
          if (current != item) {
            item = current; changed = now; rate = 0; failed = 0; next = now + 100; checks = 0; old = own; own = -1;
            rateItem = item; songRate = 0;
          }
          if (rate == 0) {
            // The song's start line comes a few tens of milliseconds before the change shows, or
            // shortly after it.
            synchronized (decoded) {
              for (long[] entry : decoded) if (entry[0] >= changed - 300) { rate = (int) entry[1]; break; }
            }
            if (rate == 0 && now - changed > 1000) rate = -1;
          }
          // Apple Music's newest track, read 0.1, 0.25, 0.5, 1, 2 and 4 seconds after the song
          // change, then every 10 seconds while it plays. Its rate replaces the logged one. From
          // 1.5 seconds on, the track of the song before counts too.
          boolean playing = code == 3 || code == 6 || code == 8;
          if (now >= next && (playing || checks < 6)) {
            int[] track = Rates.inspect().apple(Rates.applePids(), old, now - changed >= 1500);
            if (track != null) {
              if (own >= 0 && track[0] != own) System.out.println("song " + item + " moved to track " + track[0] + " at " + track[4] + " Hz");
              own = track[0]; rate = track[4]; songRate = track[4];
            }
            checks++;
            next = now + (checks < 6 ? new int[] { 150, 250, 500, 1000, 2000 }[checks - 1] : 10000);
          }
          // A new song switches at once, also while paused, so the track it starts with already
          // runs at its rate. A failed switch is tried again every two seconds.
          if ((playing || code == 2) && rate > 0 && now - failed > 2000 && Rates.mixer() != rate) {
            if (Rates.set(rate) != rate) failed = System.currentTimeMillis();
          }
        } catch (InterruptedException stop) { return; }
        catch (Exception retry) { try { Thread.sleep(1000); } catch (InterruptedException stop) { return; } }
      }
    });
    switcher.setDaemon(true);
    switcher.start();
  }

  // The rate Android mixes at, and switching it through RateServe, which runs as audioserver.
  //
  // Android 13's AudioFlinger frees its mixer's buffers and allocates new ones when the rate
  // changes (readOutputParameters_l). An open track still mixes into the buffer of its effect
  // chain, or, without one, into the old buffer that was just freed, so it plays silence from then
  // on. It moves to the new buffer only when its session's effect chain comes or goes. A switch
  // therefore attaches a disabled effect to every session on the mixer first, which AudioFlinger
  // carries over to the new buffers, and releases it afterwards, which leaves each track on the
  // new buffer. A disabled effect copies its input unchanged.
  static final class Rates {
    static final int SAMPLE_RATE = 1 + 2;
    static int output = -1;
    // The rate last read or set, for the state, which must not wait for a switch.
    static volatile int known;

    // Android's first mixer output as AudioFlinger's dump shows it: its I/O handle and its tracks,
    // each as { id, active (1 or 0), static (1 or 0), session, rate, ending (1 or 0), client }. A
    // track ends once it is stopped, stopping or terminated, as the track of the song before is.
    // The client is the process ID of the app that opened the track.
    static final class Mixer {
      int io = -1;
      final java.util.List<int[]> tracks = new java.util.ArrayList<>();

      // Apple Music's newest track that has not ended: the newest active one, or the newest one
      // at all while none plays, as after a song was prepared and before it starts. Only tracks
      // of Apple's processes (clients) count, since a newer track of another app, such as a
      // system sound at 48 kHz, would otherwise set the song's rate. The track old, which played
      // the song before, counts only with stale. Static tracks are short sounds, not songs. Null
      // without a track.
      int[] apple(java.util.Set<Integer> clients, int old, boolean stale) {
        int[] best = null;
        for (int[] t : tracks) {
          if (!clients.contains(t[6]) || t[2] == 1 || t[5] == 1 || !stale && t[0] == old) continue;
          if (best == null || t[1] > best[1] || t[1] == best[1] && t[0] > best[0]) best = t;
        }
        return best;
      }

      java.util.Set<Integer> sessions() {
        java.util.Set<Integer> all = new java.util.TreeSet<>();
        for (int[] t : tracks) all.add(t[3]);
        return all;
      }
    }

    // A track row of the dump: an optional fast-track index and type, then ID, active, client,
    // session, port, state, flags, format, channel mask and rate.
    static final java.util.regex.Pattern ROW = java.util.regex.Pattern.compile(
      "^\\s*(?:F\\d+\\s+)?([SP?]\\s+)?(\\d+)\\s+(yes|no)\\s+(\\d+)\\s+(\\d+)\\s+\\d+\\s+(\\S{1,2})\\s+0x[0-9a-fA-F]+\\s+[0-9a-fA-F]+\\s+[0-9a-fA-F]+\\s+(\\d+)\\s");

    static Mixer inspect() throws Exception {
      Process dump = Runtime.getRuntime().exec(new String[] { "dumpsys", "media.audio_flinger" });
      try (java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(dump.getInputStream(), StandardCharsets.UTF_8))) {
        return parse(in);
      } finally { dump.destroy(); }
    }

    // Reads the first mixer output from AudioFlinger's dump. hires/tests/offline/control.sh tests it.
    static Mixer parse(java.io.BufferedReader in) throws Exception {
      Mixer mixer = new Mixer();
      // 0 before the first mixer, 1 in it, 2 in its track list, 3 after it.
      int part = 0;
      for (String line; (line = in.readLine()) != null && part < 3; ) {
        String text = line.trim();
        if (part == 0) { if (line.startsWith("Output thread") && line.contains("(MIXER)")) part = 1; }
        else if (line.startsWith("Output thread") || line.startsWith("Input thread") || text.startsWith("Local log:")) part = 3;
        else if (part == 1 && text.startsWith("I/O handle:")) mixer.io = Integer.parseInt(text.substring(11).trim());
        else if (part == 1 && text.contains("Tracks of which")) part = 2;
        else if (part == 2) {
          java.util.regex.Matcher m = ROW.matcher(line);
          String type = m.find() ? m.group(1) == null ? "" : m.group(1).trim() : null;
          // Patch tracks carry audio between outputs, not an app's sound.
          if (type == null || type.equals("P")) continue;
          mixer.tracks.add(new int[] { Integer.parseInt(m.group(2)), m.group(3).equals("yes") ? 1 : 0, type.equals("S") ? 1 : 0,
            Integer.parseInt(m.group(5)), Integer.parseInt(m.group(7)), m.group(6).matches("T|S|s1|s2") ? 1 : 0, Integer.parseInt(m.group(4)) });
        }
      }
      if (mixer.io < 0) throw new IllegalStateException("Android has no mixer output");
      return mixer;
    }

    // The process IDs of Apple Music, its main process and any others it starts, read from /proc
    // each time, since a restarted Apple Music gets new ones. The shell user may read every
    // process's command line. Empty while Apple Music does not run.
    static java.util.Set<Integer> applePids() {
      java.util.Set<Integer> pids = new java.util.HashSet<>();
      java.io.File[] all = new java.io.File("/proc").listFiles();
      if (all == null) return pids;
      for (java.io.File dir : all) {
        String name = dir.getName();
        if (name.isEmpty() || !Character.isDigit(name.charAt(0))) continue;
        try {
          byte[] line = java.nio.file.Files.readAllBytes(new java.io.File(dir, "cmdline").toPath());
          int end = 0;
          while (end < line.length && line[end] != 0) end++;
          String process = new String(line, 0, end, StandardCharsets.UTF_8);
          if (process.equals(APPLE) || process.startsWith(APPLE + ":")) pids.add(Integer.parseInt(name));
        } catch (Exception gone) {}
      }
      return pids;
    }

    // The I/O handle of the first mixer output.
    static int output() throws Exception {
      if (output >= 0) return output;
      return output = inspect().io;
    }

    static int read(int io) throws Exception {
      Class<?> parcel = Class.forName("android.os.Parcel");
      Object data = parcel.getMethod("obtain").invoke(null), reply = parcel.getMethod("obtain").invoke(null);
      try {
        Object binder = Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, "media.audio_flinger");
        call(data, "writeInterfaceToken", "android.media.IAudioFlingerService");
        call(data, "writeInt", io);
        call(binder, "transact", SAMPLE_RATE, data, reply, 0);
        if ((Integer) call(reply, "readInt") != 0) throw new IllegalStateException("AudioFlinger refused the call");
        return (Integer) call(reply, "readInt");
      } finally { call(data, "recycle"); call(reply, "recycle"); }
    }

    // AudioFlinger answers 0 for an output that no longer exists, for example after audioserver
    // restarted, so the handle is looked up again then.
    static synchronized int mixer() throws Exception {
      try { int rate = read(output()); if (rate > 0) return known = rate; } catch (Exception stale) {}
      output = -1;
      return known = read(output());
    }

    // A disabled effect on each session, or none where Android refuses one. Released by release.
    static java.util.List<Object> attach(java.util.Collection<Integer> sessions) {
      java.util.List<Object> effects = new java.util.ArrayList<>();
      for (int session : sessions) {
        try { effects.add(Class.forName("android.media.audiofx.LoudnessEnhancer").getConstructor(int.class).newInstance(session)); }
        catch (Throwable refused) { System.out.println("no effect for session " + session + ": " + (refused.getCause() != null ? refused.getCause() : refused)); }
      }
      return effects;
    }

    static void release(java.util.List<Object> effects) {
      for (Object effect : effects) try { call(effect, "release"); } catch (Exception ignored) {}
    }

    // Moves every track on the mixer to the mixer's current buffer, as a switch does. Answers how
    // many sessions it reached.
    static synchronized int rebind() throws Exception {
      java.util.List<Object> effects = attach(inspect().sessions());
      release(effects);
      return effects.size();
    }

    static synchronized int set(int rate) throws Exception {
      if (mixer() == rate) return rate;
      Mixer before;
      try { before = inspect(); output = before.io; } catch (Exception unreadable) { before = new Mixer(); }
      java.util.List<Object> effects = attach(before.sessions());
      int result;
      Object socket = Class.forName("android.net.LocalSocket").getConstructor().newInstance();
      try {
        Object address = Class.forName("android.net.LocalSocketAddress").getConstructor(String.class).newInstance("peel-rate");
        call(socket, "connect", address);
        call(socket, "setSoTimeout", 3000);
        OutputStream out = (OutputStream) call(socket, "getOutputStream");
        out.write((output() + " " + rate + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
        java.io.InputStream in = (java.io.InputStream) call(socket, "getInputStream");
        StringBuilder answer = new StringBuilder();
        for (int b; (b = in.read()) >= 0 && b != '\n' && answer.length() < 16; ) answer.append((char) b);
        result = known = Integer.parseInt(answer.toString().trim());
      } catch (Exception missing) {
        result = mixer();
      } finally {
        call(socket, "close");
        release(effects);
      }
      System.out.println("mixer at " + result + " Hz, asked for " + rate + " Hz, " + effects.size() + " of " + before.sessions().size() + " sessions held");
      // A session that opened its first track between the dump and the switch still mixes into
      // the freed buffer, so it gets an effect now, which moves its tracks to the new one.
      if (result == rate) {
        try {
          java.util.Set<Integer> late = inspect().sessions();
          late.removeAll(before.sessions());
          if (!late.isEmpty()) release(attach(late));
        } catch (Exception unreadable) {}
      }
      return result;
    }
  }
}
