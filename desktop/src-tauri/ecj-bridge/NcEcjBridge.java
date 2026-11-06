import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.Writer;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;

/**
 * 常驻 ecj 编译桥（行协议见 rust 侧 java_bridge.rs）。
 *
 * 为什么需要它：一次一进程时，JVM 启动 + ecj 类加载要 0.6~0.9 秒，而这部分与源码
 * 无关。常驻后同一次编译只要 20~50 毫秒（实测见 scripts/ecj-bridge-contract.test.mjs）。
 *
 * 协议：
 * - 请求：`id \t cmd \t arg…`，一行一条，UTF-8；
 * - 响应：`{"id":"N","ok":true,"data":{"exit":0|1,"output":"…","pid":"…"}}`；
 *   堆不足回 `{"id":"N","ok":false,"code":"oom"}`，Rust 侧据此回退一次一进程；
 *   **id 必须是字符串**——java_bridge.rs 的读线程按 `as_str()` 分发，数字会被丢掉；
 * - `quit` 退出（Rust 侧关进程时先发它）。
 *
 * 编译直接调 ecj 的 {@code Main.compile(...)}（systemExit=false），**不能**调
 * `Main.main`——那个会 System.exit，整个常驻进程就没了。ecj 输出同时写 out/err，
 * 这里把 System.out/err 临时重定向到同一个缓冲区，保持与一次一进程的输出一致。
 */
public final class NcEcjBridge {

    public static void main(String[] args) throws Exception {
        PrintStream raw = System.out;
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        Writer out = new OutputStreamWriter(raw, StandardCharsets.UTF_8);
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            String[] parts = line.split("\t", -1);
            String id;
            try {
                Long.parseLong(parts[0]);
                id = parts[0];
            } catch (RuntimeException e) {
                continue; // 无法配对响应，丢弃
            }
            String cmd = parts.length > 1 ? unescape(parts[1]) : "";
            if ("quit".equals(cmd)) break;
            if (!"compile".equals(cmd) || parts.length < 3) {
                reply(out, id, false, "未知命令：" + cmd, null);
                continue;
            }
            String argFile = unescape(parts[2]);
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            PrintWriter pw = new PrintWriter(new OutputStreamWriter(buf, StandardCharsets.UTF_8), true);
            PrintStream ps = new PrintStream(buf, true, "UTF-8");
            PrintStream oldOut = System.out;
            PrintStream oldErr = System.err;
            boolean ok;
            boolean oom = false;
            try {
                System.setOut(ps);
                System.setErr(ps);
                ok = org.eclipse.jdt.internal.compiler.batch.Main.compile(
                        new String[] { "@" + argFile }, pw, pw, null);
            } catch (OutOfMemoryError e) {
                // 堆爆和「源码有错」必须分开：否则问题面板会把 OOM 显示成编译错误
                oom = true;
                ok = false;
                e.printStackTrace(pw);
            } catch (Throwable t) {
                ok = false;
                t.printStackTrace(pw);
            } finally {
                pw.flush();
                ps.flush();
                System.setOut(oldOut);
                System.setErr(oldErr);
            }
            if (oom) {
                replyError(out, id, "oom", "worker 堆不足");
            } else {
                reply(out, id, true, null, new CompileResult(ok,
                        new String(buf.toByteArray(), StandardCharsets.UTF_8)));
            }
        }
        out.flush();
    }

    private static void reply(Writer out, String id, boolean ok, String error, CompileResult result)
            throws Exception {
        if (!ok) {
            replyError(out, id, "other", error);
            return;
        }
        StringBuilder s = new StringBuilder(128);
        s.append("{\"id\":\"").append(id).append("\",\"ok\":").append(ok);
        s.append(",\"data\":{\"exit\":").append(result.ok ? 0 : 1);
        s.append(",\"pid\":\"").append(pid()).append('"');
        s.append(",\"output\":\"").append(json(result.output)).append("\"}}\n");
        out.write(s.toString());
        out.flush();
    }

    private static void replyError(Writer out, String id, String code, String error) throws Exception {
        StringBuilder s = new StringBuilder(96);
        s.append("{\"id\":\"").append(id).append("\",\"ok\":false,\"code\":\"").append(code);
        s.append("\",\"error\":\"").append(json(error)).append("\"}\n");
        out.write(s.toString());
        out.flush();
    }

    private static String pid() {
        String name = ManagementFactory.getRuntimeMXBean().getName();
        int at = name.indexOf('@');
        return at > 0 ? name.substring(0, at) : name;
    }

    private static String unescape(String v) {
        StringBuilder s = new StringBuilder(v.length());
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c != '\\' || i + 1 >= v.length()) {
                s.append(c);
                continue;
            }
            char n = v.charAt(++i);
            switch (n) {
                case 't': s.append('\t'); break;
                case 'n': s.append('\n'); break;
                case 'r': s.append('\r'); break;
                default: s.append(n); break;
            }
        }
        return s.toString();
    }

    private static String json(String v) {
        StringBuilder s = new StringBuilder(v.length() + 16);
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            switch (c) {
                case '"': s.append("\\\""); break;
                case '\\': s.append("\\\\"); break;
                case '\n': s.append("\\n"); break;
                case '\r': s.append("\\r"); break;
                case '\t': s.append("\\t"); break;
                default:
                    if (c < 0x20) s.append(String.format("\\u%04x", (int) c));
                    else s.append(c);
            }
        }
        return s.toString();
    }

    private static final class CompileResult {
        final boolean ok;
        final String output;

        CompileResult(boolean ok, String output) {
            this.ok = ok;
            this.output = output;
        }
    }
}
