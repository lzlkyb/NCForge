package ncforge.jdt;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.lsp4j.WorkspaceEdit;

/** Plans contain the exact input text, so the client can reject stale cross-file edits. */
final class RefactorWorkspace {
    static CompilationUnit ast(ICompilationUnit unit, IProgressMonitor monitor) {
        ASTParser parser = ASTParser.newParser(AST.JLS8);
        parser.setSource(unit); parser.setResolveBindings(true); parser.setBindingsRecovery(false);
        return (CompilationUnit) parser.createAST(monitor);
    }
    static int offset(CompilationUnit ast, Map<?, ?> arg) {
        // CompilationUnit lines are one-based while LSP positions are zero-based.
        return ast.getPosition(((Number) arg.get("line")).intValue()+1, ((Number) arg.get("character")).intValue());
    }
    static List<ICompilationUnit> units(IJavaProject project, IProgressMonitor monitor) throws Exception {
        List<ICompilationUnit> units = new ArrayList<ICompilationUnit>();
        for (IPackageFragment fragment : project.getPackageFragments()) {
            if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
            if (fragment.getKind() != IPackageFragmentRoot.K_SOURCE) continue;
            for (ICompilationUnit unit : fragment.getCompilationUnits()) {
                if (units.size() >= 2000) throw new IllegalArgumentException("超过 2000 个源文件，请缩小到模块后执行");
                units.add(unit);
            }
        }
        return units;
    }
    static Map<String, Object> result(WorkspaceEdit edit, IProgressMonitor monitor) throws Exception {
        if(edit==null)throw new IllegalArgumentException("语言服务没有返回编辑计划");
        removeFolderSentinels(edit);
        flattenDirectoryMoves(edit,monitor);
        Set<String> uris = new LinkedHashSet<String>();
        if (edit.getChanges() != null) uris.addAll(edit.getChanges().keySet());
        if (edit.getDocumentChanges() != null) {
            for (org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit, org.eclipse.lsp4j.ResourceOperation> change : edit.getDocumentChanges()) {
                if (change.isLeft()) uris.add(change.getLeft().getTextDocument().getUri());
                else if (change.getRight() instanceof org.eclipse.lsp4j.RenameFile) uris.add(((org.eclipse.lsp4j.RenameFile)change.getRight()).getOldUri());
                else if (change.getRight() instanceof org.eclipse.lsp4j.DeleteFile) uris.add(((org.eclipse.lsp4j.DeleteFile)change.getRight()).getUri());
            }
        }
        List<Map<String, String>> before = new ArrayList<Map<String, String>>();
        for (String uri : uris) {
            ICompilationUnit unit = JDTUtils.resolveCompilationUnit(uri);
            String source=unit==null?resourceSource(uri):unit.getSource();
            if (source != null) {
                Map<String, String> snapshot = new LinkedHashMap<String, String>();
                snapshot.put("uri", uri); snapshot.put("text", source); before.add(snapshot);
            }
        }
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("edit", edit); result.put("before", before);
        return result;
    }
    private static String resourceSource(String uri)throws Exception {
        if(!uri.startsWith("file:"))return null;
        if(!java.nio.file.Files.isRegularFile(java.nio.file.Paths.get(new java.net.URI(uri))))return null;
        org.eclipse.core.resources.IFile[] files=org.eclipse.core.resources.ResourcesPlugin.getWorkspace().getRoot().findFilesForLocationURI(new java.net.URI(uri));
        if(files.length==0)return null;
        byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(new java.net.URI(uri)));
        java.nio.charset.Charset charset=java.nio.charset.Charset.forName(files[0].getCharset(true));
        String text=charset.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        return text.startsWith("\ufeff")?text.substring(1):text;
    }
    // JDT represents package renames as folder moves. The client transaction moves files
    // individually, so expose every file rather than losing package resources or references.
    private static void flattenDirectoryMoves(WorkspaceEdit edit,IProgressMonitor monitor)throws Exception {
        if(edit.getDocumentChanges()==null)return;
        List<org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation>> changes=new ArrayList<org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation>>();
        for(org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation> change:edit.getDocumentChanges()){
            if(!change.isRight()||!(change.getRight() instanceof org.eclipse.lsp4j.RenameFile)){changes.add(change);continue;}
            org.eclipse.lsp4j.RenameFile move=(org.eclipse.lsp4j.RenameFile)change.getRight();
            java.nio.file.Path from=java.nio.file.Paths.get(new java.net.URI(move.getOldUri()));
            if(!java.nio.file.Files.isDirectory(from)){changes.add(change);continue;}
            java.nio.file.Path to=java.nio.file.Paths.get(new java.net.URI(move.getNewUri()));
            try(java.util.stream.Stream<java.nio.file.Path> paths=java.nio.file.Files.walk(from)){
                Iterator<java.nio.file.Path> iterator=paths.iterator();int count=0;
                while(iterator.hasNext()){
                    if(monitor.isCanceled())throw new org.eclipse.core.runtime.OperationCanceledException();
                    java.nio.file.Path file=iterator.next();if(!java.nio.file.Files.isRegularFile(file))continue;
                    if(++count>400)throw new IllegalArgumentException("包移动涉及超过 400 个文件，请拆分后执行");
                    changes.add(org.eclipse.lsp4j.jsonrpc.messages.Either.forRight(new org.eclipse.lsp4j.RenameFile(file.toUri().toString(),to.resolve(from.relativize(file)).toUri().toString())));
                }
            }
        }
        edit.setDocumentChanges(changes);
    }
    private static void removeFolderSentinels(WorkspaceEdit edit)throws Exception {
        if(edit.getDocumentChanges()==null)return;
        Set<String> created=new HashSet<String>(),deleted=new HashSet<String>();
        for(org.eclipse.lsp4j.jsonrpc.messages.Either<org.eclipse.lsp4j.TextDocumentEdit,org.eclipse.lsp4j.ResourceOperation> change:edit.getDocumentChanges())if(change.isRight()){
            if(change.getRight() instanceof org.eclipse.lsp4j.CreateFile)created.add(((org.eclipse.lsp4j.CreateFile)change.getRight()).getUri());
            if(change.getRight() instanceof org.eclipse.lsp4j.DeleteFile)deleted.add(((org.eclipse.lsp4j.DeleteFile)change.getRight()).getUri());
        }
        created.retainAll(deleted);Iterator<String> iterator=created.iterator();
        while(iterator.hasNext()){String uri=iterator.next();if(!uri.endsWith("/.temp")||java.nio.file.Files.exists(java.nio.file.Paths.get(new java.net.URI(uri))))iterator.remove();}
        // ChangeUtil creates then deletes a .temp file to represent a destination folder.
        // Per-file transactions already create parent folders, so these paired sentinels
        // have no user-file effect and must not be presented as a real create/delete.
        if(!created.isEmpty())edit.getDocumentChanges().removeIf(change->change.isRight()&&((change.getRight() instanceof org.eclipse.lsp4j.CreateFile&&created.contains(((org.eclipse.lsp4j.CreateFile)change.getRight()).getUri()))||(change.getRight() instanceof org.eclipse.lsp4j.DeleteFile&&created.contains(((org.eclipse.lsp4j.DeleteFile)change.getRight()).getUri()))));
    }
}
