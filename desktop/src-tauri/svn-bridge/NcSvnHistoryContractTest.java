import java.io.File;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import org.tmatesoft.svn.core.SVNDepth;
import org.tmatesoft.svn.core.SVNURL;
import org.tmatesoft.svn.core.io.SVNRepositoryFactory;
import org.tmatesoft.svn.core.internal.io.fs.FSRepositoryFactory;
import org.tmatesoft.svn.core.wc.SVNClientManager;
import org.tmatesoft.svn.core.wc.SVNRevision;

/** file:// 临时仓库真实契约：不触及用户仓库或全局 SVN 凭据。 */
public class NcSvnHistoryContractTest {
    private static Method dispatch;
    private static int checks;
    private static String call(String command, String... args) throws Exception {
        String[] fields = new String[args.length + 2]; fields[0] = "test"; fields[1] = command;
        System.arraycopy(args, 0, fields, 2, args.length);
        try { return (String) dispatch.invoke(null, command, fields); }
        catch (InvocationTargetException error) { throw (Exception) error.getCause(); }
    }
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    private static void write(File file, String text) throws Exception { Files.write(file.toPath(), text.getBytes(StandardCharsets.UTF_8)); }
    private static String decodeField(String json, String field) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\\"" + field + "\\\":\\\"([^\\\"]*)\\\"").matcher(json);
        if (!matcher.find()) throw new AssertionError("Missing " + field + ": " + json);
        return new String(Base64.getDecoder().decode(matcher.group(1)), StandardCharsets.UTF_8);
    }
    private static void readLimits(File temporary) throws Exception {
        // 注入 16 字节预算，覆盖真实流限制而不在开发机创建大文件。
        Constructor<?> constructor = Class.forName("NcSvnBridge$LimitedBytes").getDeclaredConstructor(int.class);
        constructor.setAccessible(true);
        ByteArrayOutputStream bytes = (ByteArrayOutputStream) constructor.newInstance(16);
        bytes.write(new byte[16], 0, 16);
        check(bytes.size() == 16, "exact stream limit accepted");
        boolean refused = false;
        try { bytes.write(1); } catch (IllegalArgumentException error) { refused = true; }
        check(refused && bytes.size() == 16, "extra stream byte rejected before buffering");
        bytes = (ByteArrayOutputStream) constructor.newInstance(16);
        refused = false;
        try { bytes.write(new byte[17], 0, 17); } catch (IllegalArgumentException error) { refused = true; }
        check(refused && bytes.size() == 0, "oversized stream batch rejected before buffering");
        File file = new File(temporary, "read-limit.txt"); write(file, "1234567890123456");
        Method localFile = NcSvnBridge.class.getDeclaredMethod("localFile", File.class, int.class); localFile.setAccessible(true);
        check(((byte[]) localFile.invoke(null, file, 16)).length == 16, "exact local file limit accepted");
        write(file, "12345678901234567"); refused = false;
        try { localFile.invoke(null, file, 16); }
        catch (InvocationTargetException error) { refused = error.getCause() instanceof IllegalArgumentException; }
        check(refused, "oversized local file rejected before reading");
    }
    public static void main(String[] args) throws Exception {
        File temporary = new File(args[0]).getCanonicalFile();
        if (!temporary.getName().startsWith("svn-history-contract-")) throw new IllegalArgumentException("临时测试目录无效");
        readLimits(temporary);
        FSRepositoryFactory.setup();
        File config = new File(temporary, "config"); config.mkdirs();
        SVNClientManager manager = SVNClientManager.newInstance(org.tmatesoft.svn.core.wc.SVNWCUtil.createDefaultOptions(config, true), org.tmatesoft.svn.core.wc.SVNWCUtil.createDefaultAuthenticationManager(config));
        Field cm = NcSvnBridge.class.getDeclaredField("cm"); cm.setAccessible(true); cm.set(null, manager);
        dispatch = NcSvnBridge.class.getDeclaredMethod("dispatch", String.class, String[].class); dispatch.setAccessible(true);
        SVNURL url = SVNRepositoryFactory.createLocalRepository(new File(temporary, "repository"), true, false);
        File a = new File(temporary, "a"); File b = new File(temporary, "b");
        try {
            manager.getUpdateClient().doCheckout(url, a, SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY, false);
            File text = new File(a, "A.java"); write(text, "first\nbase\n");
            manager.getWCClient().doAdd(text, false, false, false, SVNDepth.EMPTY, false, false);
            long r1 = manager.getCommitClient().doCommit(new File[]{text}, false, "add file", null, null, false, false, SVNDepth.EMPTY).getNewRevision();
            manager.getUpdateClient().doCheckout(url, b, SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY, false);
            write(text, "first\nserver\n");
            long r2 = manager.getCommitClient().doCommit(new File[]{text}, false, "server change", null, null, false, false, SVNDepth.EMPTY).getNewRevision();
            String history = call("history", a.getPath(), "30", "0");
            check(history.contains("\"path\":\"/A.java\"") && history.contains("\"revision\":" + r2), "history exposes actual changed path: " + history);
            String earlier = call("history", a.getPath(), "30", Long.toString(r2));
            check(!earlier.contains("\"revision\":" + r2 + ","), "pagination excludes cursor");
            String added = call("revision_diff", a.getPath(), "/A.java", Long.toString(r1));
            check(added.contains("\"beforeEmpty\":true") && decodeField(added, "after").equals("first\nbase\n"), "added revision content");
            String changed = call("revision_diff", a.getPath(), "/A.java", Long.toString(r2));
            check(decodeField(changed, "before").equals("first\nbase\n") && decodeField(changed, "after").equals("first\nserver\n"), "fixed before/after content");
            write(text, "LOCAL UNSAVED TO SVN\nextra\nlines\n");
            String blame = call("blame_snapshot", text.getPath(), "0");
            check(blame.contains("\"sourceRevision\":" + r2) && blame.contains("first\\nserver") && !blame.contains("LOCAL UNSAVED"), "blame uses same fixed repository content");
            check(blame.contains("\"revision\":" + r1) && blame.contains("\"revision\":" + r2), "line revision attribution");
            File local = new File(b, "A.java"); write(local, "first\nmy work\n");
            manager.getUpdateClient().doUpdate(b, SVNRevision.HEAD, SVNDepth.INFINITY, false, false);
            String conflict = call("conflict_snapshot", local.getPath());
            check(conflict.contains("\"textConflict\":true") && conflict.contains("\"revision\":" + r1) && conflict.contains("\"revision\":" + r2), "actual base/theirs conflict revisions");
            check(conflict.contains(Base64.getEncoder().encodeToString("first\nmy work\n".getBytes(StandardCharsets.UTF_8))), "actual mine snapshot");
            boolean refused = false;
            try { call("resolve_working", local.getPath()); } catch (Exception error) { refused = error.getMessage().contains("冲突标记"); }
            check(refused, "unresolved markers cannot be accepted");
            write(local, "first\nmanual merged\n"); call("resolve_working", local.getPath());
            check(new String(Files.readAllBytes(local.toPath()), StandardCharsets.UTF_8).equals("first\nmanual merged\n"), "MERGED keeps saved working content");
            check(call("conflict_snapshot", local.getPath()).contains("\"textConflict\":false"), "text conflict cleared");
            manager.getWCClient().doRevert(new File[]{text}, SVNDepth.EMPTY, null);
            manager.getWCClient().doDelete(text, false, false, false);
            long r3 = manager.getCommitClient().doCommit(new File[]{text}, false, "delete file", null, null, false, false, SVNDepth.EMPTY).getNewRevision();
            String deleted = call("revision_diff", a.getPath(), "/A.java", Long.toString(r3));
            check(deleted.contains("\"afterEmpty\":true") && decodeField(deleted, "before").equals("first\nserver\n"), "deleted revision content");
            boolean traversal = false;
            try { call("revision_diff", a.getPath(), "/../A.java", Long.toString(r1)); } catch (Exception error) { traversal = true; }
            check(traversal, "repository path traversal rejected");
            System.out.println("SVN history contract passed: " + checks + " checks");
        } finally { manager.dispose(); cm.set(null, null); }
    }
}
