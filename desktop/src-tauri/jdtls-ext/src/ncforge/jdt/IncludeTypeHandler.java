package ncforge.jdt;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.Path;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;

/** Updates only the generated project's classpath, synchronously before completion. */
public final class IncludeTypeHandler implements IDelegateCommandHandler {
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Map<?, ?> arg = (Map<?, ?>) arguments.get(0);
        ICompilationUnit unit = JDTUtils.resolveCompilationUnit((String) arg.get("uri"));
        if (unit == null) throw new IllegalArgumentException("Java document is unavailable");
        IJavaProject project = unit.getJavaProject();
        java.io.File expected = new java.io.File((String) arg.get("projectRoot")).getCanonicalFile();
        if (project.getProject().getLocation() == null
            || !project.getProject().getLocation().toFile().getCanonicalFile().equals(expected)) {
            throw new IllegalArgumentException("Classpath changes are restricted to the generated project");
        }
        Map<String, Integer> ranks = new HashMap<String, Integer>();
        for (Object path : (List<?>) arg.get("order")) {
            ranks.put(((String) path).replace('\\', '/'), Integer.valueOf(ranks.size()));
        }
        // Two highlighted type suggestions can resolve together; keep both additions.
        synchronized (IncludeTypeHandler.class) {
            List<IClasspathEntry> entries = new ArrayList<IClasspathEntry>(Arrays.asList(project.getRawClasspath()));
            Set<String> paths = new HashSet<String>();
            for (IClasspathEntry entry : entries) paths.add(entry.getPath().toString());
            boolean changed = false;
            for (Object value : (List<?>) arg.get("jars")) {
                String path = ((String) value).replace('\\', '/');
                if (paths.add(path)) {
                    String source = path.substring(0, path.length() - 4) + "_src.jar";
                    IClasspathEntry added = JavaCore.newLibraryEntry(new Path(path),
                        new java.io.File(source).isFile() ? new Path(source) : null, null);
                    int at = entries.size();
                    Integer rank = ranks.get(path);
                    for (int i = 0; i < entries.size(); i++) {
                        Integer other = ranks.get(entries.get(i).getPath().toString());
                        if (rank != null && other != null && other.intValue() > rank.intValue()) { at = i; break; }
                    }
                    // Keep NC's override priority even when a selected jar is added later.
                    entries.add(at, added);
                    changed = true;
                }
            }
            if (changed) project.setRawClasspath(entries.toArray(new IClasspathEntry[0]), monitor);
        }
        return Boolean.TRUE;
    }
}
