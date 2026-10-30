import java.io.BufferedReader;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.Reader;
import java.lang.reflect.Constructor;
import java.math.BigDecimal;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * NCForge 的数据库桥（JDBC，驱动用 NC home 自带的 ojdbc6.jar）。
 *
 * <p><b>一个桥进程管多条连接</b>：每条连接是一个 {@link Session}，各有自己的 JDBC Connection、
 * 结果游标、事务计数，以及一个专属工作线程。这样做的原因是内存——JVM 本身的底价
 * （JRE + 驱动类 + 元数据）约 50~70MB，而每多一条连接只多几 MB；一连接一进程会让
 * 「开四个库看数据」变成 250MB 常驻。
 *
 * <p>为什么每个会话要有自己的工作线程：慢查询必须只堵住它自己那条连接。主线程只管读
 * stdin 和投递任务，任何命令都不在它身上执行，于是 A 库的报表跑十分钟也不会影响 B 库。
 *
 * <p><b>取消</b>：{@code cancel} 命令不走会话队列，直接在主线程调
 * {@code Statement.cancel()}——两者必须能并发，否则「停止」会排在正在跑的查询后面。
 * 被取消的语句自己会回 ORA-01013，作为它原本那个请求的错误返回。
 *
 * <p><b>读写不在这里限制</b>：能不能写由数据库账号的权限决定。这里只负责把事务状态
 * 讲清楚——手动提交模式下记下「几条写语句、影响多少行、从什么时候开始」，
 * 每次执行都回给界面，界面据此显示事务条、在关标签/断开前提醒。
 *
 * <p>prop.xml 的口令用 NC 自带的 {@code nc.bs.framework.datatool.PropXMLReader} 解
 * （classpath 里要有 NC home 的 external/lib/basic.jar 与 lib/fwcheck.jar）。
 * 解出的口令只在本进程内存里用于连库，不回传、不落盘。
 *
 * <p>协议与 NcSvnBridge 一致：stdin 每行一条请求，TAB 分隔；stdout 每行一条 JSON。
 * <pre>
 *   1\thello\t-                      （无会话命令：会话名写 -）
 *   2\tpropList\t-\tD:\ncc\1909home
 *   3\tconn-1\tconnectProp\tD:\ncc\1909home\tdesign\tfalse
 *   4\tconn-1\texec\tselect * from bd_material\t500\t30
 *   5\tconn-1\tmore\t500
 *   6\tconn-1\tcommit / rollback / autocommit\ttrue
 *   7\tconn-1\ttables / ncNames / columns\tbd_material / indexes\tbd_material / ddl\tbd_material
 *   8\tconn-1\texplain\tselect …
 *   9\tconn-1\tschema\t0\t200 / ping / disconnect
 *  10\tconn-1\tcancel                  （主线程直接处理，不等队列）
 *  11\tquit\t-
 * </pre>
 * 响应：{"id":"3","ok":true,"data":{...}} / {"id":"3","ok":false,"error":"...","code":"sql"}
 *
 * <p>兼容旧的三段格式 `id \t cmd \t 参数…`（会话名固定 "-"）：手工用管道调试时方便，
 * 判断依据是第二段是不是已知命令名。
 */
public class NcDbBridge {

    private static final Pattern PLSQL = Pattern.compile(
            "^\\s*(begin|declare|call|exec|execute)\\b");
    private static final Pattern DDL = Pattern.compile(
            "^\\s*(create|alter|drop|truncate|rename|comment|grant|revoke)\\b");
    private static final Pattern WRITES = Pattern.compile(
            "^\\s*(insert|update|delete|merge|replace)\\b");
    private static final Pattern FOR_UPDATE = Pattern.compile("\\bfor\\s+update\\b");

    private static final int CLOB_MAX = 1024 * 1024;

    /** stdout 只留给协议。多个会话线程都会往这里写，PrintStream 的 println 是原子的。 */
    private static PrintStream out;

    /** 无会话命令（hello / propList / propCred / quit）的会话名占位。 */
    private static final String NO_SESSION = "-";

    /** 活着的会话。主线程负责增删，工作线程只读自己的那一条。 */
    private static final Map<String, Session> SESSIONS = new ConcurrentHashMap<String, Session>();

    /** 已知命令名：用来区分「新格式的第二段是会话名」还是「旧格式的第二段就是命令」。 */
    private static final Set<String> CMDS = new HashSet<String>(Arrays.asList(
            "hello", "propList", "propCred", "connect", "connectProp", "exec", "more", "commit",
            "rollback", "autocommit", "tables", "ncNames", "columns", "indexes", "ddl",
            "explain", "schema", "ping", "disconnect", "quit", "cancel"));

    public static void main(String[] args) throws Exception {
        // stdout 只留给协议；第三方库的 System.out 一律改道 stderr，否则一行日志就把 JSON 流冲乱
        out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.err), true, "UTF-8"));

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) {
                continue;
            }
            String[] parts = line.split("\t", -1);
            String id = parts[0];
            String sess;
            String cmd;
            int start;
            if (parts.length > 1 && !CMDS.contains(unescape(parts[1]))) {
                // 新格式：id \t 会话名 \t 命令 \t 参数…
                sess = unescape(parts[1]);
                cmd = parts.length > 2 ? unescape(parts[2]) : "";
                start = 3;
            } else {
                // 旧格式（手工调试）：id \t 命令 \t 参数…
                sess = NO_SESSION;
                cmd = parts.length > 1 ? unescape(parts[1]) : "";
                start = 2;
            }
            List<String> a = new ArrayList<String>();
            for (int i = start; i < parts.length; i++) {
                a.add(unescape(parts[i]));
            }
            try {
                route(id, sess, cmd, a);
            } catch (Throwable e) {
                Throwable c = e.getCause() != null ? e.getCause() : e;
                err(id, "other", c.getClass().getSimpleName() + ": " + c.getMessage());
            }
            if ("quit".equals(cmd)) {
                break;
            }
        }
        // 退出：把所有会话的未提交事务回滚掉再放人
        shutdownAll();
    }

    /**
     * 主线程只做路由，不做任何可能阻塞的活。
     *
     * <p>三个例外说明一下：{@code cancel} 必须在这里做（要能插进正在执行的语句后面），
     * {@code hello}/{@code propList} 不碰数据库所以随手做掉，{@code connect} 要先建会话
     * 对象（真正的握手仍然在会话线程里跑）。
     */
    private static void route(String id, String sess, String cmd, List<String> a) throws Exception {
        if ("quit".equals(cmd)) {
            ok(id, "{}");
            return;
        }
        if ("hello".equals(cmd)) {
            ok(id, "{\"version\":\"3\",\"java\":\"" + esc(System.getProperty("java.version"))
                    + "\",\"sessions\":" + SESSIONS.size() + "}");
            return;
        }
        if ("propList".equals(cmd)) {
            ok(id, propList(a.get(0)));
            return;
        }
        if ("propCred".equals(cmd)) {
            ok(id, propCred(a.get(0), a.get(1)));
            return;
        }
        if ("cancel".equals(cmd)) {
            // 不走队列：这条命令存在的意义就是绕过正在执行的那条语句
            boolean hit = cancel(sess);
            ok(id, "{\"cancelled\":" + hit + "}");
            return;
        }
        if ("connect".equals(cmd) || "connectProp".equals(cmd)) {
            Session old = SESSIONS.remove(sess);
            if (old != null) {
                old.close();
            }
            Session s = new Session(sess);
            SESSIONS.put(sess, s);
            s.submit(id, cmd, a);
            return;
        }
        Session s = SESSIONS.get(sess);
        if (s == null) {
            err(id, "other", "会话不存在或已断开（" + sess + "）");
            return;
        }
        if ("disconnect".equals(cmd)) {
            // 从表里摘掉后，后续命令会得到「会话不存在」；会话线程自己回响应再退出
            SESSIONS.remove(sess);
        }
        s.submit(id, cmd, a);
    }

    /** 取消指定会话上正在执行的语句。返回是否真的找到了在跑的语句。 */
    private static boolean cancel(String sess) {
        Session s = SESSIONS.get(sess);
        if (s == null) {
            return false;
        }
        Statement st = s.running;
        if (st == null) {
            return false;
        }
        try {
            st.cancel();
            return true;
        } catch (SQLException e) {
            // 语句刚好执行完了很正常，不算错
            return false;
        }
    }

    private static void shutdownAll() {
        for (Session s : SESSIONS.values()) {
            s.close();
        }
        SESSIONS.clear();
    }

    // ───────────────────────── 会话 ─────────────────────────

    /** 一条连接的全套状态。字段只在它自己的工作线程里读写（`running` 除外）。 */
    private static final class Session {
        final String name;
        final LinkedBlockingQueue<Job> queue = new LinkedBlockingQueue<Job>();
        final Thread worker;

        Connection conn;
        /** 正在执行的那条语句，供 cancel 从别的线程调。 */
        volatile Statement running;

        /** 上一次 exec 留下的游标：结果超过行上限时保留，供「加载更多」接着取。 */
        Statement cursorStmt;
        ResultSet cursor;
        int cursorCols;

        /** 手动提交模式下的未提交事务：写语句条数、影响行数、开始时刻。 */
        int txStatements;
        long txRows;
        long txSince;

        volatile boolean closed;

        Session(final String name) {
            this.name = name;
            this.worker = new Thread(new Runnable() {
                public void run() {
                    loop();
                }
            }, "ncdb-" + name);
            this.worker.setDaemon(true);
            this.worker.start();
        }

        void submit(String id, String cmd, List<String> args) {
            queue.add(new Job(id, cmd, args));
        }

        /** 停止受理新命令，并让正在跑的那条语句停下来。 */
        void close() {
            closed = true;
            queue.clear();
            queue.add(new Job("0", null, new ArrayList<String>()));
            Statement st = running;
            if (st != null) {
                try {
                    st.cancel();
                } catch (SQLException ignore) {
                    // 已经跑完了
                }
            }
        }

        private void loop() {
            try {
                while (true) {
                    Job j = queue.take();
                    if (j.cmd == null) {
                        break; // poison pill
                    }
                    try {
                        dispatch(j.id, j.cmd, j.args);
                    } catch (SQLException e) {
                        err(j.id, "sql", sqlMessage(e));
                    } catch (Throwable e) {
                        Throwable c = e.getCause() != null ? e.getCause() : e;
                        err(j.id, "other", c.getClass().getSimpleName() + ": " + c.getMessage());
                    } finally {
                        running = null;
                    }
                    if (closed) {
                        break;
                    }
                }
            } catch (InterruptedException e) {
                // 退出
            } finally {
                closeQuietly();
            }
        }

        private void dispatch(String id, String cmd, List<String> a) throws Exception {
            if ("connect".equals(cmd)) {
                ok(id, connect(a.get(0), a.get(1), a.size() > 2 ? a.get(2) : "", flag(a, 3)));
            } else if ("connectProp".equals(cmd)) {
                Hashtable<?, ?> ds = readDataSource(a.get(0), a.get(1));
                String url = str(ds.get("databaseUrl"));
                if (url == null) {
                    throw new SQLException("prop.xml 里没有数据源 " + a.get(1));
                }
                ok(id, connect(url, str(ds.get("user")), str(ds.get("password")), flag(a, 2)));
            } else if ("exec".equals(cmd)) {
                ok(id, exec(a.get(0), intArg(a, 1, 500), intArg(a, 2, 30)));
            } else if ("more".equals(cmd)) {
                ok(id, more(intArg(a, 0, 500)));
            } else if ("commit".equals(cmd)) {
                requireConn();
                conn.commit();
                resetTx();
                ok(id, "{\"tx\":" + txJson() + "}");
            } else if ("rollback".equals(cmd)) {
                requireConn();
                conn.rollback();
                resetTx();
                ok(id, "{\"tx\":" + txJson() + "}");
            } else if ("autocommit".equals(cmd)) {
                requireConn();
                boolean on = flag(a, 0);
                // 切到自动提交时 JDBC 会把在途事务提交掉——界面在有未提交事务时不允许直接切
                conn.setAutoCommit(on);
                resetTx();
                ok(id, "{\"tx\":" + txJson() + "}");
            } else if ("tables".equals(cmd)) {
                ok(id, tables());
            } else if ("ncNames".equals(cmd)) {
                ok(id, ncNames());
            } else if ("columns".equals(cmd)) {
                ok(id, columns(a.get(0)));
            } else if ("indexes".equals(cmd)) {
                ok(id, indexes(a.get(0)));
            } else if ("ddl".equals(cmd)) {
                ok(id, ddl(a.get(0)));
            } else if ("explain".equals(cmd)) {
                ok(id, explain(a.get(0)));
            } else if ("schema".equals(cmd)) {
                ok(id, schema(Integer.parseInt(a.get(0)), Integer.parseInt(a.get(1))));
            } else if ("ping".equals(cmd)) {
                boolean alive = conn != null && !conn.isClosed();
                ok(id, "{\"alive\":" + alive + ",\"tx\":" + txJson() + "}");
            } else if ("disconnect".equals(cmd)) {
                closeQuietly();
                ok(id, "{}");
                closed = true;
            } else {
                err(id, "other", "未知命令：" + cmd);
            }
        }

        // ───────────────────── 连接与事务 ─────────────────────

        private String connect(String url, String user, String pass, boolean autoCommit) throws Exception {
            closeQuietly();
            // ojdbc6 没带 META-INF/services/java.sql.Driver，JDBC 4 的自动加载认不到它，必须显式注册
            try {
                Class.forName("oracle.jdbc.OracleDriver");
            } catch (ClassNotFoundException e) {
                throw new SQLException("找不到 Oracle 驱动（ojdbc6.jar）：检查 NC home 的 driver/oracle_11g 是否完整");
            }
            Properties p = new Properties();
            p.setProperty("user", user == null ? "" : user);
            p.setProperty("password", pass == null ? "" : pass);
            p.setProperty("oracle.net.CONNECT_TIMEOUT", "15000");
            DriverManager.setLoginTimeout(15);
            conn = DriverManager.getConnection(url, p);
            conn.setAutoCommit(autoCommit);
            resetTx();
            // DBMS_OUTPUT 默认关着：打开后 PL/SQL 里的 put_line 才能在「输出」标签里看到
            try {
                Statement st = conn.createStatement();
                st.execute("begin dbms_output.enable(1000000); end;");
                st.close();
            } catch (SQLException ignore) {
                // 没有权限也不影响连库
            }
            DatabaseMetaData md = conn.getMetaData();
            return "{\"url\":\"" + esc(url)
                    + "\",\"product\":\"" + esc(md.getDatabaseProductName())
                    + "\",\"version\":\"" + esc(md.getDatabaseProductVersion())
                    + "\",\"user\":\"" + esc(md.getUserName())
                    + "\",\"autoCommit\":" + conn.getAutoCommit() + "}";
        }

        private void resetTx() {
            txStatements = 0;
            txRows = 0;
            txSince = 0;
        }

        private String txJson() throws SQLException {
            boolean auto = conn == null || conn.isClosed() || conn.getAutoCommit();
            return "{\"autoCommit\":" + auto + ",\"statements\":" + txStatements
                    + ",\"rows\":" + txRows + ",\"since\":" + txSince + "}";
        }

        // ───────────────────── 执行 ─────────────────────

        private String exec(String raw, int maxRows, int timeout) throws Exception {
            requireConn();
            closeCursor();
            String sql = normalize(raw);
            String head = leadingKeywords(sql);
            if (sql.isEmpty()) {
                throw new SQLException("空语句");
            }
            long t0 = System.currentTimeMillis();
            Statement st = conn.createStatement();
            boolean keep = false;
            try {
                st.setQueryTimeout(timeout);
                running = st; // 让 cancel 能找到它
                boolean hasRs = st.execute(sql);
                String body;
                if (hasRs) {
                    ResultSet rs = st.getResultSet();
                    body = readRows(rs, maxRows);
                    keep = cursor == rs;
                    if (keep) {
                        cursorStmt = st;
                    }
                } else {
                    int uc = st.getUpdateCount();
                    body = "\"kind\":\"update\",\"updateCount\":" + uc;
                    trackTx(head, uc);
                }
                if (hasRs && FOR_UPDATE.matcher(stripLiterals(sql).toLowerCase()).find()) {
                    trackTx("lock", 0);
                }
                long ms = System.currentTimeMillis() - t0;
                return "{" + body + ",\"ms\":" + ms + ",\"output\":" + dbmsOutput() + ",\"tx\":" + txJson() + "}";
            } finally {
                running = null;
                if (!keep) {
                    try {
                        st.close();
                    } catch (SQLException ignore) {
                        // 忽略
                    }
                }
            }
        }

        private void trackTx(String head, int updateCount) throws SQLException {
            if (conn.getAutoCommit()) {
                return;
            }
            if (DDL.matcher(head).find()) {
                resetTx(); // Oracle 的 DDL 前后各隐式提交一次
                return;
            }
            if (WRITES.matcher(head).find()) {
                if (txStatements == 0) {
                    txSince = System.currentTimeMillis();
                }
                txStatements++;
                if (updateCount > 0) {
                    txRows += updateCount;
                }
            }
        }

        private String readRows(ResultSet rs, int maxRows) throws SQLException {
            ResultSetMetaData md = rs.getMetaData();
            int n = md.getColumnCount();
            StringBuilder cols = new StringBuilder("[");
            for (int i = 1; i <= n; i++) {
                if (i > 1) {
                    cols.append(',');
                }
                cols.append("{\"name\":\"").append(esc(md.getColumnLabel(i)))
                        .append("\",\"type\":\"").append(esc(typeName(md, i)))
                        .append("\",\"precision\":").append(safeInt(md.getPrecision(i)))
                        .append(",\"scale\":").append(safeInt(md.getScale(i)))
                        .append('}');
            }
            cols.append(']');
            cursor = rs;
            cursorCols = n;
            String page = page(maxRows);
            return "\"kind\":\"rows\",\"columns\":" + cols + "," + page;
        }

        /** 从当前游标再取最多 maxRows 行；取完就关游标。 */
        private String page(int maxRows) throws SQLException {
            StringBuilder rows = new StringBuilder("[");
            int count = 0;
            boolean hasMore = false;
            while (true) {
                if (!cursor.next()) {
                    break;
                }
                if (count > 0) {
                    rows.append(',');
                }
                rows.append('[');
                for (int i = 1; i <= cursorCols; i++) {
                    if (i > 1) {
                        rows.append(',');
                    }
                    rows.append(value(cursor, i));
                }
                rows.append(']');
                count++;
                if (count >= maxRows) {
                    // 不预读下一行：Oracle 游标不能回退，预读会把一行吞掉
                    hasMore = true;
                    break;
                }
            }
            rows.append(']');
            if (!hasMore) {
                closeCursor();
            }
            return "\"rows\":" + rows + ",\"rowCount\":" + count + ",\"hasMore\":" + hasMore;
        }

        private String more(int maxRows) throws SQLException {
            if (cursor == null) {
                throw new SQLException("没有可以继续读取的结果（游标已关闭，重新执行一次）");
            }
            long t0 = System.currentTimeMillis();
            String page = page(maxRows);
            return "{" + page + ",\"ms\":" + (System.currentTimeMillis() - t0) + "}";
        }

        private void closeCursor() {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (SQLException ignore) {
                    // 忽略
                }
                cursor = null;
            }
            if (cursorStmt != null) {
                try {
                    cursorStmt.close();
                } catch (SQLException ignore) {
                    // 忽略
                }
                cursorStmt = null;
            }
        }

        /** 取出 DBMS_OUTPUT 缓冲（没开或没有权限就是空数组）。 */
        private String dbmsOutput() {
            StringBuilder sb = new StringBuilder("[");
            CallableStatement cs = null;
            try {
                cs = conn.prepareCall("begin dbms_output.get_line(?, ?); end;");
                cs.registerOutParameter(1, Types.VARCHAR);
                cs.registerOutParameter(2, Types.INTEGER);
                int n = 0;
                while (n < 5000) {
                    cs.execute();
                    if (cs.getInt(2) != 0) {
                        break;
                    }
                    if (n++ > 0) {
                        sb.append(',');
                    }
                    String l = cs.getString(1);
                    sb.append('"').append(esc(l == null ? "" : l)).append('"');
                }
            } catch (SQLException ignore) {
                // 忽略
            } finally {
                if (cs != null) {
                    try {
                        cs.close();
                    } catch (SQLException ignore) {
                        // 忽略
                    }
                }
            }
            return sb.append(']').toString();
        }

        // ───────────────────── 元数据 ─────────────────────

        private String tables() throws SQLException {
            requireConn();
            String q = "select table_name, 'TABLE' from user_tables where table_name not like 'BIN$%'"
                    + " union all select view_name, 'VIEW' from user_views order by 1";
            Statement st = conn.createStatement();
            StringBuilder sb = new StringBuilder("[");
            int n = 0;
            try {
                ResultSet rs = st.executeQuery(q);
                while (rs.next()) {
                    if (n++ > 0) {
                        sb.append(',');
                    }
                    sb.append("{\"name\":\"").append(esc(rs.getString(1)))
                            .append("\",\"kind\":\"").append(rs.getString(2)).append("\"}");
                }
                rs.close();
            } finally {
                st.close();
            }
            return "{\"tables\":" + sb.append(']') + ",\"count\":" + n + "}";
        }

        /** NC 元数据里的表中文名（md_table.displayname）。不是 NC 库就返回空。 */
        private String ncNames() throws SQLException {
            requireConn();
            StringBuilder sb = new StringBuilder("{");
            int n = 0;
            Statement st = conn.createStatement();
            try {
                ResultSet rs = st.executeQuery("select lower(name), displayname from md_table where displayname is not null");
                while (rs.next()) {
                    if (n++ > 0) {
                        sb.append(',');
                    }
                    sb.append('"').append(esc(rs.getString(1))).append("\":\"").append(esc(rs.getString(2))).append('"');
                }
                rs.close();
            } catch (SQLException e) {
                // 没有 md_table：普通库
            } finally {
                st.close();
            }
            return "{\"names\":" + sb.append('}') + ",\"count\":" + n + "}";
        }

        private String columns(String table) throws SQLException {
            requireConn();
            String t = table.toUpperCase();
            Map<String, String> zh = ncColumnNames(table);
            List<String> pk = pkColumns(t);
            String q = "select c.column_name, c.data_type, c.char_length, c.data_precision, c.data_scale,"
                    + " c.nullable, c.data_default, cc.comments"
                    + " from user_tab_columns c left join user_col_comments cc"
                    + " on cc.table_name = c.table_name and cc.column_name = c.column_name"
                    + " where c.table_name = ? order by c.column_id";
            PreparedStatement ps = conn.prepareStatement(q);
            StringBuilder sb = new StringBuilder("[");
            int n = 0;
            try {
                ps.setString(1, t);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    String name = rs.getString(1);
                    String type = rs.getString(2);
                    int len = rs.getInt(3);
                    int prec = rs.getInt(4);
                    boolean precNull = rs.wasNull();
                    int scale = rs.getInt(5);
                    boolean nullable = "Y".equals(rs.getString(6));
                    String def = rs.getString(7); // LONG 列必须按顺序读
                    String comment = rs.getString(8);
                    if (n++ > 0) {
                        sb.append(',');
                    }
                    sb.append("{\"name\":\"").append(esc(name))
                            .append("\",\"type\":\"").append(esc(type))
                            .append("\",\"size\":").append(len > 0 ? len : (precNull ? 0 : prec))
                            .append(",\"full\":\"").append(esc(fullType(type, len, prec, precNull, scale)))
                            .append("\",\"nullable\":").append(nullable)
                            .append(",\"pk\":").append(pk.contains(name))
                            .append(",\"default\":").append(def == null ? "null" : "\"" + esc(def.trim()) + "\"")
                            .append(",\"comment\":").append(comment == null ? "null" : "\"" + esc(comment) + "\"")
                            .append(",\"zh\":").append(zh.containsKey(name.toLowerCase()) ? "\"" + esc(zh.get(name.toLowerCase())) + "\"" : "null")
                            .append('}');
                }
                rs.close();
            } finally {
                ps.close();
            }
            return "{\"table\":\"" + esc(table) + "\",\"columns\":" + sb.append(']') + "}";
        }

        private Map<String, String> ncColumnNames(String table) {
            Map<String, String> m = new LinkedHashMap<String, String>();
            PreparedStatement ps = null;
            try {
                ps = conn.prepareStatement("select lower(c.name), c.displayname from md_column c"
                        + " where lower(c.tableid) = lower(?) and c.displayname is not null");
                ps.setString(1, table);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    m.put(rs.getString(1), rs.getString(2));
                }
                rs.close();
            } catch (SQLException e) {
                // 不是 NC 库
            } finally {
                if (ps != null) {
                    try {
                        ps.close();
                    } catch (SQLException ignore) {
                        // 忽略
                    }
                }
            }
            return m;
        }

        private List<String> pkColumns(String table) throws SQLException {
            List<String> out = new ArrayList<String>();
            PreparedStatement ps = conn.prepareStatement("select cc.column_name from user_constraints c"
                    + " join user_cons_columns cc on cc.constraint_name = c.constraint_name"
                    + " where c.table_name = ? and c.constraint_type = 'P' order by cc.position");
            try {
                ps.setString(1, table);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    out.add(rs.getString(1));
                }
                rs.close();
            } finally {
                ps.close();
            }
            return out;
        }

        private String indexes(String table) throws SQLException {
            requireConn();
            String q = "select i.index_name, i.uniqueness, i.status, ic.column_name"
                    + " from user_indexes i join user_ind_columns ic on ic.index_name = i.index_name"
                    + " where i.table_name = ? order by i.index_name, ic.column_position";
            PreparedStatement ps = conn.prepareStatement(q);
            Map<String, String[]> idx = new LinkedHashMap<String, String[]>();
            try {
                ps.setString(1, table.toUpperCase());
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    String name = rs.getString(1);
                    String[] v = idx.get(name);
                    if (v == null) {
                        idx.put(name, new String[] { rs.getString(2), rs.getString(3), rs.getString(4) });
                    } else {
                        v[2] = v[2] + ", " + rs.getString(4);
                    }
                }
                rs.close();
            } finally {
                ps.close();
            }
            StringBuilder sb = new StringBuilder("[");
            int n = 0;
            for (Map.Entry<String, String[]> e : idx.entrySet()) {
                if (n++ > 0) {
                    sb.append(',');
                }
                sb.append("{\"name\":\"").append(esc(e.getKey()))
                        .append("\",\"unique\":").append("UNIQUE".equals(e.getValue()[0]))
                        .append(",\"status\":\"").append(esc(e.getValue()[1]))
                        .append("\",\"columns\":\"").append(esc(e.getValue()[2])).append("\"}");
            }
            return "{\"indexes\":" + sb.append(']') + "}";
        }

        private String ddl(String table) throws SQLException {
            requireConn();
            Statement st = conn.createStatement();
            try {
                st.execute("begin"
                        + " dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SEGMENT_ATTRIBUTES', false);"
                        + " dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'STORAGE', false);"
                        + " dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SQLTERMINATOR', true);"
                        + " end;");
            } finally {
                st.close();
            }
            String t = table.toUpperCase();
            String main;
            try {
                main = metadata("select dbms_metadata.get_ddl('TABLE', ?) from dual", t);
            } catch (SQLException e) {
                main = metadata("select dbms_metadata.get_ddl('VIEW', ?) from dual", t);
            }
            String idx = "";
            try {
                idx = metadata("select dbms_metadata.get_dependent_ddl('INDEX', ?) from dual", t);
            } catch (SQLException e) {
                // ORA-31608：没有索引
            }
            return "{\"ddl\":\"" + esc((main.trim() + "\n\n" + idx.trim()).trim()) + "\"}";
        }

        private String metadata(String q, String name) throws SQLException {
            PreparedStatement ps = conn.prepareStatement(q);
            try {
                ps.setString(1, name);
                ResultSet rs = ps.executeQuery();
                String s = rs.next() ? clobText(rs.getClob(1)) : "";
                rs.close();
                return s == null ? "" : s;
            } finally {
                ps.close();
            }
        }

        /**
         * 执行计划：EXPLAIN PLAN 只解析不执行。PLAN_TABLE 在 11g 是会话级临时表，
         * 用完删掉自己那几行，不影响当前事务里的其它改动。
         */
        private String explain(String raw) throws SQLException {
            requireConn();
            String mark = "NCF" + System.nanoTime() % 100000000L;
            Statement st = conn.createStatement();
            try {
                st.execute("explain plan set statement_id = '" + mark + "' for " + normalize(raw));
            } finally {
                st.close();
            }
            String q = "select level - 1, operation || nvl2(options, ' ' || options, ''), object_name,"
                    + " access_predicates, filter_predicates, cost, cardinality from plan_table"
                    + " start with id = 0 and statement_id = ?"
                    + " connect by prior id = parent_id and statement_id = ? order siblings by position";
            PreparedStatement ps = conn.prepareStatement(q);
            StringBuilder sb = new StringBuilder("[");
            int n = 0;
            try {
                ps.setString(1, mark);
                ps.setString(2, mark);
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    if (n++ > 0) {
                        sb.append(',');
                    }
                    long cost = rs.getLong(6);
                    boolean costNull = rs.wasNull();
                    long card = rs.getLong(7);
                    boolean cardNull = rs.wasNull();
                    sb.append("{\"depth\":").append(rs.getInt(1))
                            .append(",\"operation\":\"").append(esc(rs.getString(2)))
                            .append("\",\"object\":\"").append(esc(rs.getString(3)))
                            .append("\",\"access\":\"").append(esc(rs.getString(4)))
                            .append("\",\"filter\":\"").append(esc(rs.getString(5)))
                            .append("\",\"cost\":").append(costNull ? "null" : String.valueOf(cost))
                            .append(",\"rows\":").append(cardNull ? "null" : String.valueOf(card))
                            .append('}');
                }
                rs.close();
            } finally {
                ps.close();
            }
            PreparedStatement del = conn.prepareStatement("delete from plan_table where statement_id = ?");
            try {
                del.setString(1, mark);
                del.executeUpdate();
            } finally {
                del.close();
            }
            return "{\"plan\":" + sb.append(']') + "}";
        }

        /** 批量导出表结构（工作台缓存到本地，出包前核对字段与补全用）。 */
        private String schema(int offset, int limit) throws SQLException {
            requireConn();
            DatabaseMetaData md = conn.getMetaData();
            StringBuilder sb = new StringBuilder("[");
            int n = 0;
            int skipped = 0;
            ResultSet rs = md.getColumns(null, md.getUserName(), "%", "%");
            try {
                while (rs.next() && n < limit) {
                    if (skipped < offset) {
                        skipped++;
                        continue;
                    }
                    if (n > 0) {
                        sb.append(',');
                    }
                    sb.append("{\"table\":\"").append(esc(rs.getString("TABLE_NAME")))
                            .append("\",\"column\":\"").append(esc(rs.getString("COLUMN_NAME")))
                            .append("\",\"type\":\"").append(esc(rs.getString("TYPE_NAME")))
                            .append("\",\"size\":").append(rs.getInt("COLUMN_SIZE"))
                            .append(",\"nullable\":").append(rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls)
                            .append('}');
                    n++;
                }
            } finally {
                rs.close();
            }
            sb.append(']');
            return "{\"rows\":" + sb + ",\"count\":" + n + ",\"nextOffset\":" + (offset + n) + "}";
        }

        private void requireConn() throws SQLException {
            if (conn == null || conn.isClosed()) {
                throw new SQLException("还没连数据库");
            }
        }

        /**
         * 断开：未提交的改动一律回滚。界面在有未提交事务时会先问用户（提交 / 回滚 / 取消），
         * 走到这里时用户已经选过了；进程被直接杀掉时 Oracle 也会回滚。
         */
        private void closeQuietly() {
            closeCursor();
            if (conn != null) {
                try {
                    if (!conn.getAutoCommit()) {
                        conn.rollback();
                    }
                } catch (Exception ignore) {
                    // 已断
                }
                try {
                    conn.close();
                } catch (Exception ignore) {
                    // 已断
                }
                conn = null;
            }
            resetTx();
        }
    }

    /** 一条待执行的命令。`cmd` 为 null 表示「退出循环」。 */
    private static final class Job {
        final String id;
        final String cmd;
        final List<String> args;

        Job(String id, String cmd, List<String> args) {
            this.id = id;
            this.cmd = cmd;
            this.args = args;
        }
    }

    // ───────────────────── prop.xml（与连接无关，静态） ─────────────────────

    /** 列出 prop.xml 里的数据源（不含口令）。 */
    private static String propList(String home) throws Exception {
        File prop = new File(home, "ierp/bin/prop.xml");
        if (!prop.isFile()) {
            throw new IllegalStateException("找不到 " + prop.getPath());
        }
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        for (String name : dataSourceNames(prop)) {
            Hashtable<?, ?> h = readDataSource(home, name);
            if (n++ > 0) {
                sb.append(',');
            }
            sb.append("{\"name\":\"").append(esc(name))
                    .append("\",\"url\":\"").append(esc(str(h.get("databaseUrl"))))
                    .append("\",\"user\":\"").append(esc(str(h.get("user"))))
                    .append("\",\"type\":\"").append(esc(str(h.get("databaseType"))))
                    .append("\",\"isBase\":").append("true".equalsIgnoreCase(str(h.get("isBase"))))
                    .append(",\"hasPassword\":").append(str(h.get("password")) != null)
                    .append('}');
        }
        sb.append(']');
        return "{\"source\":\"" + esc(prop.getPath()) + "\",\"sources\":" + sb + "}";
    }

    /**
     * 取某个数据源的连接三要素（**含明文口令**）。
     *
     * <p>给纯 Rust 驱动用：那边没有 classpath，解不了 prop.xml 的口令。做法是这里解一次，
     * Rust 侧立刻 DPAPI 加密存起来，之后这个连接就等同普通手动连接，不必每次再叫 JVM。
     * 口令只在 stdin/stdout 这条管道上走一次，不落日志、不回前端。
     */
    private static String propCred(String home, String dsName) throws Exception {
        Hashtable<?, ?> ds = readDataSource(home, dsName);
        String url = str(ds.get("databaseUrl"));
        if (url == null || url.isEmpty()) {
            throw new SQLException("prop.xml 里没有数据源 " + dsName);
        }
        return "{\"url\":\"" + esc(url)
                + "\",\"user\":\"" + esc(str(ds.get("user")))
                + "\",\"password\":\"" + esc(str(ds.get("password"))) + "\"}";
    }

    /**
     * 构造参数是 NC home 目录（不是 prop.xml 路径），构造器包级私有要 setAccessible。
     * 必须走 parseDataSource()：单独调 decode() 拿到的口令连不上（nc-db 工具踩过）。
     */
    private static Hashtable<?, ?> readDataSource(String home, String dsName) throws Exception {
        Class<?> c;
        try {
            c = Class.forName("nc.bs.framework.datatool.PropXMLReader");
        } catch (ClassNotFoundException e) {
            throw new IllegalStateException("解不了 prop.xml 口令：NC home 下缺 external/lib/basic.jar 或 lib/fwcheck.jar");
        }
        Constructor<?> ct = c.getDeclaredConstructor(String.class);
        ct.setAccessible(true);
        Object reader = ct.newInstance(home);
        Hashtable<?, ?>[] hs = (Hashtable<?, ?>[]) c.getMethod("parseDataSource", String.class).invoke(reader, dsName);
        if (hs == null || hs.length == 0) {
            return new Hashtable<Object, Object>();
        }
        return hs[0];
    }

    /** 数据源名都是 ASCII：按 ISO-8859-1 读，避开 gb2312 解码问题。 */
    private static List<String> dataSourceNames(File prop) throws Exception {
        byte[] buf = java.nio.file.Files.readAllBytes(prop.toPath());
        String xml = new String(buf, "ISO-8859-1");
        List<String> names = new ArrayList<String>();
        Matcher m = Pattern.compile("<dataSourceName>\\s*([^<\\s]+)\\s*</dataSourceName>").matcher(xml);
        while (m.find()) {
            if (!names.contains(m.group(1))) {
                names.add(m.group(1));
            }
        }
        return names;
    }

    // ───────────────────── 取值与 JSON（无连接状态，静态） ─────────────────────

    private static final SimpleDateFormat DATE_FMT = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    private static String value(ResultSet rs, int i) throws SQLException {
        int type = rs.getMetaData().getColumnType(i);
        if (type == Types.DATE || type == Types.TIMESTAMP || type == -101 || type == -102) {
            Timestamp ts = rs.getTimestamp(i);
            if (ts == null) {
                return "null";
            }
            String s = DATE_FMT.format(ts);
            if (type != Types.DATE && ts.getNanos() != 0) {
                s += "." + String.format("%09d", ts.getNanos()).replaceAll("0+$", "");
            }
            return "\"" + s + "\"";
        }
        Object o = rs.getObject(i);
        if (o == null || rs.wasNull()) {
            return "null";
        }
        if (o instanceof BigDecimal) {
            // 金额字段转 double 会掉精度：一律给字符串
            return "\"" + ((BigDecimal) o).toPlainString() + "\"";
        }
        if (o instanceof Number) {
            return String.valueOf(o);
        }
        if (o instanceof Clob) {
            return "\"" + esc(clobText((Clob) o)) + "\"";
        }
        if (o instanceof byte[]) {
            byte[] b = (byte[]) o;
            if (type == Types.VARBINARY || type == Types.BINARY) {
                return "\"" + hex(b, 64) + "\""; // RAW：十六进制，GUID 主键常用
            }
            return "\"<BLOB " + b.length + "B>\"";
        }
        if (o instanceof java.sql.Blob) {
            return "\"<BLOB " + ((java.sql.Blob) o).length() + "B>\"";
        }
        return "\"" + esc(String.valueOf(o)) + "\"";
    }

    private static String clobText(Clob c) throws SQLException {
        if (c == null) {
            return null;
        }
        long len = c.length();
        try {
            Reader r = c.getCharacterStream();
            StringBuilder sb = new StringBuilder((int) Math.min(len, CLOB_MAX));
            char[] buf = new char[8192];
            int k;
            while ((k = r.read(buf)) > 0 && sb.length() < CLOB_MAX) {
                sb.append(buf, 0, k);
            }
            r.close();
            if (len > CLOB_MAX) {
                sb.setLength(CLOB_MAX);
                sb.append("…（共 ").append(len).append(" 字符，只取前 1M）");
            }
            return sb.toString();
        } catch (java.io.IOException e) {
            throw new SQLException("读 CLOB 失败：" + e.getMessage());
        }
    }

    private static String hex(byte[] b, int max) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < b.length && i < max; i++) {
            sb.append(String.format("%02X", b[i]));
        }
        if (b.length > max) {
            sb.append("…");
        }
        return sb.toString();
    }

    private static String typeName(ResultSetMetaData md, int i) throws SQLException {
        String t = md.getColumnTypeName(i);
        int size = md.getPrecision(i);
        if (size > 0 && ("VARCHAR2".equals(t) || "CHAR".equals(t) || "NVARCHAR2".equals(t) || "NCHAR".equals(t))) {
            return t + "(" + size + ")";
        }
        if ("NUMBER".equals(t) && size > 0) {
            int scale = md.getScale(i);
            return scale > 0 ? t + "(" + size + "," + scale + ")" : t + "(" + size + ")";
        }
        return t;
    }

    static String fullType(String type, int len, int prec, boolean precNull, int scale) {
        if (type == null) {
            return "";
        }
        if (type.endsWith("CHAR") || type.endsWith("CHAR2") || "RAW".equals(type)) {
            return len > 0 ? type + "(" + len + ")" : type;
        }
        if ("NUMBER".equals(type) && !precNull) {
            return scale > 0 ? type + "(" + prec + "," + scale + ")" : type + "(" + prec + ")";
        }
        return type;
    }

    /** 去掉首尾空白；非 PL/SQL 去掉末尾分号（Oracle JDBC 遇到会报 ORA-00911）。 */
    static String normalize(String raw) {
        String s = raw.trim();
        if (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1).trim();
        }
        if (!PLSQL.matcher(leadingKeywords(s)).find()) {
            while (s.endsWith(";")) {
                s = s.substring(0, s.length() - 1).trim();
            }
        }
        return s;
    }

    /** 去掉开头注释后的小写文本（只用于判断语句类别）。 */
    static String leadingKeywords(String sql) {
        String s = stripLiterals(sql).trim().toLowerCase();
        return s.length() > 200 ? s.substring(0, 200) : s;
    }

    /** 去掉字符串常量与注释，避免注释或字面量里的关键字被误判。 */
    static String stripLiterals(String sql) {
        StringBuilder b = new StringBuilder(sql.length());
        int i = 0;
        int n = sql.length();
        while (i < n) {
            char c = sql.charAt(i);
            if (c == '\'') {
                i++;
                while (i < n) {
                    char d = sql.charAt(i);
                    if (d == '\'') {
                        if (i + 1 < n && sql.charAt(i + 1) == '\'') {
                            i += 2;
                            continue;
                        }
                        i++;
                        break;
                    }
                    i++;
                }
                b.append("''");
                continue;
            }
            if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                while (i < n && sql.charAt(i) != '\n') {
                    i++;
                }
                b.append(' ');
                continue;
            }
            if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < n && !(sql.charAt(i) == '*' && sql.charAt(i + 1) == '/')) {
                    i++;
                }
                i = Math.min(i + 2, n);
                b.append(' ');
                continue;
            }
            b.append(c);
            i++;
        }
        return b.toString();
    }

    private static boolean flag(List<String> a, int i) {
        return a.size() > i && "true".equalsIgnoreCase(a.get(i));
    }

    private static int intArg(List<String> a, int i, int def) {
        try {
            return a.size() > i ? Integer.parseInt(a.get(i).trim()) : def;
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static int safeInt(int v) {
        return v < 0 ? 0 : v;
    }

    private static String sqlMessage(SQLException e) {
        String m = e.getMessage();
        if (m == null) {
            m = e.getClass().getSimpleName();
        }
        return "ORA " + e.getErrorCode() + "：" + m.trim();
    }

    private static String esc(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    b.append("\\\"");
                    break;
                case '\\':
                    b.append("\\\\");
                    break;
                case '\n':
                    b.append("\\n");
                    break;
                case '\r':
                    b.append("\\r");
                    break;
                case '\t':
                    b.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        return b.toString();
    }

    private static void ok(String id, String dataJson) {
        out.println("{\"id\":\"" + esc(id) + "\",\"ok\":true,\"data\":" + dataJson + "}");
        out.flush();
    }

    private static void err(String id, String code, String msg) {
        out.println("{\"id\":\"" + esc(id) + "\",\"ok\":false,\"code\":\"" + esc(code)
                + "\",\"error\":\"" + esc(msg) + "\"}");
        out.flush();
    }

    /** 与 Rust 侧 `escape` 互逆：`\\` `\t` `\n` `\r`。 */
    private static String unescape(String s) {
        if (s.indexOf('\\') < 0) {
            return s;
        }
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) {
                b.append(c);
                continue;
            }
            i++;
            char d = s.charAt(i);
            switch (d) {
                case 't':
                    b.append('\t');
                    break;
                case 'n':
                    b.append('\n');
                    break;
                case 'r':
                    b.append('\r');
                    break;
                case '\\':
                    b.append('\\');
                    break;
                default:
                    b.append(d);
            }
        }
        return b.toString();
    }
}
