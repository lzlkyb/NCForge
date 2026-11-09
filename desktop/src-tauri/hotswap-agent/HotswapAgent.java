package io.github.lzlkyb.ncforge.hotswap;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.instrument.ClassDefinition;
import java.lang.instrument.Instrumentation;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.CodeSource;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * NCForge 热替换 agent：把工作台编译好的 class 换进运行中的 NC JVM。
 *
 * <p>方案见 docs/NCForge-热替换-方案设计-2026-11-06.md。要点：
 * <ul>
 *   <li>{@code premain}（启动参数 {@code -javaagent:jar=会话文件}）与 {@code agentmain}（Attach API
 *       动态挂载）走同一入口；重复挂载幂等：已在监听就只重读令牌、重写就绪文件。</li>
 *   <li>只绑 127.0.0.1，端口由系统分配，写进「会话文件.ready」；令牌只在会话文件里，不进命令行。</li>
 *   <li>只替换 codeSource 正好是请求里 root 目录的那份类；同名类来自别处（补丁、NC home jar）
 *       报「被遮蔽」不替换——悄悄替换会让「重启后又变回去」更难查。</li>
 *   <li>一批类一次 {@code redefineClasses}：JVM 保证整批成功或整批不生效。</li>
 * </ul>
 *
 * <p>只用 JDK 自带类，不碰 NC 的任何类，不加载用户类。运行在 ufjdk 1.8 上，但源码保持 Java 7 可编
 * （不用 lambda / stream）：本机 JAVA_HOME 是 JDK 7，构建脚本可能拿它来编。
 *
 * <p>协议（一次连接一个请求，UTF-8，行分隔）：
 * <pre>
 * NCFORGE-HOTSWAP 1
 * token &lt;令牌&gt;
 * op ping | redefine
 * root &lt;classes 目录绝对路径&gt;        （redefine 必填，可多行）
 * class &lt;类全名&gt;\t&lt;class 文件绝对路径&gt; （redefine 必填，可多行）
 * end
 * </pre>
 * 响应是一行 JSON：成功 {@code {"ok":true,...}}，失败 {@code {"ok":false,"code":..,"message":..}}。
 */
public final class HotswapAgent {

    /** 协议版本：Rust 侧据此判断 agent 是否需要重启 JVM 才能升级。 */
    static final int PROTOCOL = 1;

    private static final Charset UTF8 = Charset.forName("UTF-8");
    /** 单行上限：路径再长也到不了 16K，超过一律当作畸形请求。 */
    private static final int MAX_LINE = 16 * 1024;
    /** 单个请求的行数上限：一次保存最多几十个类，5000 行足够且防止被灌爆。 */
    private static final int MAX_LINES = 5000;
    /** 单个 class 文件上限：NC 里最大的类也只有几百 KB。 */
    private static final long MAX_CLASS_BYTES = 8L * 1024 * 1024;
    /** 读请求超时：客户端连上不发数据时不能把唯一的处理线程挂死。 */
    private static final int READ_TIMEOUT_MS = 10000;
    private static final Pattern CLASS_NAME = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*");
    private static final boolean WINDOWS =
            System.getProperty("os.name", "").toLowerCase().startsWith("windows");

    private static Instrumentation inst;
    private static ServerSocket server;
    private static volatile String token;

    private HotswapAgent() {}

    public static void premain(String args, Instrumentation instrumentation) {
        start(args, instrumentation);
    }

    public static void agentmain(String args, Instrumentation instrumentation) {
        start(args, instrumentation);
    }

    /**
     * 任何失败都只打一行日志，绝不抛出：premain 抛异常会让整个 NC 起不来，
     * 热替换是锦上添花，不能变成启动的单点故障。
     */
    static synchronized void start(String args, Instrumentation instrumentation) {
        try {
            if (args == null || args.trim().isEmpty()) {
                log("未指定会话文件，热替换不可用");
                return;
            }
            File session = new File(args.trim());
            String t = readToken(session);
            if (t == null) {
                log("会话文件里没有有效令牌，热替换不可用：" + session);
                return;
            }
            token = t;
            if (server != null && !server.isClosed()) {
                // 重复挂载：沿用已在监听的端口，只换令牌、重写就绪文件
                writeReady(session, server.getLocalPort());
                log("已在监听 127.0.0.1:" + server.getLocalPort() + "，令牌已更新");
                return;
            }
            if (!instrumentation.isRedefineClassesSupported()) {
                log("当前 JVM 不支持 redefineClasses，热替换不可用");
                return;
            }
            inst = instrumentation;
            ServerSocket ss = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            server = ss;
            writeReady(session, ss.getLocalPort());
            Thread th = new Thread(new Runnable() {
                public void run() {
                    acceptLoop();
                }
            }, "ncforge-hotswap");
            th.setDaemon(true);
            th.start();
            log("监听 127.0.0.1:" + ss.getLocalPort());
        } catch (Throwable e) {
            log("启动失败，热替换不可用：" + e);
        }
    }

    /** 会话文件格式：{@code token=<至少 16 位>}，其余行忽略。 */
    static String readToken(File session) throws IOException {
        if (!session.isFile()) return null;
        for (String line : new String(Files.readAllBytes(session.toPath()), UTF8).split("\r?\n")) {
            if (line.startsWith("token=")) {
                String t = line.substring(6).trim();
                return t.length() >= 16 ? t : null;
            }
        }
        return null;
    }

    /** 先写临时文件再改名：Rust 侧轮询到的就绪文件一定是完整的。 */
    static void writeReady(File session, int port) throws IOException {
        File ready = new File(session.getPath() + ".ready");
        File tmp = new File(session.getPath() + ".ready.tmp");
        String body = "port=" + port + "\npid=" + pid() + "\nprotocol=" + PROTOCOL + "\n";
        Files.write(tmp.toPath(), body.getBytes(UTF8));
        Files.move(tmp.toPath(), ready.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    /**
     * 单线程顺序处理：替换本来就要串行，单线程也天然避免两批替换交错。
     * 让出点是阻塞的 {@code accept()}；socket 被关闭（JVM 退出）时退出循环；
     * 其他 IO 错误退避 200ms 再接，最坏退化成每秒 5 次。
     */
    static void acceptLoop() {
        while (true) {
            Socket s;
            try {
                s = server.accept();
            } catch (SocketException e) {
                if (server.isClosed()) return;
                backoff();
                continue;
            } catch (IOException e) {
                backoff();
                continue;
            }
            try {
                s.setSoTimeout(READ_TIMEOUT_MS);
                String resp = handle(s.getInputStream());
                OutputStream out = s.getOutputStream();
                out.write((resp + "\n").getBytes(UTF8));
                out.flush();
            } catch (Throwable e) {
                log("处理请求失败：" + e);
            } finally {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // 关不掉也不影响下一个连接
                }
            }
        }
    }

    private static void backoff() {
        try {
            Thread.sleep(200);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** 解析并执行一个请求，返回一行 JSON。包可见：契约测试之外也便于单测。 */
    static String handle(InputStream in) throws IOException {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, UTF8));
        String head = readLine(r);
        if (!("NCFORGE-HOTSWAP " + PROTOCOL).equals(head)) {
            return fail("protocol", "协议头不匹配，期望 NCFORGE-HOTSWAP " + PROTOCOL + "，收到 " + head);
        }
        String tok = null;
        String op = null;
        List<String> roots = new ArrayList<String>();
        List<String[]> classes = new ArrayList<String[]>();
        boolean ended = false;
        for (int i = 0; i < MAX_LINES; i++) {
            String line = readLine(r);
            if (line == null) break;
            if (line.equals("end")) {
                ended = true;
                break;
            }
            if (line.startsWith("token ")) tok = line.substring(6);
            else if (line.startsWith("op ")) op = line.substring(3).trim();
            else if (line.startsWith("root ")) roots.add(line.substring(5));
            else if (line.startsWith("class ")) {
                String[] kv = line.substring(6).split("\t", 2);
                if (kv.length != 2) return fail("bad-request", "class 行缺少文件路径：" + line);
                classes.add(kv);
            } else return fail("bad-request", "无法识别的行：" + line);
        }
        if (!ended) return fail("bad-request", "请求没有以 end 结束（或超过 " + MAX_LINES + " 行）");
        // 鉴权放在解析完之后、执行之前：未鉴权的请求什么也做不了
        if (tok == null || !constantTimeEquals(tok, token)) return fail("auth", "令牌不正确");
        if ("ping".equals(op)) return ping();
        if ("redefine".equals(op)) return redefine(roots, classes);
        return fail("bad-request", "未知操作：" + op);
    }

    private static String readLine(BufferedReader r) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = r.read()) != -1) {
            if (c == '\n') break;
            if (sb.length() >= MAX_LINE) throw new IOException("单行超过 " + MAX_LINE + " 字符");
            sb.append((char) c);
        }
        if (c == -1 && sb.length() == 0) return null;
        int n = sb.length();
        if (n > 0 && sb.charAt(n - 1) == '\r') sb.setLength(n - 1);
        return sb.toString();
    }

    private static String ping() {
        return "{\"ok\":true,\"op\":\"ping\",\"protocol\":" + PROTOCOL + ",\"pid\":" + json(pid())
                + ",\"java\":" + json(System.getProperty("java.version", ""))
                + ",\"canRedefine\":" + inst.isRedefineClassesSupported() + "}";
    }

    /** 一个待替换的类：规范化后的文件与所属 root。 */
    private static final class Req {
        final String name;
        final File file;
        final File root;
        final byte[] bytes;

        Req(String name, File file, File root, byte[] bytes) {
            this.name = name;
            this.file = file;
            this.root = root;
            this.bytes = bytes;
        }
    }

    static String redefine(List<String> rootArgs, List<String[]> classArgs) {
        long t0 = System.nanoTime();
        if (rootArgs.isEmpty() || classArgs.isEmpty()) {
            return fail("bad-request", "redefine 至少要有一个 root 和一个 class");
        }
        List<File> roots = new ArrayList<File>();
        try {
            for (String r : rootArgs) {
                File f = new File(r).getCanonicalFile();
                if (!f.isDirectory()) return fail("bad-request", "root 不是目录：" + r);
                roots.add(f);
            }
        } catch (IOException e) {
            return fail("io", "规范化 root 失败：" + e);
        }

        // 先把每个文件都校验、读好；任何一项不合格整批拒绝，不做部分替换
        List<Req> reqs = new ArrayList<Req>();
        for (String[] kv : classArgs) {
            String name = kv[0].trim();
            if (!CLASS_NAME.matcher(name).matches()) return fail("bad-request", "类名不合法：" + name);
            File file;
            try {
                file = new File(kv[1]).getCanonicalFile();
            } catch (IOException e) {
                return fail("io", "规范化路径失败：" + kv[1]);
            }
            String rel = name.replace('.', File.separatorChar) + ".class";
            File owner = null;
            for (File root : roots) {
                if (pathEquals(new File(root, rel), file)) {
                    owner = root;
                    break;
                }
            }
            if (owner == null) {
                return fail("bad-request", "文件不在任何 root 下或与类名不对应：" + name + " → " + kv[1]);
            }
            if (!file.isFile()) return fail("io", "class 文件不存在：" + file);
            if (file.length() > MAX_CLASS_BYTES) return fail("bad-request", "class 文件过大：" + file);
            try {
                reqs.add(new Req(name, file, owner, readAll(file)));
            } catch (IOException e) {
                return fail("io", "读取失败：" + file + "：" + e);
            }
        }

        Map<String, List<Class<?>>> loaded = new HashMap<String, List<Class<?>>>();
        for (Req q : reqs) loaded.put(q.name, new ArrayList<Class<?>>());
        for (Class<?> c : inst.getAllLoadedClasses()) {
            List<Class<?>> l = loaded.get(c.getName());
            if (l != null) l.add(c);
        }

        List<ClassDefinition> defs = new ArrayList<ClassDefinition>();
        StringBuilder redefined = new StringBuilder();
        StringBuilder notLoaded = new StringBuilder();
        StringBuilder shadowed = new StringBuilder();
        for (Req q : reqs) {
            List<Class<?>> cs = loaded.get(q.name);
            if (cs.isEmpty()) {
                // 没加载过：什么也不用做，首次使用时 JVM 会从磁盘读到新 class
                append(notLoaded, json(q.name));
                continue;
            }
            for (Class<?> c : cs) {
                File src = sourceDir(c);
                if (src != null && pathEquals(src, q.root) && inst.isModifiableClass(c)) {
                    defs.add(new ClassDefinition(c, q.bytes));
                    append(redefined, "{\"name\":" + json(q.name) + ",\"loader\":" + json(loaderName(c)) + "}");
                } else {
                    append(shadowed, "{\"name\":" + json(q.name) + ",\"loader\":" + json(loaderName(c))
                            + ",\"source\":" + json(src == null ? "" : src.getPath()) + "}");
                }
            }
        }

        if (!defs.isEmpty()) {
            try {
                inst.redefineClasses(defs.toArray(new ClassDefinition[0]));
            } catch (UnsupportedOperationException e) {
                return fail("unsupported", String.valueOf(e.getMessage()));
            } catch (ClassFormatError e) {
                return fail("format", e.toString());
            } catch (LinkageError e) {
                return fail("verify", e.toString());
            } catch (Throwable e) {
                return fail("internal", e.toString());
            }
        }
        long ms = (System.nanoTime() - t0) / 1000000L;
        log("替换 " + defs.size() + " 个类，耗时 " + ms + " ms");
        return "{\"ok\":true,\"op\":\"redefine\",\"redefined\":[" + redefined + "],\"notLoaded\":[" + notLoaded
                + "],\"shadowed\":[" + shadowed + "],\"elapsedMs\":" + ms + "}";
    }

    /** 类的来源目录；来自 jar、没有 codeSource（启动类加载器）或解析失败时返回 null。 */
    static File sourceDir(Class<?> c) {
        try {
            ProtectionDomain pd = c.getProtectionDomain();
            CodeSource cs = pd == null ? null : pd.getCodeSource();
            URL u = cs == null ? null : cs.getLocation();
            if (u == null || !"file".equals(u.getProtocol())) return null;
            return new File(u.toURI()).getCanonicalFile();
        } catch (Throwable e) {
            return null;
        }
    }

    private static boolean pathEquals(File a, File b) {
        return WINDOWS ? a.getPath().equalsIgnoreCase(b.getPath()) : a.getPath().equals(b.getPath());
    }

    private static String loaderName(Class<?> c) {
        ClassLoader l = c.getClassLoader();
        return l == null ? "bootstrap" : l.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(l));
    }

    private static byte[] readAll(File f) throws IOException {
        InputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) f.length());
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (b == null) return false;
        byte[] x = a.getBytes(UTF8);
        byte[] y = b.getBytes(UTF8);
        int diff = x.length ^ y.length;
        for (int i = 0; i < Math.min(x.length, y.length); i++) diff |= x[i] ^ y[i];
        return diff == 0;
    }

    private static String pid() {
        // Java 8 没有 ProcessHandle：RuntimeMXBean 的名字形如 "12345@host"
        String n = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
        int at = n.indexOf('@');
        return at > 0 ? n.substring(0, at) : n;
    }

    private static void append(StringBuilder sb, String item) {
        if (sb.length() > 0) sb.append(',');
        sb.append(item);
    }

    static String fail(String code, String message) {
        return "{\"ok\":false,\"code\":" + json(code) + ",\"message\":" + json(message) + "}";
    }

    static String json(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
                    else sb.append(ch);
            }
        }
        return sb.append('"').toString();
    }

    private static void log(String msg) {
        System.err.println("[ncforge-hotswap] " + msg);
    }
}
