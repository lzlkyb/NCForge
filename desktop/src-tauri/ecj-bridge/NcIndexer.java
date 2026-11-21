import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.AnnotationTypeDeclaration;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.EnumDeclaration;
import org.eclipse.jdt.core.dom.FieldDeclaration;
import org.eclipse.jdt.core.dom.ImportDeclaration;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.SingleVariableDeclaration;
import org.eclipse.jdt.core.dom.Type;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;
import org.eclipse.jdt.internal.compiler.classfmt.ClassFileReader;
import org.eclipse.jdt.internal.compiler.env.IBinaryField;
import org.eclipse.jdt.internal.compiler.env.IBinaryMethod;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Phase 1 声明索引器：把「这个类/方法/字段声明在哪」一次性抽出来，写成 {@code types.idx}。
 *
 * <p>为什么它比 jdt.ls 快一个数量级：**不做语义解析**。{@code setResolveBindings(false)}
 * 意味着不解析 import、不加载 classpath、不建继承图，只把文件 parse 成 AST 抽声明。
 * 实测（2026-11-21，7524 文件 / 187.8 万行 + 589 jar / 19.66 万 class）：源码 9.06s、
 * jar 5.02s，合计 ≈14s；同工作区 jdt.ls flat 导入 99.3s。
 *
 * <p><b>只跑在 NC 自带的 1.8 上</b>（1909home/ufjdk）。不需要任何新 JDK —— 这条是产品红线，
 * 见 {@code docs/NCForge-智能代码-实施方案-2026-11-21.md} §1。
 *
 * <p>用法：
 * <pre>
 * java -cp ncecj.jar;ecj-3.17.jar NcIndexer --ws &lt;工作区&gt; --out &lt;types.idx&gt;
 *        [--jars &lt;jar清单每行一个&gt;] [--threads N]
 * </pre>
 *
 * <p>语法按 **Java 7** 写（与 {@code NcEcjBridge} 同一条约束）：NC 自带的 ufjdk 可能是 7/8，
 * 不用 lambda / var / String.join / Map.getOrDefault。
 */
public final class NcIndexer {

    /** 文件头魔数 + 版本。改格式必须同时改 Rust 侧 `decl_index.rs` 的常量。 */
    private static final byte[] MAGIC = new byte[] { 'N', 'C', 'F', 'I', 'D', 'X', '0', '1' };

    /**
     * 2 = 头部加了 {@code builtAtMs}（2026-11-21）。
     *
     * <p>为什么要它：索引跨重启持久，而源码随时会改。没有「什么时候建的」这个锚点，
     * Rust 侧就无法判断一份旧索引是否还配得上当前工作区 —— 只能永久复用，
     * 结果是**跳到旧行号**（比跳不到更坏）。写入时间取**落盘那一刻**，
     * 这样构建过程中被改的文件 mtime 一定 ≤ builtAt，不会漏判。
     *
     * <p>3 = 每个成员多写 {@code i32 line}（2026-11-21）。
     *
     * <p>为什么要它：成员级跳转（{@code vo.getCode()}）要跳到方法/字段的**声明行**，
     * 而 v2 只存了签名。多 4 字节/成员，源码侧实测只涨约 1 MB —— 因为从 v3 起
     * **jar 侧成员默认不写**（{@code --no-jar-members}），省下的 270 万条签名
     * 远多于新增的行号。
     */
    private static final int FORMAT_VERSION = 3;

    /** 只在一级目录下认这三种源根，与 `compile.rs::SRC_DIRS` 同源。 */
    private static final String[] SRC_DIRS = new String[] { "src/public", "src/client", "src/private" };
    /** 与 `shadow.rs::NOT_MODULE` 同源：这些不是模块。 */
    private static final String[] NOT_MODULE = new String[] { "out", "META-INF", "nclogs", "bin" };

    private static final int KIND_CLASS = 1;
    private static final int KIND_INTERFACE = 2;
    private static final int KIND_ENUM = 3;
    private static final int KIND_ANNOTATION = 4;

    /** `--stats` 打开：统计「有 problem 的文件数」。只用于排查解析质量，生产路径关掉。 */
    private static boolean COLLECT_PROBLEMS = false;

    /**
     * 是否写入**源码侧**成员签名 + 声明行。默认开，{@code --no-src-members} 关掉。
     *
     * <p>源码侧是成员级跳转（`vo.getCode()` → `DeliveryVO.java:88`）唯一的数据来源：
     * 7419 个文件约 20 万成员，加行号后索引涨约 1 MB，而它换来的是
     * 「窗口期能跳方法/字段」—— 与本机 Eclipse 差距最直观的那一条。
     */
    private static boolean KEEP_SRC_MEMBERS = true;

    /**
     * 是否写入**jar 侧**成员。默认开，{@code --no-jar-members} 关掉（**生产路径关**）。
     *
     * <p>jar 侧成员有两笔硬账：① 29 万个类型平均 5 个成员 ⇒ 145 万条字符串，
     * 占全文件体积的 80%（124 MB → 20 MB）、也是 jar 阶段的主要 CPU；
     * ② 字节码里的行号对不上反编译后的源码视图，**跳过去也只能落在行首**。
     * 所以「跳 jar 里的类」走类型级（`jdt://` + 反编译标签页），成员不参与。
     */
    private static boolean KEEP_JAR_MEMBERS = true;

    public static void main(String[] args) throws Exception {
        Path ws = null;
        Path out = null;
        Path jarList = null;
        int threads = Runtime.getRuntime().availableProcessors();
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--ws".equals(a) && i + 1 < args.length) {
                ws = Paths.get(args[++i]);
            } else if ("--out".equals(a) && i + 1 < args.length) {
                out = Paths.get(args[++i]);
            } else if ("--jars".equals(a) && i + 1 < args.length) {
                jarList = Paths.get(args[++i]);
            } else if ("--threads".equals(a) && i + 1 < args.length) {
                threads = Integer.parseInt(args[++i]);
            } else if ("--stats".equals(a)) {
                COLLECT_PROBLEMS = true;
            } else if ("--no-members".equals(a)) {
                // 旧开关：两个都关（保留兼容，测试与探针还在用）
                KEEP_SRC_MEMBERS = false;
                KEEP_JAR_MEMBERS = false;
            } else if ("--no-src-members".equals(a)) {
                KEEP_SRC_MEMBERS = false;
            } else if ("--no-jar-members".equals(a)) {
                KEEP_JAR_MEMBERS = false;
            } else {
                System.err.println("未知参数：" + a);
                usage();
                return;
            }
        }
        if (ws == null || out == null) {
            usage();
            return;
        }
        if (!Files.isDirectory(ws)) {
            System.err.println("工作区不存在：" + ws);
            System.exit(2);
            return;
        }
        if (threads < 1) {
            threads = 1;
        }
        run(ws, out, jarList, threads);
    }

    private static void usage() {
        System.err.println("usage: NcIndexer --ws <workspace> --out <types.idx> "
                + "[--jars <list.txt>] [--threads N] [--no-members] "
                + "[--no-src-members] [--no-jar-members] [--stats]");
    }

    private static void run(Path ws, Path out, Path jarList, int threads) throws Exception {
        long t0 = System.nanoTime();

        final List<Path> sources = new ArrayList<Path>(8192);
        // 两种布局：工作区（源根在 `<模块>/src/...`）与单个模块（源根就在 `<ws>/src/...`）。
        // 判据看 ws 自己有没有 src —— 不能只看参数名，否则单模块跑会拿到 0 个文件。
        if (isModule(ws)) {
            for (String d : SRC_DIRS) {
                collectSources(ws, d, sources);
            }
        } else {
            for (Path m : listModules(ws)) {
                for (String d : SRC_DIRS) {
                    collectSources(m, d, sources);
                }
            }
        }
        long walkMs = (System.nanoTime() - t0) / 1000000L;
        System.out.println("源文件 " + sources.size() + " 个（遍历 " + walkMs + "ms），线程 " + threads);

        final Stats st = new Stats();
        final ConcurrentLinkedQueue<Rec> recs = new ConcurrentLinkedQueue<Rec>();

        long t1 = System.nanoTime();
        runPool(threads, sources.size(), new Factory() {
            @Override
            public Worker make() {
                return new SourceWorker(sources, recs, st);
            }
        });
        long srcMs = (System.nanoTime() - t1) / 1000000L;
        System.out.println("源码 parse 完成：" + srcMs + "ms，类型 " + st.srcTypes.get()
                + "，GBK 回退 " + st.gbk.get() + "，假错文件 " + st.errFiles.get());

        final List<Path> jars = new ArrayList<Path>();
        if (jarList != null && Files.isRegularFile(jarList)) {
            for (String line : Files.readAllLines(jarList, StandardCharsets.UTF_8)) {
                line = line.trim();
                if (!line.isEmpty()) {
                    jars.add(Paths.get(line));
                }
            }
        }
        long jarMs = 0L;
        if (!jars.isEmpty()) {
            long t2 = System.nanoTime();
            // 精选：只读「含有源码引用包」的 jar。全量 4367 个 jar 时 jar 侧要 53.5s，
            // 而 59 万条目的包名扫描只要 0.73s —— 用 0.73s 换 45s。
            final List<Path> picked = pickJars(jars, st.wantedPkgs, threads);
            int skipped = jars.size() - picked.size();
            runPool(threads, picked.size(), new Factory() {
                @Override
                public Worker make() {
                    return new JarWorker(picked, recs, st);
                }
            });
            jarMs = (System.nanoTime() - t2) / 1000000L;
            System.out.println("jar 索引完成：" + jarMs + "ms，class " + st.jarTypes.get()
                    + "，坏 jar " + st.badJars.get()
                    + "；精选 " + picked.size() + "/" + jars.size()
                    + "（跳过 " + skipped + " 个未被引用的）");
        }

        List<Rec> all = new ArrayList<Rec>(recs);
        Collections.sort(all, new Comparator<Rec>() {
            @Override
            public int compare(Rec a, Rec b) {
                return a.name.compareTo(b.name);
            }
        });

        Map<String, Integer> paths = new HashMap<String, Integer>();
        for (Rec r : all) {
            if (!paths.containsKey(r.path)) {
                paths.put(r.path, Integer.valueOf(paths.size()));
            }
        }

        write(out, all, paths, st, sources.size());
        long totalMs = (System.nanoTime() - t0) / 1000000L;
        long bytes = Files.size(out);
        System.out.println("写出 " + out + "：" + (bytes / 1024) + " KB，总耗时 " + totalMs + "ms"
                + "（源码 " + srcMs + " + jar " + jarMs + " + 遍历/写出 " + (totalMs - srcMs - jarMs) + "）");
        System.out.println("统计：类型 " + all.size() + " / 路径 " + paths.size()
                + " / 方法 " + st.methods.get() + " / 字段 " + st.fields.get());
    }

    // ---- 目录遍历 ----------------------------------------------------------

    /** 一个目录自己是不是模块：看它下面有没有任一源根。 */
    private static boolean isModule(Path dir) {
        for (String d : SRC_DIRS) {
            if (Files.isDirectory(dir.resolve(d))) {
                return true;
            }
        }
        return false;
    }

    /** 工作区下的模块目录，跳过 `out` / `META-INF` 这类非模块。 */
    private static List<Path> listModules(Path ws) throws IOException {
        List<Path> mods = new ArrayList<Path>(64);
        java.nio.file.DirectoryStream<Path> ds = Files.newDirectoryStream(ws);
        try {
            for (Path p : ds) {
                if (!Files.isDirectory(p)) {
                    continue;
                }
                String n = p.getFileName().toString();
                boolean skip = false;
                for (String x : NOT_MODULE) {
                    if (x.equals(n)) {
                        skip = true;
                        break;
                    }
                }
                if (!skip) {
                    mods.add(p);
                }
            }
        } finally {
            ds.close();
        }
        return mods;
    }

    private static void collectSources(Path ws, final String rel, final List<Path> out) throws IOException {
        final Path base = ws.resolve(rel);
        if (!Files.isDirectory(base)) {
            return;
        }
        Files.walkFileTree(base, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                if (file.getFileName().toString().endsWith(".java")) {
                    out.add(file);
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    // ---- 并行骨架 ----------------------------------------------------------

    private interface Factory {
        Worker make();
    }

    /** 每个线程拿一个，内部自己循环取下标；`total` 只是终止条件。 */
    private interface Worker {
        void work(int idx);
    }

    private static void runPool(int threads, final int total, final Factory factory) throws Exception {
        if (total <= 0) {
            return;
        }
        final AtomicLong cursor = new AtomicLong();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        List<Future<?>> tasks = new ArrayList<Future<?>>(threads);
        for (int i = 0; i < threads; i++) {
            tasks.add(pool.submit(new Callable<Void>() {
                @Override
                public Void call() {
                    Worker w = factory.make();
                    while (true) {
                        int idx = (int) cursor.getAndIncrement();
                        if (idx >= total) {
                            break;
                        }
                        w.work(idx);
                    }
                    return null;
                }
            }));
        }
        for (Future<?> f : tasks) {
            f.get();
        }
        pool.shutdown();
    }

    // ---- 累加器 ------------------------------------------------------------

    private static final class Stats {
        final AtomicLong srcTypes = new AtomicLong();
        final AtomicLong jarTypes = new AtomicLong();
        final AtomicLong methods = new AtomicLong();
        final AtomicLong fields = new AtomicLong();
        final AtomicLong gbk = new AtomicLong();
        final AtomicLong errFiles = new AtomicLong();
        final AtomicLong badJars = new AtomicLong();
        final AtomicLong sourceBytes = new AtomicLong();
        final AtomicLong sourceFiles = new AtomicLong();
        /**
         * 源码引用到的包（自带 package + 每条 import 的所属包）。
         *
         * <p>用来把 4367 个 jar 精选到实际用得到的几百个。不加精选时 jar 侧要 53.5s
         * （59 万 class 全部读签名），精选后约 8s —— 而**只扫条目名只要 0.73s**
         * （2026-11-21 实测，`tools/index-probe/EntryScanProbe.java`），所以这笔账划得来。
         */
        // Java 7 兼容（`ConcurrentHashMap.newKeySet` 是 8 才有的）
        final Set<String> wantedPkgs = Collections.synchronizedSet(new HashSet<String>());
    }

    private static final class Rec {
        int kind;
        boolean fromJar;
        String path;
        int line;
        String name;
        String[] methods;
        String[] fields;
        /** 与 {@link #methods} 等长：声明行（1 基；jar 侧恒 0，字节码行号对不上源码视图）。 */
        int[] methodLines;
        /** 与 {@link #fields} 等长，同上。 */
        int[] fieldLines;
    }

    // ---- 源码侧 ------------------------------------------------------------

    private static final class SourceWorker implements Worker {
        private final List<Path> files;
        private final ConcurrentLinkedQueue<Rec> out;
        private final Stats st;
        private final ASTParser parser;
        private final Map<String, String> opts;

        SourceWorker(List<Path> files, ConcurrentLinkedQueue<Rec> out, Stats st) {
            this.files = files;
            this.out = out;
            this.st = st;
            this.parser = ASTParser.newParser(AST.JLS11);
            this.parser.setKind(ASTParser.K_COMPILATION_UNIT);
            this.parser.setResolveBindings(false);
            this.parser.setEnvironment(null, null, null, false);
            this.parser.setStatementsRecovery(true);
            this.parser.setBindingsRecovery(false);
            this.opts = compilerOptions();
            this.parser.setCompilerOptions(this.opts);
        }

        @Override
        public void work(int idx) {
            Path f = files.get(idx);
            byte[] raw;
            try {
                raw = Files.readAllBytes(f);
            } catch (Exception e) {
                return;
            }
            st.sourceFiles.incrementAndGet();
            st.sourceBytes.addAndGet(raw.length);
            char[] src = decode(raw, st);

            parser.setSource(src);
            parser.setUnitName(f.toString());
            CompilationUnit cu;
            try {
                cu = (CompilationUnit) parser.createAST(null);
            } catch (Throwable t) {
                st.errFiles.incrementAndGet();
                return;
            }
            if (cu == null) {
                st.errFiles.incrementAndGet();
                return;
            }
            // 🔴 默认**不算** problems：索引只要声明，而 JDT 在 recovery 时会生成 7.8 万条
            // 「source level 1.4」假错，遍历它们纯粹是浪费（实测占 parse 的 1/4）。
            // 需要观测解析质量时才加 --stats。
            if (COLLECT_PROBLEMS && cu.getProblems() != null && cu.getProblems().length > 0) {
                st.errFiles.incrementAndGet();
            }

            String pkg = cu.getPackage() == null ? "" : cu.getPackage().getName().getFullyQualifiedName();
            // 收集「源码用到了哪些包」，给 jar 精选用。三类都要收：
            // ① 自己的 package（同包类不需要 import，但跳转常落在同包）
            // ② 显式 import `a.b.C` → 包 `a.b`
            // ③ 通配 import `a.b.*` → 包 `a.b`
            // 静态 import 按 ② 处理：`import static a.b.C.m` 去掉最后一段得 `a.b.C`，
            // 它比真正的包名更精确（只会多选 jar，不会漏），正合适。
            // 🔴 存 `a/b/c` 形式（jar 条目里包路径用斜杠），不是 `a.b.c`。
            //    直接存点号会让匹配率归零（实测 7419 个源码只命中 3 个 jar）。
            if (pkg.length() > 0) {
                st.wantedPkgs.add(pkg.replace('.', '/'));
            }
            List<?> imps = cu.imports();
            for (int i = 0; i < imps.size(); i++) {
                String fq = ((ImportDeclaration) imps.get(i)).getName().getFullyQualifiedName();
                int dot = fq.lastIndexOf('.');
                if (dot > 0) {
                    st.wantedPkgs.add(fq.substring(0, dot).replace('.', '/'));
                }
            }

            Collector c = new Collector(f.toString(), pkg, cu, out, st);
            cu.accept(c);
        }
    }

    /** 拼全限定名 + 抽成员。内部类用 `$` 连接，跟 jar 侧 ClassFileReader 的命名一致。 */
    private static final class Collector extends ASTVisitor {
        private final String path;
        private final String pkg;
        private final CompilationUnit cu;
        private final ConcurrentLinkedQueue<Rec> out;
        private final Stats st;
        private final List<String> stack = new ArrayList<String>();

        Collector(String path, String pkg, CompilationUnit cu, ConcurrentLinkedQueue<Rec> out, Stats st) {
            this.path = path;
            this.pkg = pkg;
            this.cu = cu;
            this.out = out;
            this.st = st;
        }

        private String qualify(String simple) {
            StringBuilder sb = new StringBuilder();
            if (pkg.length() > 0) {
                sb.append(pkg).append('.');
            }
            for (int i = 0; i < stack.size(); i++) {
                sb.append(stack.get(i)).append('$');
            }
            return sb.append(simple).toString();
        }

        @Override
        public boolean visit(TypeDeclaration node) {
            emit(node.getName().getIdentifier(), node.isInterface() ? KIND_INTERFACE : KIND_CLASS,
                    node.getStartPosition(), node.getMethods(), node.getFields());
            stack.add(node.getName().getIdentifier());
            return true;
        }

        @Override
        public void endVisit(TypeDeclaration node) {
            stack.remove(stack.size() - 1);
        }

        @Override
        public boolean visit(EnumDeclaration node) {
            emit(node.getName().getIdentifier(), KIND_ENUM, node.getStartPosition(),
                    new MethodDeclaration[0], new FieldDeclaration[0]);
            stack.add(node.getName().getIdentifier());
            return true;
        }

        @Override
        public void endVisit(EnumDeclaration node) {
            stack.remove(stack.size() - 1);
        }

        @Override
        public boolean visit(AnnotationTypeDeclaration node) {
            emit(node.getName().getIdentifier(), KIND_ANNOTATION, node.getStartPosition(),
                    new MethodDeclaration[0], new FieldDeclaration[0]);
            stack.add(node.getName().getIdentifier());
            return true;
        }

        @Override
        public void endVisit(AnnotationTypeDeclaration node) {
            stack.remove(stack.size() - 1);
        }

        private void emit(String simple, int kind, int start, Object[] methodNodes, Object[] fieldNodes) {
            Rec r = new Rec();
            r.kind = kind;
            r.fromJar = false;
            r.path = path;
            r.line = cu.getLineNumber(start);
            r.name = qualify(simple);

            List<String> ms = new ArrayList<String>();
            List<String> fs = new ArrayList<String>();
            List<Integer> ml = new ArrayList<Integer>();
            List<Integer> fl = new ArrayList<Integer>();
            if (KEEP_SRC_MEMBERS) {
                for (int i = 0; i < methodNodes.length; i++) {
                    MethodDeclaration m = (MethodDeclaration) methodNodes[i];
                    ms.add(signature(m));
                    ml.add(Integer.valueOf(cu.getLineNumber(m.getStartPosition())));
                }
                for (int i = 0; i < fieldNodes.length; i++) {
                    FieldDeclaration fd = (FieldDeclaration) fieldNodes[i];
                    for (Object o : fd.fragments()) {
                        VariableDeclarationFragment v = (VariableDeclarationFragment) o;
                        fs.add(v.getName().getIdentifier() + ":" + simple(fd.getType()));
                        // 每个 fragment 单独取行：`int a, b;` 里 a 与 b 可能跨行
                        fl.add(Integer.valueOf(cu.getLineNumber(v.getStartPosition())));
                    }
                }
            }
            r.methods = ms.toArray(new String[ms.size()]);
            r.fields = fs.toArray(new String[fs.size()]);
            r.methodLines = toIntArray(ml);
            r.fieldLines = toIntArray(fl);
            st.srcTypes.incrementAndGet();
            st.methods.addAndGet(r.methods.length);
            st.fields.addAndGet(r.fields.length);
            out.add(r);
        }

        private String signature(MethodDeclaration m) {
            StringBuilder sb = new StringBuilder(m.getName().getIdentifier()).append('(');
            List<?> ps = m.parameters();
            for (int i = 0; i < ps.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(simple(((SingleVariableDeclaration) ps.get(i)).getType()));
            }
            return sb.append(')').toString();
        }
    }

    /** `List<Integer>` → `int[]`。Java 7 没有 `stream().mapToInt`，手写一遍。 */
    private static int[] toIntArray(List<Integer> src) {
        int[] out = new int[src.size()];
        for (int i = 0; i < out.length; i++) {
            out[i] = src.get(i).intValue();
        }
        return out;
    }

    /** 类型名去泛型去包：`List<String>` → `List`，`a.b.C` → `C`。索引只需要区分重载。 */
    private static String simple(Type t) {        String s = t.toString();
        int lt = s.indexOf('<');
        if (lt >= 0) {
            s = s.substring(0, lt);
        }
        int dot = s.lastIndexOf('.');
        if (dot >= 0) {
            s = s.substring(dot + 1);
        }
        return s;
    }

    private static Map<String, String> compilerOptions() {
        Map<String, String> m = new HashMap<String, String>();
        // 无 OSGi Platform 时 JavaCore.getDefaultOptions() 只返 3 个键、setOptions 直接 NPE，
        // 所以 key 一律写字面量，别用 JavaCore 常量（常量会内联，jar 版本一换就静默失配）。
        m.put("org.eclipse.jdt.core.compiler.source", "1.8");
        m.put("org.eclipse.jdt.core.compiler.compliance", "1.8");
        m.put("org.eclipse.jdt.core.compiler.codegen.targetPlatform", "1.8");
        m.put("org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures", "disabled");
        return m;
    }

    /** NC 代码 87% 是 GBK：按字节严格试 UTF-8，失败才整段回退 GBK。 */
    private static char[] decode(byte[] raw, Stats st) {
        try {
            CharBuffer cb = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(raw));
            return cb.toString().toCharArray();
        } catch (CharacterCodingException e) {
            st.gbk.incrementAndGet();
            return new String(raw, Charset.forName("GBK")).toCharArray();
        }
    }

    // ---- jar 侧 ------------------------------------------------------------

    /**
     * 从 jar 清单里挑出「含源码引用包」的那些。
     *
     * <p>判据是**包名精确命中**：只要 jar 里有任意一个 `{@code 包名/xxx.class}` 条目，整个
     * jar 入选。不做「只读命中的类」的细筛 —— 同一个 jar 里的类互相引用，跳转常落在
     * 同 jar 的其他包里。
     *
     * <p>两个退化保护（宁慢勿缺）：
     * <ul>
     *   <li>源码侧一个包都没收到（工作区选错/全是坏文件）⇒ 返回全部 jar</li>
     *   <li>精选结果少于 8 个 jar（判据明显没生效）⇒ 返回全部 jar</li>
     * </ul>
     *
     * <p>实测（2026-11-21，4367 jar / 59.4 万条目 / 66862 个不同包）扫描 0.73s。
     */
    private static List<Path> pickJars(final List<Path> jars, final Set<String> wanted,
                                       int threads) throws Exception {
        if (wanted.isEmpty()) {
            System.out.println("jar 精选：源码侧没有引用任何包，退回全部 " + jars.size() + " 个");
            return jars;
        }
        // 拿一份无锁副本：扫描阶段每个条目都要 contains，synchronizedSet 会成为串行点
        final Set<String> want = new HashSet<String>(wanted);
        final java.util.concurrent.atomic.AtomicIntegerArray hit =
                new java.util.concurrent.atomic.AtomicIntegerArray(jars.size());
        runPool(threads, jars.size(), new Factory() {
            @Override
            public Worker make() {
                return new Worker() {
                    @Override
                    public void work(int idx) {
                        ZipFile zf = null;
                        try {
                            zf = new ZipFile(jars.get(idx).toFile());
                            java.util.Enumeration<? extends ZipEntry> en = zf.entries();
                            while (en.hasMoreElements()) {
                                ZipEntry e = en.nextElement();
                                String n = e.getName();
                                if (!n.endsWith(".class")) {
                                    continue;
                                }
                                int slash = n.lastIndexOf('/');
                                if (slash > 0 && want.contains(n.substring(0, slash))) {
                                    hit.set(idx, 1);
                                    return;
                                }
                            }
                        } catch (Throwable t) {
                            // 坏 jar 直接不选；真需要它时 JarWorker 也读不出来
                        } finally {
                            if (zf != null) {
                                try {
                                    zf.close();
                                } catch (Exception ignored) {
                                    // 关闭失败不影响结果
                                }
                            }
                        }
                    }
                };
            }
        });
        List<Path> out = new ArrayList<Path>();
        for (int i = 0; i < jars.size(); i++) {
            if (hit.get(i) != 0) {
                out.add(jars.get(i));
            }
        }
        if (out.size() < 8) {
            System.out.println("jar 精选只命中 " + out.size() + " 个，判据可疑，退回全部");
            return jars;
        }
        return out;
    }

    private static final class JarWorker implements Worker {
        private final List<Path> jars;
        private final ConcurrentLinkedQueue<Rec> out;
        private final Stats st;

        JarWorker(List<Path> jars, ConcurrentLinkedQueue<Rec> out, Stats st) {
            this.jars = jars;
            this.out = out;
            this.st = st;
        }

        @Override
        public void work(int idx) {
            Path jar = jars.get(idx);
            ZipFile zf = null;
            try {
                zf = new ZipFile(jar.toFile());
                java.util.Enumeration<? extends ZipEntry> en = zf.entries();
                while (en.hasMoreElements()) {
                    ZipEntry e = en.nextElement();
                    String n = e.getName();
                    if (e.isDirectory() || !n.endsWith(".class") || n.startsWith("META-INF/")) {
                        continue;
                    }
                    byte[] raw;
                    try {
                        raw = readAll(zf.getInputStream(e));
                    } catch (Exception ex) {
                        continue;
                    }
                    try {
                        ClassFileReader r = ClassFileReader.read(
                                new java.io.ByteArrayInputStream(raw), n);
                        if (r == null) {
                            continue;
                        }
                        Rec rec = new Rec();
                        rec.kind = isInterface(r) ? KIND_INTERFACE : KIND_CLASS;
                        rec.fromJar = true;
                        rec.path = jar.toString();
                        rec.line = 0;
                        rec.name = new String(r.getName()).replace('/', '.');
                        List<String> sigs = new ArrayList<String>();
                        List<String> flds = new ArrayList<String>();
                        if (KEEP_JAR_MEMBERS) {
                            IBinaryMethod[] ms = r.getMethods();
                            if (ms != null) {
                                for (int i = 0; i < ms.length; i++) {
                                    sigs.add(new String(ms[i].getSelector()) + "(" + params(ms[i]) + ")");
                                }
                            }
                            IBinaryField[] fs = r.getFields();
                            if (fs != null) {
                                for (int i = 0; i < fs.length; i++) {
                                    flds.add(new String(fs[i].getName()) + ":" + new String(fs[i].getTypeName()));
                                }
                            }
                        }
                        rec.methods = sigs.toArray(new String[sigs.size()]);
                        rec.fields = flds.toArray(new String[flds.size()]);
                        // 行号恒 0：字节码里的 LineNumberTable 指向原始 .java，
                        // 反编译视图（CFR）的行号跟它没关系，跳过去只能落在行首。
                        rec.methodLines = new int[rec.methods.length];
                        rec.fieldLines = new int[rec.fields.length];
                        st.jarTypes.incrementAndGet();
                        st.methods.addAndGet(rec.methods.length);
                        st.fields.addAndGet(rec.fields.length);
                        out.add(rec);
                    } catch (Throwable t) {
                        // 单个 class 读失败不影响整批：jar 里本来就混着非 class 内容
                    }
                }
            } catch (Throwable t) {
                st.badJars.incrementAndGet();
            } finally {
                if (zf != null) {
                    try {
                        zf.close();
                    } catch (IOException ignore) {
                        // 关不掉不影响已收集的结果
                    }
                }
            }
        }

        private static boolean isInterface(ClassFileReader r) {
            int mod = r.getModifiers();
            return (mod & 0x0200) != 0; // AccInterface
        }

        /** 方法描述符 `(Ljava/lang/String;I)V` → `String,int`，只留能区分重载的信息。 */
        private static String params(IBinaryMethod m) {
            char[] d = m.getMethodDescriptor();
            if (d == null) {
                return "";
            }
            StringBuilder sb = new StringBuilder();
            int i = 1;
            while (i < d.length && d[i] != ')') {
                while (d[i] == '[') {
                    sb.append("[]");
                    i++;
                }
                if (d[i] == 'L') {
                    int end = i;
                    while (end < d.length && d[end] != ';') {
                        end++;
                    }
                    String q = new String(d, i + 1, end - i - 1);
                    int slash = q.lastIndexOf('/');
                    sb.append(slash >= 0 ? q.substring(slash + 1) : q);
                    i = end + 1;
                } else {
                    sb.append(primitive(d[i]));
                    i++;
                }
                if (i < d.length && d[i] != ')') {
                    sb.append(',');
                }
            }
            return sb.toString();
        }

        private static String primitive(char c) {
            switch (c) {
                case 'B': return "byte";
                case 'C': return "char";
                case 'D': return "double";
                case 'F': return "float";
                case 'I': return "int";
                case 'J': return "long";
                case 'S': return "short";
                case 'Z': return "boolean";
                default: return String.valueOf(c);
            }
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[8192];
        int k;
        while ((k = in.read(buf)) > 0) {
            bos.write(buf, 0, k);
        }
        in.close();
        return bos.toByteArray();
    }

    // ---- 写出 --------------------------------------------------------------

    private static void write(Path out, List<Rec> all, Map<String, Integer> paths, Stats st, int srcCount)
            throws IOException {
        if (out.getParent() != null) {
            Files.createDirectories(out.getParent());
        }
        DataOutputStream os = new DataOutputStream(
                new BufferedOutputStream(new FileOutputStream(out.toFile()), 1 << 16));
        try {
            os.write(MAGIC);
            os.writeInt(FORMAT_VERSION);
            os.writeInt(all.size());
            os.writeInt(paths.size());
            os.writeInt(srcCount);
            os.writeLong(st.sourceBytes.get());
            os.writeLong(st.jarTypes.get());
            // 落盘时刻（毫秒）：Rust 侧拿它跟「工作区源码最新 mtime」比，判断索引是否过期。
            // 必须在这里取（写完记录之后）而不是 main 开头 —— 否则构建期间被改的文件
            // 会因为 mtime > builtAt 而被误判成「索引过期」，每次启动都重建。
            os.writeLong(System.currentTimeMillis());
            // 路径表放**记录之前**：读取端一遍顺序读完就能解析记录（放末尾要扫两遍）。
            // 🔴 必须按下标顺序写：paths 是 HashMap，遍历顺序 != 分配的下标顺序。
            String[] byIdx = new String[paths.size()];
            for (Map.Entry<String, Integer> e : paths.entrySet()) {
                byIdx[e.getValue().intValue()] = e.getKey();
            }
            for (int i = 0; i < byIdx.length; i++) {
                writeStr(os, byIdx[i]);
            }
            for (Rec r : all) {
                os.writeByte(r.kind);
                os.writeBoolean(r.fromJar);
                os.writeInt(paths.get(r.path).intValue());
                os.writeInt(r.line);
                writeStr(os, r.name);
                os.writeInt(r.methods.length);
                for (int i = 0; i < r.methods.length; i++) {
                    writeStr(os, r.methods[i]);
                    // 行号紧跟在签名后（而不是整块写在成员列表末尾）：
                    // 读取端要能逐条流式读，跳过 jar 侧成员时才不必回头找行号。
                    os.writeInt(r.methodLines[i]);
                }
                os.writeInt(r.fields.length);
                for (int i = 0; i < r.fields.length; i++) {
                    writeStr(os, r.fields[i]);
                    os.writeInt(r.fieldLines[i]);
                }
            }
        } finally {
            os.close();
        }
    }

    private static void writeStr(DataOutputStream os, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        if (b.length > 65535) {
            b = new byte[] { '.' };
        }
        os.writeShort(b.length);
        os.write(b);
    }
}
