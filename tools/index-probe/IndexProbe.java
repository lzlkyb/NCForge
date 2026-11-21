// 声明索引探针（一次性质检工具，不进产品）
//
// 目的：量化「context-free 声明索引」在真实 NC 工作区上的成本。
// 与 jdt.ls 的区别：setResolveBindings(false) —— 不解析 import、不碰 classpath、
// 不建类型继承图，只把文件 parse 成 AST 并抽出声明。这正是 java-ls 主张「可 25s」的机制。
//
// 跑法（1.8 即可，无需新 JDK）：
//   javac -cp <jdt.core.jar> -d out IndexProbe.java
//   java  -cp out;<jdt.core.jar> IndexProbe <工作区> [线程数]

import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.AnnotationTypeDeclaration;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.EnumDeclaration;
import org.eclipse.jdt.core.dom.FieldDeclaration;
import org.eclipse.jdt.core.dom.IExtendedModifier;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.compiler.IProblem;

import java.io.File;
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
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

public final class IndexProbe {

    static final AtomicLong types = new AtomicLong();
    static final AtomicLong methods = new AtomicLong();
    static final AtomicLong fields = new AtomicLong();
    static final AtomicLong lines = new AtomicLong();
    static final AtomicLong bytesRead = new AtomicLong();
    static final AtomicLong gbkFiles = new AtomicLong();
    static final AtomicLong errFiles = new AtomicLong();
    static final AtomicLong errCount = new AtomicLong();
    static final List<String> errSamples = Collections.synchronizedList(new ArrayList<String>());
    static final AtomicLong cpuNanos = new AtomicLong();
    // 用于判定「1.4 假错误」是否影响 AST 结构：注解与泛型节点若仍被建出来，
    // 说明只有 problems 数组脏，声明抽取不受影响。
    static final AtomicLong annos = new AtomicLong();
    static final AtomicLong generics = new AtomicLong();

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.out.println("usage: IndexProbe <workspace-root> [threads]");
            return;
        }
        Path root = Paths.get(args[0]);
        int threads = args.length > 1 ? Integer.parseInt(args[1]) : Runtime.getRuntime().availableProcessors();
        if (!Files.isDirectory(root)) {
            System.out.println("not a dir: " + root);
            return;
        }

        long t0 = System.nanoTime();
        final List<Path> all = new ArrayList<Path>(8000);
        try (Stream<Path> s = Files.walk(root)) {
            s.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".java"))
                    .filter(p -> !p.toString().contains(File.separator + "out" + File.separator))
                    .forEach(all::add);
        }
        long collectMs = (System.nanoTime() - t0) / 1000000L;
        System.out.println("files=" + all.size() + "  threads=" + threads
                + "  collect=" + collectMs + "ms");

        Map<String, String> base;
        try {
            base = JavaCore.getDefaultOptions();      // 无 Platform 时可能失败，失败就手搓最小集
        } catch (Throwable t) {
            base = new HashMap<String, String>();
        }
        final Map<String, String> opts = new HashMap<String, String>(base);
        // 用字面量而不是 JavaCore 常量：常量走的是编译期内联，万一 jar 版本不同就成了静默失配
        opts.put("org.eclipse.jdt.core.compiler.source", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.compliance", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.codegen.targetPlatform", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures", "disabled");
        System.out.println("opts.source=" + opts.get("org.eclipse.jdt.core.compiler.source")
                + "  (default table size=" + base.size() + ")");
        // 诊断：Map 到底能不能被 CompilerOptions 认出来（JDK1_8 = 340000）
        try {
            java.util.Hashtable<String, String> ht = new java.util.Hashtable<String, String>();
            ht.putAll(opts);
            JavaCore.setOptions(ht);
            System.out.println("诊断 JavaCore.setOptions OK → getOptions.source="
                    + JavaCore.getOptions().get("org.eclipse.jdt.core.compiler.source")
                    + " size=" + JavaCore.getOptions().size());
        } catch (Throwable t) {
            System.out.println("诊断 JavaCore.setOptions 失败: " + t);
        }

        final int n = all.size();
        final AtomicLong cursor = new AtomicLong();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        long t1 = System.nanoTime();
        List<Future<Long>> tasks = new ArrayList<Future<Long>>(threads);
        for (int i = 0; i < threads; i++) {
            tasks.add(pool.submit(new Callable<Long>() {
                @Override
                public Long call() {
                    ASTParser parser = ASTParser.newParser(AST.JLS11);
                    parser.setKind(ASTParser.K_COMPILATION_UNIT);   // ← 漏了它，源码会被当表达式解析
                    parser.setResolveBindings(false);   // ← context-free 的全部含义
                    parser.setEnvironment(null, null, null, false);
                    parser.setStatementsRecovery(true);
                    parser.setBindingsRecovery(false);
                    // 🔴 必须放在 setEnvironment 之后：3.22 的 setEnvironment 会重建默认 options，
                    // 放前面设的 source level 会被 1.4 冲掉（实测 911/999 文件报
                    // "annotations are only available if source level is 1.5 or greater"）。
                    parser.setCompilerOptions(opts);
                    long wall = 0L;
                    while (true) {
                        int idx = (int) cursor.getAndIncrement();
                        if (idx >= n) break;
                        long a = System.nanoTime();
                        parseOne(parser, all.get(idx));
                        wall += System.nanoTime() - a;
                    }
                    return Long.valueOf(wall);
                }
            }));
        }
        long cpuSum = 0L;
        for (Future<Long> f : tasks) {
            cpuSum += f.get().longValue();
        }
        pool.shutdown();
        long wallMs = (System.nanoTime() - t1) / 1000000L;

        System.out.println("---- 结果 ----");
        System.out.println("parse wall      = " + wallMs + "ms  (含 I/O)");
        System.out.println("parse cpu 累加   = " + (cpuSum / 1000000L) + "ms  (并行度 "
                + String.format("%.2f", wallMs == 0 ? 0.0 : (cpuSum / 1000000.0) / wallMs) + "x)");
        System.out.println("bytes           = " + (bytesRead.get() / 1024 / 1024) + " MB");
        System.out.println("lines           = " + lines.get());
        System.out.println("types           = " + types.get());
        System.out.println("methods         = " + methods.get());
        System.out.println("fields          = " + fields.get());
        System.out.println("注解节点        = " + annos.get() + "   泛型节点 = " + generics.get());
        System.out.println("gbk 回退文件     = " + gbkFiles.get());
        System.out.println("有 error 的文件  = " + errFiles.get() + "   error 总数 = " + errCount.get());
        for (int i = 0; i < errSamples.size(); i++) {
            System.out.println("  err> " + errSamples.get(i));
        }
        if (wallMs > 0) {
            System.out.println("吞吐            = " + (n * 1000L / wallMs) + " files/s");
            System.out.println("行吞吐          = " + (lines.get() * 1000L / wallMs) + " lines/s");
        }
    }

    static void parseOne(ASTParser parser, Path p) {
        byte[] raw;
        try {
            raw = Files.readAllBytes(p);
        } catch (Exception e) {
            errFiles.incrementAndGet();
            addErr(p + " 读取失败: " + e);
            return;
        }
        bytesRead.addAndGet(raw.length);
        char[] src = decode(raw);
        parser.setSource(src);
        parser.setUnitName(p.toString());
        CompilationUnit cu;
        try {
            cu = (CompilationUnit) parser.createAST(null);
        } catch (Throwable t) {
            errFiles.incrementAndGet();
            addErr(p + " createAST 抛错: " + t);
            return;
        }
        if (cu == null) {
            errFiles.incrementAndGet();
            addErr(p + " AST 为 null");
            return;
        }
        IProblem[] probs = cu.getProblems();
        int errs = 0;
        for (IProblem pr : probs) {
            if (pr.isError()) {
                errs++;
                if (errSamples.size() < 12) {
                    errSamples.add(p.getFileName() + ":" + pr.getSourceLineNumber() + " " + pr.getMessage());
                }
            }
        }
        if (errs > 0) {
            errFiles.incrementAndGet();
            errCount.addAndGet(errs);
        }
        lines.addAndGet(cu.getLineNumber(src.length - 1));
        final CompilationUnit fcu = cu;
        cu.accept(new ASTVisitor() {
            @Override
            public boolean visit(TypeDeclaration node) {
                types.incrementAndGet();
                countMods(node.modifiers());
                return true;
            }

            @Override
            public boolean visit(EnumDeclaration node) {
                types.incrementAndGet();
                return true;
            }

            @Override
            public boolean visit(AnnotationTypeDeclaration node) {
                types.incrementAndGet();
                return true;
            }

            @Override
            public boolean visit(MethodDeclaration node) {
                methods.incrementAndGet();
                return true;
            }

            @Override
            public boolean visit(FieldDeclaration node) {
                fields.incrementAndGet();
                return true;
            }

            @Override
            public boolean visit(org.eclipse.jdt.core.dom.MarkerAnnotation node) {
                annos.incrementAndGet();
                return false;
            }

            @Override
            public boolean visit(org.eclipse.jdt.core.dom.ParameterizedType node) {
                generics.incrementAndGet();
                return true;
            }

            @SuppressWarnings("unchecked")
            void countMods(List<?> mods) { /* 占位：暂不需要修饰符统计 */ }
        });
    }

    static void addErr(String s) {
        synchronized (errSamples) {
            if (errSamples.size() < 12) {
                errSamples.add(s);
            }
        }
    }

    /// NC 代码大量 GBK。先严格按 UTF-8 解，失败整套 bytes 回退 GBK。
    static char[] decode(byte[] raw) {
        try {
            CharBuffer cb = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(raw));
            return cb.toString().toCharArray();
        } catch (CharacterCodingException e) {
            gbkFiles.incrementAndGet();
            return new String(raw, Charset.forName("GBK")).toCharArray();
        }
    }
}
