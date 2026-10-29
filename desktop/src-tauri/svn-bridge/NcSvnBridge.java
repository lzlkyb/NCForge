import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.List;

import org.tmatesoft.svn.core.SVNDepth;
import org.tmatesoft.svn.core.SVNException;
import org.tmatesoft.svn.core.SVNLogEntry;
import org.tmatesoft.svn.core.wc.ISVNAnnotateHandler;
import org.tmatesoft.svn.core.wc.ISVNInfoHandler;
import org.tmatesoft.svn.core.ISVNLogEntryHandler;
import org.tmatesoft.svn.core.wc.ISVNStatusHandler;
import org.tmatesoft.svn.core.wc.SVNRevision;
import org.tmatesoft.svn.core.wc.SVNClientManager;
import org.tmatesoft.svn.core.wc.SVNConflictChoice;
import org.tmatesoft.svn.core.wc.SVNInfo;
import org.tmatesoft.svn.core.wc.SVNStatus;
import org.tmatesoft.svn.core.wc.SVNStatusType;
import org.tmatesoft.svn.core.wc.SVNWCUtil;
import org.tmatesoft.svn.core.internal.io.dav.DAVRepositoryFactory;
import org.tmatesoft.svn.core.internal.io.fs.FSRepositoryFactory;
import org.tmatesoft.svn.core.internal.io.svn.SVNRepositoryFactoryImpl;

/**
 * NCForge 的 SVN 桥（SVNKit 1.3.5）。
 *
 * <p>为什么是 1.3.5：工作副本是 format 10（SVN 1.6 的「每目录一份 .svn」），
 * 命令行 svn 1.7+ 与 SVNKit 1.8+ 都已不支持，只会要求 upgrade —— 而 upgrade 不可逆，
 * 升完 Eclipse 与同事都打不开。所以这里刻意用老版本，且**任何操作都不升级工作副本格式**。
 *
 * <p>协议：stdin 每行一条请求，TAB 分隔；stdout 每行一条 JSON 响应。
 * 请求里出现的 \ 与 TAB、换行由调用方转义成 \\ \t \n（Rust 侧统一处理）。
 * <pre>
 *   1	hello
 *   2	auth	lzl	密码
 *   3	status	C:\work\aier\newar
 *   4	diff	C:\work\aier\newar\pu\src\A.java
 *   5	log	C:\work\aier\newar\pu	30	-1
 *   6	blame	C:\work\aier\newar\pu\src\A.java
 *   7	commit	C:\Temp\msg.txt	C:\work\aier\newar\pu\src\A.java
 *   8	update	C:\work\aier\newar
 *   9	revert	1	C:\work\aier\newar\pu\src\A.java
 *   10	resolve	mine	C:\work\aier\newar\pu\src\A.java
 *   11	info	C:\work\aier\newar
 *   12	quit
 * </pre>
 * 响应：{"id":3,"ok":true,"data":{...}} / {"id":3,"ok":false,"error":"...","code":"auth"}，
 * 长任务在最终响应前会有若干 {"id":3,"progress":{"scanned":1200}}。
 */
public class NcSvnBridge {

	// 协议出口：固定 UTF-8，且与可能存在的第三方打印彻底分开（System.out 一律改道 stderr）
	private static PrintStream out;
	private static SVNClientManager cm;
	private static String user = "";
	private static String pass = "";
	/** 自己的配置目录（凭据缓存、config）。不传就退回用户全局目录 —— 但那样会**改写**用户的
	 *  %APPDATA%\Subversionuth 缓存（实测会把已存的密码顺手清成只有用户名），
	 *  所以宿主必须传 --config，指到应用自己的目录。 */
	private static File configDir = null;

	public static void main(String[] args) throws Exception {
		for (int i = 0; i + 1 < args.length; i++) {
			if ("--config".equals(args[i])) {
				configDir = new File(args[i + 1]);
			}
		}
		out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
		System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.err), true, "UTF-8"));

		DAVRepositoryFactory.setup();
		SVNRepositoryFactoryImpl.setup();
		FSRepositoryFactory.setup();

		BufferedReader in = new BufferedReader(new InputStreamReader(new FileInputStream(FileDescriptor.in), "UTF-8"));
		String line;
		while ((line = in.readLine()) != null) {
			if (line.isEmpty()) {
				continue;
			}
			String[] raw = line.split("\t", -1);
			String[] f = new String[raw.length];
			for (int i = 0; i < raw.length; i++) {
				f[i] = unescape(raw[i]);
			}
			String id = f[0];
			String cmd = f.length > 1 ? f[1] : "";
			try {
				String data = dispatch(cmd, f);
				if ("quit".equals(cmd)) {
					respond(id, data);
					break;
				}
				respond(id, data);
			} catch (Throwable t) {
				error(id, t);
			}
		}
		dispose();
		System.exit(0);
	}

	private static String dispatch(String cmd, String[] f) throws Exception {
		if ("hello".equals(cmd)) {
			return "{\"protocol\":1,\"svnkit\":\"1.3.5\"}";
		}
		if ("quit".equals(cmd)) {
			return "{}";
		}
		if ("auth".equals(cmd)) {
			user = f.length > 2 ? f[2] : "";
			pass = f.length > 3 ? f[3] : "";
			dispose();
			manager();
			return "{\"user\":" + jstr(user) + "}";
		}
		if ("info".equals(cmd)) {
			return info(new File(f[2]));
		}
		if ("status".equals(cmd)) {
			return status(f[0], new File(f[2]));
		}
		if ("diff".equals(cmd)) {
			return baseContent(new File(f[2]));
		}
		if ("log".equals(cmd)) {
			return log(new File(f[2]), Integer.parseInt(f[3]), Long.parseLong(f[4]));
		}
		if ("blame".equals(cmd)) {
			return blame(new File(f[2]));
		}
		if ("commit".equals(cmd)) {
			return commit(new File(f[2]), tail(f, 3));
		}
		if ("update".equals(cmd)) {
			return update(new File(f[2]));
		}
		if ("revert".equals(cmd)) {
			return revert("1".equals(f[2]), tail(f, 3));
		}
		if ("resolve".equals(cmd)) {
			return resolve(f[2], new File(f[3]));
		}
		throw new IllegalArgumentException("未知命令: " + cmd);
	}

	// ───────────────────────── 命令实现 ─────────────────────────

	private static String info(final File path) throws SVNException {
		final List<String> out1 = new ArrayList<String>();
		manager().getWCClient().doInfo(path, SVNRevision.WORKING, SVNRevision.WORKING, SVNDepth.EMPTY, null,
				new ISVNInfoHandler() {
					public void handleInfo(SVNInfo info) {
						out1.add("{\"path\":" + jstr(info.getFile().getPath())
								+ ",\"url\":" + jstr(info.getURL() == null ? "" : info.getURL().toString())
								+ ",\"root\":" + jstr(info.getRepositoryRootURL() == null ? "" : info.getRepositoryRootURL().toString())
								+ ",\"revision\":" + (info.getRevision() == null ? -1 : info.getRevision().getNumber())
								+ ",\"kind\":" + jstr(info.getKind() == null ? "" : info.getKind().toString()) + "}");
					}
				});
		if (out1.isEmpty()) {
			throw new SVNException(org.tmatesoft.svn.core.SVNErrorMessage.create(
					org.tmatesoft.svn.core.SVNErrorCode.UNVERSIONED_RESOURCE, "不在版本控制下: " + path));
		}
		return out1.get(0);
	}

	private static String status(final String id, File root) throws SVNException {
		final List<String> items = new ArrayList<String>();
		final int[] n = new int[1];
		// reportAll=false：只回改动与未纳管。全量 12757 条目报全部要 61 秒，只报改动 7.6 秒——
		// 界面要的就是「改动」，normal 条目一条都用不上。
		manager().getStatusClient().doStatus(root, SVNRevision.WORKING, SVNDepth.INFINITY, false, false, false, false,
				new ISVNStatusHandler() {
					public void handleStatus(SVNStatus s) {
						n[0]++;
						if (n[0] % 300 == 0) {
							progress(id, n[0]);
						}
						SVNStatusType st = s.getContentsStatus();
						String name = st == null ? "none" : st.toString();
						if ("normal".equals(name) || "none".equals(name)) {
							return;
						}
						items.add("{\"path\":" + jstr(s.getFile().getPath())
								+ ",\"status\":" + jstr(name)
								+ ",\"revision\":" + (s.getRevision() == null || s.getRevision().getNumber() < 0 ? -1
										: s.getRevision().getNumber())
								+ ",\"dir\":" + (s.getFile().isDirectory() ? "true" : "false") + "}");
					}
				}, null);
		return "{\"scanned\":" + n[0] + ",\"entries\":[" + join(items) + "]}";
	}

	private static String baseContent(File path) throws Exception {
		ByteArrayOutputStream bos = new ByteArrayOutputStream();
		try {
			manager().getWCClient().doGetFileContents(path, SVNRevision.BASE, SVNRevision.BASE, false, bos);
		} catch (SVNException e) {
			// 新增文件（还没 add 或已 add 未提交）没有 BASE 版本，正文按空处理
			if (e.getErrorMessage() != null && e.getErrorMessage().getErrorCode() ==
					org.tmatesoft.svn.core.SVNErrorCode.UNVERSIONED_RESOURCE) {
				return "{\"base\":\"\",\"size\":0,\"empty\":true}";
			}
			throw e;
		}
		byte[] b = bos.toByteArray();
		return "{\"base\":" + jstr(Base64.getEncoder().encodeToString(b)) + ",\"size\":" + b.length + ",\"empty\":false}";
	}

	private static String log(File path, int limit, long from) throws SVNException {
		final List<String> items = new ArrayList<String>();
		final int[] n = new int[1];
		final int cap = limit <= 0 ? 30 : limit;
		SVNRevision start = from > 0 ? SVNRevision.create(from) : SVNRevision.HEAD;
		// 必须走 URL 版：SVNKit 1.3 的 File 版 doLog 在这种「工作副本混版本」的目录上会静默返回 0 条
		// （实测：同一路径 URL 版能拿到 5 条，File 版 0 条）。URL 由 info 从工作副本反查得到。
		SVNInfo wcInfo = manager().getWCClient().doInfo(path, SVNRevision.WORKING);
		org.tmatesoft.svn.core.SVNURL url = wcInfo.getURL();
		manager().getLogClient().doLog(url, null, SVNRevision.HEAD, start, SVNRevision.create(1), true, false,
				false, cap, null, new ISVNLogEntryHandler() {
					public void handleLogEntry(SVNLogEntry e) {
						n[0]++;
						items.add("{\"revision\":" + e.getRevision()
								+ ",\"author\":" + jstr(e.getAuthor() == null ? "" : e.getAuthor())
								+ ",\"date\":" + (e.getDate() == null ? 0 : e.getDate().getTime())
								+ ",\"message\":" + jstr(e.getMessage() == null ? "" : e.getMessage()) + "}");
					}
				});
		return "{\"entries\":[" + join(items) + "]}";
	}

	private static String blame(File path) throws SVNException {
		final List<String> items = new ArrayList<String>();
		manager().getLogClient().doAnnotate(path, SVNRevision.HEAD, SVNRevision.create(1), SVNRevision.HEAD,
				new ISVNAnnotateHandler() {
					public void handleLine(Date date, long revision, String author, String line) {
						items.add("{\"revision\":" + revision + ",\"author\":" + jstr(author == null ? "" : author)
								+ ",\"date\":" + (date == null ? 0 : date.getTime()) + "}");
					}

					public void handleLine(Date date, long revision, String author, String line, Date mergedDate,
							long mergedRevision, String mergedAuthor, String mergedPath, int lineNumber) {
						handleLine(date, revision, author, line);
					}

					public boolean handleRevision(Date date, long revision, String author, File contents) {
						return true;
					}

					public void handleEOF() {
					}
				});
		return "{\"lines\":[" + join(items) + "]}";
	}

	private static String commit(File msgFile, String[] paths) throws Exception {
		String msg = new String(java.nio.file.Files.readAllBytes(msgFile.toPath()), "UTF-8").trim();
		if (msg.isEmpty()) {
			throw new IllegalArgumentException("提交说明为空");
		}
		// 先整体查一遍冲突，再做任何写动作。以前冲突检查混在「逐文件 doAdd」的循环里：
		// 第 3 个文件有冲突时，前两个已经被 add 成 scheduled 状态——提交失败了，工作副本
		// 却被改了，用户下次提交会莫名带上它们。冲突是可以在动手之前就知道的。
		java.util.Map<String, SVNStatus> statuses = new java.util.HashMap<String, SVNStatus>();
		for (String p : paths) {
			SVNStatus st = manager().getStatusClient().doStatus(new File(p), false);
			statuses.put(p, st);
			if (st != null && st.getContentsStatus() == SVNStatusType.STATUS_CONFLICTED) {
				throw new IllegalStateException("文件仍有冲突，不能提交: " + p);
			}
		}
		List<String> added = new ArrayList<String>();
		List<File> targets = new ArrayList<File>();
		// 新文件所在目录若未纳管（没有 .svn），从上往下逐级 add 目录本身（不递归，不带目录里的其它文件）
		for (String p : paths) {
			File f = new File(p);
			List<File> newDirs = new ArrayList<File>();
			for (File d = f.getAbsoluteFile().getParentFile(); d != null && !new File(d, ".svn").isDirectory();
					d = d.getParentFile()) {
				newDirs.add(0, d);
			}
			for (File d : newDirs) {
				if (!targets.contains(d)) {
					manager().getWCClient().doAdd(d, false, false, false, SVNDepth.EMPTY, false, false);
					targets.add(d);
					added.add(d.getPath() + " (目录)");
				}
			}
		}
		for (String p : paths) {
			File f = new File(p);
			SVNStatus st = statuses.get(p);
			if (st == null || st.getContentsStatus() == SVNStatusType.STATUS_UNVERSIONED) {
				manager().getWCClient().doAdd(f, false, false, true, SVNDepth.EMPTY, false, false);
				added.add(f.getPath());
			}
			targets.add(f);
		}
		org.tmatesoft.svn.core.SVNCommitInfo info = manager().getCommitClient()
				.doCommit(targets.toArray(new File[0]), false, msg, null, null, false, false, SVNDepth.EMPTY);
		if (info.getErrorMessage() != null) {
			throw new SVNException(info.getErrorMessage());
		}
		return "{\"revision\":" + info.getNewRevision() + ",\"author\":"
				+ jstr(info.getAuthor() == null ? "" : info.getAuthor())
				+ ",\"added\":[" + join(quoteAll(added)) + "]}";
	}

	private static String update(File root) throws SVNException {
		long rev = manager().getUpdateClient().doUpdate(root, SVNRevision.HEAD, SVNDepth.INFINITY, false, false);
		return "{\"revision\":" + rev + "}";
	}

	private static String revert(boolean recursive, String[] paths) throws SVNException {
		File[] fs = new File[paths.length];
		for (int i = 0; i < paths.length; i++) {
			fs[i] = new File(paths[i]);
		}
		manager().getWCClient().doRevert(fs, recursive ? SVNDepth.INFINITY : SVNDepth.EMPTY, null);
		return "{\"count\":" + fs.length + "}";
	}

	private static String resolve(String choice, File path) throws SVNException {
		SVNConflictChoice c;
		if ("mine".equals(choice)) {
			c = SVNConflictChoice.MINE_FULL;
		} else if ("theirs".equals(choice)) {
			c = SVNConflictChoice.THEIRS_FULL;
		} else if ("base".equals(choice)) {
			c = SVNConflictChoice.BASE;
		} else {
			throw new IllegalArgumentException("未知的解决方式: " + choice);
		}
		// 注意：doResolve 会丢掉 .mine/.rN 临时文件，必须由用户先选定版本再调用（界面分两步）
		manager().getWCClient().doResolve(path, SVNDepth.EMPTY, c);
		return "{}";
	}

	// ───────────────────────── 基础设施 ─────────────────────────

	private static SVNClientManager manager() {
		if (cm == null) {
			org.tmatesoft.svn.core.wc.ISVNOptions options = configDir == null
					? SVNWCUtil.createDefaultOptions(true)
					: SVNWCUtil.createDefaultOptions(configDir, true);
			if (user.isEmpty()) {
				cm = SVNClientManager.newInstance(options, configDir == null
						? SVNWCUtil.createDefaultAuthenticationManager()
						: SVNWCUtil.createDefaultAuthenticationManager(configDir));
			} else {
				cm = SVNClientManager.newInstance(options, configDir == null
						? SVNWCUtil.createDefaultAuthenticationManager(user, pass)
						: SVNWCUtil.createDefaultAuthenticationManager(configDir, user, pass));
			}
		}
		return cm;
	}

	private static void dispose() {
		if (cm != null) {
			cm.dispose();
			cm = null;
		}
	}

	private static void respond(String id, String data) throws Exception {
		Writer w = new OutputStreamWriter(out, "UTF-8");
		w.write("{\"id\":" + jstr(id) + ",\"ok\":true,\"data\":" + data + "}\n");
		w.flush();
	}

	private static void progress(String id, int scanned) {
		out.print("{\"id\":" + jstr(id) + ",\"progress\":{\"scanned\":" + scanned + "}}\n");
		out.flush();
	}

	private static void error(String id, Throwable t) {
		String code = "other";
		String msg = t.getMessage() == null ? t.toString() : t.getMessage();
		if (t instanceof SVNException) {
			org.tmatesoft.svn.core.SVNErrorMessage em = ((SVNException) t).getErrorMessage();
			if (em != null) {
				msg = em.getFullMessage();
				org.tmatesoft.svn.core.SVNErrorCode ec = em.getErrorCode();
				if (ec == org.tmatesoft.svn.core.SVNErrorCode.RA_NOT_AUTHORIZED
						|| ec == org.tmatesoft.svn.core.SVNErrorCode.AUTHN_CREDS_UNAVAILABLE
						|| msg.toLowerCase().contains("authentication")
						|| msg.toLowerCase().contains("not authorized")) {
					code = "auth";
				} else if (ec == org.tmatesoft.svn.core.SVNErrorCode.UNVERSIONED_RESOURCE
						|| msg.toLowerCase().contains("not a working copy")) {
					code = "wc";
				} else if (ec == org.tmatesoft.svn.core.SVNErrorCode.WC_FOUND_CONFLICT
						|| msg.toLowerCase().contains("conflict")) {
					code = "conflict";
				}
			}
		} else if (msg.contains("冲突")) {
			code = "conflict";
		}
		out.print("{\"id\":" + jstr(id) + ",\"ok\":false,\"error\":" + jstr(msg) + ",\"code\":" + jstr(code) + "}\n");
		out.flush();
	}

	private static String[] tail(String[] f, int from) {
		List<String> list = new ArrayList<String>();
		for (int i = from; i < f.length; i++) {
			if (!f[i].isEmpty()) {
				list.add(f[i]);
			}
		}
		return list.toArray(new String[0]);
	}

	private static String join(List<String> items) {
		StringBuilder sb = new StringBuilder();
		for (int i = 0; i < items.size(); i++) {
			if (i > 0) {
				sb.append(',');
			}
			sb.append(items.get(i));
		}
		return sb.toString();
	}

	private static List<String> quoteAll(List<String> raw) {
		List<String> list = new ArrayList<String>();
		for (String s : raw) {
			list.add(jstr(s));
		}
		return list;
	}

	/** 反转义调用方写入的 \ 	 
（Rust 侧统一转义，避免路径里的特殊字符把协议切坏）。 */
	private static String unescape(String s) {
		StringBuilder sb = new StringBuilder(s.length());
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			if (c == '\\' && i + 1 < s.length()) {
				char n = s.charAt(++i);
				if (n == 't') {
					sb.append('\t');
				} else if (n == 'n') {
					sb.append('\n');
				} else if (n == 'r') {
					sb.append('\r');
				} else {
					sb.append(n);
				}
			} else {
				sb.append(c);
			}
		}
		return sb.toString();
	}

	/** 最小 JSON 字符串转义（路径与提交说明里的反斜杠、引号、换行都要处理）。 */
	private static String jstr(String s) {
		if (s == null) {
			return "null";
		}
		StringBuilder sb = new StringBuilder(s.length() + 8);
		sb.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
			case '"':
				sb.append("\\\"");
				break;
			case '\\':
				sb.append("\\\\");
				break;
			case '\n':
				sb.append("\\n");
				break;
			case '\r':
				sb.append("\\r");
				break;
			case '\t':
				sb.append("\\t");
				break;
			default:
				if (c < 0x20) {
					sb.append(String.format("\\u%04x", (int) c));
				} else {
					sb.append(c);
				}
			}
		}
		sb.append('"');
		return sb.toString();
	}
}
