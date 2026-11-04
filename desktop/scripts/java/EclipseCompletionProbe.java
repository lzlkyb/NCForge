package ncforge.probe;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;
import org.eclipse.core.resources.*;
import org.eclipse.core.runtime.*;
import org.eclipse.equinox.app.*;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.search.*;

/** Uses the installed Eclipse JDT in a disposable workspace, never the user's project. */
public final class EclipseCompletionProbe implements IApplication {
    public Object start(IApplicationContext context) throws Exception {
        String[] args = (String[]) context.getArguments().get(IApplicationContext.APPLICATION_ARGS);
        IProject project = ResourcesPlugin.getWorkspace().getRoot().getProject("completion-baseline");
        project.create(null);
        project.open(null);
        IProjectDescription description = project.getDescription();
        description.setNatureIds(new String[] { JavaCore.NATURE_ID });
        project.setDescription(description, null);
        IFolder src = project.getFolder("src");
        src.create(true, true, null);
        IFolder pkg = src.getFolder("demo");
        pkg.create(true, true, null);
        IJavaProject javaProject = JavaCore.create(project);
        Map<String, String> options = new HashMap<String, String>();
        JavaCore.setComplianceOptions(JavaCore.VERSION_1_8, options);
        options.put(JavaCore.CODEASSIST_CAMEL_CASE_MATCH, JavaCore.ENABLED);
        javaProject.setOptions(options);
        List<IClasspathEntry> cp = new ArrayList<IClasspathEntry>();
        cp.add(JavaCore.newSourceEntry(src.getFullPath()));
        cp.add(JavaCore.newLibraryEntry(new Path(args[0] + "/jre/lib/rt.jar"), null, null));
        for (String jar : Files.readAllLines(Paths.get(args[1]), StandardCharsets.UTF_8)) {
            if (!jar.isEmpty()) cp.add(JavaCore.newLibraryEntry(new Path(jar), null, null));
        }
        javaProject.setRawClasspath(cp.toArray(new IClasspathEntry[0]), project.getFullPath().append("bin"), null);
        write(pkg.getFile("WorkspaceWidget.java"), "package demo; public class WorkspaceWidget { public void refresh() {} }");
        IFile file = pkg.getFile("CompletionDemo.java");
        write(file, "package demo; public class CompletionDemo {}");
        new SearchEngine().searchAllTypeNames(null, SearchPattern.R_PATTERN_MATCH,
            "WorkspaceWidget".toCharArray(), SearchPattern.R_EXACT_MATCH, IJavaSearchConstants.TYPE,
            SearchEngine.createJavaSearchScope(new IJavaElement[] { javaProject }),
            new TypeNameRequestor() {}, IJavaSearchConstants.WAIT_UNTIL_READY_TO_SEARCH, null);
        ICompilationUnit unit = JavaCore.createCompilationUnitFrom(file).getWorkingCopy(null);
        boolean allFound = true;
        try {
            for (String line : Files.readAllLines(Paths.get(args[2]), StandardCharsets.UTF_8)) {
                String[] fields = line.split("\t", -1);
                String source = new String(Base64.getDecoder().decode(fields[2]), StandardCharsets.UTF_8);
                int offset = source.indexOf("/*cursor*/");
                unit.getBuffer().setContents(source.replace("/*cursor*/", ""));
                final List<CompletionProposal> proposals = new ArrayList<CompletionProposal>();
                CompletionRequestor requestor = new CompletionRequestor() {
                    public void accept(CompletionProposal proposal) { proposals.add(proposal); }
                };
                for (int kind = 1; kind <= 30; kind++) {
                    for (int required = 1; required <= 30; required++) {
                        try { requestor.setAllowsRequiredProposals(kind, required, true); }
                        catch (IllegalArgumentException ignored) {}
                    }
                }
                long start = System.nanoTime();
                unit.codeComplete(offset, requestor);
                long ms = (System.nanoTime() - start) / 1000000;
                boolean found = false;
                for (CompletionProposal proposal : proposals) {
                    char[] rawName = proposal.getName();
                    String name = rawName == null && proposal.getSignature() != null
                        ? Signature.getSimpleName(Signature.toString(new String(proposal.getSignature())))
                        : rawName == null ? "" : new String(rawName);
                    int generic = name.indexOf('<');
                    if (generic >= 0) name = name.substring(0, generic);
                    if (fields[1].equals(name)) found = true;
                }
                allFound &= found;
                System.out.println("NCFORGE_RESULT\t" + fields[0] + "\t" + ms + "\t" + proposals.size() + "\t" + found);
            }
        } finally { unit.discardWorkingCopy(); }
        return allFound ? EXIT_OK : Integer.valueOf(2);
    }
    private static void write(IFile file, String text) throws Exception {
        java.io.InputStream stream = new java.io.ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
        try {
            if (file.exists()) file.setContents(stream, true, false, null);
            else file.create(stream, true, null);
        } finally { stream.close(); }
    }
    public void stop() {}
}
