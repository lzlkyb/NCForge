// S0 止损门探针：窗口期真 binding 解析的成本与正确性（一次性质检，不进产品）
//
// 目的：量出 docs/NCForge-窗口期精确解析-设计方案-2026-11-21.md §6 S0 的三个数——
//   ① 单 CU resolve 首次耗时（冷）② 热查询耗时 ③ 内存峰值；
// 并验一个**继承成员**真实案例的位置正确性。探针不过（首次 >5s 或热 >500ms）→ 整体止损。
//
// 与 IndexProbe 的区别：setResolveBindings(true) + setEnvironment(真实 154 源根 + 1204 jar)，
// 让 ECJ 建真绑定。这正是产品里常驻 resolver 每次查询要做的事。
//
// 跑法（1.8.0_202 即可）：
//   javac -cp <plugins/*.jar> -d out ResolveProbe.java
//   java -Xmx768m -cp out;<plugins/*.jar> ResolveProbe \
//        <workspace> <shadow/.classpath> <cuPath> <utf16offset> [repeats] [expectFqcn]
//   java -cp out;<plugins/*.jar> ResolveProbe pressure <jars.txt> <seconds> <threads>   # 单独进程施压
//
// 关键实现口径（与设计文档对齐）：
// - offset = UTF-16 code unit（LSP/Monaco 与 Java char 同语义，直接传不转换）
// - 编码：CU 自己按字节严格试 UTF-8 再回退 GBK（照抄 NcIndexer）；setEnvironment 的
//   encoding 传 "GBK"（影子工程 .settings 的 <project> 默认值，87% 文件是 GBK）。
//   S2 若走索引摘要方案可整体绕开此问题（Rust 传已解码内容），此处只量成本。
// - setCompilerOptions 必须放在 setEnvironment 之后（3.22 的 setEnvironment 会重建默认
//   options，放前面设的 source=1.8 会被 1.4 冲掉 —— IndexProbe 2026-11-21 实测踩过）。

import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.IBinding;
import org.eclipse.jdt.core.dom.IMethodBinding;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.core.dom.IVariableBinding;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.SimpleName;
// 注意：DOM 与内部 compiler API 都有 ASTVisitor / ASTNode，单类型 import 撞名 ⇒
// 内部侧一律全限定名（OffsetFinder / describeInternal），不 import。
import org.eclipse.jdt.internal.compiler.CompilationResult;
import org.eclipse.jdt.internal.compiler.DefaultErrorHandlingPolicies;
import org.eclipse.jdt.internal.compiler.IErrorHandlingPolicy;
import org.eclipse.jdt.internal.compiler.IProblemFactory;
import org.eclipse.jdt.internal.compiler.ast.AllocationExpression;
import org.eclipse.jdt.internal.compiler.ast.CompilationUnitDeclaration;
import org.eclipse.jdt.internal.compiler.ast.FieldReference;
import org.eclipse.jdt.internal.compiler.ast.MessageSend;
import org.eclipse.jdt.internal.compiler.ast.QualifiedNameReference;
import org.eclipse.jdt.internal.compiler.ast.QualifiedTypeReference;
import org.eclipse.jdt.internal.compiler.ast.ParameterizedSingleTypeReference;
import org.eclipse.jdt.internal.compiler.ast.SingleNameReference;
import org.eclipse.jdt.internal.compiler.ast.SingleTypeReference;
import org.eclipse.jdt.internal.compiler.ast.TypeReference;
import org.eclipse.jdt.internal.compiler.batch.FileSystem;
import org.eclipse.jdt.internal.compiler.env.ICompilationUnit;
import org.eclipse.jdt.internal.compiler.env.AccessRestriction;
import org.eclipse.jdt.internal.compiler.env.IBinaryType;
import org.eclipse.jdt.internal.compiler.env.ICompilationUnit;
import org.eclipse.jdt.internal.compiler.env.ISourceType;
import org.eclipse.jdt.internal.compiler.impl.CompilerOptions;
import org.eclipse.jdt.internal.compiler.impl.ITypeRequestor;
import org.eclipse.jdt.internal.compiler.lookup.Binding;
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
import org.eclipse.jdt.internal.compiler.lookup.BlockScope;

import java.io.File;
import java.lang.management.ManagementFactory;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public final class ResolveProbe {

    static final Pattern ENTRY = Pattern.compile("<classpathentry\\b(.*?)/>", Pattern.DOTALL);
    static final Pattern KIND = Pattern.compile("kind=\"([^\"]+)\"");
    static final Pattern PATH = Pattern.compile("path=\"([^\"]+)\"");

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("pressure")) {
            runPressure(args);
            return;
        }
        if (args.length < 4) {
            System.out.println("usage: ResolveProbe <workspace> <shadowClasspath.xml> <cuPath> <utf16offset> [repeats] [expectFqcn]");
            return;
        }
        Path ws = Paths.get(args[0]);
        Path cpXml = Paths.get(args[1]);

        // ---- 环境清单：影子工程同一份 classpath（源根 / jar / 类目录） ----
        String xml = new String(Files.readAllBytes(cpXml), StandardCharsets.UTF_8);
        List<String> srcRoots = new ArrayList<String>();
        List<String> cpEntries = new ArrayList<String>();
        long jarBytes = 0L;
        int jarCount = 0;
        Matcher em = ENTRY.matcher(xml);
        while (em.find()) {
            String a = em.group(1);
            Matcher km = KIND.matcher(a);
            Matcher pm = PATH.matcher(a);
            if (!km.find() || !pm.find()) continue;
            String kind = km.group(1);
            String path = pm.group(1);
            if (kind.equals("src")) {
                // 影子里的相对路径 → 真实工作区路径（不走 junction，直接读真身）
                srcRoots.add(ws.toString().replace('\\', '/') + "/" + path);
            } else if (kind.equals("lib")) {
                cpEntries.add(path);
                if (path.toLowerCase().endsWith(".jar")) {
                    jarCount++;
                    try {
                        jarBytes += new File(path).length();
                    } catch (Exception ignore) {
                    }
                }
            }
        }
        // RESOLVE_PROBE_MINIMAL=1：只留 CU 自己所在源根，无 jar 无 boot（归因实验：
        // 固定过路费是否随环境规模增长 → 持久化 NameEnvironment 是否划得来）
        if ("1".equals(System.getenv("RESOLVE_PROBE_MINIMAL"))) {
            String one = ws.toString().replace('\\', '/') + "/ct/src/private";
            System.out.println("minimal 环境：srcRoots=1 (" + one + "), cp=0, boot=false");
            srcRoots.clear();
            srcRoots.add(one);
            cpEntries.clear();
            jarCount = 0;
            jarBytes = 0L;
        }
        System.out.println("== 环境 ==");
        System.out.println("srcRoots   = " + srcRoots.size());
        System.out.println("cpEntries  = " + cpEntries.size() + " (jar=" + jarCount + ", 类目录=" + (cpEntries.size() - jarCount) + ")");
        System.out.println("jarBytes   = " + jarBytes / 1024 / 1024 + " MB");
        SRC_ROOTS.clear();
        SRC_ROOTS.addAll(srcRoots);
        System.out.println("java       = " + System.getProperty("java.version") + "  maxHeap="
                + ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getMax() / 1024 / 1024 + "MB");

        // RESOLVE_PROBE_PERSIST=1：S2a 迷你门——自持 LookupEnvironment 跨查询（C 路线核心假设）。
        // args: <ws> <cp.xml> <cu1> <off1> [<cu2> <off2> ...]，REPEATS=N 循环整序列（默认 5）。
        if ("1".equals(System.getenv("RESOLVE_PROBE_PERSIST"))) {
            List<String[]> pairs = new ArrayList<String[]>();
            for (int i = 2; i + 1 < args.length; i += 2) {
                pairs.add(new String[] { args[i], args[i + 1] });
            }
            if (pairs.isEmpty()) {
                System.out.println("persist 模式至少要给一对 <cuPath> <offset>");
                return;
            }
            runPersist(srcRoots, cpEntries, pairs);
            return;
        }

        Path cuPath = Paths.get(args[2]);
        int offset = Integer.parseInt(args[3]);
        int repeats = args.length > 4 ? Integer.parseInt(args[4]) : 3;
        String expect = args.length > 5 ? args[5] : null;

        Map<String, String> opts = new HashMap<String, String>();
        try {
            opts.putAll(JavaCore.getDefaultOptions());
        } catch (Throwable t) {
            System.out.println("JavaCore.getDefaultOptions 失败（无 Platform）：" + t);
        }
        opts.put("org.eclipse.jdt.core.compiler.source", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.compliance", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.codegen.targetPlatform", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures", "disabled");

        byte[] raw = Files.readAllBytes(cuPath);
        char[] src = decode(raw);
        String unitName = cuPath.toString().replace('\\', '/');
        System.out.println("== 目标 CU ==");
        System.out.println("cu         = " + unitName);
        System.out.println("cuChars    = " + src.length + "  offset=" + offset + "  ⇒ "
                + new String(src, Math.max(0, offset - 24), Math.min(24, src.length - Math.max(0, offset - 24))).replace('\n', ' '));

        // ---- 查询序列：冷（新建 parser）→ 热（新建 parser）×N → 热（复用 parser）×N ----
        System.out.println("== 查询 ==");
        ASTParser fresh = newParser(srcRoots, cpEntries, opts);
        Result r1 = query(fresh, src, unitName, offset, "cold-fresh");
        report(r1, expect);

        for (int i = 2; i <= repeats; i++) {
            ASTParser p = newParser(srcRoots, cpEntries, opts);
            report(query(p, src, unitName, offset, "warm-fresh#" + i), expect);
        }
        ASTParser reuse = newParser(srcRoots, cpEntries, opts);
        for (int i = 1; i <= repeats; i++) {
            report(query(reuse, src, unitName, offset, "warm-reuse#" + i), expect);
        }
        System.out.println("== 探针结束 ==");
    }

    // ================= S2a：自持 LookupEnvironment 跨查询 =================
    //
    // 驱动口径抄 `CompilationUnitResolver` 私有 resolve 的参照流程（javap 反汇编确认）：
    //   Parser.parse(unit, result) → buildTypeBindings → completeTypeBindings → traverse
    // 与 S0 的 ASTParser 路线的区别：环境只建一次，绑定缓存（二进制类型 + 源码类型）跨查询存活。
    // batch `FileSystem` 构造器不带 VM bootclasspath ⇒ rt.jar 显式补进 classpath（1.8）。

    static void runPersist(List<String> srcRoots, List<String> cpEntries, List<String[]> pairs) throws Exception {
        int repeats = 5;
        try {
            repeats = Integer.parseInt(System.getenv().getOrDefault("REPEATS", "5"));
        } catch (NumberFormatException ignore) {
        }
        List<String> cp = new ArrayList<String>(cpEntries);
        // 🔴 源根必须也进 classpathNames：FileSystem.findType 只查 classpaths 数组，
        // sourcepathNames 构造参数**不参与类型查找**（javap 2026-11-21 坐实；
        // ASTParser.getClasspath 也是把 sourcepaths 经 processPathEntries 混进同一列表）。
        // 顺序照 ASTParser：boot(rt.jar) → 源根 → jar/类目录（源优先）。
        String rt = System.getProperty("java.home") + File.separator + "lib" + File.separator + "rt.jar";
        if (new File(rt).exists()) {
            cp.add(0, rt.replace('\\', '/'));
        } else {
            System.out.println("WARN: rt.jar 不在 " + rt + "（java.lang 将不可用）");
        }
        cp.addAll(0, srcRoots);
        long t0 = System.nanoTime();
        FileSystem fs = new FileSystem(cp.toArray(new String[0]), srcRoots.toArray(new String[0]), "GBK");
        Map<String, String> opts = new HashMap<String, String>();
        try {
            opts.putAll(JavaCore.getDefaultOptions());
        } catch (Throwable t) {
            System.out.println("JavaCore.getDefaultOptions 失败（无 Platform）：" + t);
        }
        opts.put("org.eclipse.jdt.core.compiler.source", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.compliance", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.codegen.targetPlatform", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures", "disabled");
        CompilerOptions options = new CompilerOptions(opts);
        IErrorHandlingPolicy policy = DefaultErrorHandlingPolicies.proceedWithAllProblems();
        IProblemFactory factory = new DefaultProblemFactory(java.util.Locale.ENGLISH);
        ProblemReporter reporter = new ProblemReporter(policy, options, factory);
        // 查询与闭包共用一个 Parser（ECJ Compiler 也是单 parser 串行复用）。
        // 🔴 LookupEnvironment 的 typeRequestor **不能传 null**：askForType 找到源/二进制
        // 类型后会回调 accept，null 直接 NPE（最小环境实测坐实 2026-11-21）。
        // 闭包类型的 dietParse + buildTypeBindings 全靠它——这正是「跨查询缓存」的生长点。
        Parser parser = new Parser(reporter, true);
        ClosureRequestor requestor = new ClosureRequestor(parser, options);
        LookupEnvironment le = new LookupEnvironment(requestor, options, reporter, fs);
        requestor.le = le;
        System.out.println("== persist 环境 ==");
        System.out.println("srcRoots=" + srcRoots.size() + " cp=" + cp.size() + "  环境构建="
                + (System.nanoTime() - t0) / 1000000L + "ms（不含首次查询）");

        HeapSampler sampler = new HeapSampler();
        sampler.start();
        // S2a CU 缓存：同一文件未变更 ⇒ 直接复用首次解析的 CUD（绑定已在）。
        // 不缓存会撞「The type X is already defined」——buildTypeBindings 对已知类型名
        // 拒绝重复注册，新 CUD 的全部绑定变 problem binding（2026-11-21 实测坐实）。
        // key = 文件绝对路径；value = [原始字节, CUD]。
        Map<String, Object[]> cuCache = new java.util.LinkedHashMap<String, Object[]>();
        for (int round = 1; round <= repeats; round++) {
            for (String[] pair : pairs) {
                Path cuPath = Paths.get(pair[0]);
                int offset = Integer.parseInt(pair[1]);
                byte[] raw = Files.readAllBytes(cuPath);
                char[] src = decode(raw);
                String unitName = cuPath.toString().replace('\\', '/');
                String cacheKey = cuPath.toAbsolutePath().toString().replace('\\', '/');
                long a = System.nanoTime();
                CompilationUnitDeclaration cud;
                Object[] cached = cuCache.get(cacheKey);
                if (cached != null && java.util.Arrays.equals((byte[]) cached[0], raw)) {
                    cud = (CompilationUnitDeclaration) cached[1];
                } else {
                    SourceUnit unit = new SourceUnit(src, unitName, packageOf(src),
                            baseName(cuPath.getFileName().toString()));
                    CompilationResult cr = new CompilationResult(unit, 0, 1, 100);
                    cud = parser.parse(unit, cr);
                    le.buildTypeBindings(cud, null);
                    // 🔴 必须无参版：单参 completeTypeBindings(CUD) 只做 checkAndSetImports +
                    // connectTypeHierarchy，**从不解析类型**（javap 反汇编 2026-11-21 坐实）。
                    // 无参版驱动：units 三循环（imports → 类型层级 → 字段/方法签名）+ 闭包注册。
                    le.completeTypeBindings();
                    // 之后还要走 Compiler 每单元流程的剩余步（javap 2026-11-21 坐实）：
                    //   unitBeingCompleted=cud → getMethodBodies（全解析过则直接返回）→
                    //   scope.faultInTypes → scope.verifyMethods → **cud.resolve()**
                    // 最后一步才是语句级绑定（MessageSend.binding 等）——缺了它绑定全 null。
                    le.unitBeingCompleted = cud;
                    parser.getMethodBodies(cud);
                    if (cud.scope != null) {
                        cud.scope.faultInTypes();
                        cud.scope.verifyMethods(le.methodVerifier());
                    }
                    cud.resolve();
                    cuCache.put(cacheKey, new Object[] { raw, cud });
                }
                long ms = (System.nanoTime() - a) / 1000000L;
                OffsetFinder finder = new OffsetFinder(offset);
                cud.traverse(finder, cud.scope);
                long used = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
                String desc = finder.best == null ? "offset 处无引用节点"
                        : describeInternal(finder.best);
                CompilationResult cr = cud.compilationResult();
                System.out.println("[persist r" + round + " " + cuPath.getFileName() + "] wall=" + ms
                        + "ms  usedHeap=" + used / 1024 / 1024 + "MB  problems=" + cr.problemCount
                        + "  闭包(源+二进)=" + (requestor.srcAccepted + requestor.binAccepted)
                        + "  " + desc);
                if (cr.problemCount > 0) {
                    for (org.eclipse.jdt.core.compiler.CategorizedProblem p : cr.getProblems()) {
                        System.out.println("    problem: " + p.getMessage()
                                + "  @" + p.getSourceLineNumber());
                    }
                }
            }
        }
        sampler.stopSampler();
        System.out.println("peakHeap=" + sampler.peakUsed / 1024 / 1024 + "MB");
        System.out.println("== persist 结束 ==");
    }

    /// ITypeRequestor 实现：completeTypeBindings 解析闭包时，nameEnvironment 每发现一个
    /// 源/二进制类型就回调到这里。抄 Compiler.accept 的流程（javap 2026-11-21 坐实）：
    ///   源：CompilationResult(checkSecondaryTypes=true) → dietParse → buildTypeBindings
    ///   二进制：createBinaryTypeFrom
    /// buildTypeBindings 会把 CUD 注册进 le.units，无参 completeTypeBindings 的循环随即
    /// 接管它——这就是「跨查询缓存」的生长机制，也是 S2a 要量的闭包规模。
    static final class ClosureRequestor implements ITypeRequestor {
        LookupEnvironment le; // 构造 le 之后才能注入（先有 requestor 才有 le）
        final Parser parser;
        final CompilerOptions options;
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
            // javap 坐实）；其他 INameEnvironment 实现可能走。ISourceType 不是 ICompilationUnit，
            // 无法复用 dietParse 路径 ⇒ 跳过（该类型会被当 missing 处理）。计数留痕。
            srcAccepted += sourceTypes.length;
        }
    }

    /// 内部 AST 上的 offset → 最深的引用节点 → 绑定描述。节点 sourceStart/End 覆盖 offset 且范围最小者胜。
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
    }

    static String describeInternal(org.eclipse.jdt.internal.compiler.ast.ASTNode node) {
        if (node instanceof MessageSend) {
            MethodBinding mb = ((MessageSend) node).binding;
            if (mb == null) return "kind=method 绑定为 null（未解析）";
            ReferenceBinding dc = mb.declaringClass;
            return "kind=method  name=" + new String(mb.selector)
                    + "  declaring=" + fqcn(dc)
                    + "  binary=" + (dc != null && dc.isBinaryBinding())
                    + "  params=" + (mb.parameters == null ? 0 : mb.parameters.length)
                    + "  decl=" + locateByFqcn(fqcnTop(dc), new String(mb.selector),
                            mb.parameters == null ? 0 : mb.parameters.length);
        }
        if (node instanceof AllocationExpression) {
            MethodBinding mb = ((AllocationExpression) node).binding;
            if (mb == null) return "kind=new 绑定为 null";
            return "kind=new  declaring=" + fqcn(mb.declaringClass);
        }
        if (node instanceof FieldReference) {
            FieldBinding fb = ((FieldReference) node).binding;
            if (fb == null) return "kind=field 绑定为 null";
            return "kind=field  name=" + new String(fb.name) + "  declaring=" + fqcn(fb.declaringClass)
                    + "  binary=" + (fb.declaringClass != null && fb.declaringClass.isBinaryBinding());
        }
        if (node instanceof SingleNameReference) {
            Binding b = ((SingleNameReference) node).binding;
            if (b == null) return "kind=name 绑定为 null（未解析）";
            if (b instanceof VariableBinding) return "kind=var  name=" + new String(((VariableBinding) b).name);
            if (b instanceof FieldBinding) {
                FieldBinding fb = (FieldBinding) b;
                return "kind=field  name=" + new String(fb.name) + "  declaring=" + fqcn(fb.declaringClass);
            }
            if (b instanceof ReferenceBinding) return "kind=type  name=" + fqcn((ReferenceBinding) b);
            return "kind=name  " + b.getClass().getSimpleName();
        }
        if (node instanceof QualifiedNameReference) {
            Binding b = ((QualifiedNameReference) node).binding;
            if (b == null) return "kind=qualified 绑定为 null（未解析）";
            if (b instanceof FieldBinding) {
                FieldBinding fb = (FieldBinding) b;
                return "kind=field  name=" + new String(fb.name) + "  declaring=" + fqcn(fb.declaringClass);
            }
            if (b instanceof ReferenceBinding) return "kind=type  name=" + fqcn((ReferenceBinding) b);
            return "kind=qualified  " + b.getClass().getSimpleName();
        }
        if (node instanceof TypeReference) {
            TypeBinding t = ((TypeReference) node).resolvedType;
            if (t == null) return "kind=type 绑定为 null";
            return "kind=type  name=" + fqcn((ReferenceBinding) t)
                    + "  binary=" + ((ReferenceBinding) t).isBinaryBinding();
        }
        return "未识别节点 " + node.getClass().getSimpleName();
    }

    /// ReferenceBinding.compoundName 拼点分全名。嵌套类的段间也是 '.'（产品侧 Rust 需按需规整，探针不管）。
    static String fqcn(ReferenceBinding rb) {
        if (rb == null) return "<null>";
        char[][] cn = rb.compoundName;
        if (cn == null) return "<null>";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cn.length; i++) {
            if (i > 0) sb.append('.');
            sb.append(cn[i]);
        }
        return sb.toString();
    }

    /// 从源码头部解 package 声明（探针自产 ICompilationUnit 用）。
    static char[][] packageOf(char[] src) {
        int i = 0;
        int n = src.length;
        while (i < n && Character.isWhitespace(src[i])) i++;
        if (i + 7 > n || !"package".equals(new String(src, i, 7))) return new char[0][];
        i += 7;
        StringBuilder sb = new StringBuilder();
        while (i < n && src[i] != ';') {
            if (!Character.isWhitespace(src[i])) sb.append(src[i]);
            i++;
        }
        if (sb.length() == 0) return new char[0][];
        String[] parts = sb.toString().split("\\.");
        char[][] out = new char[parts.length][];
        for (int k = 0; k < parts.length; k++) out[k] = parts[k].toCharArray();
        return out;
    }

    static char[] baseName(String fileName) {
        String s = fileName.endsWith(".java") ? fileName.substring(0, fileName.length() - 5) : fileName;
        return s.toCharArray();
    }

    /// 自产 ICompilationUnit：内容由 Rust 侧同等规则解码后传入（UTF-8 严格试 → GBK 回退）。
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

    static ASTParser newParser(List<String> srcRoots, List<String> cpEntries, Map<String, String> opts) {
        ASTParser parser = ASTParser.newParser(AST.JLS11);
        parser.setKind(ASTParser.K_COMPILATION_UNIT);
        parser.setResolveBindings(true);
        parser.setBindingsRecovery(true);
        parser.setStatementsRecovery(true);
        // encodings 与 sourcepathEntries 平行（ECJ FileSystem 口径）。影子工程 .settings 的
        // <project> 默认 GBK（87% 文件 GBK），逐个 UTF-8 登记表达不了 → 全 GBK。
        String[] encodings = new String[srcRoots.size()];
        java.util.Arrays.fill(encodings, "GBK");
        // RESOLVE_PROBE_NO_BOOT=1：不带 VM bootclasspath（归因实验：地板成本是不是 rt.jar）
        boolean boot = !"1".equals(System.getenv("RESOLVE_PROBE_NO_BOOT"))
                && !"1".equals(System.getenv("RESOLVE_PROBE_MINIMAL"));
        parser.setEnvironment(cpEntries.toArray(new String[0]), srcRoots.toArray(new String[0]), encodings, boot);
        parser.setCompilerOptions(opts); // 🔴 必须在 setEnvironment 之后
        return parser;
    }

    static final class Result {
        String tag;
        long ms;
        long peakHeap;
        long usedHeap;
        String binding;   // 解析报告
        boolean ok;
    }

    static Result query(ASTParser parser, char[] src, String unitName, int offset, String tag) {
        Result r = new Result();
        r.tag = tag;
        HeapSampler sampler = new HeapSampler();
        sampler.start();
        long t0 = System.nanoTime();
        CompilationUnit cu;
        try {
            parser.setSource(src);
            parser.setUnitName(unitName);
            cu = (CompilationUnit) parser.createAST(null);
        } catch (Throwable t) {
            sampler.stopSampler();
            r.ok = false;
            r.binding = "createAST 抛错: " + t;
            return r;
        }
        r.ms = (System.nanoTime() - t0) / 1000000L;
        sampler.stopSampler();
        r.peakHeap = sampler.peakUsed;
        r.usedHeap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
        r.ok = true;
        r.binding = describe(cu, offset);
        return r;
    }

    static void report(Result r, String expect) {
        System.out.println("[" + r.tag + "] " + (r.ok ? "" : "FAIL ") + "wall=" + r.ms + "ms"
                + "  peakHeap=" + r.peakHeap / 1024 / 1024 + "MB  usedHeap=" + r.usedHeap / 1024 / 1024 + "MB");
        System.out.println("    " + r.binding);
        if (expect != null && r.binding != null) {
            System.out.println("    expect " + expect + " → " + (r.binding.contains(expect) ? "PASS" : "FAIL"));
        }
    }

    /// 找 offset 处最深的标识符，按父节点类型取绑定，输出「kind / fqcn / 名 / 二进制还是源码」。
    static String describe(CompilationUnit cu, int offset) {
        final int[] best = new int[] { -1, -1 }; // start, length
        final Object[] found = new Object[] { null };
        cu.accept(new ASTVisitor() {
            @Override
            public void preVisit(ASTNode node) {
                int s = node.getStartPosition();
                int l = node.getLength();
                if (l <= 0 || offset < s || offset >= s + l) return;
                if (found[0] == null || l < best[1]) {
                    found[0] = node;
                    best[0] = s;
                    best[1] = l;
                }
            }
        });
        ASTNode node = (ASTNode) found[0];
        if (node == null) return "offset 处没有 AST 节点";
        if (!(node instanceof SimpleName)) {
            return "offset 处节点是 " + node.getClass().getSimpleName() + "（不是标识符）";
        }
        SimpleName sn = (SimpleName) node;
        IBinding b = sn.resolveBinding();
        if (b == null || b.isRecovered()) {
            return "标识符 " + sn.getIdentifier() + " 绑定解析失败（recovered=" + (b != null && b.isRecovered()) + "）";
        }
        if (b instanceof IMethodBinding) {
            IMethodBinding mb = (IMethodBinding) b;
            ITypeBinding dc = mb.getDeclaringClass();
            StringBuilder sb = new StringBuilder();
            sb.append("kind=method  name=").append(mb.getName())
                    .append("  declaring=").append(dc == null ? "<null>" : dc.getQualifiedName())
                    .append("  binary=").append(dc != null && !dc.isFromSource())
                    .append("  params=").append(mb.getParameterTypes().length)
                    .append("  returns=").append(mb.getReturnType() == null ? "?" : mb.getReturnType().getQualifiedName());
            String where = locate(dc, mb.getName(), mb.getParameterTypes().length);
            if (where != null) sb.append("  decl=").append(where);
            return sb.toString();
        }
        if (b instanceof IVariableBinding) {
            IVariableBinding vb = (IVariableBinding) b;
            ITypeBinding dc = vb.getDeclaringClass();
            return "kind=field  name=" + vb.getName() + "  declaring="
                    + (dc == null ? "<null>" : dc.getQualifiedName())
                    + "  binary=" + (dc != null && !dc.isFromSource());
        }
        if (b instanceof ITypeBinding) {
            ITypeBinding tb = (ITypeBinding) b;
            return "kind=type  name=" + tb.getQualifiedName() + "  binary=" + !tb.isFromSource();
        }
        return "绑定类型 " + b.getClass().getName();
    }

    /// ReferenceBinding → 顶层 enclosing 的全名。成员类型的 compoundName 段间是 '.'，
    /// 但源码文件是外层类的文件名，定位必须上跳。ECJ 的 outermostEnclosingType() 一步到位。
    static String fqcnTop(ReferenceBinding rb) {
        if (rb == null) return null;
        ReferenceBinding top = rb.outermostEnclosingType();
        return fqcn(top == null ? rb : top);
    }

    /// DOM 版定位（S0 ASTParser 路线用）：ITypeBinding → 顶层类全名，转 fqcn 版共用。
    static String locate(ITypeBinding declaring, String member, int paramCount) {
        if (declaring == null) return null;
        ITypeBinding top = declaring;
        while (top.getDeclaringClass() != null) top = top.getDeclaringClass();
        return locateByFqcn(top.getQualifiedName(), member, paramCount);
    }

    /// 源码侧顶层类全名 → 在源根里找文件 + context-free 重解析找成员行（产品链路同款：fqcn+name+line）。
    /// 返回 "path:line"；jar 侧或找不到返回 null。
    static String locateByFqcn(String fqcn, String member, int paramCount) {
        if (fqcn == null || fqcn.isEmpty()) return null;
        String rel = fqcn.replace('.', '/') + ".java";
        for (String root : SRC_ROOTS) {
            Path f = Paths.get(root, rel.split("/"));
            if (!Files.isRegularFile(f)) continue;
            try {
                byte[] raw = Files.readAllBytes(f);
                char[] src = decode(raw);
                ASTParser p = ASTParser.newParser(AST.JLS11);
                p.setKind(ASTParser.K_COMPILATION_UNIT);
                p.setResolveBindings(false);
                p.setEnvironment(null, null, null, false);
                p.setSource(src);
                p.setUnitName(f.toString().replace('\\', '/'));
                CompilationUnit cu = (CompilationUnit) p.createAST(null);
                final String want = member;
                final int pc = paramCount;
                final int[] line = new int[] { -1 };
                cu.accept(new ASTVisitor() {
                    @Override
                    public boolean visit(MethodDeclaration node) {
                        if (line[0] > 0) return false;
                        if (node.getName().getIdentifier().equals(want)
                                && node.parameters().size() == pc) {
                            line[0] = cu.getLineNumber(node.getName().getStartPosition());
                        }
                        return false;
                    }
                });
                if (line[0] > 0) return f.toString().replace('\\', '/') + ":" + line[0];
                return f.toString().replace('\\', '/') + ":成员未找到";
            } catch (Exception e) {
                return f + ":读取失败 " + e;
            }
        }
        return null; // 不在源根里 → jar 侧
    }

    static List<String> SRC_ROOTS = new ArrayList<String>();

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

    static final class HeapSampler extends Thread {
        volatile long peakUsed = 0L;
        private final AtomicBoolean stop = new AtomicBoolean();

        @Override
        public void run() {
            while (!stop.get()) {
                long used = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
                if (used > peakUsed) peakUsed = used;
                try {
                    Thread.sleep(5);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }

        void stopSampler() {
            stop.set(true);
            try {
                join(50);
            } catch (InterruptedException ignore) {
            }
        }
    }

    /// 单独进程的 I/O 压力模式：N 个线程反复读 jar 并集，模拟 jdt.ls 冷导入抢盘。
    /// 不在测量进程内起线程——那会污染被测堆的峰值。
    static void runPressure(String[] args) throws Exception {
        Path jarsFile = Paths.get(args[1]);
        int seconds = Integer.parseInt(args[2]);
        int threads = args.length > 3 ? Integer.parseInt(args[3]) : 4;
        List<String> jars = new ArrayList<String>();
        for (String line : Files.readAllLines(jarsFile)) {
            if (!line.trim().isEmpty()) jars.add(line.trim());
        }
        System.out.println("pressure: jars=" + jars.size() + " threads=" + threads + " seconds=" + seconds);
        final AtomicBoolean stop = new AtomicBoolean();
        List<Thread> ts = new ArrayList<Thread>();
        for (int i = 0; i < threads; i++) {
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    long read = 0L;
                    int k = 0;
                    while (!stop.get()) {
                        String j = jars.get((k++ * 7919) % jars.size());
                        try {
                            ZipFile zf = new ZipFile(j);
                            java.util.Enumeration<? extends ZipEntry> en = zf.entries();
                            while (en.hasMoreElements()) {
                                ZipEntry e = en.nextElement();
                                byte[] buf = new byte[8192];
                                java.io.InputStream in = zf.getInputStream(e);
                                int n;
                                while ((n = in.read(buf)) > 0) read += n;
                                in.close();
                            }
                            zf.close();
                        } catch (Exception ignore) {
                        }
                    }
                    System.out.println("  thread read=" + read / 1024 / 1024 + "MB");
                }
            });
            ts.add(t);
            t.start();
        }
        Thread.sleep(seconds * 1000L);
        stop.set(true);
        for (Thread t : ts) t.join();
        System.out.println("pressure done");
    }

    private ResolveProbe() {
    }
}
