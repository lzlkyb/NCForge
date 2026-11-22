// 一次性排障探针：dump cud.traverse 实际访问了哪些节点及其 source 范围。
// 用法：java -cp <plugins> TraverseDump <srcRoot> <file.java> [offset...]
// 每个 offset 会用与产品相同的 consider 逻辑选最深节点并打印归属。

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.internal.compiler.CompilationResult;
import org.eclipse.jdt.internal.compiler.DefaultErrorHandlingPolicies;
import org.eclipse.jdt.internal.compiler.IErrorHandlingPolicy;
import org.eclipse.jdt.internal.compiler.IProblemFactory;
import org.eclipse.jdt.internal.compiler.ast.AllocationExpression;
import org.eclipse.jdt.internal.compiler.ast.Argument;
import org.eclipse.jdt.internal.compiler.ast.CompilationUnitDeclaration;
import org.eclipse.jdt.internal.compiler.ast.FieldReference;
import org.eclipse.jdt.internal.compiler.ast.LocalDeclaration;
import org.eclipse.jdt.internal.compiler.ast.MessageSend;
import org.eclipse.jdt.internal.compiler.ast.QualifiedNameReference;
import org.eclipse.jdt.internal.compiler.ast.QualifiedTypeReference;
import org.eclipse.jdt.internal.compiler.ast.SingleNameReference;
import org.eclipse.jdt.internal.compiler.ast.SingleTypeReference;
import org.eclipse.jdt.internal.compiler.ast.TypeDeclaration;
import org.eclipse.jdt.internal.compiler.ast.TypeReference;
import org.eclipse.jdt.internal.compiler.batch.FileSystem;
import org.eclipse.jdt.internal.compiler.env.ICompilationUnit;
import org.eclipse.jdt.internal.compiler.impl.CompilerOptions;
import org.eclipse.jdt.internal.compiler.lookup.BlockScope;
import org.eclipse.jdt.internal.compiler.lookup.ClassScope;
import org.eclipse.jdt.internal.compiler.lookup.CompilationUnitScope;
import org.eclipse.jdt.internal.compiler.env.AccessRestriction;
import org.eclipse.jdt.internal.compiler.env.IBinaryType;
import org.eclipse.jdt.internal.compiler.impl.ITypeRequestor;
import org.eclipse.jdt.internal.compiler.lookup.LookupEnvironment;
import org.eclipse.jdt.internal.compiler.lookup.MethodScope;
import org.eclipse.jdt.internal.compiler.parser.Parser;
import org.eclipse.jdt.internal.compiler.problem.DefaultProblemFactory;
import org.eclipse.jdt.internal.compiler.problem.ProblemReporter;
import org.eclipse.jdt.internal.compiler.ASTVisitor;

public class TraverseDump {
    static char[] src;

    public static void main(String[] args) throws Exception {
        String srcRoot = args[0];
        String file = args[1];
        List<Integer> offsets = new ArrayList<Integer>();
        for (int i = 2; i < args.length; i++) offsets.add(Integer.parseInt(args[i]));

        byte[] raw = Files.readAllBytes(Paths.get(file));
        src = decode(raw);
        String unitName = file.replace('\\', '/');

        List<String> cp = new ArrayList<String>();
        String rt = System.getProperty("java.home") + File.separator + "lib" + File.separator + "rt.jar";
        if (!new File(rt).exists()) {
            rt = System.getProperty("java.home") + File.separator + ".." + File.separator
                    + "jre" + File.separator + "lib" + File.separator + "rt.jar";
        }
        if (new File(rt).exists()) cp.add(rt.replace('\\', '/'));
        cp.add(srcRoot);
        FileSystem fs = new FileSystem(cp.toArray(new String[0]), null, "GBK");

        Map<String, String> opts = new HashMap<String, String>();
        try {
            opts.putAll(JavaCore.getDefaultOptions());
        } catch (Throwable t) {
            System.out.println("JavaCore 默认选项失败（无 Platform）：" + t);
        }
        opts.put("org.eclipse.jdt.core.compiler.source", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.compliance", "1.8");
        opts.put("org.eclipse.jdt.core.compiler.codegen.targetPlatform", "1.8");
        CompilerOptions options = new CompilerOptions(opts);
        IErrorHandlingPolicy policy = DefaultErrorHandlingPolicies.proceedWithAllProblems();
        IProblemFactory factory = new DefaultProblemFactory(java.util.Locale.ENGLISH);
        ProblemReporter reporter = new ProblemReporter(policy, options, factory);
        Parser parser = new Parser(reporter, true);
        DumpRequestor requestor = new DumpRequestor(parser, options);
        LookupEnvironment le = new LookupEnvironment(requestor, options, reporter, fs);
        requestor.le = le;

        SourceUnit unit = new SourceUnit(src, unitName, packageOf(src),
                new File(file).getName().replace(".java", "").toCharArray());
        CompilationResult cr = new CompilationResult(unit, 0, 1, 100);
        CompilationUnitDeclaration cud = parser.parse(unit, cr);
        le.buildTypeBindings(cud, null);
        le.completeTypeBindings();
        le.unitBeingCompleted = cud;
        parser.getMethodBodies(cud);
        if (cud.scope != null) {
            cud.scope.faultInTypes();
            cud.scope.verifyMethods(le.methodVerifier());
        }
        cud.resolve();

        // 方法 scope 是否就位（MethodDeclaration.traverse 用 this.scope 传 statements）
        if (cud.types != null && cud.types.length > 0 && cud.types[0].methods != null) {
            for (org.eclipse.jdt.internal.compiler.ast.AbstractMethodDeclaration m : cud.types[0].methods) {
                System.out.println("== method " + new String(m.selector) + "  scope=" + m.scope
                        + "  statements=" + (m.statements == null ? "null" : m.statements.length));
            }
        }
        System.out.println("== traverse ==");
        DumpVisitor dv = new DumpVisitor();
        cud.traverse(dv, cud.scope);

        System.out.println("== offset 归属 ==");
        for (int off : offsets) {
            org.eclipse.jdt.internal.compiler.ast.ASTNode best = null;
            int bestLen = Integer.MAX_VALUE;
            for (org.eclipse.jdt.internal.compiler.ast.ASTNode n : dv.nodes) {
                if (n.sourceStart <= off && off <= n.sourceEnd && (n.sourceEnd - n.sourceStart) < bestLen) {
                    best = n;
                    bestLen = n.sourceEnd - n.sourceStart;
                }
            }
            if (best == null) {
                System.out.println("offset " + off + " -> 无节点");
            } else {
                System.out.println("offset " + off + " -> " + best.getClass().getSimpleName()
                        + " [" + best.sourceStart + ".." + best.sourceEnd + "] len=" + (bestLen + 1)
                        + " : " + text(best));
            }
        }
    }

    static String text(org.eclipse.jdt.internal.compiler.ast.ASTNode n) {
        if (n.sourceStart < 0 || n.sourceEnd >= src.length || n.sourceEnd < n.sourceStart) return "?";
        return new String(src, n.sourceStart, n.sourceEnd - n.sourceStart + 1);
    }

    static String bindingOf(Object b) {
        if (b == null) return "null";
        String cls = b.getClass().getSimpleName();
        String nm = "?";
        try {
            if (b instanceof org.eclipse.jdt.internal.compiler.lookup.FieldBinding) {
                nm = new String(((org.eclipse.jdt.internal.compiler.lookup.FieldBinding) b).name)
                        + " of " + fqcnOf(((org.eclipse.jdt.internal.compiler.lookup.FieldBinding) b).declaringClass);
            } else if (b instanceof org.eclipse.jdt.internal.compiler.lookup.VariableBinding) {
                nm = new String(((org.eclipse.jdt.internal.compiler.lookup.VariableBinding) b).name);
            } else if (b instanceof org.eclipse.jdt.internal.compiler.lookup.ReferenceBinding) {
                nm = fqcnOf((org.eclipse.jdt.internal.compiler.lookup.ReferenceBinding) b);
            }
        } catch (Throwable ignore) {
        }
        return cls + "(" + nm + ")";
    }

    static String fqcnOf(org.eclipse.jdt.internal.compiler.lookup.ReferenceBinding rb) {
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

    static final class DumpVisitor extends ASTVisitor {
        final List<org.eclipse.jdt.internal.compiler.ast.ASTNode> nodes =
                new ArrayList<org.eclipse.jdt.internal.compiler.ast.ASTNode>();

        void dump(String tag, org.eclipse.jdt.internal.compiler.ast.ASTNode n) {
            nodes.add(n);
            System.out.println("  " + tag + " " + n.getClass().getSimpleName()
                    + " [" + n.sourceStart + ".." + n.sourceEnd + "] len="
                    + (n.sourceEnd - n.sourceStart + 1) + " : " + text(n));
        }

        @Override public boolean visit(TypeDeclaration node, CompilationUnitScope scope) {
            dump("unit", node);
            return true;
        }

        @Override public boolean visit(MessageSend node, BlockScope scope) {
            dump("blk", node);
            return true;
        }

        @Override public boolean visit(SingleNameReference node, BlockScope scope) {
            dump("blk", node);
            return true;
        }

        @Override public boolean visit(QualifiedNameReference node, BlockScope scope) {
            dump("blk", node);
            StringBuilder sb = new StringBuilder("      QNR tokens=");
            for (int i = 0; i < node.tokens.length; i++) {
                if (i > 0) sb.append('.');
                sb.append(new String(node.tokens[i]));
            }
            sb.append("  binding=").append(bindingOf(node.binding));
            sb.append("  indexOfFirstFieldBinding=").append(node.indexOfFirstFieldBinding);
            sb.append("  otherBindings=");
            if (node.otherBindings == null) {
                sb.append("null");
            } else {
                for (int i = 0; i < node.otherBindings.length; i++) {
                    if (i > 0) sb.append(',');
                    sb.append(bindingOf(node.otherBindings[i]));
                }
            }
            sb.append("  positions=");
            for (int i = 0; i < node.sourcePositions.length; i++) {
                long p = node.sourcePositions[i];
                sb.append("[").append(p >>> 32).append("..").append(p & 0xFFFFFFFFL).append("]");
            }
            System.out.println(sb);
            return true;
        }

        @Override public boolean visit(FieldReference node, BlockScope scope) {
            dump("blk", node);
            return true;
        }

        @Override public boolean visit(SingleTypeReference node, BlockScope scope) {
            dump("blk", node);
            return true;
        }

        @Override public boolean visit(QualifiedTypeReference node, BlockScope scope) {
            dump("blk", node);
            return true;
        }

        @Override public boolean visit(AllocationExpression node, BlockScope scope) {
            dump("blk", node);
            return true;
        }

        @Override public boolean visit(SingleTypeReference node, ClassScope scope) {
            dump("cls", node);
            return true;
        }

        @Override public boolean visit(QualifiedTypeReference node, ClassScope scope) {
            dump("cls", node);
            return true;
        }

        @Override public boolean visit(LocalDeclaration node, BlockScope scope) {
            dump("blk", node);
            return true;
        }

        @Override public boolean visit(Argument node, BlockScope scope) {
            dump("blk", node);
            return true;
        }
    }

    /// 极简 ITypeRequestor：只接二进制类型（createBinaryTypeFrom），源类型照流程 diet+build。
    static final class DumpRequestor implements ITypeRequestor {
        LookupEnvironment le;
        final Parser parser;
        final CompilerOptions options;

        DumpRequestor(Parser parser, CompilerOptions options) {
            this.parser = parser;
            this.options = options;
        }

        @Override
        public void accept(ICompilationUnit unit, AccessRestriction accessRestriction) {
            CompilationResult cr = new CompilationResult(unit, 0, 1, options.maxProblemsPerUnit);
            cr.checkSecondaryTypes = true;
            CompilationUnitDeclaration cud = this.parser.dietParse(unit, cr);
            if (cud != null && le != null) {
                this.le.buildTypeBindings(cud, accessRestriction);
            }
        }

        @Override
        public void accept(IBinaryType binaryType,
                org.eclipse.jdt.internal.compiler.lookup.PackageBinding packageBinding,
                AccessRestriction accessRestriction) {
            if (binaryType != null && le != null) {
                this.le.createBinaryTypeFrom(binaryType, packageBinding, accessRestriction);
            }
        }

        @Override
        public void accept(org.eclipse.jdt.internal.compiler.env.ISourceType[] sourceTypes,
                org.eclipse.jdt.internal.compiler.lookup.PackageBinding packageBinding,
                AccessRestriction accessRestriction) {
            // 不需要
        }
    }

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

    static char[] decode(byte[] raw) {
        try {
            java.nio.charset.CharsetDecoder dec = java.nio.charset.Charset.forName("UTF-8").newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
            return dec.decode(java.nio.ByteBuffer.wrap(raw)).array();
        } catch (Throwable t) {
            try {
                return new String(raw, "GBK").toCharArray();
            } catch (Exception e) {
                return new String(raw).toCharArray();
            }
        }
    }

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

        @Override public char[] getContents() { return this.contents; }
        @Override public char[] getFileName() { return this.fileName; }
        @Override public char[][] getPackageName() { return this.packageName; }
        @Override public char[] getMainTypeName() { return this.mainTypeName; }
    }
}
