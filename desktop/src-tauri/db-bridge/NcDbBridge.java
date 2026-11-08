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
    /**
     * PL/SQL 里「游标 OUT 参数」的写法：`open :1 for select …`。
     *
     * 这是 JDBC 调用存储过程的标准形态（DBMS_SQL / PL/SQL Developer / DBeaver 导出的脚本里都有），
     * 但**普通 {@code Statement} 表达不了它**：`:1` 是游标类型的 OUT 参数，必须
     * `prepareCall` + `registerOutParameter(1, CURSOR)` 才拿得到行。
     * 2026-10-31 真库实测：走普通 Statement 报 `ORA-01008 并非所有变量都已绑定`。
     */
    private static final Pattern CURSOR_OPEN = Pattern.compile(
            "\\bopen\\s*:\\s*(\\d+)\\s+for\\b");

    /**
     * 游标 OUT 参数的类型码。
     *
     * **编译期不能引 `oracle.jdbc.OracleTypes`**：桥只依赖 JDK 标准库（见
     * `scripts/build-bridge-jar.mjs` 的 `cp: []`），驱动是运行时才加载的。所以运行时反射取一次，
     * 取不到就用 −10（`OracleTypes.CURSOR` 的历史值；NC 自带的 ufjdk 是 Java 7，
     * 连 `java.sql.Types.REF_CURSOR` 都还没有，别指望它）。
     */
    private static final int CURSOR_TYPE = cursorType();

    private static final int CLOB_MAX = 1024 * 1024;

    private static int cursorType() {
        try {
            return Class.forName("oracle.jdbc.OracleTypes").getField("CURSOR").getInt(null);
        } catch (Throwable ignore) {
            // 没驱动（离线编译/单测）时用 OracleTypes.CURSOR 的历史值；真跑的时候驱动一定在
            return -10;
        }
    }

    /** stdout 只留给协议。多个会话线程都会往这里写，PrintStream 的 println 是原子的。 */
    private static PrintStream out;

    /** 无会话命令（hello / propList / propCred / quit）的会话名占位。 */
    private static final String NO_SESSION = "-";

    /** 活着的会话。主线程负责增删，工作线程只读自己的那一条。 */
    private static final Map<String, Session> SESSIONS = new ConcurrentHashMap<String, Session>();

    /** 已知命令名：用来区分「新格式的第二段是会话名」还是「旧格式的第二段就是命令」。 */
    private static final Set<String> CMDS = new HashSet<String>(Arrays.asList(
            "hello", "propList", "propCred", "connect", "connectProp", "exec", "execBound", "readOnly", "more", "commit",
            "rollback", "autocommit", "tables", "ncNames", "query", "columns", "indexes", "ddl",
            "explain", "sessions", "objects", "source", "schema", "schemas", "setSchema", "ping", "probe",
            "disconnect", "quit", "cancel"));

    /**
     * 能直接拼进 `alter session set current_schema = …` 的名字。
     *
     * <p>schema 名在 SQL 里是<b>标识符</b>，JDBC 的绑定变量只能替字面量，替不了标识符，
     * 所以只能拼串。这里按 Oracle 标识符的字符集卡死（字母开头，其余字母/数字/_$#，
     * 最长 128），与 Rust 侧 {@code db_conns::valid_schema} 完全一致 —— 两侧不一致会出现
     * 「Rust 引擎能过、JVM 桥报错」这种只在某个引擎上复现的怪问题。
     */
    private static final java.util.regex.Pattern SCHEMA_NAME =
            java.util.regex.Pattern.compile("[A-Za-z][A-Za-z0-9_$#]{0,127}");

    /**
     * 对象树里的非表对象类型（`user_objects.object_type` 的取值）。
     *
     * 两个用途：①`objects()` 的 `in (...)` 列表；②`ddl()` 拼
     * `dbms_metadata.get_ddl('&lt;type&gt;', ?)` 时的**注入防线** —— 类型名是 SQL 字面量、
     * 绑不进去，只能拼，所以必须只认这几个。改这里要同步 Rust 侧 `OBJECT_TYPES`。
     */
    private static final List<String> OBJECT_TYPES = Arrays.asList(
            "PACKAGE", "PACKAGE BODY", "PROCEDURE", "FUNCTION",
            "SEQUENCE", "SYNONYM", "TRIGGER", "TYPE", "TYPE BODY");

    /** `OBJECT_TYPES` 拼成 SQL 的 `in (...)` 列表（写死常量，不含用户输入）。 */
    private static final String OBJECT_TYPES_IN = "'PACKAGE','PACKAGE BODY','PROCEDURE','FUNCTION',"
            + "'SEQUENCE','SYNONYM','TRIGGER','TYPE','TYPE BODY'";

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
        boolean readOnly, readOnlyStarted, previousAuto;

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
                // 第 5 参是默认 schema（老调用没有 → 空串 = 不切），连上就 alter session，
                // 之后写 `select * from org_orgs` 不用再带 `aier633.` 前缀。
                ok(id, connect(a.get(0), a.get(1), a.size() > 2 ? a.get(2) : "", flag(a, 3),
                        a.size() > 4 ? a.get(4) : "", true));
            } else if ("connectProp".equals(cmd)) {
                Hashtable<?, ?> ds = readDataSource(a.get(0), a.get(1));
                String url = str(ds.get("databaseUrl"));
                if (url == null) {
                    throw new SQLException("prop.xml 里没有数据源 " + a.get(1));
                }
                // 第 4 参才是 schema（第 3 参是 autoCommit，见 connect_args 的构造顺序）
                ok(id, connect(url, str(ds.get("user")), str(ds.get("password")), flag(a, 2),
                        a.size() > 3 ? a.get(3) : "", true));
            } else if ("exec".equals(cmd)) {
                ok(id, exec(a.get(0), intArg(a, 1, 500), intArg(a, 2, 30)));
            } else if ("execBound".equals(cmd)) {
                ok(id, execParams(a.get(0), intArg(a,1,500), intArg(a,2,30), a.subList(3,a.size())));
            } else if ("readOnly".equals(cmd)) {
                ok(id, setReadOnly(flag(a,0)));
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
            } else if ("query".equals(cmd)) {
                ok(id, query(a.get(0), intArg(a, 1, 1000)));
            } else if ("columns".equals(cmd)) {
                ok(id, columns(a.get(0)));
            } else if ("indexes".equals(cmd)) {
                ok(id, indexes(a.get(0)));
            } else if ("ddl".equals(cmd)) {
                ok(id, ddl(a.get(0), a.size() > 1 ? a.get(1) : null));
            } else if ("objects".equals(cmd)) {
                ok(id, objects());
            } else if ("source".equals(cmd)) {
                ok(id, source(a.get(0)));
            } else if ("explain".equals(cmd)) {
                ok(id, explain(a.get(0)));
            } else if ("sessions".equals(cmd)) {
                ok(id, sessions());
            } else if ("schemaBatch".equals(cmd)) {
                ok(id, query(a.get(0), 1000));
            } else if ("schema".equals(cmd)) {
                ok(id, schema(Integer.parseInt(a.get(0)), Integer.parseInt(a.get(1))));
            } else if ("schemas".equals(cmd)) {
                ok(id, schemas());
            } else if ("setSchema".equals(cmd)) {
                ok(id, setSchema(a.size() > 0 ? a.get(0) : ""));
            } else if ("ping".equals(cmd)) {
                boolean alive = conn != null && !conn.isClosed();
                ok(id, "{\"alive\":" + alive + ",\"tx\":" + txJson() + "}");
            } else if ("probe".equals(cmd)) {
                boolean alive = conn != null && !conn.isClosed();
                if (alive) {
                    // isClosed() only checks the local handle. Check the wire without replacing the user's cursor.
                    try (Statement s = conn.createStatement()) {
                        s.setQueryTimeout(2);
                        try (ResultSet rs = s.executeQuery("select 1 from dual")) {
                            alive = rs.next();
                        }
                    }
                }
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

        private String connect(String url, String user, String pass, boolean autoCommit, String schema,
                boolean strictSchema) throws Exception {
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
            readOnly = false; readOnlyStarted = false;
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
            // 默认 schema 跟着连接一起设（严格模式）：配置里写错名字就别假装连好了 ——
            // 用户看到的「已连接」必须等于「prefix 真能省掉」，否则他会以为工具坏了。
            String warning = "";
            if (strictSchema) {
                try {
                    applySchema(schema);
                } catch (SQLException e) {
                    // 连接过程里失败不抛（抛了连会话都不会建，用户连改配置的入口都没有），
                    // 把原因带回去，前端在连接卡片上标一行黄字。
                    warning = e.getMessage();
                }
            } else {
                applySchema(schema);
            }
            String current = currentSchema();
            return "{\"url\":\"" + esc(url)
                    + "\",\"product\":\"" + esc(md.getDatabaseProductName())
                    + "\",\"version\":\"" + esc(md.getDatabaseProductVersion())
                    + "\",\"user\":\"" + esc(md.getUserName())
                    + "\",\"schema\":\"" + esc(current)
                    + "\",\"schemaWarning\":\"" + esc(warning)
                    + "\",\"autoCommit\":" + conn.getAutoCommit() + "}";
        }

        /**
         * 切默认 schema。空串 = 回到登录账号自己的 schema。
         *
         * <p>名字校验在拼串之前（见 {@link #SCHEMA_NAME}）；执行后再读一次
         * {@code sys_context} 核对，因为 Oracle 对不存在的 schema 不报错（它只在下一次
         * 名字解析时抛 ORA-00942），不核对的话界面上会显示一个假的当前 schema。
         *
         * <p>事务安全：{@code alter session} 是会话控制语句，<b>不隐式提交</b>当前事务
         * （Oracle Concepts「Implicit Commit」列出的语句里没有它），所以在有未提交 update
         * 的会话上切 schema 不会把那些改动提交掉。
         */
        private void applySchema(String name) throws SQLException {
            requireConn();
            String target = name == null ? "" : name.trim();
            if (target.isEmpty()) {
                target = conn.getMetaData().getUserName();
            }
            if (target == null || !SCHEMA_NAME.matcher(target).matches()) {
                throw new SQLException("schema 名不合法：" + target
                        + "（只能字母开头，其余用字母、数字、下划线，最长 128 个字符）");
            }
            target = target.toUpperCase(java.util.Locale.ROOT);
            Statement st = conn.createStatement();
            try {
                st.execute("alter session set current_schema = " + target);
            } finally {
                st.close();
            }
            String now = currentSchema();
            if (now != null && !now.equalsIgnoreCase(target)) {
                throw new SQLException("切换默认 schema 没生效：期望 " + target + "，当前仍是 " + now);
            }
        }

        /** 当前会话的默认 schema；读不到返回 null（调用方自己决定回落到什么）。 */
        private String currentSchema() {
            if (conn == null) {
                return null;
            }
            Statement st = null;
            try {
                st = conn.createStatement();
                ResultSet rs = st.executeQuery("select sys_context('userenv','current_schema') from dual");
                try {
                    return rs.next() ? rs.getString(1) : null;
                } finally {
                    rs.close();
                }
            } catch (SQLException e) {
                return null;
            } finally {
                if (st != null) {
                    try { st.close(); } catch (SQLException ignore) { /* 关不掉也没别的办法 */ }
                }
            }
        }

        /** 库里能看到的 schema 清单（{@code all_users}，任何账号都读得到）。 */
        private String schemas() throws SQLException {
            requireConn();
            // 独立 Statement，不走 exec()：那条路会 closeCursor()，把「加载更多」的游标毁掉
            Statement st = conn.createStatement();
            StringBuilder sb = new StringBuilder("[");
            int n = 0;
            try {
                ResultSet rs = st.executeQuery("select username from all_users order by username");
                try {
                    while (rs.next()) {
                        String name = rs.getString(1);
                        if (name == null) {
                            continue;
                        }
                        if (n++ > 0) {
                            sb.append(',');
                        }
                        sb.append('"').append(esc(name)).append('"');
                    }
                } finally {
                    rs.close();
                }
            } finally {
                st.close();
            }
            String now = currentSchema();
            String user = conn.getMetaData().getUserName();
            return "{\"schemas\":" + sb.append(']')
                    + ",\"current\":\"" + esc(now == null ? user : now)
                    + "\",\"user\":\"" + esc(user) + "\"}";
        }

        /** 切 schema 的命令入口：切完把生效后的名字回给前端（界面上那个胶囊显示它）。 */
        private String setSchema(String name) throws SQLException {
            applySchema(name);
            String now = currentSchema();
            return "{\"schema\":\"" + esc(now == null ? name : now) + "\"}";
        }

        private void resetTx() {
            readOnlyStarted = false;
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

        private String setReadOnly(boolean enabled) throws Exception {
            requireConn();
            if (enabled != readOnly) {
                if (txStatements > 0) throw new SQLException("有未提交写入，请先提交或回滚再切换只读查询");
                if (enabled) { previousAuto = conn.getAutoCommit(); conn.setAutoCommit(false); }
                conn.rollback();
                if (!enabled) conn.setAutoCommit(previousAuto);
                readOnly = enabled; readOnlyStarted = false;
            }
            if (enabled && !readOnlyStarted) {
                Statement s = conn.createStatement();
                try { s.execute("set transaction read only"); readOnlyStarted = true; } finally { s.close(); }
            }
            return "{\"readOnly\":" + readOnly + ",\"tx\":" + txJson() + "}";
        }
        private String exec(String raw, int maxRows, int timeout) throws Exception {
            return execParams(raw,maxRows,timeout,null);
        }
        private String execParams(String raw, int maxRows, int timeout, List<String> binds) throws Exception {
            requireConn();
            closeCursor();
            String sql = normalize(raw);
            String head = leadingKeywords(sql);
            if (sql.isEmpty()) {
                throw new SQLException("空语句");
            }
            long t0 = System.currentTimeMillis();
            // A2 Autotrace：执行前后各读一次 v$mystat，差值才是这条语句的真实开销。
            // 读不到（低权限账号没有 V_$MYSTAT 授权）时为 null，界面据此不显示统计行。
            long[] statBefore = statSnapshot();
            // 游标 OUT 参数要走 CallableStatement（见 CURSOR_OPEN 注释）；
            // 其余语句仍是普通 Statement，行为一字不改。
            int[] cursorBinds = cursorOutBinds(sql);
            Statement st = null;
            boolean keep = false;
            try {
                String body;
                if (cursorBinds.length > 0) {
                    CallableStatement cs = prepareCursorCall(sql, cursorBinds);
                    st = cs;
                    st.setQueryTimeout(timeout);
                    running = st; // 让 cancel 能找到它
                    cs.execute();
                    ResultSet first = cursorResult(cs, cursorBinds[0]);
                    // 多个游标：第一个进顶层（这样「加载更多」还能接着用那条游标），
                    // 其余的按 Rust 引擎的 `sets` 形状带出去，前端已经有「结果集 1/2…」标签。
                    String extra = cursorBinds.length > 1 ? cursorSets(cs, cursorBinds, maxRows) : "";
                    if (first == null) {
                        body = "\"kind\":\"update\",\"updateCount\":0";
                    } else {
                        body = readRows(first, maxRows);
                        keep = cursor == first;
                        if (keep) {
                            cursorStmt = st;
                        }
                    }
                    if (!extra.isEmpty()) {
                        body = body + ",\"sets\":" + extra;
                    }
                } else {
                    if (binds == null) st = conn.createStatement();
                    else {
                        PreparedStatement ps = conn.prepareStatement(toQuestionMarks(sql));
                        st = ps;
                        for (int i=0; i<binds.size(); i+=2) {
                            int n=i/2+1; String type=binds.get(i), value=binds.get(i+1);
                            if ("null".equals(type)) ps.setNull(n, java.sql.Types.VARCHAR);
                            else if ("number".equals(type)) ps.setBigDecimal(n,new java.math.BigDecimal(value));
                            else if ("bool".equals(type)) ps.setInt(n,"true".equals(value)?1:0);
                            else ps.setString(n,value);
                        }
                    }
                    st.setQueryTimeout(timeout);
                    running = st; // 让 cancel 能找到它
                    boolean hasRs = binds == null ? st.execute(sql) : ((PreparedStatement)st).execute();
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
                }
                if (st != null && FOR_UPDATE.matcher(stripLiterals(sql).toLowerCase()).find()) {
                    trackTx("lock", 0);
                }
                long ms = System.currentTimeMillis() - t0;
                // 必须在 dbmsOutput() 之前取快照：那段 get_line 循环也会产生逻辑读
                long[] statAfter = statSnapshot();
                return "{" + body + ",\"ms\":" + ms + ",\"stats\":" + statsJson(statBefore, statAfter)
                        + ",\"output\":" + dbmsOutput() + ",\"tx\":" + txJson() + "}";
            } finally {
                running = null;
                if (!keep && st != null) {
                    try {
                        st.close();
                    } catch (SQLException ignore) {
                        // 忽略
                    }
                }
            }
        }

        /**
         * 找出这条语句里「游标 OUT 参数」的位置（1 起，与 `:N` 的 N 一致）。
         *
         * 空数组 = 照常走普通 Statement。认不出就返回空：宁可让它在老路径上报
         * `ORA-01008`，也不要把普通绑定参数误当游标注册（那样报的是更难懂的类型错）。
         */
        static int[] cursorOutBinds(String sql) {
            java.util.regex.Matcher m = CURSOR_OPEN.matcher(stripLiterals(sql));
            java.util.List<Integer> found = new java.util.ArrayList<Integer>();
            while (m.find()) {
                int idx = Integer.parseInt(m.group(1));
                if (!found.contains(Integer.valueOf(idx))) {
                    found.add(Integer.valueOf(idx));
                }
            }
            int[] out = new int[found.size()];
            for (int i = 0; i < out.length; i++) {
                out[i] = found.get(i).intValue();
            }
            return out;
        }

        /** 把 `:N` 改写成 JDBC 的 `?`（字符串常量与注释里的不动）。 */
        static String toQuestionMarks(String sql) {
            StringBuilder b = new StringBuilder(sql.length());
            int i = 0;
            int n = sql.length();
            while (i < n) {
                char c = sql.charAt(i);
                if (c == '\'') {
                    int j = i++;
                    while (i < n) {
                        if (sql.charAt(i) == '\'') {
                            if (i + 1 < n && sql.charAt(i + 1) == '\'') {
                                i += 2;
                                continue;
                            }
                            i++;
                            break;
                        }
                        i++;
                    }
                    b.append(sql, j, Math.min(i, n));
                } else if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                    int j = i;
                    while (i < n && sql.charAt(i) != '\n') {
                        i++;
                    }
                    b.append(sql, j, i);
                } else if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                    int j = i;
                    i += 2;
                    while (i + 1 < n && !(sql.charAt(i) == '*' && sql.charAt(i + 1) == '/')) {
                        i++;
                    }
                    i = Math.min(i + 2, n);
                    b.append(sql, j, i);
                } else if (c == ':' && i + 1 < n && Character.isDigit(sql.charAt(i + 1))) {
                    int j = i + 1;
                    while (j < n && Character.isDigit(sql.charAt(j))) {
                        j++;
                    }
                    b.append('?');
                    i = j;
                } else {
                    b.append(c);
                    i++;
                }
            }
            return b.toString();
        }

        /**
         * 准备游标 OUT 参数的调用。
         *
         * **不能去掉结尾的 `;`**：这是 PL/SQL 匿名块自己的 `end;`（不是语句结束符），
         * 去掉就变成 `begin … end`，真库报 `PLS-00103 出现符号 end-of-file`（实测踩过）。
         * 普通 SQL 的尾分号由 {@code normalize} 处理，那条路不走这里。
         */
        private CallableStatement prepareCursorCall(String sql, int[] binds) throws SQLException {
            CallableStatement cs = conn.prepareCall(toQuestionMarks(sql));
            for (int idx : binds) {
                cs.registerOutParameter(idx, CURSOR_TYPE);
            }
            return cs;
        }

        /** 取第 idx 个参数上的游标；万一不是游标（比如用户写了 INTO 别的类型）返回 null。 */
        private static ResultSet cursorResult(CallableStatement cs, int idx) throws SQLException {
            Object v = cs.getObject(idx);
            return v instanceof ResultSet ? (ResultSet) v : null;
        }

        /**
         * 第 2 个及以后的游标，按 Rust 引擎 `implicit_sets` 的形状拼成 `sets` 数组。
         * 第一个游标已经在顶层（`kind:"rows"`），这里不重复放。
         */
        private String cursorSets(CallableStatement cs, int[] binds, int maxRows) throws SQLException {
            StringBuilder b = new StringBuilder("[");
            boolean any = false;
            for (int k = 1; k < binds.length; k++) {
                ResultSet rs = cursorResult(cs, binds[k]);
                if (rs == null) {
                    continue;
                }
                if (any) {
                    b.append(',');
                }
                b.append(setJson(rs, maxRows));
                any = true;
                try {
                    rs.close();
                } catch (SQLException ignore) {
                    // 忽略
                }
            }
            b.append(']');
            return any ? b.toString() : "";
        }

        /** 一段结果集：`{columns, rows, rowCount, hasMore}`，与 Rust 侧 `implicit_sets` 同形。 */
        private String setJson(ResultSet rs, int maxRows) throws SQLException {
            ResultSetMetaData md = rs.getMetaData();
            // 同上：先取列信息再取行，顺序反了会撞「关闭的语句」
            String cols = columnsJson(md);
            Page p = pageOf(rs, md.getColumnCount(), maxRows);
            return "{\"columns\":" + cols + ",\"rows\":" + p.rows
                    + ",\"rowCount\":" + p.count + ",\"hasMore\":" + p.hasMore + "}";
        }

        /**
         * 读一次会话统计，顺序：[db block gets, consistent gets, physical reads, execute count]。
         *
         * <p>读不到就返回 null —— 「没有权限读统计」是能力降级，不是错误，也**不是 0**。
         * 四项的名字必须与 Rust 引擎（{@code db_rust.rs} 的 STAT_NAMES）逐字一致，
         * 否则同一条 SQL 换引擎会给出两种逻辑读。
         */
        private long[] statSnapshot() {
            Statement st = null;
            ResultSet rs = null;
            try {
                st = conn.createStatement();
                rs = st.executeQuery("select n.name, m.value from v$mystat m, v$statname n "
                        + "where n.statistic# = m.statistic# and n.name in ("
                        + "'db block gets','consistent gets','physical reads','execute count')");
                long[] v = new long[4];
                int found = 0;
                while (rs.next()) {
                    String name = rs.getString(1);
                    long val = rs.getLong(2);
                    if (name == null) {
                        continue;
                    }
                    name = name.trim().toLowerCase();
                    if ("db block gets".equals(name)) {
                        v[0] = val;
                        found++;
                    } else if ("consistent gets".equals(name)) {
                        v[1] = val;
                        found++;
                    } else if ("physical reads".equals(name)) {
                        v[2] = val;
                        found++;
                    } else if ("execute count".equals(name)) {
                        v[3] = val;
                        found++;
                    }
                }
                return found > 0 ? v : null;
            } catch (SQLException e) {
                return null;
            } finally {
                try {
                    if (rs != null) {
                        rs.close();
                    }
                } catch (SQLException ignore) {
                    // 忽略
                }
                try {
                    if (st != null) {
                        st.close();
                    }
                } catch (SQLException ignore) {
                    // 忽略
                }
            }
        }

        /** 差值 → JSON。与 Rust 侧同一组字段，`logicalReads` 都在服务端算好，前端不重复推导。 */
        private String statsJson(long[] before, long[] after) {
            if (before == null || after == null) {
                return "null";
            }
            long[] d = new long[4];
            for (int i = 0; i < 4; i++) {
                d[i] = Math.max(0, after[i] - before[i]);
            }
            return "{\"dbBlockGets\":" + d[0] + ",\"consistentGets\":" + d[1]
                    + ",\"logicalReads\":" + (d[0] + d[1]) + ",\"physicalReads\":" + d[2]
                    + ",\"executeCount\":" + d[3] + "}";
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
            // **列信息必须在 page() 之前取**：page 取完（没更多行）会 closeCursor()，
            // 之后再读元数据就是「ORA-17009 关闭的语句」（2026-10-31 实测踩过，堆栈指到 columnsJson）。
            String cols = columnsJson(md);
            cursor = rs;
            cursorCols = md.getColumnCount();
            String page = page(maxRows);
            return "\"kind\":\"rows\",\"columns\":" + cols + "," + page;
        }

        /** 列信息（`[{name,type,precision,scale}]`）。总览表与 `sets` 共用同一份形状。 */
        static String columnsJson(ResultSetMetaData md) throws SQLException {
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
            return cols.toString();
        }

        /** 一页行（纯函数：不动 `cursor` / `cursorStmt`，供多结果集复用）。 */
        static final class Page {
            final String rows;
            final int count;
            final boolean hasMore;

            Page(String rows, int count, boolean hasMore) {
                this.rows = rows;
                this.count = count;
                this.hasMore = hasMore;
            }
        }

        static Page pageOf(ResultSet rs, int cols, int maxRows) throws SQLException {
            StringBuilder rows = new StringBuilder("[");
            int count = 0;
            boolean hasMore = false;
            while (true) {
                if (!rs.next()) {
                    break;
                }
                if (count > 0) {
                    rows.append(',');
                }
                rows.append('[');
                for (int i = 1; i <= cols; i++) {
                    if (i > 1) {
                        rows.append(',');
                    }
                    rows.append(value(rs, i));
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
            return new Page(rows.toString(), count, hasMore);
        }

        /** 从当前游标再取最多 maxRows 行；取完就关游标。 */
        private String page(int maxRows) throws SQLException {
            Page p = pageOf(cursor, cursorCols, maxRows);
            if (!p.hasMore) {
                closeCursor();
            }
            return "\"rows\":" + p.rows + ",\"rowCount\":" + p.count + ",\"hasMore\":" + p.hasMore;
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
            // 按**当前默认 schema** 过滤，不是登录账号：切了 schema 之后树里列的必须和
            // 「不带前缀能解析到的表」一致，否则会出现「树上有、SQL 报 ORA-00942」。
            // 用 all_* 而不是 user_*：user_* 永远只有登录账号自己的表，切过去就是空的。
            // 代价是没授权的表不显示 —— 那正是「能查什么」的真实边界，不是缺陷。
            String q = "select table_name, 'TABLE' from all_tables"
                    + " where owner = sys_context('userenv','current_schema')"
                    + " and table_name not like 'BIN$%'"
                    + " union all select view_name, 'VIEW' from all_views"
                    + " where owner = sys_context('userenv','current_schema') order by 1";
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

        /**
         * 会话与锁：谁在跑、谁在等、谁锁了哪张表。**只读**，不生成也不执行 kill。
         *
         * <p>权限边界：{@code v$session} 普通账号可读；{@code v$locked_object} 多数客户库只给 DBA，
         * 读不到时回 {@code granted:false}，前端显示黄条与授权语句——<b>不能当成「没有锁」</b>
         * （那是把事故说成正常）。
         *
         * <p>JSON 形状必须与 {@code db_rust.rs::sessions()} 完全一致：字段名、null 语义、
         * {@code granted} 含义都对齐。不一致会变成「换个引擎面板就空白」这种只在个别人机器上
         * 复现的 bug。
         */
        private String sessions() throws SQLException {
            requireConn();
            String q = "select s.sid, s.serial#, s.username, s.machine, s.program, s.status,"
                    + " s.blocking_session, s.event, s.wait_class, s.seconds_in_wait,"
                    + " s.last_call_et, s.sql_id from v$session s"
                    + " where s.type = 'USER'"
                    + " and (s.status = 'ACTIVE' or s.blocking_session is not null)"
                    + " order by nvl(s.blocking_session, s.sid), s.sid";
            List<String[]> raw = new ArrayList<String[]>();
            Statement st = conn.createStatement();
            try {
                ResultSet rs = st.executeQuery(q);
                while (rs.next()) {
                    long sid = rs.getLong(1);
                    long serial = rs.getLong(2);
                    String user = nz(rs.getString(3));
                    String machine = nz(rs.getString(4));
                    String program = nz(rs.getString(5));
                    String status = nz(rs.getString(6));
                    long blocker = rs.getLong(7);
                    boolean blockerNull = rs.wasNull();
                    String event = nz(rs.getString(8));
                    String waitClass = nz(rs.getString(9));
                    long waitSec = rs.getLong(10);
                    if (rs.wasNull()) {
                        waitSec = 0;
                    }
                    long elapsed = rs.getLong(11);
                    if (rs.wasNull()) {
                        elapsed = 0;
                    }
                    String sqlId = nz(rs.getString(12));
                    raw.add(new String[]{
                        String.valueOf(sid), String.valueOf(serial), user, machine, program,
                        status, blockerNull ? null : String.valueOf(blocker), event, waitClass,
                        String.valueOf(waitSec), String.valueOf(elapsed), sqlId
                    });
                }
                rs.close();
            } finally {
                st.close();
            }

            // 锁：读不到权限就记 granted=false，绝不返回「空锁列表」冒充「没有锁」
            boolean granted = true;
            Map<Long, List<String>> locks = new LinkedHashMap<Long, List<String>>();
            try {
                Statement ls = conn.createStatement();
                try {
                    ResultSet rs = ls.executeQuery(
                            "select l.session_id, o.owner, o.object_name, o.object_type, l.locked_mode"
                                    + " from v$locked_object l join all_objects o"
                                    + " on o.object_id = l.object_id");
                    while (rs.next()) {
                        long sid = rs.getLong(1);
                        String text = nz(rs.getString(2)) + "." + nz(rs.getString(3))
                                + "(" + nz(rs.getString(4)) + ",L" + rs.getLong(5) + ")";
                        List<String> v = locks.get(Long.valueOf(sid));
                        if (v == null) {
                            v = new ArrayList<String>();
                            locks.put(Long.valueOf(sid), v);
                        }
                        v.add(text);
                    }
                    rs.close();
                } finally {
                    ls.close();
                }
            } catch (SQLException e) {
                granted = false;
            }

            // SQL 文本：v$sql 在低权限账号下常常只返回自己的语句，读不到就留空（前端只显示 sqlId）
            Map<String, String> texts = new LinkedHashMap<String, String>();
            try {
                Statement qs = conn.createStatement();
                try {
                    ResultSet rs = qs.executeQuery(
                            "select sql_id, sql_text from v$sql"
                                    + " where sql_id is not null and rownum <= 500");
                    while (rs.next()) {
                        texts.put(nz(rs.getString(1)), cut(rs.getString(2), 300));
                    }
                    rs.close();
                } finally {
                    qs.close();
                }
            } catch (SQLException e) {
                // 读不到就没有 SQL 文本，其余照常
            }

            StringBuilder sb = new StringBuilder("{\"rows\":[");
            for (int i = 0; i < raw.size(); i++) {
                String[] r = raw.get(i);
                if (i > 0) {
                    sb.append(',');
                }
                sb.append("{\"sid\":").append(r[0])
                        .append(",\"serial\":").append(r[1])
                        .append(",\"user\":\"").append(esc(r[2]))
                        .append("\",\"machine\":\"").append(esc(r[3]))
                        .append("\",\"program\":\"").append(esc(r[4]))
                        .append("\",\"status\":\"").append(esc(r[5]))
                        .append("\",\"blocker\":").append(r[6] == null ? "null" : r[6])
                        .append(",\"event\":\"").append(esc(r[7]))
                        .append("\",\"waitClass\":\"").append(esc(r[8]))
                        .append("\",\"waitSec\":").append(r[9])
                        .append(",\"elapsedSec\":").append(r[10])
                        .append(",\"sqlId\":\"").append(esc(r[11]))
                        .append("\",\"locked\":[");
                List<String> lk = locks.get(Long.valueOf(Long.parseLong(r[0])));
                if (lk != null) {
                    for (int j = 0; j < lk.size(); j++) {
                        if (j > 0) {
                            sb.append(',');
                        }
                        sb.append('"').append(esc(lk.get(j))).append('"');
                    }
                }
                sb.append(']');
                String text = texts.get(r[11]);
                sb.append(",\"sql\":\"").append(text == null ? "" : esc(text)).append("\"}");
            }
            return sb.append("],\"granted\":").append(granted).append('}').toString();
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

        /**
         * 只读查询：用**自己的** Statement/ResultSet，取完立刻关。
         *
         * 两条硬约束：
         * ① 绝不碰 `cursor` / `cursorStmt`（那是 `exec` 的「加载更多」槽）——
         *    借来查一句元数据会把用户结果集的游标顶掉，表现为「跑完之后加载更多没了」；
         * ② 不改事务状态（不 commit / 不 rollback / 不碰 autocommit）。
         *
         * 返回形状与 `exec` 的 rows 一致，让 Rust 侧用同一套解析。**不在这里拼业务 JSON**：
         * 2026-11-02 的 `columnsZh` 就是因为手拼多包了一层 `names`，整行 JSON 不合法 ⇒
         * Rust 当「非协议输出」丢弃 ⇒ 命令干等 60 秒超时 ⇒ 前端静默，界面像功能没做。
         */
        private String query(String sql, int maxRows) throws SQLException {
            requireConn();
            Statement st = conn.createStatement();
            try {
                st.setQueryTimeout(30);
                ResultSet rs = st.executeQuery(sql);
                try {
                    ResultSetMetaData md = rs.getMetaData();
                    int n = md.getColumnCount();
                    String cols = columnsJson(md);
                    Page p = pageOf(rs, n, maxRows);
                    return "{\"columns\":" + cols + ",\"rows\":" + p.rows
                            + ",\"rowCount\":" + p.count + ",\"hasMore\":" + p.hasMore + "}";
                } finally {
                    rs.close();
                }
            } finally {
                st.close();
            }
        }

        private String columns(String table) throws SQLException {
            requireConn();
            String t = table.toUpperCase();
            Map<String, String> zh = ncColumnNames(table);
            List<String> pk = pkColumns(t);
            String q = "select c.column_name, c.data_type, c.char_length, c.data_precision, c.data_scale,"
                    + " c.nullable, c.data_default, cc.comments"
                    + " from all_tab_columns c left join all_col_comments cc"
                    + " on cc.owner = c.owner and cc.table_name = c.table_name"
                    + " and cc.column_name = c.column_name"
                    + " where c.owner = sys_context('userenv','current_schema')"
                    + " and c.table_name = ? order by c.column_id";
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
            PreparedStatement ps = conn.prepareStatement("select cc.column_name from all_constraints c"
                    + " join all_cons_columns cc on cc.owner = c.owner"
                    + " and cc.constraint_name = c.constraint_name"
                    + " where c.owner = sys_context('userenv','current_schema')"
                    + " and c.table_name = ? and c.constraint_type = 'P' order by cc.position");
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
                    + " from all_indexes i join all_ind_columns ic"
                    + " on ic.owner = i.owner and ic.index_name = i.index_name"
                    + " where i.owner = sys_context('userenv','current_schema')"
                    + " and i.table_name = ? order by i.index_name, ic.column_position";
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

        /**
         * DDL。`otype` 为空 = 按表处理（TABLE 失败后回落 VIEW）；非空 = 该类型对象。
         *
         * `otype` 会被拼进 SQL（`dbms_metadata.get_ddl` 的类型是字面量、绑不进去），
         * 所以必须过 `OBJECT_TYPES` 白名单，认不出来的一律当表处理。
         */
        private String ddl(String table, String otype) throws SQLException {
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
            String ty = otype == null ? null : otype.toUpperCase();
            if (ty != null && OBJECT_TYPES.contains(ty)) {
                // 对象 DDL 没有「依赖索引」那一段；拿到什么给什么
                String d = metadata("select dbms_metadata.get_ddl('" + ty + "', ?) from dual", t);
                return "{\"ddl\":\"" + esc(d.trim()) + "\",\"type\":\"" + esc(ty) + "\"}";
            }
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

        /**
         * 非表对象：包 / 包体 / 过程 / 函数 / 序列 / 同义词 / 触发器 / 类型。
         *
         * 过滤在 **owner = 当前默认 schema** 上（不是登录账号）：切了 schema 之后对象树跟着换，
         * 与「不带前缀能解析到的对象」一致。用 `all_objects` 而不是 `user_objects`——
         * `user_objects` 永远只含登录账号自己的对象，切过去就是空的。
         * `generated = 'N'` 排掉系统生成的（回收站对象、LOB 索引之类）。
         */
        private String objects() throws SQLException {
            requireConn();
            PreparedStatement ps = conn.prepareStatement(
                    "select object_name, object_type, status, to_char(created, 'YYYY-MM-DD')"
                    + " from all_objects where owner = sys_context('userenv','current_schema')"
                    + " and object_type in (" + OBJECT_TYPES_IN + ")"
                    + " and generated = 'N' order by object_type, object_name");
            try {
                ResultSet rs = ps.executeQuery();
                StringBuilder sb = new StringBuilder("[");
                int n = 0;
                while (rs.next()) {
                    if (n++ > 0) {
                        sb.append(',');
                    }
                    String created = rs.getString(4);
                    sb.append("{\"name\":\"").append(esc(rs.getString(1)))
                            .append("\",\"type\":\"").append(esc(rs.getString(2)))
                            .append("\",\"status\":\"").append(esc(rs.getString(3)))
                            .append("\",\"created\":")
                            .append(created == null ? "null" : "\"" + esc(created) + "\"")
                            .append("}");
                }
                rs.close();
                return "{\"objects\":" + sb.append(']') + ",\"count\":" + n + "}";
            } finally {
                ps.close();
            }
        }

        /**
         * 库内源码（`all_source`，按当前默认 schema 过滤）。序列、同义词这类没有源码的对象
         * 返回空 `lines`。
         *
         * `order by type, line`：字典序里 PACKAGE 排在 PACKAGE BODY 之前，正好是
         * 「规范在前、实现在后」的阅读顺序（TYPE / TYPE BODY 同理）。
         */
        private String source(String name) throws SQLException {
            requireConn();
            PreparedStatement ps = conn.prepareStatement(
                    "select type, line, text from all_source"
                    + " where owner = sys_context('userenv','current_schema') and name = ?"
                    + " order by type, line");
            try {
                ps.setString(1, name.toUpperCase());
                ResultSet rs = ps.executeQuery();
                StringBuilder sb = new StringBuilder("[");
                StringBuilder all = new StringBuilder();
                int n = 0;
                while (rs.next()) {
                    if (n++ > 0) {
                        sb.append(',');
                    }
                    String text = rs.getString(3);
                    if (text == null) {
                        text = "";
                    }
                    all.append(text);
                    sb.append("{\"type\":\"").append(esc(rs.getString(1)))
                            .append("\",\"line\":").append(rs.getInt(2))
                            .append(",\"text\":\"").append(esc(text)).append("\"}");
                }
                rs.close();
                return "{\"name\":\"" + esc(name.toUpperCase()) + "\",\"lines\":"
                        + sb.append(']') + ",\"text\":\"" + esc(all.toString())
                        + "\",\"count\":" + n + "}";
            } finally {
                ps.close();
            }
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

    /** null → 空串。JSON 里统一写 ""，前端不用区分 null 与空。 */
    private static String nz(String s) {
        return s == null ? "" : s;
    }

    /** 截断到 n 个字符：SQL 文本只用来认「是哪条」，完整语句用户点开再复制。 */
    private static String cut(String s, int n) {
        if (s == null) {
            return "";
        }
        return s.length() <= n ? s : s.substring(0, n);
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
