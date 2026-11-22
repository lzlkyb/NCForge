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
    /**
     * 🔴 调度顺序（LPT，最慢先跑）与合并顺序（原始升序）是两件事。
     * 跨单元去重是「先到先得」，按 LPT 顺序合并会让同一条目的胜者随上次耗时漂移。
     */
    @SuppressWarnings("unchecked")
    private static void mergeOrderContracts() throws Exception {
        Method mergeOrder = NcSvnBridge.class.getDeclaredMethod("mergeOrder", java.util.List.class);
        mergeOrder.setAccessible(true);
        // LPT 把最慢的模块（下标 3）排到最前，根层 0 被挤到后面
        java.util.List<Integer> scheduled = new java.util.ArrayList<Integer>(java.util.Arrays.asList(3, 0, 2, 1));
        java.util.List<Integer> merged = (java.util.List<Integer>) mergeOrder.invoke(null, scheduled);
        check(merged.equals(java.util.Arrays.asList(0, 1, 2, 3)),
                "merge order must be the original ascending unit order, got " + merged);
        check(merged.get(0) == 0, "root unit (index 0) must win cross-unit dedup");
        check(scheduled.equals(java.util.Arrays.asList(3, 0, 2, 1)),
                "merge order must not mutate the scheduling order");
        // 同一份输入无论调度怎么排，合并结果必须一致（去重胜者不漂移）
        java.util.List<Integer> other = (java.util.List<Integer>) mergeOrder.invoke(null,
                new java.util.ArrayList<Integer>(java.util.Arrays.asList(2, 1, 3, 0)));
        check(merged.equals(other), "merge order must be independent of LPT scheduling");
        check(((java.util.List<Integer>) mergeOrder.invoke(null, new java.util.ArrayList<Integer>())).isEmpty(),
                "empty schedule merges to empty");
    }
    public static void main(String[] args) throws Exception {
        File temporary = new File(args[0]).getCanonicalFile();
        if (!temporary.getName().startsWith("svn-history-contract-")) throw new IllegalArgumentException("临时测试目录无效");
        readLimits(temporary);
        mergeOrderContracts();
        FSRepositoryFactory.setup();
        File config = new File(temporary, "config"); config.mkdirs();
        // 与生产 newManager() 同构造：factory 承载 options/auth，getOperationFactory() 非空，
        // 否则 wc2 的 status/commit 预检拿不到工厂直接 NPE。
        org.tmatesoft.svn.core.wc2.SvnOperationFactory factory = new org.tmatesoft.svn.core.wc2.SvnOperationFactory();
        factory.setOptions(org.tmatesoft.svn.core.wc.SVNWCUtil.createDefaultOptions(config, true));
        factory.setAuthenticationManager(org.tmatesoft.svn.core.wc.SVNWCUtil.createDefaultAuthenticationManager(config));
        SVNClientManager manager = SVNClientManager.newInstance(factory);
        Field cm = NcSvnBridge.class.getDeclaredField("cm"); cm.setAccessible(true); cm.set(null, manager);
        dispatch = NcSvnBridge.class.getDeclaredMethod("dispatch", String.class, String[].class); dispatch.setAccessible(true);
        SVNURL url = SVNRepositoryFactory.createLocalRepository(new File(temporary, "repository"), true, false);
        File a = new File(temporary, "a"); File b = new File(temporary, "b");
        // out 的替换覆盖到测试结束：反射直调不经过 main()，out 初始为 null，
        // status/commit 都会写 progress，不接管会 NPE。声明在 try 外供 finally 恢复。
        Field out = NcSvnBridge.class.getDeclaredField("out"); out.setAccessible(true);
        java.io.PrintStream original = (java.io.PrintStream) out.get(null);
        try {
            manager.getUpdateClient().doCheckout(url, a, SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY, false);
            File text = new File(a, "A.java"); write(text, "first\nbase\n");
            manager.getWCClient().doAdd(text, false, false, false, SVNDepth.EMPTY, false, false);
            long r1 = manager.getCommitClient().doCommit(new File[]{text}, false, "add file", null, null, false, false, SVNDepth.EMPTY).getNewRevision();
            manager.getUpdateClient().doCheckout(url, b, SVNRevision.HEAD, SVNRevision.HEAD, SVNDepth.INFINITY, false);
            write(text, "first\nserver\n");
            org.tmatesoft.svn.core.SVNCommitInfo second = manager.getCommitClient()
                    .doCommit(new File[]{text}, false, "server change", null, null, false, false, SVNDepth.EMPTY);
            long r2 = second.getNewRevision();
            String cleanCommits = call("file_commits", a.getPath());
            check(cleanCommits.contains("A.java") && cleanCommits.contains("\"revision\":" + r2)
                    && cleanCommits.contains("\"author\":\"" + second.getAuthor() + "\""),
                    "clean files expose their last revision and committer: " + cleanCommits);
            File draft = new File(a, "Draft.java");
            write(draft, "uncommitted\n");
            check(!call("file_commits", a.getPath()).contains("Draft.java"), "unversioned file has no commit metadata");
            manager.getWCClient().doAdd(draft, false, false, false, SVNDepth.EMPTY, false, false);
            String pendingCommits = call("file_commits", a.getPath());
            check(pendingCommits.contains("Draft.java") && pendingCommits.contains("\"revision\":null"),
                    "scheduled addition is distinguished from unversioned files: " + pendingCommits);
            manager.getWCClient().doRevert(new File[]{draft}, SVNDepth.EMPTY, null);
            Files.delete(draft.toPath());
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
            check(call("file_commits", b.getPath()).contains("\"revision\":" + r1),
                    "modified file still uses local BASE, even if the repository has newer history");
            String remote = call("remote_status", b.getPath());
            check(remote.contains("\"revision\":" + r2) && remote.contains("\"baseRevision\":" + r1),
                    "remote preview reports working and repository revisions: " + remote);
            check(remote.contains("\"relativePath\":\"A.java\"") && remote.contains("\"repositoryPath\":\"/A.java\"")
                    && remote.contains("\"overlap\":true"), "preview identifies overlap on the real path: " + remote);
            String remoteDiff = call("revision_diff", b.getPath(), "/A.java", Long.toString(r2), Long.toString(r1));
            check(decodeField(remoteDiff, "before").equals("first\nbase\n") && decodeField(remoteDiff, "after").equals("first\nserver\n"),
                    "remote diff uses pinned base and target text");
            check(new String(Files.readAllBytes(local.toPath()), StandardCharsets.UTF_8).equals("first\nmy work\n"),
                    "remote preview does not change the working file");
            String update = call("update", b.getPath(), Long.toString(r2));
            check(update.contains("\"revision\":" + r2) && update.contains("\"modified\":1"),
                    "update reports the pinned result and changed count: " + update);
            check(call("file_commits", b.getPath()).contains("\"revision\":" + r2),
                    "working-copy update refreshes the visible commit metadata");
            String conflict = call("conflict_snapshot", local.getPath());
            check(conflict.contains("\"textConflict\":true") && conflict.contains("\"revision\":" + r1) && conflict.contains("\"revision\":" + r2), "actual base/theirs conflict revisions");
            check(conflict.contains(Base64.getEncoder().encodeToString("first\nmy work\n".getBytes(StandardCharsets.UTF_8))), "actual mine snapshot");
            boolean refused = false;
            try { call("resolve_working", local.getPath()); } catch (Exception error) { refused = error.getMessage().contains("冲突标记"); }
            check(refused, "unresolved markers cannot be accepted");
            write(local, "first\nmanual merged\n"); call("resolve_working", local.getPath());
            check(new String(Files.readAllBytes(local.toPath()), StandardCharsets.UTF_8).equals("first\nmanual merged\n"), "MERGED keeps saved working content");
            check(call("conflict_snapshot", local.getPath()).contains("\"textConflict\":false"), "text conflict cleared");
            String currentRemote = call("remote_status", b.getPath());
            check(currentRemote.contains("\"total\":0") && currentRemote.contains("\"revision\":" + r2),
                    "a local-only edit is not counted as an incoming change: " + currentRemote);
            manager.getWCClient().doRevert(new File[]{text}, SVNDepth.EMPTY, null);
            manager.getWCClient().doDelete(text, false, false, false);
            long r3 = manager.getCommitClient().doCommit(new File[]{text}, false, "delete file", null, null, false, false, SVNDepth.EMPTY).getNewRevision();
            String deleted = call("revision_diff", a.getPath(), "/A.java", Long.toString(r3));
            check(deleted.contains("\"afterEmpty\":true") && decodeField(deleted, "before").equals("first\nserver\n"), "deleted revision content");
            String incomingDelete = call("remote_status", b.getPath());
            check(incomingDelete.contains("\"kind\":\"deleted\"") && incomingDelete.contains("\"relativePath\":\"A.java\""),
                    "remote preview exposes deletions: " + incomingDelete);
            boolean traversal = false;
            try { call("revision_diff", a.getPath(), "/../A.java", Long.toString(r1)); } catch (Exception error) { traversal = true; }
            check(traversal, "repository path traversal rejected");
            // 流式上屏：status 每扫完一个单元推一条带该单元条目的 progress，
            // 且与最终结果同源（同一条目、同一字段）。把 out 换到缓冲里接住这些行。
            File fresh = new File(a, "Stream.java"); write(fresh, "streaming\n");
            java.io.ByteArrayOutputStream captured = new java.io.ByteArrayOutputStream();
            out.set(null, new java.io.PrintStream(captured, true, "UTF-8"));
            String statusResult;
            java.lang.reflect.Method status = NcSvnBridge.class
                    .getDeclaredMethod("status", String.class, File.class, String.class);
            status.setAccessible(true);
            statusResult = (String) status.invoke(null, "t", a, "");
            String streamed = captured.toString("UTF-8");
            check(statusResult.contains("\"entries\":["), "status 最终结果带 entries: " + statusResult);
            check(statusResult.contains("\"status\":\"unversioned\"") && statusResult.contains("\"revision\":-1"),
                    "最终结果的条目带状态与版本: " + statusResult);
            int unitLines = 0;
            for (String line : streamed.split("\n")) {
                if (line.isEmpty()) continue;
                check(line.startsWith("{\"id\":\"t\",\"progress\":{") && line.endsWith("}}"),
                        "每个单元的 progress 行都是完整 JSON: " + line);
                if (line.contains("\"entries\":[")) unitLines++;
            }
            check(unitLines >= 1, "至少一个单元推了条目: " + streamed);
            check(streamed.contains("\"module\":\"\""), "根层单元的 module 是空串: " + streamed);
            check(streamed.contains("\"entries\":[{\"path\":") && streamed.contains("\"status\":\"unversioned\"")
                    && streamed.contains("\"revision\":-1") && streamed.contains("\"dir\":false"),
                    "单元条目带 path/status/revision/dir: " + streamed);
            check(streamed.contains("Stream.java") && statusResult.contains("Stream.java"),
                    "单元条目与最终结果指向同一批文件");
            // 1.7+ 新格式回归：SVNKit 1.10.11 的 checkout 造的就是 wc.db 式副本。
            // 旧 status API 在这种副本上把 unversioned 报成 none，曾让改动列表整个为空、
            // 让 commit 预检的「未纳管自动 add」分支失效（E200009）。这两条钉死 wc2 路径。
            check(new File(a, ".svn/wc.db").isFile(), "契约副本是 1.7+ 新格式（wc.db），否则下面的回归没有意义");
            // 走生产 commit 命令：unversioned 新文件必须被自动 add 并提交成功
            File viaBridge = new File(a, "ViaBridge.java"); write(viaBridge, "via bridge\n");
            File msg = new File(temporary, "commit-msg.txt"); write(msg, "contract: bridge commit auto-add");
            String committed = call("commit", msg.getPath(), viaBridge.getPath());
            check(committed.contains("\"revision\":") && committed.contains("ViaBridge.java"),
                    "新格式副本上桥 commit 自动 add unversioned 文件: " + committed);
            String pinned = call("update", b.getPath(), Long.toString(r3));
            check(pinned.contains("\"revision\":" + r3) && !new File(b,"ViaBridge.java").exists(),
                    "a newer repository commit does not silently change the reviewed update target: " + pinned);
            String incomingAdd = call("remote_status", b.getPath());
            check(incomingAdd.contains("\"kind\":\"added\"") && incomingAdd.contains("\"repositoryPath\":\"/ViaBridge.java\""),
                    "remote preview exposes new paths with their repository location: " + incomingAdd);
            File newer = new File(b, "ViaBridge.java");
            long newerRevision = manager.getUpdateClient().doUpdate(newer, SVNRevision.HEAD, SVNDepth.EMPTY, false, false);
            check(newer.isFile() && newerRevision > r3
                    && manager.getWCClient().doInfo(b, SVNRevision.WORKING).getRevision().getNumber() == r3,
                    "an external file-only update leaves the root at the previously reviewed revision");
            boolean rejectedOlder = false;
            try { call("update", b.getPath(), Long.toString(r3)); }
            catch (Exception error) { rejectedOlder = error.getMessage().contains("更高版本"); }
            check(rejectedOlder && newer.isFile(), "a reviewed update must never roll back a newer working-copy path");
            // 提交后再改一次，status 必须报 modified（旧 API 在新格式上报 normal 被滤掉）
            write(viaBridge, "via bridge modified\n");
            String afterCommit = call("status", a.getPath(), "");
            check(afterCommit.contains("\"status\":\"modified\"") && afterCommit.contains("ViaBridge.java"),
                    "新格式副本上 modified 不被误报成 normal: " + afterCommit);
            System.out.println("SVN history contract passed: " + checks + " checks");
        } finally { manager.dispose(); cm.set(null, null); out.set(null, original); }
    }
}
