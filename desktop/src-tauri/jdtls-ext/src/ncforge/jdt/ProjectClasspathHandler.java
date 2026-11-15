package ncforge.jdt;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.Path;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.ls.core.internal.*;

/** Reports JDT's actual resolved classpath; attachment changes touch only our generated project. */
public final class ProjectClasspathHandler implements IDelegateCommandHandler {
    public Object executeCommand(String commandId,List<Object> arguments,IProgressMonitor monitor) throws Exception{
        Map<?,?> arg=(Map<?,?>)arguments.get(0);ICompilationUnit unit=JDTUtils.resolveCompilationUnit((String)arg.get("uri"));
        if(unit==null)throw new IllegalArgumentException("请先打开代码智能已就绪的 Java 文件");
        IJavaProject project=unit.getJavaProject();
        if("attach".equals(arg.get("mode"))){
            if(!"nc-forge-shadow".equals(project.getElementName()))throw new IllegalArgumentException("源码附件只能更新工作台生成的语言服务工程");
            String jar=String.valueOf(arg.get("jar")).replace('\\','/'),source=String.valueOf(arg.get("source"));
            if(!source.isEmpty()&&!new java.io.File(source).isFile())throw new IllegalArgumentException("源码附件不存在或不是文件");
            List<IClasspathEntry> entries=new ArrayList<IClasspathEntry>();boolean found=false;
            for(IClasspathEntry entry:project.getRawClasspath()){
                if(entry.getEntryKind()==IClasspathEntry.CPE_LIBRARY&&entry.getPath().toString().equalsIgnoreCase(jar)){
                    List<IClasspathAttribute> attributes=new ArrayList<IClasspathAttribute>();
                    for(IClasspathAttribute attribute:entry.getExtraAttributes())if(!IClasspathAttribute.JAVADOC_LOCATION_ATTRIBUTE_NAME.equals(attribute.getName()))attributes.add(attribute);
                    String javadoc=arg.get("javadoc") instanceof String?(String)arg.get("javadoc"):"";
                    if(!javadoc.isEmpty())attributes.add(JavaCore.newClasspathAttribute(IClasspathAttribute.JAVADOC_LOCATION_ATTRIBUTE_NAME,javadoc));
                    entries.add(JavaCore.newLibraryEntry(entry.getPath(),source.isEmpty()?null:new Path(source),null,entry.getAccessRules(),attributes.toArray(new IClasspathAttribute[0]),entry.isExported()));found=true;
                }else entries.add(entry);
            }
            if(!found)throw new IllegalArgumentException("该 JAR 未进入当前有效类路径");
            project.setRawClasspath(entries.toArray(new IClasspathEntry[0]),monitor);
        }
        List<Map<String,Object>> entries=new ArrayList<Map<String,Object>>();List<String> issues=new ArrayList<String>();Set<String> paths=new HashSet<String>();
        for(IClasspathEntry entry:project.getResolvedClasspath(true)){
            String path=entry.getPath().toString();Map<String,Object> item=new LinkedHashMap<String,Object>();
            item.put("path",path);item.put("kind",entry.getEntryKind());item.put("exported",entry.isExported());
            item.put("source",entry.getSourceAttachmentPath()==null?"":entry.getSourceAttachmentPath().toString());
            String javadoc="";for(IClasspathAttribute attribute:entry.getExtraAttributes())if(IClasspathAttribute.JAVADOC_LOCATION_ATTRIBUTE_NAME.equals(attribute.getName()))javadoc=attribute.getValue();
            item.put("javadoc",javadoc);entries.add(item);
            if(!paths.add(path.toLowerCase()))issues.add("重复类路径："+path);
            if(entry.getEntryKind()==IClasspathEntry.CPE_LIBRARY&&!new java.io.File(path).exists())issues.add("依赖不存在："+path);
            if(entry.getSourceAttachmentPath()!=null&&!entry.getSourceAttachmentPath().toFile().exists())issues.add("源码附件不存在："+entry.getSourceAttachmentPath());
        }
        Map<String,Object> result=new LinkedHashMap<String,Object>();result.put("entries",entries);result.put("issues",issues);result.put("project",project.getElementName());return result;
    }
}
