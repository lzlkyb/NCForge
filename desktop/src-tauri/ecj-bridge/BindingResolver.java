// 常驻 binding resolver（窗口期精确跳转的第二链路）。
//
// 存在理由：jdt.ls 冷启动的 3~6 分钟里，Ctrl+点击只能靠声明索引（①）与内容搜索（③），
// 继承成员、精确接收者、同名消歧答不上。本进程用 ECJ 编译内核自持一个 LookupEnvironment
// 跨查询存活，做真 binding 解析。设计与实测数据见
// docs/NCForge-窗口期精确解析-设计方案-2026-11-21.md（§2 组件表 / §3 协议 / §6.3 S2a）。
//
// 协议（照 NcEcjBridge 的行协议；id 必须是字符串——java_bridge.rs 的读线程按 as_str() 分发）：
// →  id \t init \t <argsFile>       argsFile 每行一个 classpath 条目（源根在前，jar/类目录随后）
// →  id \t resolve \t <argsFile>    argsFile = {"path":"…","offset":123}（offset = UTF-16 code unit）
// →  id \t invalidate \t <argsFile> argsFile 每行一个已保存文件的路径
// →  id \t quit
// ←  {"id":"N","ok":true,"data":{…}} / {"id":"N","ok":false,"code":"timeout|oom|other","error":"…"}
//
// resolve 的 data：
//   {"kind":"method|field|type|local","fqcn":"nc.vo.AggPayBillVO","name":"getCode","problems":3}
//   —— 位置由 Rust 查 decl_index（源码 find(fq) / jar 侧无行号），Java 只给身份（§2 契约）。
//   fqcn 内部类用 $ 连接（与 decl_index 的键一致）；data 为 null = offset 处没有可解析的
//   引用，调用方退回内容搜索。
//
// 🔴 为什么走 ECJ 内部 API 而不是 ASTParser：ASTParser 每次查询重建 LookupEnvironment，
//    固定过路费 ~515ms 且随 classpath 规模增长；实例复用第 2 次起静默失败（返回无绑定 AST）。
//    S0/S2a 实测见设计文档 §6.1/§6.3。
//
// 🔴 五个实现级坑（javap 反汇编 + 实测坐实，改这段代码前先读设计文档 §6.3）：
//    1. 源根必须混进 FileSystem 的第一个参数 classpathNames——findType 只遍历 classpaths
//       数组（字节码确认）。第二个参数只建「已登记文件名黑名单」（internalFindClass 命中即
//       返回 null），黑名单内容是限定名形态（nc/bs/Foo），绝对路径永远匹配不上 ⇒ 传 null。
//    2. completeTypeBindings() 必须无参版：单参版只做 imports + 类型层级，从不解析类型。
//    3. LookupEnvironment 的 ITypeRequestor 不能为 null：闭包生长全靠它回调 accept。
//    4. cud.resolve() 才是语句级绑定：缺它 MessageSend.binding 全 null。
//    5. 同一文件重复 buildTypeBindings 撞「The type X is already defined」⇒ CU 缓存
//       （路径 + 内容字节）是硬需求；invalidate 只能整体 reset（不能单摘文件）。
//    6. OffsetFinder 必须同时重载 BlockScope 与 ClassScope 两套 visit——ASTVisitor 按
//       scope 静态类型重载解析：extends/implements 走 ClassScope，语句级与方法签名全走
//       BlockScope（MethodScope 是其子类；AbstractMethodDeclaration.traverse 是空方法，
//       实现在 MethodDeclaration.traverse）。QualifiedNameReference 还要逐 token 归属
//       （sourcePositions + indexOfFirstFieldBinding + otherBindings）——只按整链返回
//       binding 会把点 `label` 判成接收变量 `p`（2026-11-21 合成冒烟抓到）。
//
// 🔴 stdout 是协议通道：除响应帧外不得往 stdout 写任何东西（NcEcjBridge 的 compile 也是
//    把 ecj 输出重定向进缓冲区再随响应返回）。
//
// 语法按 Java 7 写（NC 自带的 ufjdk 可能是 7/8）：不用 lambda / var / String.join /
// getOrDefault / switch 表达式。

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.internal.compiler.CompilationResult;
import org.eclipse.jdt.internal.compiler.DefaultErrorHandlingPolicies;
import org.eclipse.jdt.internal.compiler.IErrorHandlingPolicy;
import org.eclipse.jdt.internal.compiler.IProblemFactory;
import org.eclipse.jdt.internal.compiler.ast.AllocationExpression;
import org.eclipse.jdt.internal.compiler.ast.ArrayQualifiedTypeReference;
import org.eclipse.jdt.internal.compiler.ast.ArrayTypeReference;
import org.eclipse.jdt.internal.compiler.ast.CompilationUnitDeclaration;
import org.eclipse.jdt.internal.compiler.ast.FieldReference;
import org.eclipse.jdt.internal.compiler.ast.MessageSend;
import org.eclipse.jdt.internal.compiler.ast.ParameterizedQualifiedTypeReference;
import org.eclipse.jdt.internal.compiler.ast.ParameterizedSingleTypeReference;
import org.eclipse.jdt.internal.compiler.ast.QualifiedNameReference;
import org.eclipse.jdt.internal.compiler.ast.QualifiedTypeReference;
import org.eclipse.jdt.internal.compiler.ast.SingleNameReference;
import org.eclipse.jdt.internal.compiler.ast.SingleTypeReference;
import org.eclipse.jdt.internal.compiler.ast.TypeReference;
import org.eclipse.jdt.internal.compiler.batch.FileSystem;
import org.eclipse.jdt.internal.compiler.env.AccessRestriction;
import org.eclipse.jdt.internal.compiler.env.IBinaryType;
import org.eclipse.jdt.internal.compiler.env.ICompilationUnit;
import org.eclipse.jdt.internal.compiler.env.ISourceType;
import org.eclipse.jdt.internal.compiler.impl.CompilerOptions;
import org.eclipse.jdt.internal.compiler.impl.ITypeRequestor;
import org.eclipse.jdt.internal.compiler.lookup.Binding;
import org.eclipse.jdt.internal.compiler.lookup.BlockScope;
import org.eclipse.jdt.internal.compiler.lookup.ClassScope;
import org.eclipse.jdt.internal.compiler.lookup.FieldBinding;
import org.eclipse.jdt.internal.compiler.lookup.LookupEnvironment;
import org.eclipse.jdt.internal.compiler.lookup.MethodBinding;
import org.eclipse.jdt.internal.compiler.lookup.PackageBinding;
import org.eclipse.jdt.internal.compiler.lookup.ReferenceBinding;
import org.eclipse.jdt.internal.compiler.lookup.TypeBinding;
import org.eclipse.jdt.internal.compiler.lookup.VariableBinding;
import org.eclipse.jdt.internal.compiler.parser.Parser;
import org.eclipse.jdt.internal.compiler.problem.DefaultProblemFactory;
import org.eclipse.jdt.internal.compiler.problem.ProblemReporter;

public final class BindingResolver {

    /** CU 缓存上限。超限整体作废（reset + 清缓存）——不能单摘，见文件头坑 5。 */
    private static final int MAX_CU_CACHE = 64;

    /** init 之后才可用；invalidate / init 重建会整体替换。 */
    private static Engine engine;

    private BindingResolver() {
    }

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
            try {
                if ("init".equals(cmd)) {
                    doInit(out, id, argFile);
                } else if ("resolve".equals(cmd)) {
                    doResolve(out, id, argFile);
                } else if ("invalidate".equals(cmd)) {
                    doInvalidate(out, id, argFile);
                } else {
                    replyError(out, id, "other", "未知命令：" + cmd);
                }
            } catch (OutOfMemoryError e) {
                // 堆爆与「答不上」必须分开：Rust 侧据此杀进程 + 退避（不重置状态，直接杀）
                replyError(out, id, "oom", "resolver 堆不足");
            } catch (Throwable t) {
                // 引擎状态可能已被破坏，整体作废，下次查询冷走全流程自愈
                if (engine != null) engine.reset();
                replyError(out, id, "other", cmd + " 失败：" + t);
            }
        }
        out.flush();
    }

    private static void doInit(Writer out, String id, String argFile) throws Exception {
        List<String> entries;
        try {
            entries = readLines(argFile);
        } catch (Exception e) {
            replyError(out, id, "other", "读 classpath 文件失败：" + e.getMessage());
            return;
        }
        if (entries.isEmpty()) {
            replyError(out, id, "other", "classpath 为空");
            return;
        }
        engine = new Engine(entries);
        StringBuilder s = new StringBuilder(128);
        s.append("{\"id\":\"").append(id).append("\",\"ok\":true,\"data\":{\"entries\":")
                .append(entries.size()).append(",\"dirs\":").append(engine.dirCount())
                .append(",\"rtJar\":").append(engine.rtFound).append("}}\n");
        out.write(s.toString());
        out.flush();
    }

    private static void doResolve(Writer out, String id, String argFile) throws Exception {
        if (engine == null) {
            replyError(out, id, "other", "尚未 init");
            return;
        }
        String json;
        try {
            json = new String(Files.readAllBytes(new File(argFile).toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            replyError(out, id, "other", "读参数文件失败：" + e.getMessage());
            return;
        }
        String path = jsonStr(json, "path");
        int offset = jsonInt(json, "offset", -1);
        if (path == null || offset < 0) {
            replyError(out, id, "other", "参数文件缺 path/offset");
            return;
        }
        Hit hit = engine.resolve(path, offset);
        StringBuilder s = new StringBuilder(200);
        s.append("{\"id\":\"").append(id).append("\",\"ok\":true,\"data\":");
        if (hit == null) {
            s.append("null");
        } else {
            s.append("{\"kind\":\"").append(hit.kind).append("\",\"fqcn\":");
            if (hit.fqcn == null) {
                s.append("null");
            } else {
                s.append('"').append(json(hit.fqcn)).append('"');
            }
            s.append(",\"name\":\"").append(json(hit.name)).append("\",\"problems\":")
                    .append(hit.problems).append('}');
        }
        s.append("}\n");
        out.write(s.toString());
        out.flush();
    }

    private static void doInvalidate(Writer out, String id, String argFile) throws Exception {
        List<String> paths;
        try {
            paths = readLines(argFile);
        } catch (Exception e) {
            replyError(out, id, "other", "读路径文件失败：" + e.getMessage());
            return;
        }
        int cleared = engine == null ? 0 : engine.reset();
        StringBuilder s = new StringBuilder(96);
        s.append("{\"id\":\"").append(id).append("\",\"ok\":true,\"data\":{\"paths\":")
                .append(paths.size()).append(",\"cachedCleared\":").append(cleared).append("}}\n");
        out.write(s.toString());
        out.flush();
    }

    // ───────────────────────── 引擎：自持 LookupEnvironment 跨查询 ─────────────────────────

    static final class Engine {
        private final FileSystem fs;
        private final CompilerOptions options;
        private final ProblemReporter reporter;
        private final Parser parser;
        private final ClosureRequestor requestor;
        private final LookupEnvironment le;
        /** 目录形态的 classpath 条目（源根 + 类目录）的绝对路径，查询 CU 的包名推导用。 */
        private final List<String> dirEntries = new ArrayList<String>();
        final boolean rtFound;
        /** key = 文件绝对路径（'/'); value = [原始字节, CUD]。同文件同内容直接复用（坑 5）。 */
        private final Map<String, Object[]> cuCache = new LinkedHashMap<String, Object[]>();

        Engine(List<String> entries) {
            List<String> cp = new ArrayList<String>(entries.size() + 1);
            // boot(rt.jar) 最前——batch FileSystem 不带 VM bootclasspath（1.8 口径）。
            // 顺序照 ASTParser：boot → 源根 → jar/类目录（源优先，影子工程覆盖 NC  jar）。
            // JRE 布局 java.home/lib/rt.jar，JDK 布局 java.home/jre/lib/rt.jar（ufjdk 是 JDK）。
            this.rtFound = addBootJar(cp);
            cp.addAll(entries);
            // 🔴 第二个参数传 null：它只建「已登记文件名黑名单」（internalFindClass 命中即
            // 返回 null），黑名单内容是限定名形态（nc/bs/Foo），绝对路径永远匹配不上
            // ⇒ 空黑名单与探针配置（源根放这里）等价（javap 坐实，见文件头坑 1）。
            this.fs = new FileSystem(cp.toArray(new String[0]), null, "GBK");
            Map<String, String> opts = new HashMap<String, String>();
            try {
                opts.putAll(JavaCore.getDefaultOptions());
            } catch (Throwable t) {
                // 无 Platform 时退回最小集：下面四条才是承重的
                System.err.println("JavaCore.getDefaultOptions 失败（无 Platform）：" + t);
            }
            opts.put("org.eclipse.jdt.core.compiler.source", "1.8");
            opts.put("org.eclipse.jdt.core.compiler.compliance", "1.8");
            opts.put("org.eclipse.jdt.core.compiler.codegen.targetPlatform", "1.8");
            opts.put("org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures", "disabled");
            this.options = new CompilerOptions(opts);
            IErrorHandlingPolicy policy = DefaultErrorHandlingPolicies.proceedWithAllProblems();
            IProblemFactory factory = new DefaultProblemFactory(Locale.ENGLISH);
            this.reporter = new ProblemReporter(policy, this.options, factory);
            // 查询与闭包共用一个 Parser（ECJ Compiler 也是单 parser 串行复用；本进程单线程）。
            this.parser = new Parser(this.reporter, true);
            // 🔴 typeRequestor 不能传 null（坑 3）：闭包生长全靠它回调 accept
            this.requestor = new ClosureRequestor(this.parser, this.options);
            this.le = new LookupEnvironment(this.requestor, this.options, this.reporter, this.fs);
            this.requestor.le = this.le;
            for (String e : entries) {
                File d = new File(e);
                if (d.isDirectory()) {
                    this.dirEntries.add(d.getAbsolutePath().replace('\\', '/'));
                }
            }
        }

        int dirCount() {
            return this.dirEntries.size();
        }

        /// 把 rt.jar 插到 classpath 最前。JRE（java.home/lib）与 JDK（java.home/jre/lib）
        /// 两种布局都认；都找不到返回 false（java.lang 将不可用，绑定会退化）。
        private static boolean addBootJar(List<String> cp) {
            String home = System.getProperty("java.home");
            String[] candidates = new String[] {
                    home + File.separator + "lib" + File.separator + "rt.jar",
                    home + File.separator + "jre" + File.separator + "lib" + File.separator + "rt.jar",
            };
            for (String rt : candidates) {
                if (new File(rt).exists()) {
                    cp.add(rt.replace('\\', '/'));
                    return true;
                }
            }
            return false;
        }

        /// 一次查询。返回 null = 文件读不了 / offset 处没有可解析引用（调用方退回内容搜索）。
        ///
        /// 冷路径 = S2a 验证过的完整流程（设计 §6.3）：parse → buildTypeBindings →
        /// 无参 completeTypeBindings → unitBeingCompleted → getMethodBodies → faultInTypes →
        /// verifyMethods → cud.resolve()。热路径 = CU 缓存命中（同文件同内容，绑定已在）。
        Hit resolve(String path, int offset) {
            try {
                File f = new File(path);
                byte[] raw = Files.readAllBytes(f.toPath());
                char[] src = decode(raw);
                String abs = f.getAbsolutePath().replace('\\', '/');
                CompilationUnitDeclaration cud;
                Object[] cached = this.cuCache.get(abs);
                if (cached != null && Arrays.equals((byte[]) cached[0], raw)) {
                    cud = (CompilationUnitDeclaration) cached[1];
                } else {
                    if (this.cuCache.size() >= MAX_CU_CACHE) {
                        reset(); // 超限只能整体作废（单摘会撞「already defined」，坑 5）
                    }
                    SourceUnit unit = new SourceUnit(src, abs, packageOfPath(abs), baseName(f.getName()));
                    CompilationResult cr = new CompilationResult(unit, 0, 1, 100);
                    cud = this.parser.parse(unit, cr);
                    if (cud == null) return null;
                    this.le.buildTypeBindings(cud, null);
                    this.le.completeTypeBindings(); // 🔴 必须无参版（坑 2）
                    this.le.unitBeingCompleted = cud;
                    this.parser.getMethodBodies(cud);
                    if (cud.scope != null) {
                        cud.scope.faultInTypes();
                        cud.scope.verifyMethods(this.le.methodVerifier());
                    }
                    cud.resolve(); // 🔴 语句级绑定在这一步（坑 4）
                    this.cuCache.put(abs, new Object[] { raw, cud });
                }
                OffsetFinder finder = new OffsetFinder(offset);
                cud.traverse(finder, cud.scope);
                if (finder.best == null) return null;
                Hit hit = hitOf(finder.best, offset);
                if (hit == null) return null;
                CompilationResult cr = cud.compilationResult();
                hit.problems = cr == null ? 0 : cr.problemCount;
                return hit;
            } catch (OutOfMemoryError e) {
                throw e; // 上交：Rust 杀进程 + 退避
            } catch (Throwable t) {
                // 单个文件答不上不该毒化退避；引擎状态可能已坏，整体作废等下次自愈
                this.reset();
                System.err.println("resolve 失败（" + path + "）：" + t);
                return null;
            }
        }

        /// 整体作废：le.reset() + 清 CU 缓存。返回清掉的缓存条数。
        ///
        /// 为什么不能只摘单文件：le.reset() 清 knownPackages/defaultPackage/verifier 等
        /// 18 个字段 ⇒ 全部已注册类型不可达；而残留的 SourceTypeBinding 会让变更后的同文件
        /// 撞「The type X is already defined」（坑 5）。FileSystem/classpath 配置保留，
        /// 下次查询冷走全流程（~1s，S2a 实测）。
        int reset() {
            int n = this.cuCache.size();
            this.cuCache.clear();
            this.le.reset();
            return n;
        }

        /// 查询 CU 的包名：按「最长目录 classpath 前缀」推导（与 FileSystem 的
        /// ClasspathDirectory 同口径）——保证同一文件被闭包重新找到时包名一致。
        /// 不在任何目录条目下 ⇒ 默认包。
        private char[][] packageOfPath(String abs) {
            String best = null;
            for (String d : this.dirEntries) {
                if (abs.startsWith(d + "/") && (best == null || d.length() > best.length())) {
                    best = d;
                }
            }
            if (best == null) return new char[0][];
            String rel = abs.substring(best.length() + 1);
            int slash = rel.lastIndexOf('/');
            if (slash <= 0) return new char[0][];
            String[] parts = rel.substring(0, slash).split("/");
            char[][] out = new char[parts.length][];
            for (int i = 0; i < parts.length; i++) {
                out[i] = parts[i].toCharArray();
            }
            return out;
        }
    }

    /** 一次解析结果的身份（位置由 Rust 查索引）。 */
    static final class Hit {
        String kind;   // method / field / type / local
        String fqcn;   // 声明类或类型（内部类 $ 连接）；local 为 null
        String name;   // 成员简单名 / 类型简单名 / 局部名
        int problems;  // 该 CU 的 problem 数（recovery 绑定会 > 0）
    }

    // ───────────────────────── 节点 → 绑定身份 ─────────────────────────

    /// 最深的引用节点 → 绑定身份。节点类型集合与 S2a 探针一致。
    static Hit hitOf(org.eclipse.jdt.internal.compiler.ast.ASTNode node, int offset) {
        if (node instanceof MessageSend) {
            return hitOfMethod(((MessageSend) node).binding);
        }
        if (node instanceof AllocationExpression) {
            return hitOfMethod(((AllocationExpression) node).binding);
        }
        if (node instanceof FieldReference) {
            FieldBinding fb = ((FieldReference) node).binding;
            return fb == null ? null : memberHit("field", fb.declaringClass, new String(fb.name));
        }
        if (node instanceof QualifiedNameReference) {
            return hitOfQualified((QualifiedNameReference) node, offset);
        }
        if (node instanceof SingleNameReference) {
            Binding b = ((SingleNameReference) node).binding;
            // FieldBinding 是 VariableBinding 的子类——必须先判字段，再判局部
            if (b instanceof FieldBinding) {
                FieldBinding fb = (FieldBinding) b;
                return memberHit("field", fb.declaringClass, new String(fb.name));
            }
            if (b instanceof VariableBinding) {
                return localHit(new String(((VariableBinding) b).name));
            }
            if (b instanceof ReferenceBinding) {
                return typeHit((ReferenceBinding) b);
            }
            return null;
        }
        if (node instanceof TypeReference) {
            // SingleTypeReference / QualifiedTypeReference / ParameterizedSingleTypeReference
            TypeBinding t = ((TypeReference) node).resolvedType;
            if (t == null) return null;
            TypeBinding e = t.erasure(); // 泛型/类型变量归一（设计 §3）
            if (!(e instanceof ReferenceBinding)) return null; // 数组/基本类型没有唯一声明
            return typeHit((ReferenceBinding) e);
        }
        return null;
    }

    /// QualifiedNameReference 逐 token 归属（TraverseDump 探针坐实 2026-11-21）：
    ///   binding       = 接收段最后一个 token 的绑定（下标 indexOfFirstFieldBinding-1）
    ///   otherBindings = 字段段逐 token 的 FieldBinding（token i → otherBindings[i-iOFB]）
    ///   iOFB          = 第一个字段段 token 的下标；== tokens.length 表示整链是
    ///                   「类型.静态字段」链、binding 即最终答案
    /// 实例：c.inst          → binding=LocalVar(c), iOFB=1, otherBindings=[inst]
    ///       Chain.CONST     → binding=Field(CONST), iOFB=2(=n), otherBindings=null
    ///       Chain.SELF.inst → binding=Field(SELF),  iOFB=2, otherBindings=[inst]
    ///       c.SELF.inst     → binding=LocalVar(c),  iOFB=1, otherBindings=[SELF,inst]
    /// 只按整链返回 binding 会把点 `label` 归属到接收变量 `p`（2026-11-21 合成冒烟抓到）。
    static Hit hitOfQualified(QualifiedNameReference q, int offset) {
        int n = q.tokens.length;
        // 定位 offset 所在 token：sourcePositions[i] = (start << 32) | end
        int idx = -1;
        if (q.sourcePositions != null) {
            int lim = Math.min(n, q.sourcePositions.length);
            for (int i = 0; i < lim; i++) {
                long p = q.sourcePositions[i];
                int s = (int) (p >>> 32);
                int e = (int) (p & 0xFFFFFFFFL);
                if (offset >= s && offset <= e) {
                    idx = i;
                    break;
                }
            }
        }
        if (idx < 0) idx = n - 1; // 落在点号/空白：按最后一个 token（通常是字段）算
        Binding b;
        if (idx == q.indexOfFirstFieldBinding - 1) {
            b = q.binding; // 接收段末 token
        } else if (idx >= q.indexOfFirstFieldBinding) {
            int fi = idx - q.indexOfFirstFieldBinding;
            b = (q.otherBindings != null && fi < q.otherBindings.length) ? q.otherBindings[fi] : null;
        } else {
            b = null; // 类型/包名前段（如 Chain.CONST 的 Chain）：无 per-token 绑定，交回内容搜索
        }
        if (b == null) return null;
        if (b instanceof FieldBinding) {
            FieldBinding fb = (FieldBinding) b;
            return memberHit("field", fb.declaringClass, new String(fb.name));
        }
        if (b instanceof VariableBinding) {
            return localHit(new String(((VariableBinding) b).name));
        }
        if (b instanceof ReferenceBinding) {
            return typeHit((ReferenceBinding) b);
        }
        return null;
    }

    /// 方法/构造器调用 → 成员跳转；`<init>` 归一到类声明（索引里没有构造器独立行）。
    static Hit hitOfMethod(MethodBinding mb) {
        if (mb == null) return null;
        ReferenceBinding dc = mb.declaringClass;
        if (dc == null) return null;
        String sel = new String(mb.selector);
        if (sel.length() > 0 && sel.charAt(0) == '<') {
            return typeHit(dc);
        }
        return memberHit("method", dc, sel);
    }

    static Hit memberHit(String kind, ReferenceBinding dc, String name) {
        if (name.isEmpty()) return null;
        String fqcn = idxName(dc);
        if (fqcn == null) return null;
        Hit h = new Hit();
        h.kind = kind;
        h.fqcn = fqcn;
        h.name = name;
        return h;
    }

    static Hit typeHit(ReferenceBinding rb) {
        String fqcn = idxName(rb);
        if (fqcn == null) return null;
        Hit h = new Hit();
        h.kind = "type";
        h.fqcn = fqcn;
        int dot = fqcn.lastIndexOf('.');
        int dollar = fqcn.lastIndexOf('$');
        int cut = dot > dollar ? dot : dollar;
        h.name = cut >= 0 ? fqcn.substring(cut + 1) : fqcn;
        return h;
    }

    static Hit localHit(String name) {
        if (name.isEmpty()) return null;
        Hit h = new Hit();
        h.kind = "local";
        h.fqcn = null;
        h.name = name;
        return h;
    }

    /// ReferenceBinding → decl_index 的键格式：顶层类用 '.'，嵌套类用 '$' 连接
    /// （与 ClassFileReader.getName() 一致，见 decl_index.rs 的 find）。
    /// 匿名类返回 null（没有可跳的声明位置）。
    static String idxName(ReferenceBinding rb) {
        if (rb == null || rb.isAnonymousType()) return null;
        ReferenceBinding top = rb.outermostEnclosingType();
        if (top == null) top = rb;
        String base = dotted(top);
        if (base == null) return null;
        StringBuilder sb = new StringBuilder(base);
        List<char[]> nest = new ArrayList<char[]>();
        ReferenceBinding cur = rb;
        while (cur != null && cur != top) {
            char[][] cn = cur.compoundName;
            if (cn == null || cn.length == 0) return null;
            char[] last = cn[cn.length - 1];
            if (last == null || last.length == 0) return null; // 局部/匿名无名段
            nest.add(last);
            cur = cur.enclosingType();
        }
        if (cur != top) return null; // 嵌套链断了，宁可不答
        for (int i = nest.size() - 1; i >= 0; i--) {
            sb.append('$').append(nest.get(i));
        }
        return sb.toString();
    }

    /// compoundName 拼点分全名；有空段（匿名/坏绑定）返回 null。
    static String dotted(ReferenceBinding rb) {
        char[][] cn = rb.compoundName;
        if (cn == null || cn.length == 0) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cn.length; i++) {
            if (cn[i] == null || cn[i].length == 0) return null;
            if (i > 0) sb.append('.');
            sb.append(cn[i]);
        }
        return sb.toString();
    }

    // ───────────────────────── 闭包生长 ─────────────────────────

    /// ITypeRequestor 实现：completeTypeBindings 解析闭包时，nameEnvironment 每发现一个
    /// 源/二进制类型就回调到这里。抄 Compiler.accept 的流程（javap 坐实，坑 3）：
    ///   源：CompilationResult(checkSecondaryTypes=true) → dietParse → buildTypeBindings
    ///   二进制：createBinaryTypeFrom
    /// buildTypeBindings 把 CUD 注册进 le.units，无参 completeTypeBindings 的循环随即接管
    /// —— 这就是「跨查询缓存」的生长机制。
    static final class ClosureRequestor implements ITypeRequestor {
        LookupEnvironment le; // 构造 le 之后才能注入（先有 requestor 才有 le）
        private final Parser parser;
        private final CompilerOptions options;
        int srcAccepted = 0;
        int binAccepted = 0;

        ClosureRequestor(Parser parser, CompilerOptions options) {
            this.parser = parser;
            this.options = options;
        }

        @Override
        public void accept(ICompilationUnit unit, AccessRestriction accessRestriction) {
            srcAccepted++;
            CompilationResult cr = new CompilationResult(unit, 0, 1, options.maxProblemsPerUnit);
            cr.checkSecondaryTypes = true;
            CompilationUnitDeclaration cud = parser.dietParse(unit, cr);
            if (cud != null && le != null) {
                le.buildTypeBindings(cud, accessRestriction);
            }
        }

        @Override
        public void accept(IBinaryType binaryType, PackageBinding packageBinding,
                AccessRestriction accessRestriction) {
            binAccepted++;
            if (binaryType != null && le != null) {
                le.createBinaryTypeFrom(binaryType, packageBinding, accessRestriction);
            }
        }

        @Override
        public void accept(ISourceType[] sourceTypes, PackageBinding packageBinding,
                AccessRestriction accessRestriction) {
            // batch FileSystem 不走这条（ClasspathDirectory 构造的是 ICompilationUnit answer，
            // javap 坐实）；ISourceType 不是 ICompilationUnit，无法复用 dietParse 路径 ⇒ 跳过
            // （该类型会被当 missing 处理）。计数留痕。
            srcAccepted += sourceTypes.length;
        }
    }

    // ───────────────────────── offset → 最深的引用节点 ─────────────────────────

    /// 内部 AST 上的 offset → 最深的引用节点（sourceStart/End 覆盖 offset 且范围最小者胜）。
    static final class OffsetFinder extends org.eclipse.jdt.internal.compiler.ASTVisitor {
        final int offset;
        org.eclipse.jdt.internal.compiler.ast.ASTNode best = null;
        int bestLen = Integer.MAX_VALUE;

        OffsetFinder(int offset) {
            this.offset = offset;
        }

        void consider(org.eclipse.jdt.internal.compiler.ast.ASTNode n) {
            if (n.sourceStart <= offset && offset <= n.sourceEnd && (n.sourceEnd - n.sourceStart) < bestLen) {
                best = n;
                bestLen = n.sourceEnd - n.sourceStart;
            }
        }

        @Override
        public boolean visit(MessageSend node, BlockScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(SingleNameReference node, BlockScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(QualifiedNameReference node, BlockScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(FieldReference node, BlockScope scope) {
            consider(node);
            return true;
        }

        // TypeReference 是抽象类，内部 ASTVisitor 没有它的 visit 重载，只有各具体子类
        // （SingleTypeReference / QualifiedTypeReference / ParameterizedSingleTypeReference）。
        @Override
        public boolean visit(SingleTypeReference node, BlockScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(QualifiedTypeReference node, BlockScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(ParameterizedSingleTypeReference node, BlockScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(AllocationExpression node, BlockScope scope) {
            consider(node);
            return true;
        }

        // ─── 类级（ClassScope）重载 ───
        // javap + TraverseDump 探针坐实（2026-11-21）：TypeDeclaration.traverse 只对
        // superclass / superInterfaces 调 TypeReference.traverse(visitor, ClassScope)
        // ⇒ 这组重载的用途就是 extends / implements 子句（含泛型 `extends Foo<T>`、
        // 限定 `implements nc.bs.Foo`、数组形态）。字段类型与方法签名类型不走这里：
        // FieldDeclaration.traverse 与 MethodDeclaration.traverse 都传 this.scope
        // （MethodScope，是 BlockScope 子类）⇒ 上面那组 BlockScope 重载已覆盖。
        // 注意 AbstractMethodDeclaration.traverse 是**空方法**（0: return），
        // 真正的实现在 MethodDeclaration.traverse。
        @Override
        public boolean visit(SingleTypeReference node, ClassScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(QualifiedTypeReference node, ClassScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(ParameterizedSingleTypeReference node, ClassScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(ParameterizedQualifiedTypeReference node, ClassScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(ArrayTypeReference node, ClassScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(ArrayQualifiedTypeReference node, ClassScope scope) {
            consider(node);
            return true;
        }

        @Override
        public boolean visit(FieldReference node, ClassScope scope) {
            consider(node);
            return true;
        }
    }

    // ───────────────────────── 自产 ICompilationUnit 与解码 ─────────────────────────

    /// 自产 ICompilationUnit：内容已解码（UTF-8 严格试 → GBK 回退），包名按路径推导。
    static final class SourceUnit implements ICompilationUnit {
        private final char[] contents;
        private final char[] fileName;
        private final char[][] packageName;
        private final char[] mainTypeName;

        SourceUnit(char[] contents, String fileName, char[][] packageName, char[] mainTypeName) {
            this.contents = contents;
            this.fileName = fileName.toCharArray();
            this.packageName = packageName;
            this.mainTypeName = mainTypeName;
        }

        @Override
        public char[] getContents() {
            return this.contents;
        }

        @Override
        public char[] getFileName() {
            return this.fileName;
        }

        @Override
        public char[][] getPackageName() {
            return this.packageName;
        }

        @Override
        public char[] getMainTypeName() {
            return this.mainTypeName;
        }
    }

    /// NC 代码大量 GBK。先严格按 UTF-8 解，失败整套 bytes 回退 GBK（与 NcIndexer 同规则）。
    static char[] decode(byte[] raw) {
        try {
            CharBuffer cb = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(raw));
            return cb.toString().toCharArray();
        } catch (CharacterCodingException e) {
            return new String(raw, Charset.forName("GBK")).toCharArray();
        }
    }

    static char[] baseName(String fileName) {
        String s = fileName.endsWith(".java") ? fileName.substring(0, fileName.length() - 5) : fileName;
        return s.toCharArray();
    }

    // ───────────────────────── 协议工具（照 NcEcjBridge） ─────────────────────────

    private static void replyError(Writer out, String id, String code, String error) throws Exception {
        StringBuilder s = new StringBuilder(96);
        s.append("{\"id\":\"").append(id).append("\",\"ok\":false,\"code\":\"").append(code);
        s.append("\",\"error\":\"").append(json(error)).append("\"}\n");
        out.write(s.toString());
        out.flush();
    }

    private static List<String> readLines(String path) throws Exception {
        List<String> out = new ArrayList<String>();
        BufferedReader r = Files.newBufferedReader(new File(path).toPath(), StandardCharsets.UTF_8);
        try {
            String l;
            while ((l = r.readLine()) != null) {
                String t = l.trim();
                if (!t.isEmpty()) out.add(t);
            }
        } finally {
            r.close();
        }
        return out;
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

    /// 参数文件（JSON）里取字符串值。只认 "key" : "value" 这一种形态，够解析
    /// {"path":"…","offset":123}；解析不到返回 null。
    private static String jsonStr(String json, String key) {
        String pat = "\"" + key + "\"";
        int i = json.indexOf(pat);
        if (i < 0) return null;
        i = json.indexOf(':', i + pat.length());
        if (i < 0) return null;
        i++;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length() || json.charAt(i) != '"') return null;
        i++;
        StringBuilder sb = new StringBuilder();
        while (i < json.length()) {
            char c = json.charAt(i++);
            if (c == '"') return sb.toString();
            if (c == '\\' && i < json.length()) {
                char n = json.charAt(i++);
                switch (n) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'u':
                        if (i + 4 <= json.length()) {
                            try {
                                sb.append((char) Integer.parseInt(json.substring(i, i + 4), 16));
                            } catch (NumberFormatException ignore) {
                                return null;
                            }
                            i += 4;
                        }
                        break;
                    default: sb.append(n); break;
                }
            } else {
                sb.append(c);
            }
        }
        return null; // 引号没闭合
    }

    /// 参数文件（JSON）里取整数值。Windows 路径里的反斜杠在 JSON 里是 \\，不影响按 key 找。
    private static int jsonInt(String json, String key, int dflt) {
        String pat = "\"" + key + "\"";
        int i = json.indexOf(pat);
        if (i < 0) return dflt;
        i = json.indexOf(':', i + pat.length());
        if (i < 0) return dflt;
        i++;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        int start = i;
        if (i < json.length() && (json.charAt(i) == '-' || json.charAt(i) == '+')) i++;
        int end = i;
        while (end < json.length() && json.charAt(end) >= '0' && json.charAt(end) <= '9') end++;
        if (end == i) return dflt;
        try {
            return Integer.parseInt(json.substring(start, end));
        } catch (NumberFormatException e) {
            return dflt;
        }
    }
}
