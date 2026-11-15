package ncforge.jdt;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.core.dom.rewrite.*;
import org.eclipse.jdt.core.search.*;
import org.eclipse.jdt.internal.core.JavaElement;
import org.eclipse.jdt.ls.core.internal.*;
import org.eclipse.jdt.ls.core.internal.corext.refactoring.rename.RippleMethodFinder;
import org.eclipse.lsp4j.WorkspaceEdit;

/** Binding-based signature edits include overrides and exact call sites, never same-name text. */
public final class SignatureWorkbenchHandler implements IDelegateCommandHandler {
    private static String declarationHandle(IJavaElement element) {
        // Generic invocations have a resolved handle suffix; match the original declaration.
        return (element instanceof JavaElement ? ((JavaElement)element).unresolved() : element).getHandleIdentifier();
    }
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        final Map<?, ?> arg = (Map<?, ?>)arguments.get(0);
        ICompilationUnit unit = JDTUtils.resolveCompilationUnit((String)arg.get("uri"));
        if (unit == null) throw new IllegalArgumentException("当前 Java 文档不可用");
        CompilationUnit ast = RefactorWorkspace.ast(unit, monitor);
        int offset = RefactorWorkspace.offset(ast, arg);
        IJavaElement[] selected = unit.codeSelect(offset, 0);
        if (selected.length == 0 || !(selected[0] instanceof IMethod)) throw new IllegalArgumentException("请把光标放在方法声明或调用名称上");
        final IMethod method = (IMethod)selected[0];
        if (method.isBinary()) throw new IllegalArgumentException("依赖中的二进制方法是只读的");
        if ("info".equals(arg.get("mode"))) return info(method, monitor);
        if (Flags.isVarargs(method.getFlags())) throw new IllegalArgumentException("可变参数方法需先转换为固定参数后再修改签名");
        final String name = String.valueOf(arg.get("name"));
        if (!method.isConstructor() && !JavaConventions.validateMethodName(name, JavaCore.VERSION_1_8, JavaCore.VERSION_1_8).isOK()) throw new IllegalArgumentException("方法名不合法");
        final List<Parameter> parameters = parameters(arg, declaration(method, monitor));
        final Set<String> handles = new HashSet<String>();
        Set<ICompilationUnit> files = new LinkedHashSet<ICompilationUnit>();
        IMethod[] related = method.isConstructor() || Flags.isStatic(method.getFlags()) || Flags.isPrivate(method.getFlags())
            ? new IMethod[] { method } : RippleMethodFinder.getRelatedMethods(method, monitor, null);
        if (related.length == 0) related = new IMethod[] { method };
        SignatureSafety.checkTypeEdits(related, parameters.stream().anyMatch(p -> p.index < 0 || p.typeChanged));
        for (IMethod item : related) {
            if (item.isBinary()) throw new IllegalArgumentException("该方法重写了依赖中的方法，不能只修改源码一侧的签名");
            if (Flags.isVarargs(item.getFlags())) throw new IllegalArgumentException("关联声明含可变参数，需先转换为固定参数后再修改签名");
            handles.add(declarationHandle(item)); files.add(item.getCompilationUnit());
            // Include inferred generic invocations; the AST still confirms the exact declaration.
            SearchPattern pattern = SearchPattern.createPattern(item, IJavaSearchConstants.REFERENCES, SearchPattern.R_EXACT_MATCH | SearchPattern.R_CASE_SENSITIVE | SearchPattern.R_ERASURE_MATCH);
            new SearchEngine().search(pattern, new SearchParticipant[] { SearchEngine.getDefaultSearchParticipant() }, SearchEngine.createWorkspaceScope(), new SearchRequestor() {
                public void acceptSearchMatch(SearchMatch match) {
                    if (match.getAccuracy() != SearchMatch.A_ACCURATE) throw new IllegalArgumentException("存在无法确认目标的引用，请先修复工程诊断");
                    Object element = match.getElement();
                    if (element instanceof IJavaElement) {
                        ICompilationUnit cu = (ICompilationUnit)((IJavaElement)element).getAncestor(IJavaElement.COMPILATION_UNIT);
                        if (cu == null) throw new IllegalArgumentException("存在二进制调用点，无法完整修改签名");
                        files.add(cu);
                    }
                }
            }, monitor);
        }
        if (files.size() > 400) throw new IllegalArgumentException("涉及超过 400 个文件，请缩小重构范围");
        Map<String,List<org.eclipse.lsp4j.TextEdit>> changes = new LinkedHashMap<String,List<org.eclipse.lsp4j.TextEdit>>();
        for (ICompilationUnit file : files) {
            if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
            CompilationUnit tree = RefactorWorkspace.ast(file, monitor);
            ASTRewrite rewrite = ASTRewrite.create(tree.getAST());
            tree.accept(new ASTVisitor() {
                boolean matches(IMethodBinding binding) {
                    return binding != null && binding.getMethodDeclaration().getJavaElement() != null
                        && handles.contains(declarationHandle(binding.getMethodDeclaration().getJavaElement()));
                }
                public boolean visit(MethodDeclaration declaration) {
                    if (!matches(declaration.resolveBinding())) return true;
                    changeDeclaration(declaration, rewrite, parameters, name, method);
                    return true;
                }
                void call(ASTNode call, IMethodBinding binding, ChildListPropertyDescriptor property, SimpleName oldName) {
                    if (!matches(binding)) return;
                    List<?> old = (List<?>)call.getStructuralProperty(property);
                    if (old.size() != method.getNumberOfParameters()) throw new IllegalArgumentException("调用参数数量与签名不一致，请先修复编译问题");
                    ListRewrite list = rewrite.getListRewrite(call, property);
                    for (Object value : old) list.remove((ASTNode)value, null);
                    for (Parameter parameter : parameters) {
                        ASTNode value = parameter.index >= 0 ? rewrite.createMoveTarget((ASTNode)old.get(parameter.index)) : ASTNode.copySubtree(call.getAST(), expression(parameter.value));
                        list.insertLast(value, null);
                    }
                    if (oldName != null && !oldName.getIdentifier().equals(name)) rewrite.replace(oldName, call.getAST().newSimpleName(name), null);
                }
                public boolean visit(MethodInvocation call) { call(call, call.resolveMethodBinding(), MethodInvocation.ARGUMENTS_PROPERTY, call.getName()); return true; }
                public boolean visit(SuperMethodInvocation call) { call(call, call.resolveMethodBinding(), SuperMethodInvocation.ARGUMENTS_PROPERTY, call.getName()); return true; }
                public boolean visit(ClassInstanceCreation call) { call(call, call.resolveConstructorBinding(), ClassInstanceCreation.ARGUMENTS_PROPERTY, null); return true; }
                public boolean visit(ConstructorInvocation call) { call(call, call.resolveConstructorBinding(), ConstructorInvocation.ARGUMENTS_PROPERTY, null); return true; }
                public boolean visit(SuperConstructorInvocation call) { call(call, call.resolveConstructorBinding(), SuperConstructorInvocation.ARGUMENTS_PROPERTY, null); return true; }
                void reference(IMethodBinding binding) { if (matches(binding)) throw new IllegalArgumentException("存在方法引用（::），请先展开为 lambda 再修改签名"); }
                public boolean visit(ExpressionMethodReference reference) { reference(reference.resolveMethodBinding()); return true; }
                public boolean visit(TypeMethodReference reference) { reference(reference.resolveMethodBinding()); return true; }
                public boolean visit(SuperMethodReference reference) { reference(reference.resolveMethodBinding()); return true; }
                public boolean visit(CreationReference reference) { reference(reference.resolveMethodBinding()); return true; }
            });
            List<org.eclipse.lsp4j.TextEdit> edits = new TextEditConverter(file, rewrite.rewriteAST()).convert();
            if (!edits.isEmpty()) changes.put(JDTUtils.toURI(file), edits);
        }
        Map<String,Object> result = RefactorWorkspace.result(new WorkspaceEdit(changes), monitor);
        result.put("warnings", Arrays.asList("仅修改 Java 语义引用；XML、UPM、反射和外部调用需另行核对", "新增参数的默认表达式在每个调用点执行；移除参数会同时移除对应实参，请核对副作用"));
        return result;
    }
    private static MethodDeclaration declaration(IMethod method, IProgressMonitor monitor) throws Exception {
        CompilationUnit ast = RefactorWorkspace.ast(method.getCompilationUnit(), monitor);
        final MethodDeclaration[] found = { null };
        ast.accept(new ASTVisitor() {
            public boolean visit(MethodDeclaration node) {
                IMethodBinding binding = node.resolveBinding();
                if (binding == null || binding.getJavaElement() == null || !declarationHandle(method).equals(declarationHandle(binding.getJavaElement()))) return true;
                found[0] = node;
                return false;
            }
        });
        if (found[0] == null) throw new IllegalArgumentException("无法读取方法声明，请先修复类型解析问题");
        return found[0];
    }
    private static Object info(IMethod method, IProgressMonitor monitor) throws Exception {
        MethodDeclaration node = declaration(method, monitor);
        Map<String,Object> info = new LinkedHashMap<String,Object>();
        List<Map<String,Object>> params = new ArrayList<Map<String,Object>>();
        for (Object item : node.parameters()) {
            SingleVariableDeclaration parameter = (SingleVariableDeclaration)item;
            Map<String,Object> value = new LinkedHashMap<String,Object>();
            value.put("index", params.size()); value.put("name", parameter.getName().getIdentifier());
            value.put("type", SignatureSafety.typeText(parameter)); value.put("value", ""); params.add(value);
        }
        info.put("name", method.getElementName()); info.put("parameters", params); info.put("constructor", node.isConstructor());
        return info;
    }
    private static final class Parameter {
        int index; String name, type, value; boolean typeChanged;
    }
    private static List<Parameter> parameters(Map<?,?> arg, MethodDeclaration declaration) {
        if (!(arg.get("parameters") instanceof List)) throw new IllegalArgumentException("缺少参数列表");
        int oldCount = declaration.parameters().size();
        List<Parameter> result = new ArrayList<Parameter>(); Set<Integer> used = new HashSet<Integer>(); Set<String> names = new HashSet<String>();
        for (Object raw : (List<?>)arg.get("parameters")) {
            Map<?,?> value = (Map<?,?>)raw; Parameter p = new Parameter();
            p.index = ((Number)value.get("index")).intValue(); p.name = String.valueOf(value.get("name"));
            p.type = String.valueOf(value.get("type")); p.value = String.valueOf(value.get("value"));
            if (p.index < -1 || p.index >= oldCount || (p.index >= 0 && !used.add(p.index))) throw new IllegalArgumentException("参数来源索引无效或重复");
            if (!names.add(p.name) || !JavaConventions.validateIdentifier(p.name, JavaCore.VERSION_1_8, JavaCore.VERSION_1_8).isOK()) throw new IllegalArgumentException("参数名无效或重复");
            SingleVariableDeclaration parsed = parameter(p);
            if (p.index < 0) expression(p.value);
            else p.typeChanged = !SignatureSafety.sameType(parsed, (SingleVariableDeclaration)declaration.parameters().get(p.index));
            result.add(p);
        }
        return result;
    }
    private static SingleVariableDeclaration parameter(Parameter parameter) {
        ASTParser parser = ASTParser.newParser(AST.JLS8); parser.setKind(ASTParser.K_CLASS_BODY_DECLARATIONS);
        parser.setSource(("void method(" + parameter.type + " " + parameter.name + ") {}").toCharArray());
        TypeDeclaration root = (TypeDeclaration)parser.createAST(null);
        if (root.getMethods().length != 1 || root.getMethods()[0].parameters().size() != 1 || (root.getFlags() & ASTNode.MALFORMED) != 0) throw new IllegalArgumentException("参数类型不合法：" + parameter.type);
        return (SingleVariableDeclaration)root.getMethods()[0].parameters().get(0);
    }
    private static Expression expression(String value) {
        ASTParser parser = ASTParser.newParser(AST.JLS8); parser.setKind(ASTParser.K_EXPRESSION); parser.setSource(value.toCharArray());
        ASTNode node = parser.createAST(null);
        if (!(node instanceof Expression) || (node.getFlags() & ASTNode.MALFORMED) != 0 || node.getLength() != value.length()) throw new IllegalArgumentException("新增参数需要一个合法默认表达式");
        return (Expression)node;
    }
    private static void changeDeclaration(MethodDeclaration node, ASTRewrite rewrite, List<Parameter> parameters, String name, IMethod original) {
        List<?> old = node.parameters(); ListRewrite list = rewrite.getListRewrite(node, MethodDeclaration.PARAMETERS_PROPERTY);
        Map<IVariableBinding,String> renames = new HashMap<IVariableBinding,String>();
        Set<IVariableBinding> removed = new HashSet<IVariableBinding>();
        Set<IVariableBinding> originalBindings = new HashSet<IVariableBinding>();
        Set<String> introducedNames = new HashSet<String>();
        for (Object item : old) {
            SingleVariableDeclaration p = (SingleVariableDeclaration)item;
            if (p.resolveBinding() == null) throw new IllegalArgumentException("参数绑定不可用，请先修复类型解析问题");
            originalBindings.add(p.resolveBinding()); removed.add(p.resolveBinding()); list.remove(p, null);
        }
        for (Parameter p : parameters) {
            SingleVariableDeclaration parsed = parameter(p);
            SingleVariableDeclaration newParameter = (SingleVariableDeclaration)ASTNode.copySubtree(node.getAST(), p.index >= 0 ? (SingleVariableDeclaration)old.get(p.index) : parsed);
            newParameter.setName(node.getAST().newSimpleName(p.name));
            // A generic override may specialize T as String; unchanged types belong to each declaration.
            if (p.index < 0 || p.typeChanged) {
                newParameter.setType((Type)ASTNode.copySubtree(node.getAST(), parsed.getType()));
                newParameter.extraDimensions().clear();
            }
            if (p.index >= 0) {
                SingleVariableDeclaration previous = (SingleVariableDeclaration)old.get(p.index);
                IVariableBinding binding = previous.resolveBinding(); removed.remove(binding);
                if (!previous.getName().getIdentifier().equals(p.name)) { renames.put(binding, p.name); introducedNames.add(p.name); }
            } else introducedNames.add(p.name);
            list.insertLast(newParameter, null);
        }
        SignatureSafety.checkNames(node, introducedNames, originalBindings, renames);
        if (node.getBody() != null) node.getBody().accept(new ASTVisitor() {
            public boolean visit(SimpleName reference) {
                IBinding binding = reference.resolveBinding();
                if (removed.contains(binding)) throw new IllegalArgumentException("被移除的参数仍在方法体中使用，请先处理引用");
                if (renames.containsKey(binding)) rewrite.replace(reference, node.getAST().newSimpleName(renames.get(binding)), null);
                return true;
            }
        });
        if (!node.isConstructor() && !node.getName().getIdentifier().equals(name)) rewrite.replace(node.getName(), node.getAST().newSimpleName(name), null);
        // Keep descriptions bound to their old parameter index; type-parameter tags are unrelated.
        if (node.getJavadoc() != null) {
            ListRewrite tags = rewrite.getListRewrite(node.getJavadoc(), Javadoc.TAGS_PROPERTY);
            Map<String,TagElement> previousTags = new HashMap<String,TagElement>();
            Set<String> previousNames = new HashSet<String>();
            for (Object parameter : old) previousNames.add(((SingleVariableDeclaration)parameter).getName().getIdentifier());
            for (Object item : node.getJavadoc().tags()) {
                TagElement tag = (TagElement)item;
                if (!TagElement.TAG_PARAM.equals(tag.getTagName()) || tag.fragments().isEmpty() || !(tag.fragments().get(0) instanceof SimpleName)) continue;
                String parameter = ((SimpleName)tag.fragments().get(0)).getIdentifier();
                if (!previousNames.contains(parameter)) continue;
                previousTags.put(parameter, tag); tags.remove(tag, null);
            }
            for (Parameter p : parameters) {
                TagElement oldTag = p.index < 0 ? null : previousTags.get(((SingleVariableDeclaration)old.get(p.index)).getName().getIdentifier());
                if (oldTag != null) {
                    SimpleName oldName = (SimpleName)oldTag.fragments().get(0);
                    if (!oldName.getIdentifier().equals(p.name)) rewrite.replace(oldName, node.getAST().newSimpleName(p.name), null);
                    tags.insertLast(rewrite.createMoveTarget(oldTag), null);
                } else {
                    TagElement tag = node.getAST().newTagElement(); tag.setTagName(TagElement.TAG_PARAM);
                    tag.fragments().add(node.getAST().newSimpleName(p.name)); tags.insertLast(tag, null);
                }
            }
        }
    }
}
