package ncforge.jdt;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.core.search.*;
import org.eclipse.jdt.ls.core.internal.*;
import org.eclipse.lsp4j.Location;

/** Search bindings identify the field; AST context classifies reads, writes and increments. */
public final class FieldAccessHandler implements IDelegateCommandHandler {
    private static final class SearchLimit extends RuntimeException {private static final long serialVersionUID=1L;}
    public Object executeCommand(String id,List<Object> arguments,final IProgressMonitor monitor)throws Exception {
        Map<?,?> arg=(Map<?,?>)arguments.get(0);ICompilationUnit unit=JDTUtils.resolveCompilationUnit((String)arg.get("uri"));
        if(unit==null)throw new IllegalArgumentException("当前 Java 文档不可用");
        CompilationUnit tree=RefactorWorkspace.ast(unit,monitor);int offset=RefactorWorkspace.offset(tree,arg);
        IJavaElement[] selected=unit.codeSelect(offset,0);
        if(selected.length==0||!(selected[0] instanceof IField))throw new IllegalArgumentException("请把光标放在字段声明或引用上");
        final IField field=(IField)selected[0];final List<Map<String,Object>> references=new ArrayList<Map<String,Object>>();
        final Map<ICompilationUnit,CompilationUnit> trees=new HashMap<ICompilationUnit,CompilationUnit>();
        final long started=System.currentTimeMillis();final boolean[] truncated={false};
        SearchPattern pattern=SearchPattern.createPattern(field,IJavaSearchConstants.REFERENCES,SearchPattern.R_EXACT_MATCH);
        try{new SearchEngine().search(pattern,new SearchParticipant[]{SearchEngine.getDefaultSearchParticipant()},SearchEngine.createWorkspaceScope(),new SearchRequestor(){
            public void acceptSearchMatch(SearchMatch match)throws org.eclipse.core.runtime.CoreException {
                if(references.size()>=2000||System.currentTimeMillis()-started>20000){truncated[0]=true;throw new SearchLimit();}
                if(monitor.isCanceled())throw new org.eclipse.core.runtime.OperationCanceledException();
                if(!(match.getElement() instanceof IJavaElement))return;
                IJavaElement element=(IJavaElement)match.getElement();ICompilationUnit source=(ICompilationUnit)element.getAncestor(IJavaElement.COMPILATION_UNIT);
                Location location;String access="unknown";
                if(source!=null){
                    location=JDTUtils.toLocation(source,match.getOffset(),match.getLength());
                    if(match.getAccuracy()==SearchMatch.A_ACCURATE){
                        CompilationUnit ast=trees.get(source);if(ast==null){ast=RefactorWorkspace.ast(source,monitor);trees.put(source,ast);}
                        ASTNode node=NodeFinder.perform(ast,match.getOffset(),match.getLength());
                        if(node instanceof SimpleName){IBinding binding=((SimpleName)node).resolveBinding();
                            if(binding instanceof IVariableBinding&&binding.getJavaElement()!=null&&field.getHandleIdentifier().equals(binding.getJavaElement().getHandleIdentifier()))access=classify((SimpleName)node);
                        }
                    }
                }else{
                    IClassFile binary=(IClassFile)element.getAncestor(IJavaElement.CLASS_FILE);
                    location=binary==null?JDTUtils.toLocation(element):JDTUtils.toLocation(binary,match.getOffset(),match.getLength());
                }
                if(location==null)return;
                Map<String,Object> item=new LinkedHashMap<String,Object>();item.put("uri",location.getUri());item.put("range",location.getRange());item.put("access",access);item.put("accurate",match.getAccuracy()==SearchMatch.A_ACCURATE);references.add(item);
            }
        },monitor);}catch(SearchLimit limit){/* The caller receives already-classified references and truncated=true. */}
        Map<String,Object> result=new LinkedHashMap<String,Object>();result.put("name",field.getElementName());result.put("references",references);result.put("truncated",truncated[0]);return result;
    }
    static String classify(SimpleName name){
        ASTNode value=name,parent=value.getParent();
        if(parent instanceof QualifiedName&&((QualifiedName)parent).getName()==value)value=parent;
        else if(parent instanceof FieldAccess&&((FieldAccess)parent).getName()==value)value=parent;
        else if(parent instanceof SuperFieldAccess&&((SuperFieldAccess)parent).getName()==value)value=parent;
        while(value.getParent() instanceof ParenthesizedExpression)value=value.getParent();
        parent=value.getParent();
        if(parent instanceof Assignment&&((Assignment)parent).getLeftHandSide()==value)return ((Assignment)parent).getOperator()==Assignment.Operator.ASSIGN?"write":"readWrite";
        if(parent instanceof PostfixExpression&&((PostfixExpression)parent).getOperand()==value)return "readWrite";
        if(parent instanceof PrefixExpression&&((PrefixExpression)parent).getOperand()==value){PrefixExpression.Operator op=((PrefixExpression)parent).getOperator();if(op==PrefixExpression.Operator.INCREMENT||op==PrefixExpression.Operator.DECREMENT)return "readWrite";}
        return "read";
    }
}
