package ncforge.jdt;

import java.util.*;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.core.dom.rewrite.*;
import org.eclipse.jdt.internal.corext.refactoring.code.InlineMethodRefactoring;
import org.eclipse.jdt.internal.corext.refactoring.code.InlineTempRefactoring;
import org.eclipse.jdt.ls.core.internal.*;
import org.eclipse.jdt.ls.core.internal.corext.refactoring.rename.RenameSupport;
import org.eclipse.jdt.ls.core.internal.corext.refactoring.reorg.*;
import org.eclipse.ltk.core.refactoring.*;
import org.eclipse.ltk.core.refactoring.participants.MoveRefactoring;
import org.eclipse.lsp4j.WorkspaceEdit;

/** JDT calculates semantic edits in the generated project; no Change.perform is called. */
public final class RefactorWorkbenchHandler implements IDelegateCommandHandler {
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Map<?, ?> arg = (Map<?, ?>) arguments.get(0);
        ICompilationUnit unit = JDTUtils.resolveCompilationUnit((String) arg.get("uri"));
        if (unit == null) throw new IllegalArgumentException("当前 Java 文档不可用");
        String kind = (String) arg.get("kind");
        if ("rename".equals(kind)) {
            org.eclipse.lsp4j.RenameParams params=new org.eclipse.lsp4j.RenameParams();
            params.setTextDocument(new org.eclipse.lsp4j.TextDocumentIdentifier(JDTUtils.toURI(unit)));
            params.setPosition(new org.eclipse.lsp4j.Position(((Number)arg.get("line")).intValue(),((Number)arg.get("character")).intValue()));
            params.setNewName((String)arg.get("target"));
            WorkspaceEdit edit=new org.eclipse.jdt.ls.core.internal.handlers.RenameHandler(JavaLanguageServerPlugin.getPreferencesManager()).rename(params,monitor);
            return RefactorWorkspace.result(edit,monitor);
        }
        CompilationUnit ast = RefactorWorkspace.ast(unit, monitor);
        int offset = RefactorWorkspace.offset(ast, arg);
        if (offset < 0) throw new IllegalArgumentException("光标位置已失效，请重新执行");
        int length = arg.get("length") instanceof Number ? ((Number)arg.get("length")).intValue() : 0;
        Refactoring refactoring;boolean initialChecked=false;
        if ("inlineVariable".equals(kind)) {
            refactoring = new InlineTempRefactoring(unit, ast, offset, length);
        } else if ("inlineMethod".equals(kind)) {
            InlineMethodRefactoring inline = InlineMethodRefactoring.create(unit, ast, offset, length);
            if (inline == null) throw new IllegalArgumentException("请把光标放在可内联的方法或调用上");
            // JDT initializes its source provider during the initial check; mode selection
            // before that check dereferences an uninitialized provider in JDT 0.57.
            check(inline.checkInitialConditions(monitor));initialChecked=true;
            inline.setCurrentMode(InlineMethodRefactoring.Mode.INLINE_ALL);
            if (inline.canEnableDeleteSource()) inline.setDeleteSource(true);
            refactoring = inline;
        } else if ("renamePackage".equals(kind)) {
            String name = (String)arg.get("target");
            if (!validPackage(name)) throw new IllegalArgumentException("请输入合法的包名");
            RenameSupport support = RenameSupport.create((IPackageFragment)unit.getParent(), name, RenameSupport.UPDATE_REFERENCES);
            refactoring = support.getRenameRefactoring();
        } else if ("moveType".equals(kind)) {
            String name = (String)arg.get("target");
            if (!validPackage(name)) throw new IllegalArgumentException("请输入合法的目标包名");
            IPackageFragmentRoot root = (IPackageFragmentRoot)unit.getAncestor(IJavaElement.PACKAGE_FRAGMENT_ROOT);
            IPackageFragment destination = root.getPackageFragment(name);
            IReorgPolicy.IMovePolicy policy = ReorgPolicyFactory.createMovePolicy(new IResource[0], new IJavaElement[] { unit });
            JavaMoveProcessor processor = new JavaMoveProcessor(policy);
            processor.setUpdateReferences(true); processor.setReorgQueries(new NullReorgQueries());
            RefactoringStatus destinationStatus = processor.setDestination(ReorgDestinationFactory.createDestination(destination));
            check(destinationStatus); refactoring = new MoveRefactoring(processor);
        } else if ("visibility".equals(kind)) {
            return visibility(unit, ast, offset, (String)arg.get("target"), monitor);
        } else {
            throw new IllegalArgumentException("未知重构动作：" + kind);
        }
        if(!initialChecked)check(refactoring.checkInitialConditions(monitor));
        check(refactoring.checkFinalConditions(monitor));
        Change change = refactoring.createChange(monitor);
        try {
            WorkspaceEdit edit=ChangeUtil.convertToWorkspaceEdit(change);
            if("renamePackage".equals(kind))includePackageResources(edit,(IPackageFragment)unit.getParent(),(String)arg.get("target"));
            Map<String,Object> result=RefactorWorkspace.result(edit,monitor);
            result.put("warnings",Arrays.asList("XML、UPM、NC 注册与反射调用不属于 Java 语义引用，请核对后编译；无法无损处理的包资源会阻止整个应用。"));return result;
        }
        finally { change.dispose(); }
    }
    static void check(RefactoringStatus status) {
        if (status.hasError()) throw new IllegalArgumentException(status.getEntryWithHighestSeverity().getMessage());
    }
    static boolean validPackage(String name) {
        if (name == null || name.isEmpty()) return false;
        return !JavaConventions.validatePackageName(name, JavaCore.VERSION_1_8, JavaCore.VERSION_1_8).matches(org.eclipse.core.runtime.IStatus.ERROR);
    }
    private static void includePackageResources(WorkspaceEdit edit,IPackageFragment fragment,String target)throws Exception {
        IPackageFragmentRoot root=(IPackageFragmentRoot)fragment.getAncestor(IJavaElement.PACKAGE_FRAGMENT_ROOT);
        java.nio.file.Path destination=java.nio.file.Paths.get(root.getResource().getLocationURI()).resolve(target.replace('.','/'));
        List<org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation>> changes=edit.getDocumentChanges()==null?new ArrayList<org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation>>():new ArrayList<org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation>>(edit.getDocumentChanges());
        Set<String> moved=new HashSet<String>();for(org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation> entry:changes)if(entry.isRight()&&entry.getRight() instanceof org.eclipse.lsp4j.RenameFile)moved.add(((org.eclipse.lsp4j.RenameFile)entry.getRight()).getOldUri());
        // ChangeUtil omits MoveResourceChange for package assets in JDT 0.57. Include
        // those assets explicitly so package moves cannot strand XML beside the old package.
        for(Object item:fragment.getNonJavaResources())if(item instanceof IResource){IResource resource=(IResource)item;String uri=resource.getLocationURI().toString();if(moved.add(uri))changes.add(org.eclipse.lsp4j.jsonrpc.messages.Either.forRight(new org.eclipse.lsp4j.RenameFile(uri,destination.resolve(resource.getName()).toUri().toString())));}
        edit.setDocumentChanges(changes);
    }
    private Object visibility(ICompilationUnit unit, CompilationUnit ast, int offset, String visibility, IProgressMonitor monitor) throws Exception {
        if (!Arrays.asList("public", "protected", "private", "package").contains(visibility)) throw new IllegalArgumentException("未知可见性");
        ASTNode node = NodeFinder.perform(ast, offset, 0);
        while (node != null && !(node instanceof BodyDeclaration)) node = node.getParent();
        if (!(node instanceof MethodDeclaration || node instanceof FieldDeclaration || node instanceof TypeDeclaration)) throw new IllegalArgumentException("请选择类、方法或字段声明");
        if (node.getParent() instanceof TypeDeclaration && ((TypeDeclaration)node.getParent()).isInterface()) throw new IllegalArgumentException("接口成员的可见性由 Java 规则决定");
        if (node instanceof TypeDeclaration && node.getParent() instanceof CompilationUnit && ("private".equals(visibility) || "protected".equals(visibility))) throw new IllegalArgumentException("顶级类型只能为 public 或包可见");
        BodyDeclaration declaration = (BodyDeclaration)node;
        ASTRewrite rewrite = ASTRewrite.create(ast.getAST());
        ListRewrite modifiers = rewrite.getListRewrite(declaration, declaration.getModifiersProperty());
        for (Object modifier : declaration.modifiers()) {
            if (modifier instanceof Modifier) {
                Modifier m = (Modifier)modifier;
                if (m.isPublic() || m.isPrivate() || m.isProtected()) modifiers.remove(m, null);
            }
        }
        if (!"package".equals(visibility)) modifiers.insertFirst(ast.getAST().newModifier(Modifier.ModifierKeyword.toKeyword(visibility)), null);
        WorkspaceEdit edit = new WorkspaceEdit(Collections.singletonMap(JDTUtils.toURI(unit), new TextEditConverter(unit, rewrite.rewriteAST()).convert()));
        Map<String,Object> result = RefactorWorkspace.result(edit, monitor);
        result.put("warnings", Arrays.asList("可见性调整会改变访问规则，请核对引用并在应用后编译；XML、反射和 NC 配置不由 Java 编译器检查"));
        return result;
    }
}
