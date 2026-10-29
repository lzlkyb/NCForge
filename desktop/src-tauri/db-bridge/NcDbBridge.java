import java.io.BufferedReader;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.math.BigDecimal;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * NCForge 的数据库桥（JDBC，驱动用 NC home 自带的 ojdbc6.jar）。
 *
 * <p>为什么用 JDBC 而不是 Rust 直连：Oracle 驱动就在 NC home 的 driver/oracle_11g 里，
 * JDBC 一行就通；Rust 侧要么带 Instant Client（几十 MB）、要么自己实现 TNS，都不划算。
 * JVM 由工作台常驻托管（见 java_bridge.rs），连一次握手之后每次查询都是毫秒级。
 *
 * <p><b>只读是硬约束</b>，三道保险：
 * <ol>
 *   <li>语句白名单：只认单条 select / with（挡住手滑和粘贴错）</li>
 *   <li>Oracle {@code SET TRANSACTION READ ONLY}：会话级拒绝 DML/DDL（挡住真写）</li>
 *   <li>每次执行后 rollback（兜底）</li>
 * </ol>
 * 不靠关键字黑名单——那玩意永远有缝。
 *
 * <p><b>已知边界</b>：PL/SQL 包的 {@code PRAGMA AUTONOMOUS_TRANSACTION} 函数在
 * 自己的事务里提交，三道都拦不住——{@code select my_pkg.do_write() from dual}
 * 看着是查询，函数里的写操作照样落库。这里不拦（拦不住可靠地区分「自带工具包」
 * 与「自定义包」，误杀正常排查查询的代价更高），改由前端在调用自定义包函数时
 * 给一句提醒（见 {@code desktop/src/lib/db.ts} 的 {@code autonomousCallHint}）。
 *
 * <p>协议与 NcSvnBridge 完全一致：stdin 每行一条请求，TAB 分隔；stdout 每行一条 JSON。
 * <pre>
 *   1	hello
 *   2	connect	jdbc:oracle:thin:@10.200.22.144:1521/aier260824	aier633	密码
 *   3	query	select * from bd_material	500	30
 *   4	tables
 *   5	columns	bd_material
 *   6	schema	0	200
 *   7	ping
 *   8	quit
 * </pre>
 * 响应：{"id":"3","ok":true,"data":{...}} / {"id":"3","ok":false,"error":"...","code":"sql"}
 */
public class NcDbBridge {

    /** 只允许这些开头的单条语句。`with` 用于 CTE 查询。 */
    private static final String[] ALLOWED = { "select", "with" };

    /**
     * `with x as (select …) insert into …`：CTE 后面接写操作（Oracle 里合法）。
     * 所以「开头是 with」不等于整句只读，还要扫一遍主语句关键字。
     * `\b` 保证 `update_time` 这类列名不会被误命中（下划线是词字符）。
     */
    private static final java.util.regex.Pattern DML =
            java.util.regex.Pattern.compile("\\b(insert|update|delete|merge)\\b");

    /** `for\nupdate` 这种换行写法也要拦住（以前只匹配中间一个空格）。 */
    private static final java.util.regex.Pattern FOR_UPDATE =
            java.util.regex.Pattern.compile("\\bfor\\s+update\\b");

    private static PrintStream out;
    private static Connection conn;
    private static String connectedUrl = "";

    public static void main(String[] args) throws Exception {
        // stdout 只留给协议；任何第三方库的 System.out 一律改道 stderr，
        // 否则一行日志就把 JSON 流冲乱了（SVN 桥踩过这个坑）。
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
            String cmd = parts.length > 1 ? unescape(parts[1]) : "";
            List<String> a = new ArrayList<String>();
            for (int i = 2; i < parts.length; i++) {
                a.add(unescape(parts[i]));
            }
            try {
                dispatch(id, cmd, a);
            } catch (SQLException e) {
                err(id, "sql", sqlMessage(e));
            } catch (Exception e) {
                err(id, "other", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            if ("quit".equals(cmd)) {
                break;
            }
        }
        closeQuietly();
    }

    private static void dispatch(String id, String cmd, List<String> a) throws Exception {
        if ("hello".equals(cmd)) {
            ok(id, "{\"version\":\"1\",\"java\":\"" + esc(System.getProperty("java.version")) + "\"}");
        } else if ("connect".equals(cmd)) {
            ok(id, connect(a));
        } else if ("query".equals(cmd)) {
            ok(id, query(a));
        } else if ("tables".equals(cmd)) {
            ok(id, tables());
        } else if ("columns".equals(cmd)) {
            ok(id, columns(a.get(0)));
        } else if ("schema".equals(cmd)) {
            ok(id, schema(Integer.parseInt(a.get(0)), Integer.parseInt(a.get(1))));
        } else if ("ping".equals(cmd)) {
            boolean alive = conn != null && !conn.isClosed();
            ok(id, "{\"alive\":" + alive + "}");
        } else if ("disconnect".equals(cmd)) {
            closeQuietly();
            ok(id, "{}");
        } else if ("quit".equals(cmd)) {
            ok(id, "{}");
        } else {
            err(id, "other", "未知命令：" + cmd);
        }
    }

    // ───────────────────────── 连接 ─────────────────────────

    private static String connect(List<String> a) throws Exception {
        String url = a.get(0);
        String user = a.get(1);
        String pass = a.size() > 2 ? a.get(2) : "";
        if (conn != null && !conn.isClosed() && url.equals(connectedUrl)) {
            // 同一个库且连接还活着：直接复用，省掉一次握手
            return connInfo();
        }
        closeQuietly();
        // ojdbc6（2010 年）没带 META-INF/services/java.sql.Driver，JDBC 4 的自动加载认不到它，
        // 必须显式注册一次；不注册的话报的是「No suitable driver」，很容易被当成连不上库。
        try {
            Class.forName("oracle.jdbc.OracleDriver");
        } catch (ClassNotFoundException e) {
            throw new SQLException("找不到 Oracle 驱动（ojdbc6.jar）：检查 NC home 的 driver/oracle_11g 是否完整");
        }
        Properties p = new Properties();
        p.setProperty("user", user);
        p.setProperty("password", pass);
        // 连接超时：库挂了不要让界面干等默认的无限期
        p.setProperty("oracle.net.CONNECT_TIMEOUT", "15000");
        DriverManager.setLoginTimeout(15);
        conn = DriverManager.getConnection(url, p);
        connectedUrl = url;
        conn.setAutoCommit(false);
        conn.setReadOnly(true);
        return connInfo();
    }

    private static String connInfo() throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        return "{\"product\":\"" + esc(md.getDatabaseProductName())
                + "\",\"version\":\"" + esc(md.getDatabaseProductVersion())
                + "\",\"user\":\"" + esc(md.getUserName())
                + "\",\"readOnly\":" + conn.isReadOnly() + "}";
    }

    // ───────────────────────── 查询 ─────────────────────────

    private static String query(List<String> a) throws SQLException {
        requireConn();
        String sql = a.get(0);
        int maxRows = a.size() > 1 ? Integer.parseInt(a.get(1)) : 500;
        int timeout = a.size() > 2 ? Integer.parseInt(a.get(2)) : 30;
        checkReadOnly(sql);

        long t0 = System.currentTimeMillis();
        Statement st = null;
        try {
            // 每个查询都是独立事务：先回滚上一个，再开只读事务。
            // SET TRANSACTION READ ONLY 是事务级语义，rollback 之后不设就又变回可写了。
            conn.rollback();
            st = conn.createStatement();
            st.setQueryTimeout(timeout);
            st.setMaxRows(maxRows + 1); // 多取一行用来判断「还有没有」
            st.execute("SET TRANSACTION READ ONLY");

            boolean hasRs = st.execute(sql);
            if (!hasRs) {
                throw new SQLException("这条语句没有结果集（只读面板只放查询）");
            }
            ResultSet rs = st.getResultSet();
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

            StringBuilder rows = new StringBuilder("[");
            int count = 0;
            boolean truncated = false;
            while (rs.next()) {
                if (count >= maxRows) {
                    truncated = true;
                    break;
                }
                if (count > 0) {
                    rows.append(',');
                }
                rows.append('[');
                for (int i = 1; i <= n; i++) {
                    if (i > 1) {
                        rows.append(',');
                    }
                    rows.append(value(rs, i));
                }
                rows.append(']');
                count++;
            }
            rs.close();
            rows.append(']');

            long ms = System.currentTimeMillis() - t0;
            return "{\"columns\":" + cols + ",\"rows\":" + rows
                    + ",\"rowCount\":" + count
                    + ",\"truncated\":" + truncated
                    + ",\"ms\":" + ms + "}";
        } finally {
            // 兜底：即使前面抛了，也不让这个事务留到下一次
            try {
                conn.rollback();
            } catch (SQLException ignore) {
                // 连接已死的情况，下一次 connect 会重建
            }
            if (st != null) {
                try {
                    st.close();
                } catch (SQLException ignore) {
                    // 忽略
                }
            }
        }
    }

    /**
     * 三道保险里的第一道（启发式）：只认单条 select / with。
     *
     * <p>这里刻意做得「笨」：去掉注释与字符串常量后，只要出现非末尾的分号就拒。
     * 它挡不住的东西是**故意**留给后面的——真正的兜底是第二道（连接设为只读事务，
     * 写操作会被数据库以 ORA-01456 拒绝），以及第三道（执行后 rollback）。
     * 取舍标准是「宁可少判一点风险，也别误杀正常查询」：一次误报就没人再用这个面板了。
     */
    private static void checkReadOnly(String sql) throws SQLException {
        String s = stripLiterals(sql).trim();
        while (s.endsWith(";")) {
            s = s.substring(0, s.length() - 1).trim();
        }
        if (s.isEmpty()) {
            throw new SQLException("空语句");
        }
        if (s.indexOf(';') >= 0) {
            throw new SQLException("只允许单条语句（检测到多个分号）");
        }
        String lower = s.toLowerCase();
        boolean okStart = false;
        for (String k : ALLOWED) {
            if (lower.startsWith(k + " ") || lower.startsWith(k + "\n") || lower.startsWith(k + "\t")
                    || lower.startsWith(k + "(")) {
                okStart = true;
                break;
            }
        }
        if (!okStart) {
            throw new SQLException("只读面板只放行 select / with 开头的查询；改数据请走正式 SQL 脚本");
        }
        // `with` 只是开头合法，主语句仍可能是写操作：`with x as (select …) insert into t …`
        if (lower.startsWith("with") && DML.matcher(lower).find()) {
            throw new SQLException("with 后面跟的是写操作（insert / update / delete / merge），只读面板不放行");
        }
        if (FOR_UPDATE.matcher(lower).find()) {
            throw new SQLException("for update 会加锁，只读面板不放行");
        }
    }

    /** 去掉字符串常量与注释，避免 `-- 注释里的分号` 被误判。 */
    private static String stripLiterals(String sql) {
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

    private static void requireConn() throws SQLException {
        if (conn == null || conn.isClosed()) {
            throw new SQLException("还没连数据库");
        }
    }

    // ───────────────────────── 元数据 ─────────────────────────

    private static String tables() throws SQLException {
        requireConn();
        DatabaseMetaData md = conn.getMetaData();
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        ResultSet rs = md.getTables(null, md.getUserName(), "%", new String[] { "TABLE", "VIEW" });
        try {
            while (rs.next()) {
                String name = rs.getString("TABLE_NAME");
                if (name == null || name.startsWith("BIN$")) {
                    continue; // 回收站里的表
                }
                if (n > 0) {
                    sb.append(',');
                }
                sb.append("{\"name\":\"").append(esc(name))
                        .append("\",\"kind\":\"").append(esc(rs.getString("TABLE_TYPE")))
                        .append("\"}");
                n++;
            }
        } finally {
            rs.close();
        }
        sb.append(']');
        return "{\"tables\":" + sb + ",\"count\":" + n + "}";
    }

    private static String columns(String table) throws SQLException {
        requireConn();
        DatabaseMetaData md = conn.getMetaData();
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        ResultSet rs = md.getColumns(null, md.getUserName(), table.toUpperCase(), "%");
        try {
            while (rs.next()) {
                if (n > 0) {
                    sb.append(',');
                }
                sb.append("{\"name\":\"").append(esc(rs.getString("COLUMN_NAME")))
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
        return "{\"table\":\"" + esc(table) + "\",\"columns\":" + sb + "}";
    }

    /**
     * 批量导出表结构（供工作台缓存到本地，出包前核对字段用）。
     *
     * <p>用 offset/limit 分页：这台库有两千多张表、几万个字段，一次吐完 JSON 会是几 MB，
     * 桥的行缓冲与界面的解析都吃不消。
     */
    private static String schema(int offset, int limit) throws SQLException {
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

    // ───────────────────────── 取值与 JSON ─────────────────────────

    private static String value(ResultSet rs, int i) throws SQLException {
        Object o = rs.getObject(i);
        if (o == null || rs.wasNull()) {
            return "null";
        }
        if (o instanceof Number) {
            // BigDecimal 走字符串：转 double 会掉精度（金额字段就是这个坑）
            if (o instanceof BigDecimal) {
                return ((BigDecimal) o).toPlainString();
            }
            return String.valueOf(o);
        }
        if (o instanceof Clob) {
            return "\"<CLOB>\"";
        }
        if (o instanceof byte[]) {
            return "\"<BLOB " + ((byte[]) o).length + "B>\"";
        }
        if (o instanceof java.sql.Timestamp) {
            return "\"" + o.toString().replace(' ', 'T') + "\"";
        }
        return "\"" + esc(String.valueOf(o)) + "\"";
    }

    private static String typeName(ResultSetMetaData md, int i) throws SQLException {
        String t = md.getColumnTypeName(i);
        int size = md.getPrecision(i);
        if (size > 0 && ("VARCHAR2".equals(t) || "CHAR".equals(t) || "NVARCHAR2".equals(t))) {
            return t + "(" + size + ")";
        }
        return t;
    }

    private static int safeInt(int v) {
        return v < 0 ? 0 : v;
    }

    private static String sqlMessage(SQLException e) {
        String m = e.getMessage();
        if (m == null) {
            m = e.getClass().getSimpleName();
        }
        return "ORA " + e.getErrorCode() + "：" + m;
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

    private static void closeQuietly() {
        if (conn != null) {
            try {
                conn.rollback();
            } catch (Exception ignore) {
                // 已断
            }
            try {
                conn.close();
            } catch (Exception ignore) {
                // 已断
            }
            conn = null;
            connectedUrl = "";
        }
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
