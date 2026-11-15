package ncforge.jdt;

import java.util.*;
import java.util.regex.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.ls.core.internal.*;
import org.eclipse.lsp4j.*;

/** AST patterns match Java structure, ignoring layout while keeping repeated captures consistent. */
public final class StructuralSearchHandler implements IDelegateCommandHandler {
    private static final Pattern VARIABLE = Pattern.compile("\\$[A-Za-z_][A-Za-z0-9_]*\\$");
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Map<?,?> arg = (Map<?,?>)arguments.get(0);
        ICompilationUnit selected = JDTUtils.resolveCompilationUnit((String)arg.get("uri"));
        if (selected == null) throw new IllegalArgumentException("请先打开模块中的 Java 文件");
        String pattern = String.valueOf(arg.get("pattern")).trim();
        String replacement = arg.get("replacement") instanceof String ? (String)arg.get("replacement") : null;
        ASTNode template = parse(pattern);
        Map<String,List<org.eclipse.lsp4j.TextEdit>> changes = new LinkedHashMap<String,List<org.eclipse.lsp4j.TextEdit>>();
        List<Map<String,Object>> matches = new ArrayList<Map<String,Object>>();
        long deadline = System.currentTimeMillis() + 20000;
        List<ICompilationUnit> files = "file".equals(arg.get("scope")) ? Arrays.asList(selected) : RefactorWorkspace.units(selected.getJavaProject(), monitor);
        for (ICompilationUnit file : files) {
            if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
            if (System.currentTimeMillis() > deadline) throw new IllegalArgumentException("结构搜索超过 20 秒，请缩小到当前文件");
            final String source = file.getSource(), uri = JDTUtils.toURI(file);
            CompilationUnit ast = RefactorWorkspace.ast(file, monitor);
            List<org.eclipse.lsp4j.TextEdit> edits = new ArrayList<org.eclipse.lsp4j.TextEdit>();
            ast.accept(new ASTVisitor() {
                public boolean preVisit2(ASTNode node) {
                    if (node instanceof Javadoc || node instanceof Comment) return false;
                    Captures matcher = new Captures(source);
                    if (!template.subtreeMatch(matcher, node)) return true;
                    if (matches.size() >= 200) throw new IllegalArgumentException("匹配超过 200 处，请缩小范围；未生成可应用的部分清单");
                    int start = node.getStartPosition(), end = start + node.getLength();
                    Range range = new Range(new Position(ast.getLineNumber(start)-1, ast.getColumnNumber(start)), new Position(ast.getLineNumber(end)-1, ast.getColumnNumber(end)));
                    Map<String,Object> hit = new LinkedHashMap<String,Object>(); hit.put("uri", uri); hit.put("range", range); hit.put("text", source.substring(start,end)); matches.add(hit);
                    if (replacement != null) {
                        Matcher variables = VARIABLE.matcher(replacement); StringBuffer text = new StringBuffer();
                        while (variables.find()) {
                            String capture = matcher.values.get(variables.group());
                            if (capture == null) throw new IllegalArgumentException("替换模板使用了没有捕获的变量：" + variables.group());
                            variables.appendReplacement(text, Matcher.quoteReplacement(capture));
                        }
                        variables.appendTail(text);
                        ASTNode replaced = parse(text.toString());
                        if (replaced.getNodeType() != node.getNodeType() && !((replaced instanceof Expression && node instanceof Expression) || (replaced instanceof Statement && node instanceof Statement))) throw new IllegalArgumentException("替换模板与匹配位置的 Java 结构不相容");
                        edits.add(new org.eclipse.lsp4j.TextEdit(range,text.toString()));
                    }
                    // Replacing an outer match subsumes its children, keeping all edits non-overlapping.
                    return false;
                }
            });
            if (!edits.isEmpty()) changes.put(uri, edits);
        }
        Map<String,Object> result = RefactorWorkspace.result(new WorkspaceEdit(changes), monitor);
        result.put("matches", matches); result.put("filesScanned", files.size());
        return result;
    }
    static ASTNode parse(String source) {
        if (source.isEmpty()) throw new IllegalArgumentException("请输入 Java 结构模板，例如 $value$ == null");
        ASTParser parser = ASTParser.newParser(AST.JLS8); parser.setKind(ASTParser.K_EXPRESSION); parser.setSource(source.toCharArray());
        ASTNode expression = parser.createAST(null);
        if (expression instanceof Expression && (expression.getFlags() & ASTNode.MALFORMED) == 0 && expression.getLength() == source.length()) return expression;
        parser = ASTParser.newParser(AST.JLS8); parser.setKind(ASTParser.K_STATEMENTS); parser.setSource(source.toCharArray());
        Block statements = (Block)parser.createAST(null);
        if (statements.statements().size() == 1) {
            ASTNode node = (ASTNode)statements.statements().get(0);
            if ((node.getFlags() & ASTNode.MALFORMED) == 0 && node.getLength() == source.length()) return node;
        }
        throw new IllegalArgumentException("模板必须是一条完整 Java 表达式或语句");
    }
    private static final class Captures extends ASTMatcher {
        final Map<String,String> values = new HashMap<String,String>();
        final Map<String,String> canonical = new HashMap<String,String>();
        final String source;
        Captures(String source) { this.source = source; }
        public boolean match(SimpleName template, Object other) {
            String name = template.getIdentifier();
            if (!VARIABLE.matcher(name).matches()) return super.match(template, other);
            if (!(other instanceof ASTNode)) return false;
            ASTNode node = (ASTNode)other;
            if (!(node instanceof Expression || node instanceof Type || node instanceof SimpleName)) return false;
            String normalized = node.toString(), previous = canonical.get(name);
            if (previous != null && !previous.equals(normalized)) return false;
            canonical.put(name, normalized);
            values.put(name, source.substring(node.getStartPosition(), node.getStartPosition()+node.getLength()));
            return true;
        }
    }
}
