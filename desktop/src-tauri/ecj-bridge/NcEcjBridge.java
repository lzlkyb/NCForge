import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.Writer;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import org.eclipse.jdt.internal.compiler.classfmt.ClassFileConstants;
import org.eclipse.jdt.internal.compiler.classfmt.ClassFileReader;
import org.eclipse.jdt.internal.compiler.codegen.AnnotationTargetTypeConstants;
import org.eclipse.jdt.internal.compiler.env.IBinaryAnnotation;
import org.eclipse.jdt.internal.compiler.env.IBinaryElementValuePair;
import org.eclipse.jdt.internal.compiler.env.IBinaryField;
import org.eclipse.jdt.internal.compiler.env.IBinaryMethod;
import org.eclipse.jdt.internal.compiler.env.IBinaryNestedType;
import org.eclipse.jdt.internal.compiler.env.IBinaryTypeAnnotation;
import org.eclipse.jdt.internal.compiler.impl.Constant;
import org.eclipse.jdt.internal.compiler.lookup.TagBits;
import org.eclipse.jdt.internal.compiler.lookup.TypeIds;

/**
 * 常驻 ecj 编译桥（行协议见 rust 侧 java_bridge.rs）。
 *
 * 为什么需要它：一次一进程时，JVM 启动 + ecj 类加载要 0.6~0.9 秒，而这部分与源码
 * 无关。常驻后同一次编译只要 20~50 毫秒（实测见 scripts/ecj-bridge-contract.test.mjs）。
 *
 * 协议：
 * - 请求：`id \t cmd \t arg…`，一行一条，UTF-8；
 * - 响应：`{"id":"N","ok":true,"data":{…}}`；
 *   堆不足回 `{"id":"N","ok":false,"code":"oom"}`，Rust 侧据此回退一次一进程；
 *   **id 必须是字符串**——java_bridge.rs 的读线程按 `as_str()` 分发，数字会被丢掉；
 * - `quit` 退出（Rust 侧关进程时先发它）。
 *
 * 命令：
 * - `compile <argsFile>`：ecj 批编译。直接调 {@code Main.compile(...)}（systemExit=false），
 *   **不能**调 `Main.main`——那个会 System.exit，整个常驻进程就没了。ecj 输出同时写
 *   out/err，这里把 System.out/err 临时重定向到同一个缓冲区，保持与一次一进程的输出一致。
 *   data = {"exit":0|1,"output":"…","pid":"…"}。
 * - `struct <pathsFile>`：逐行读 class 文件路径，对每个 class 算**结构指纹**（SHA-256 hex）。
 *   指纹的投影面与 Eclipse 增量构建器用的 ClassFileReader.hasStructuralChanges 完全对齐
 *   （R4_11 源码逐项核对）：类修饰符/结构相关 tagBits/注解（含成员值）/泛型签名/继承/
 *   成员类型/非合成字段（含常量逐类型比值）/非合成非 clinit 方法（含参数注解与声明异常）/
 *   missing types。**方法体不在投影里**——只改方法体指纹不变。private 成员不豁免
 *   （Eclipse 同样不豁免，宁可多编）。data = {"structs":[{"path","fp","name"}],"errors":["path\tmsg"]}。
 *   单个 class 读失败进 errors、不进 structs，Rust 侧按「结构可能变了」保守处理。
 * - `diff <pairsFile>`：逐行 `旧class路径\t新class路径`，直接调 ecj 自己的
 *   hasStructuralChanges（Eclipse 的原版判定）。**只给契约测试当 oracle 用**：
 *   断言「struct 指纹相等 ⟺ hasStructuralChanges=false」，把指纹钉在 Eclipse 语义上。
 *   data = {"diffs":[{"old","new","structural"}],"errors":[…]}。
 *
 * 语法按 Java 7 写（NC 自带的 ufjdk 可能是 7/8），不用 lambda / var / String.join。
 */
public final class NcEcjBridge {

    /** 与 Eclipse hasStructuralChanges 里 OnlyStructuralTagBits 同一组掩码。 */
    private static final long STRUCTURAL_TAG_BITS = TagBits.AnnotationTargetMASK
            | TagBits.AnnotationDeprecated
            | TagBits.AnnotationRetentionMASK
            | TagBits.HierarchyHasProblems;

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
            if (parts.length < 3) {
                replyError(out, id, "other", "参数不足：" + cmd);
                continue;
            }
            String argFile = unescape(parts[2]);
            if ("compile".equals(cmd)) {
                doCompile(out, id, argFile);
            } else if ("struct".equals(cmd)) {
                doStruct(out, id, argFile);
            } else if ("diff".equals(cmd)) {
                doDiff(out, id, argFile);
            } else {
                replyError(out, id, "other", "未知命令：" + cmd);
            }
        }
        out.flush();
    }

    private static void doCompile(Writer out, String id, String argFile) throws Exception {
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
            StringBuilder s = new StringBuilder(128);
            s.append("{\"id\":\"").append(id).append("\",\"ok\":true");
            s.append(",\"data\":{\"exit\":").append(ok ? 0 : 1);
            s.append(",\"pid\":\"").append(pid()).append('"');
            s.append(",\"output\":\"").append(json(new String(buf.toByteArray(), StandardCharsets.UTF_8))).append("\"}}\n");
            out.write(s.toString());
            out.flush();
        }
    }

    private static void doStruct(Writer out, String id, String argFile) throws Exception {
        List<String> paths;
        try {
            paths = readLines(argFile);
        } catch (Exception e) {
            replyError(out, id, "other", "读路径文件失败：" + e.getMessage());
            return;
        }
        StringBuilder structs = new StringBuilder(256);
        StringBuilder errors = new StringBuilder(64);
        boolean oom = false;
        try {
            for (String p : paths) {
                try {
                    ClassFileReader r = ClassFileReader.read(new File(p));
                    String fp = structuralFingerprint(r);
                    if (structs.length() > 0) structs.append(',');
                    structs.append("{\"path\":\"").append(json(p)).append("\",\"fp\":\"").append(fp)
                            .append("\",\"name\":\"").append(json(str(r.getName()))).append("\"}");
                } catch (OutOfMemoryError e) {
                    throw e;
                } catch (Throwable t) {
                    if (errors.length() > 0) errors.append(',');
                    errors.append('"').append(json(p + "\t" + t)).append('"');
                }
            }
        } catch (OutOfMemoryError e) {
            oom = true;
        }
        if (oom) {
            replyError(out, id, "oom", "worker 堆不足");
            return;
        }
        StringBuilder s = new StringBuilder(128 + structs.length() + errors.length());
        s.append("{\"id\":\"").append(id).append("\",\"ok\":true,\"data\":{\"structs\":[")
                .append(structs).append("],\"errors\":[").append(errors).append("],\"pid\":\"")
                .append(pid()).append("\"}}\n");
        out.write(s.toString());
        out.flush();
    }

    private static void doDiff(Writer out, String id, String argFile) throws Exception {
        List<String> lines;
        try {
            lines = readLines(argFile);
        } catch (Exception e) {
            replyError(out, id, "other", "读路径文件失败：" + e.getMessage());
            return;
        }
        StringBuilder diffs = new StringBuilder(128);
        StringBuilder errors = new StringBuilder(64);
        boolean oom = false;
        try {
            for (String l : lines) {
                int tab = l.indexOf('\t');
                if (tab <= 0 || tab + 1 >= l.length()) {
                    if (errors.length() > 0) errors.append(',');
                    errors.append('"').append(json(l + "\t行格式应为 旧路径<TAB>新路径")).append('"');
                    continue;
                }
                String oldP = l.substring(0, tab);
                String newP = l.substring(tab + 1);
                try {
                    ClassFileReader oldR = ClassFileReader.read(new File(oldP));
                    byte[] newBytes = Files.readAllBytes(new File(newP).toPath());
                    boolean structural = oldR.hasStructuralChanges(newBytes);
                    if (diffs.length() > 0) diffs.append(',');
                    diffs.append("{\"old\":\"").append(json(oldP)).append("\",\"new\":\"").append(json(newP))
                            .append("\",\"structural\":").append(structural).append('}');
                } catch (OutOfMemoryError e) {
                    throw e;
                } catch (Throwable t) {
                    if (errors.length() > 0) errors.append(',');
                    errors.append('"').append(json(l + "\t" + t)).append('"');
                }
            }
        } catch (OutOfMemoryError e) {
            oom = true;
        }
        if (oom) {
            replyError(out, id, "oom", "worker 堆不足");
            return;
        }
        StringBuilder s = new StringBuilder(128 + diffs.length() + errors.length());
        s.append("{\"id\":\"").append(id).append("\",\"ok\":true,\"data\":{\"diffs\":[")
                .append(diffs).append("],\"errors\":[").append(errors).append("],\"pid\":\"")
                .append(pid()).append("\"}}\n");
        out.write(s.toString());
        out.flush();
    }

    // ───────────────────────── 结构指纹 ─────────────────────────
    //
    // 投影面逐项对齐 ClassFileReader.hasStructuralChanges（eclipse.jdt.core R4_11）：
    // 它比较什么，这里就把什么规范化进指纹；它忽略什么（方法体、合成成员、clinit、
    // 块内类型注解），这里也忽略。两处刻意的保守偏差（都只会多编、不会漏编）：
    // ① float/double 常量按位比（Eclipse 用 !=，±0.0 会被这里判成变化）；
    // ② 成员类型按名字排序（Eclipse 按声明顺序 positional 比，重排会被这里放过——
    //    成员类型重排不影响引用方字节码，语义上安全）。

    private static String structuralFingerprint(ClassFileReader r) throws Exception {
        StringBuilder sb = new StringBuilder(512);
        sb.append("c:").append(str(r.getName())).append('|').append(r.getModifiers()).append('|')
                .append(r.getTagBits() & STRUCTURAL_TAG_BITS).append('|')
                .append(str(r.getGenericSignature())).append('|')
                .append(str(r.getSuperclassName())).append("|if:");
        char[][] ifs = r.getInterfaceNames();
        if (ifs != null) {
            for (char[] i : ifs) sb.append(str(i)).append(',');
        }
        sb.append("|mt:");
        IBinaryNestedType[] mts = r.getMemberTypes();
        List<String> memberTypes = new ArrayList<String>();
        if (mts != null) {
            for (IBinaryNestedType t : mts) {
                memberTypes.add(str(t.getName()) + ":" + t.getModifiers());
            }
        }
        Collections.sort(memberTypes);
        for (String m : memberTypes) sb.append(m).append(',');
        sb.append("|an:");
        canonAnnotations(sb, r.getAnnotations());
        sb.append("|ta:");
        canonTypeAnnotations(sb, r.getTypeAnnotations());

        sb.append("|f:");
        List<IBinaryField> fields = new ArrayList<IBinaryField>();
        IBinaryField[] fs = r.getFields();
        if (fs != null) {
            for (IBinaryField f : fs) {
                if ((f.getModifiers() & ClassFileConstants.AccSynthetic) == 0) fields.add(f);
            }
        }
        Collections.sort(fields, new Comparator<IBinaryField>() {
            public int compare(IBinaryField a, IBinaryField b) {
                int c = str(a.getName()).compareTo(str(b.getName()));
                return c != 0 ? c : str(a.getTypeName()).compareTo(str(b.getTypeName()));
            }
        });
        for (IBinaryField f : fields) {
            sb.append(str(f.getName())).append(':').append(str(f.getTypeName())).append(':')
                    .append(str(f.getGenericSignature())).append(':').append(f.getModifiers()).append(':')
                    .append(f.getTagBits() & TagBits.AnnotationDeprecated).append(':');
            canonAnnotations(sb, f.getAnnotations());
            sb.append(':');
            canonTypeAnnotations(sb, f.getTypeAnnotations());
            sb.append(':');
            Constant k = f.getConstant();
            if (k == null || k == Constant.NotAConstant) {
                sb.append("nc");
            } else {
                sb.append(k.typeID()).append(':').append(k.getClass().getName()).append(':');
                canonConstant(sb, k);
            }
            sb.append(';');
        }

        sb.append("|m:");
        List<IBinaryMethod> methods = new ArrayList<IBinaryMethod>();
        IBinaryMethod[] ms = r.getMethods();
        if (ms != null) {
            for (IBinaryMethod m : ms) {
                if ((m.getModifiers() & ClassFileConstants.AccSynthetic) == 0 && !m.isClinit()) {
                    methods.add(m);
                }
            }
        }
        Collections.sort(methods, new Comparator<IBinaryMethod>() {
            public int compare(IBinaryMethod a, IBinaryMethod b) {
                int c = str(a.getSelector()).compareTo(str(b.getSelector()));
                return c != 0 ? c : str(a.getMethodDescriptor()).compareTo(str(b.getMethodDescriptor()));
            }
        });
        for (IBinaryMethod m : methods) {
            sb.append(str(m.getSelector())).append(':').append(str(m.getMethodDescriptor())).append(':')
                    .append(str(m.getGenericSignature())).append(':').append(m.getModifiers()).append(':')
                    .append(m.getTagBits() & TagBits.AnnotationDeprecated).append(':');
            canonAnnotations(sb, m.getAnnotations());
            sb.append(":pa:");
            int params = m.getAnnotatedParametersCount();
            sb.append(params).append(':');
            for (int i = 0; i < params; i++) {
                canonAnnotations(sb, m.getParameterAnnotations(i, r.getFileName()));
                sb.append(';');
            }
            sb.append(':');
            canonTypeAnnotations(sb, m.getTypeAnnotations());
            sb.append(":ex:");
            char[][] exs = m.getExceptionTypeNames();
            if (exs != null) {
                for (char[] e : exs) sb.append(str(e)).append(',');
            }
            sb.append(';');
        }

        sb.append("|ms:");
        char[][][] missing = r.getMissingTypeNames();
        if (missing != null) {
            for (char[][] g : missing) {
                sb.append('[');
                if (g != null) {
                    for (char[] n : g) sb.append(str(n)).append(',');
                }
                sb.append(']');
            }
        }
        return sha256(sb.toString());
    }

    /** 常量逐类型比值，与 Eclipse hasStructuralFieldChanges 的 switch 同一套。 */
    private static void canonConstant(StringBuilder sb, Constant k) {
        switch (k.typeID()) {
            case TypeIds.T_int: sb.append(k.intValue()); break;
            case TypeIds.T_byte: sb.append(k.byteValue()); break;
            case TypeIds.T_short: sb.append(k.shortValue()); break;
            case TypeIds.T_char: sb.append((int) k.charValue()); break;
            case TypeIds.T_long: sb.append(k.longValue()); break;
            case TypeIds.T_float: sb.append(Float.floatToIntBits(k.floatValue())); break;
            case TypeIds.T_double: sb.append(Double.doubleToLongBits(k.doubleValue())); break;
            case TypeIds.T_boolean: sb.append(k.booleanValue()); break;
            case TypeIds.T_JavaLangString: sb.append('"').append(k.stringValue()).append('"'); break;
            default: sb.append('?').append(k.typeID()); break;
        }
    }

    /** 声明注解：按声明顺序（Eclipse positional 比较），内容含成员值。 */
    private static void canonAnnotations(StringBuilder sb, IBinaryAnnotation[] anns) {
        sb.append('[');
        if (anns != null) {
            for (IBinaryAnnotation a : anns) {
                canonAnnotation(sb, a);
                sb.append(',');
            }
        }
        sb.append(']');
    }

    private static void canonAnnotation(StringBuilder sb, IBinaryAnnotation a) {
        sb.append(str(a.getTypeName())).append('{');
        IBinaryElementValuePair[] pairs = a.getElementValuePairs();
        if (pairs != null) {
            for (IBinaryElementValuePair p : pairs) {
                sb.append(str(p.getName())).append('=');
                canonValue(sb, p.getValue());
                sb.append(',');
            }
        }
        sb.append('}');
    }

    /**
     * 类型注解：Eclipse 按内容多重集匹配（忽略位置），这里排序后拼接。
     * 块内目标（局部变量等）不影响签名，与 affectsSignature 同一口径跳过。
     */
    private static void canonTypeAnnotations(StringBuilder sb, IBinaryTypeAnnotation[] anns) {
        List<String> parts = new ArrayList<String>();
        if (anns != null) {
            for (IBinaryTypeAnnotation a : anns) {
                int t = a.getTargetType();
                if (t >= AnnotationTargetTypeConstants.LOCAL_VARIABLE
                        && t <= AnnotationTargetTypeConstants.METHOD_REFERENCE_TYPE_ARGUMENT) {
                    continue;
                }
                StringBuilder one = new StringBuilder();
                canonAnnotation(one, a.getAnnotation());
                parts.add(one.toString());
            }
        }
        Collections.sort(parts);
        sb.append('[');
        for (String p : parts) sb.append(p).append(',');
        sb.append(']');
    }

    /** 注解成员值规范化：数组/char[]/嵌套注解/基本类型包装都要有稳定表示。 */
    private static void canonValue(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof Object[]) {
            sb.append('[');
            for (Object e : (Object[]) v) {
                canonValue(sb, e);
                sb.append(',');
            }
            sb.append(']');
        } else if (v instanceof char[]) {
            sb.append('"').append(new String((char[]) v)).append('"');
        } else if (v instanceof IBinaryAnnotation) {
            canonAnnotation(sb, (IBinaryAnnotation) v);
        } else if (v instanceof String) {
            sb.append('"').append((String) v).append('"');
        } else if (v instanceof Boolean || v instanceof Byte || v instanceof Short
                || v instanceof Integer || v instanceof Long || v instanceof Float
                || v instanceof Double || v instanceof Character) {
            sb.append(v.getClass().getSimpleName()).append(':').append(v);
        } else {
            // 兜底：类名 + 字符串化。未知类型若是身份哈希表示，只会造成「指纹不稳→多编」，
            // 不会造成「该变没变→漏编」，方向安全。
            sb.append(v.getClass().getName()).append(':').append(String.valueOf(v));
        }
    }

    private static String sha256(String s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder h = new StringBuilder(d.length * 2);
        for (byte b : d) {
            h.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        }
        return h.toString();
    }

    private static String str(char[] c) {
        return c == null ? "" : new String(c);
    }

    private static List<String> readLines(String path) throws Exception {
        List<String> out = new ArrayList<String>();
        BufferedReader r = Files.newBufferedReader(new File(path).toPath(), StandardCharsets.UTF_8);
        try {
            String l;
            while ((l = r.readLine()) != null) {
                // diff 的行内含 TAB，不能 trim 掉行首尾以外的内容；这里只去首尾空白
                String t = l.trim();
                if (!t.isEmpty()) out.add(t);
            }
        } finally {
            r.close();
        }
        return out;
    }

    // ───────────────────────── 协议工具 ─────────────────────────

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
}