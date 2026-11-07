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

  // One line, or null at the end. A longer line than MAX_LINE ends the connection.
  static String line(java.io.InputStream in) throws java.io.IOException {
    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
    for (int b; (b = in.read()) != '\n'; ) {
      if (b < 0) return bytes.size() > 0 ? bytes.toString("UTF-8") : null;
      if (bytes.size() >= MAX_LINE) throw new java.io.IOException("line too long");
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
      while ((line = line(in)) != null) {
        int space = line.indexOf(' ');
        if (space < 0 || !java.security.MessageDigest.isEqual(line.substring(0, space).getBytes(StandardCharsets.UTF_8), key.getBytes(StandardCharsets.UTF_8))) {
          out.write("{\"error\":\"key\"}\n".getBytes(StandardCharsets.UTF_8));
          return;
        }
        s.setSoTimeout(0);
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
    Object c = session(false);
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
      // volume <0..15>: Android's media volume. 15 leaves the samples unchanged.
      case "volume": call(c, "setVolumeTo", CALLER, CALLER, Integer.parseInt(arg), 0); break;
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
  static Object session(boolean refresh) throws Exception {
    if (controller != null && !refresh) return controller;
    controller = null;
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
}
