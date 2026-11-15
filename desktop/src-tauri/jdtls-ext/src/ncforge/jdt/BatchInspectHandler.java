package ncforge.jdt;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.compiler.IProblem;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.manipulation.OrganizeImportsOperation;
import org.eclipse.jdt.ls.core.internal.*;
import org.eclipse.lsp4j.WorkspaceEdit;

/** Batch inspection reads all selected source ASTs; import fixes remain an explicit preview plan. */
public final class BatchInspectHandler implements IDelegateCommandHandler {
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Map<?,?> arg=(Map<?,?>)arguments.get(0);
        ICompilationUnit selected=JDTUtils.resolveCompilationUnit((String)arg.get("uri"));
        if(selected==null) throw new IllegalArgumentException("请先打开模块中的 Java 文件");
        List<ICompilationUnit> files="file".equals(arg.get("scope"))?Arrays.asList(selected):RefactorWorkspace.units(selected.getJavaProject(),monitor);
        boolean fix="organizeImports".equals(arg.get("mode"));
        Map<String,List<org.eclipse.lsp4j.TextEdit>> edits=new LinkedHashMap<String,List<org.eclipse.lsp4j.TextEdit>>();
        List<Map<String,Object>> issues=new ArrayList<Map<String,Object>>();
        long deadline=System.currentTimeMillis()+30000; int scanned=0;
        for(ICompilationUnit file:files){
            if(monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
            if(System.currentTimeMillis()>deadline) throw new IllegalArgumentException("批量检查超过 30 秒，请缩小范围");
            CompilationUnit ast=RefactorWorkspace.ast(file,monitor); String uri=JDTUtils.toURI(file);scanned++;
            for(IProblem problem:ast.getProblems()){
                if(issues.size()>=1000) throw new IllegalArgumentException("问题超过 1000 条，请先缩小范围或处理当前文件");
                int offset=Math.max(0,problem.getSourceStart());
                Map<String,Object> issue=new LinkedHashMap<String,Object>();issue.put("uri",uri);issue.put("line",Math.max(1,ast.getLineNumber(offset)));issue.put("column",Math.max(1,ast.getColumnNumber(offset)+1));
                issue.put("severity",problem.isError()?"error":"warning");issue.put("message",problem.getMessage());issues.add(issue);
            }
            if(fix){
                OrganizeImportsOperation operation=new OrganizeImportsOperation(file,ast,true,false,true,(choices,ranges)->{
                    throw new IllegalArgumentException("存在同名导入候选，请在该文件中选择准确类后再批量整理");
                });
                List<org.eclipse.lsp4j.TextEdit> changes=new TextEditConverter(file,operation.createTextEdit(monitor)).convert();
                if(operation.getParseError()!=null) throw new IllegalArgumentException("文件有语法错误，未生成部分修复："+file.getElementName());
                if(!changes.isEmpty()) edits.put(uri,changes);
            }
        }
        Map<String,Object> result=RefactorWorkspace.result(new WorkspaceEdit(edits),monitor);
        result.put("issues",issues);result.put("filesScanned",scanned);return result;
    }
}
