import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.lang.reflect.Method;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/** Both JUnit Vintage and Jupiter run through the official platform console. */
public final class NcJavaTestRunner {
    private static String encoded(Object value) {
        return Base64.getEncoder().encodeToString(String.valueOf(value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
    }
    private static String methodSelector(String target) throws Exception {
        String[] parts = target.split("#", 2);
        Class<?> type = Class.forName(parts[0], false, NcJavaTestRunner.class.getClassLoader());
        Method selected = null;
        for (Class<?> owner = type; owner != null; owner = owner.getSuperclass()) {
            for (Method method : owner.getDeclaredMethods()) {
                if (!method.getName().equals(parts[1]) || method.isBridge() || method.isSynthetic()) continue;
                if (selected != null && !java.util.Arrays.equals(selected.getParameterTypes(), method.getParameterTypes())) {
                    throw new IllegalArgumentException("Overloaded test method: " + target + "; select the test class instead");
                }
                if (selected == null) selected = method;
            }
        }
        if (selected == null) throw new IllegalArgumentException("Test method not found: " + target);
        ArrayList<String> parameters = new ArrayList<String>();
        for (Class<?> parameter : selected.getParameterTypes()) parameters.add(parameter.getTypeName());
        return target + "(" + String.join(",", parameters) + ")";
    }
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 2 || !"--targets-file".equals(arguments[0])) throw new IllegalArgumentException("Targets file required");
        Path targets = Paths.get(arguments[1]);
        Path reports = targets.getParent().resolve("test-reports");
        ArrayList<String> options = new ArrayList<String>();
        options.add("execute"); options.add("--disable-banner"); options.add("--disable-ansi-colors");
        options.add("--fail-if-no-tests"); options.add("--reports-dir=" + reports);
        for (String target : Files.readAllLines(targets, StandardCharsets.UTF_8)) {
            options.add(target.contains("#") ? "--select-method=" + methodSelector(target) : "--select-class=" + target);
        }
        Class<?> launcher = Class.forName("org.junit.platform.console.ConsoleLauncher");
        Object result = launcher.getMethod("run", PrintWriter.class, PrintWriter.class, String[].class)
            .invoke(null, new PrintWriter(System.out, true), new PrintWriter(System.err, true), options.toArray(new String[0]));
        int exit = ((Integer) result.getClass().getMethod("getExitCode").invoke(result)).intValue();
        Map<String, int[]> summaries = new LinkedHashMap<String, int[]>();
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        if (Files.isDirectory(reports)) {
            try (java.nio.file.DirectoryStream<Path> files = Files.newDirectoryStream(reports, "TEST-*.xml")) {
                for (Path file : files) {
                    NodeList cases = factory.newDocumentBuilder().parse(file.toFile()).getElementsByTagName("testcase");
                    for (int n = 0; n < cases.getLength(); n++) {
                        Element test = (Element) cases.item(n);
                        String name = test.getAttribute("classname");
                        String method = test.getAttribute("name").replaceFirst("\\(\\)$", "");
                        int[] totals = summaries.get(name);
                        if (totals == null) { totals = new int[3]; summaries.put(name, totals); }
                        boolean skipped = test.getElementsByTagName("skipped").getLength() > 0;
                        if (skipped) totals[2]++; else totals[0]++;
                        NodeList failed = test.getElementsByTagName("failure");
                        if (failed.getLength() == 0) failed = test.getElementsByTagName("error");
                        if (failed.getLength() > 0) {
                            totals[1]++;
                            String trace = failed.item(0).getTextContent();
                            if (trace.length() > 16000) trace = trace.substring(0, 16000) + "\n[trace truncated]";
                            System.out.println("NCFORGE_TEST_FAILURE\t" + encoded(name) + "\t" + encoded(method) + "\t" + encoded(trace));
                        }
                    }
                }
            }
        }
        for (Map.Entry<String, int[]> summary : summaries.entrySet()) {
            int[] totals = summary.getValue();
            System.out.println("NCFORGE_TEST_SUMMARY\t" + encoded(summary.getKey()) + "\t" + totals[0] + "\t" + totals[1] + "\t" + totals[2]);
        }
        System.exit(exit);
    }
}
