import java.lang.reflect.*;
import java.sql.*;
import java.util.*;
import java.math.BigDecimal;

/** Offline JDBC contract test: no driver, credentials or real database are involved. */
public class NcDbBridgeContractTest {
    static boolean auto=true, failReadOnly=false;
    static int readonlyStatements=0;
    static int probes=0;
    static int statQueries=0;
    static int fetchSize=0;
    static String executed="";
    /** 最近一次 `alter session set current_schema = …` 的原文（默认 schema 契约用）。 */
    static String schemaSql="";
    static Map<Integer,Object> bound=new HashMap<Integer,Object>();
    static Object proxy(final Class<?> type) {
        return proxy(type, false);
    }
    static Object proxy(final Class<?> type, final boolean hasRow) {
        return Proxy.newProxyInstance(type.getClassLoader(),new Class<?>[]{type},new InvocationHandler() {
            boolean first = hasRow;
            public Object invoke(Object p,Method m,Object[] a) throws Throwable {
                String n=m.getName();
                if (n.equals("getAutoCommit")) return auto;
                if (n.equals("setAutoCommit")) {auto=(Boolean)a[0];return null;}
                if (n.equals("createStatement")) return proxy(Statement.class);
                if (n.equals("setFetchSize")) {fetchSize=(Integer)a[0];return null;}
                // 默认 schema 契约要读登录账号名（空串 = 切回它）
                if (n.equals("getMetaData")) return proxy(DatabaseMetaData.class);
                if (n.equals("getUserName")) return "AIER633";
                if (n.equals("getDatabaseProductName")) return "Oracle";
                if (n.equals("getDatabaseProductVersion")) return "19.0.0";
                if (n.equals("prepareStatement")) {executed=(String)a[0];return proxy(PreparedStatement.class);}
                if (n.equals("prepareCall")) return proxy(CallableStatement.class);
                if (n.equals("executeQuery")) {
                    if (a != null && a.length > 0 && String.valueOf(a[0]).contains("v$mystat")) statQueries++;
                    boolean probe = a != null && a.length == 1 && "select 1 from dual".equals(a[0]);
                    if (probe) probes++;
                    return proxy(ResultSet.class, probe);
                }
                if (n.equals("next")) {
                    boolean row = first;
                    first = false;
                    return row;
                }
                if (n.equals("execute")) {
                    if (a!=null && a.length>0 && String.valueOf(a[0]).equals("set transaction read only")) {
                        if(failReadOnly) throw new SQLException("read-only not supported");
                        readonlyStatements++;
                    }
                    if (a!=null && a.length>0 && String.valueOf(a[0]).startsWith("alter session set current_schema")) {
                        schemaSql=String.valueOf(a[0]);
                    }
                    return false;
                }
                if (n.equals("getUpdateCount")) return 1;
                if (n.equals("getInt")) return 1;
                if (n.equals("setString") || n.equals("setBigDecimal") || n.equals("setNull")) {bound.put((Integer)a[0],n.equals("setNull")?null:a[1]);return null;}
                if (m.getReturnType()==boolean.class) return false;
                if (m.getReturnType()==int.class) return 0;
                if (m.getReturnType()==long.class) return 0L;
                return null;
            }
        });
    }
    static void check(boolean ok,String label) {if(!ok) throw new AssertionError(label);}

    static Object call(Object session, String name, Class<?>[] types, Object... args) throws Exception {
        Method method=session.getClass().getDeclaredMethod(name,types);method.setAccessible(true);
        try { return method.invoke(session,args); }
        catch (InvocationTargetException e) { throw (Exception)e.getCause(); }
    }
    static String runResult(Object session,String sql,int count,boolean full,String id) throws Exception {
        return (String)call(session,"execResult",new Class<?>[]{String.class,int.class,int.class,boolean.class,boolean.class,String.class},sql,count,30,false,full,id);
    }
    static String nextResult(Object session,int count,String id) throws Exception {
        return (String)call(session,"moreResult",new Class<?>[]{int.class,String.class},count,id);
    }
    static void cursorError(Object session,String id,String code) throws Exception {
        try { nextResult(session,1,id);throw new AssertionError("closed result must fail"); }
        catch (SQLException expected) {
            Field f=expected.getClass().getDeclaredField("code");f.setAccessible(true);
            check(code.equals(f.get(expected)),"cursor error has a distinct protocol code");
        }
    }
    static class QueryHandle implements InvocationHandler {
        final String[] values;
        int position=-1, failAt=-1;
        boolean rowsClosed,statementClosed;
        final ResultSet rows;
        QueryHandle(String[] values) {
            this.values=values;
            rows=(ResultSet)Proxy.newProxyInstance(ResultSet.class.getClassLoader(),new Class<?>[]{ResultSet.class},this);
        }
        public Object invoke(Object p,Method m,Object[] a) throws Throwable {
            String n=m.getName();
            if(n.equals("close")) {rowsClosed=true;return null;}
            if(rowsClosed) throw new SQLException("result already closed");
            if(n.equals("next")) {
                if(position+1==failAt) throw new SQLException("page fetch failed");
                return ++position<values.length;
            }
            if(n.equals("getObject") || n.equals("getString")) return values[position];
            if(n.equals("getMetaData")) return Proxy.newProxyInstance(ResultSetMetaData.class.getClassLoader(),new Class<?>[]{ResultSetMetaData.class},new InvocationHandler(){
                public Object invoke(Object p,Method m,Object[] a) {
                    String n=m.getName();
                    if(n.equals("getColumnCount")) return 1;
                    if(n.equals("getColumnLabel")) return "VALUE";
                    if(n.equals("getColumnTypeName")) return "VARCHAR2";
                    if(n.equals("getColumnType")) return Types.VARCHAR;
                    return defaultValue(m);
                }
            });
            return defaultValue(m);
        }
    }
    static Object defaultValue(Method m) {
        if(m.getReturnType()==boolean.class) return false;
        if(m.getReturnType()==int.class) return 0;
        if(m.getReturnType()==long.class) return 0L;
        return null;
    }
    static class QueryFixture implements InvocationHandler {
        final Map<String,QueryHandle> queries=new LinkedHashMap<String,QueryHandle>();
        boolean closed;
        int executions;
        Connection connection() {
            return (Connection)Proxy.newProxyInstance(Connection.class.getClassLoader(),new Class<?>[]{Connection.class},this);
        }
        public Object invoke(Object p,Method m,Object[] a) {
            String n=m.getName();
            if(n.equals("isClosed")) return closed;
            if(n.equals("close")) {closed=true;return null;}
            if(n.equals("getAutoCommit")) return auto;
            if(n.equals("setAutoCommit")) {auto=(Boolean)a[0];return null;}
            if(n.equals("getMetaData")) return proxy(DatabaseMetaData.class);
            if(n.equals("prepareCall")) return proxy(CallableStatement.class);
            if(n.equals("createStatement")) return Proxy.newProxyInstance(Statement.class.getClassLoader(),new Class<?>[]{Statement.class},new InvocationHandler(){
                QueryHandle query;
                public Object invoke(Object p,Method m,Object[] a) throws Throwable {
                    String n=m.getName();
                    if(n.equals("execute")) {
                        String sql=(String)a[0];executions++;
                        if(sql.equals("select FAIL")) throw new SQLException("second statement failed");
                        if(!sql.startsWith("select ")) return false;
                        String prefix=sql.substring(7);
                        query=new QueryHandle(new String[]{prefix+"1",prefix+"2",prefix+"3",prefix+"4",prefix+"5"});
                        if(prefix.equals("SHORT")) query=new QueryHandle(new String[]{"SHORT1"});
                        if(prefix.equals("FAIL_PAGE")) query.failAt=1;
                        queries.put(sql,query);return true;
                    }
                    if(n.equals("executeQuery")) return proxy(ResultSet.class);
                    if(n.equals("getResultSet")) return query.rows;
                    if(n.equals("close") && query!=null) {query.statementClosed=true;query.rowsClosed=true;return null;}
                    return defaultValue(m);
                }
            });
            return defaultValue(m);
        }
    }
    static Object cursorSession(QueryFixture fixture) throws Exception {
        Class<?> c=Class.forName("NcDbBridge$Session");Constructor<?> ctor=c.getDeclaredConstructor(String.class);ctor.setAccessible(true);
        Object s=ctor.newInstance("cursors");Field conn=c.getDeclaredField("conn");conn.setAccessible(true);conn.set(s,fixture.connection());return s;
    }
    static void independentCursorContracts() throws Exception {
        auto=true;failReadOnly=false;
        QueryFixture fixture=new QueryFixture();Object s=cursorSession(fixture);
        check(runResult(s,"select LEGACY",1,false,"").contains("LEGACY1"),"empty result ID keeps legacy exec");
        check(runResult(s,"select A",2,true,"a").contains("A2"),"first result has its own first page");
        check(runResult(s,"select B",1,false,"b").contains("B1"),"second result starts independently");
        Field pool=s.getClass().getDeclaredField("resultCursors");pool.setAccessible(true);
        Map<?,?> states=(Map<?,?>)pool.get(s);
        Field full=states.get("a").getClass().getDeclaredField("fullLob");full.setAccessible(true);
        check(full.getBoolean(states.get("a")) && !full.getBoolean(states.get("b")),"LOB modes belong to each result");
        check(nextResult(s,1,"").contains("LEGACY2"),"named execution preserves legacy pagination");
        try {runResult(s,"select FAIL",1,false,"bad");throw new AssertionError("SQL failure expected");}catch(SQLException expected){}
        check(nextResult(s,2,"a").contains("A3"),"second query failure preserves first result");
        cursorError(s,"missing","cursor-closed");
        check(nextResult(s,2,"b").contains("B2"),"wrong ID never consumes a different result");
        runResult(s,"select FAIL_PAGE",1,false,"fetch-error");
        try {nextResult(s,1,"fetch-error");throw new AssertionError("fetch failure expected");}catch(SQLException expected){}
        QueryHandle failed=fixture.queries.get("select FAIL_PAGE");
        check(failed.rowsClosed && failed.statementClosed,"failed pagination releases its resources");
        cursorError(s,"fetch-error","cursor-closed");
        check(nextResult(s,2,"a").contains("A5"),"other result survives a fetch error");
        QueryHandle a=fixture.queries.get("select A");
        check(a.rowsClosed && a.statementClosed,"EOF releases result and statement");
        cursorError(s,"a","cursor-closed");
        check((Boolean)call(s,"closeResult",new Class<?>[]{String.class},"b"),"explicit close releases selected result");
        check(!(Boolean)call(s,"closeResult",new Class<?>[]{String.class},"b"),"explicit close is idempotent");
        check(nextResult(s,1,"").contains("LEGACY3"),"named close leaves legacy result untouched");
        runResult(s,"select SHORT",1,false,"short");
        check(nextResult(s,1,"short").contains("\"hasMore\":false"),"exact page boundary detects EOF on next page");
        check(fixture.queries.get("select SHORT").statementClosed,"exact boundary eventually releases statement");
        runResult(s,"select ORIGINAL",1,false,"replace");QueryHandle original=fixture.queries.get("select ORIGINAL");
        runResult(s,"select REPLACEMENT",1,false,"replace");
        check(original.rowsClosed && original.statementClosed,"same result ID replaces only its own old cursor");
        check(nextResult(s,1,"replace").contains("REPLACEMENT2"),"replacement has a fresh position");
        call(s,"applySchema",new Class<?>[]{String.class},"AIER633");
        check(states.isEmpty() && fixture.queries.get("select REPLACEMENT").statementClosed,"schema change releases all named results");
        check(fixture.queries.get("select LEGACY").statementClosed,"schema change releases legacy result");
        runResult(s,"select READONLY",1,false,"ro");
        call(s,"setReadOnly",new Class<?>[]{boolean.class},false);
        check(nextResult(s,1,"ro").contains("READONLY2"),"unchanged read-only mode keeps result alive");
        call(s,"setReadOnly",new Class<?>[]{boolean.class},true);
        check(states.isEmpty() && fixture.queries.get("select READONLY").statementClosed,"read-only change releases named results");
        java.io.ByteArrayOutputStream wire=new java.io.ByteArrayOutputStream();
        Field output=Class.forName("NcDbBridge").getDeclaredField("out");output.setAccessible(true);output.set(null,new java.io.PrintStream(wire));
        Class<?>[] dispatchTypes=new Class<?>[]{String.class,String.class,List.class};
        call(s,"dispatch",dispatchTypes,"wire-exec","exec",Arrays.asList("select WIRE","1","30","0","wire"));
        check(wire.toString("UTF-8").contains("WIRE1") && states.containsKey("wire"),"exec fifth argument selects a named result");
        wire.reset();
        call(s,"dispatch",dispatchTypes,"wire-more","more",Arrays.asList("1","wire"));
        check(wire.toString("UTF-8").contains("WIRE2"),"more second argument resumes the named result");
        wire.reset();
        call(s,"dispatch",dispatchTypes,"wire-close","closeResult",Arrays.asList("wire"));
        check(wire.toString("UTF-8").contains("\"closed\":true") && !states.containsKey("wire"),"closeResult protocol releases only its ID");
        Field commands=Class.forName("NcDbBridge").getDeclaredField("CMDS");commands.setAccessible(true);
        check(((Set<?>)commands.get(null)).contains("closeResult"),"new command is recognized by protocol parser");
        wire.reset();
        Method submit=s.getClass().getDeclaredMethod("submit",String.class,String.class,List.class);submit.setAccessible(true);
        submit.invoke(s,"wire-error","more",Arrays.asList("1","wire"));
        long deadline=System.currentTimeMillis()+2000;
        while(!wire.toString("UTF-8").contains("cursor-closed") && System.currentTimeMillis()<deadline) Thread.sleep(10);
        check(wire.toString("UTF-8").contains("cursor-closed"),"session worker preserves the cursor-specific error code");
        runResult(s,"select DISCONNECTED",1,false,"dc");fixture.closed=true;
        try {nextResult(s,1,"dc");throw new AssertionError("closed connection must fail");}catch(SQLException expected){}
        check(states.isEmpty() && fixture.queries.get("select DISCONNECTED").statementClosed,"connection invalidation releases named results");
        call(s,"closeQuietly",new Class<?>[]{});

        auto=true;QueryFixture limit=new QueryFixture();Object bounded=cursorSession(limit);
        for(int i=0;i<32;i++) runResult(bounded,"select Q"+i,1,false,"q"+i);
        int before=limit.executions;
        try {runResult(bounded,"select OVERFLOW",1,false,"overflow");throw new AssertionError("cursor cap expected");}
        catch(SQLException expected){Field code=expected.getClass().getDeclaredField("code");code.setAccessible(true);check("cursor-limit".equals(code.get(expected)),"limit has an explicit protocol code");}
        check(limit.executions==before,"cursor overflow rejects before SQL executes");
        check(nextResult(bounded,1,"q0").contains("Q02"),"cursor limit does not evict an existing result");
        runResult(bounded,"select REUSED",1,false,"q31");
        check(limit.queries.get("select Q31").statementClosed,"existing ID can be replaced at capacity");
        call(bounded,"closeResult",new Class<?>[]{String.class},"q1");
        runResult(bounded,"select AVAILABLE",1,false,"available");
        runResult(bounded,"select OLD_API",1,false,"");
        check(nextResult(bounded,1,"").contains("OLD_API2"),"legacy slot remains available at named capacity");
        call(bounded,"closeQuietly",new Class<?>[]{});
        for(QueryHandle query:limit.queries.values()) check(query.rowsClosed && query.statementClosed,"session close releases every result");
    }
    public static void main(String[] args) throws Exception {
        Class<?> c=Class.forName("NcDbBridge$Session");Constructor<?> ctor=c.getDeclaredConstructor(String.class);ctor.setAccessible(true);Object s=ctor.newInstance("contract");
        Field conn=c.getDeclaredField("conn");conn.setAccessible(true);conn.set(s,proxy(Connection.class));
        java.io.ByteArrayOutputStream reply = new java.io.ByteArrayOutputStream();
        Field out = Class.forName("NcDbBridge").getDeclaredField("out");
        out.setAccessible(true);
        out.set(null, new java.io.PrintStream(reply));
        Method dispatch=c.getDeclaredMethod("dispatch",String.class,String.class,List.class);dispatch.setAccessible(true);
        dispatch.invoke(s,"probe-test","probe",Collections.emptyList());
        check(probes==1 && auto && reply.toString("UTF-8").contains("\"alive\":true"),
                "probe does one network query and preserves the transaction mode");
        Method ro=c.getDeclaredMethod("setReadOnly",boolean.class);ro.setAccessible(true);
        ro.invoke(s,true);check(!auto && readonlyStatements==1,"Oracle transaction protects reads");
        ro.invoke(s,true);check(readonlyStatements==1,"same transaction is reused");
        Method reset=c.getDeclaredMethod("resetTx");reset.setAccessible(true);reset.invoke(s);ro.invoke(s,true);check(readonlyStatements==2,"transaction boundary reapplies protection");
        ro.invoke(s,false);check(auto,"original autocommit restored");
        Field writes=c.getDeclaredField("txStatements");writes.setAccessible(true);writes.set(s,1);
        try {ro.invoke(s,true);throw new AssertionError("pending writes must reject toggle");}catch(InvocationTargetException expected){check(expected.getCause() instanceof SQLException,"pending writes error");}
        writes.set(s,0);
        Method exec=c.getDeclaredMethod("execParams",String.class,int.class,int.class,List.class);exec.setAccessible(true);
        String number="12345678901234567890123456789012345678", text="x' or 1=1 --";
        exec.invoke(s,"update T set CODE=:1, AMOUNT=:2 where ID=:3",1,30,Arrays.asList("string",text,"number",number,"null",""));
        check(executed.equals("update T set CODE=?, AMOUNT=? where ID=?"),"values are never concatenated");
        check(text.equals(bound.get(1)),"quoted text stays bound");check(new BigDecimal(number).equals(bound.get(2)),"38 digit precision preserved");check(bound.containsKey(3) && bound.get(3)==null,"NULL bound separately");
          exec.invoke(s,"update T set CODE=:1",1,30,Arrays.asList("string",text));
          check(statQueries == 0,"ordinary queries do not collect optional statistics");
          Method profiled=c.getDeclaredMethod("execParams",String.class,int.class,int.class,List.class,boolean.class);profiled.setAccessible(true);
          profiled.invoke(s,"update T set CODE=:1",1,30,Arrays.asList("string",text),true);
          profiled.invoke(s,"update T set CODE=:1",1,30,Arrays.asList("string",text),true);
          check(statQueries == 1,"unavailable statistics are probed once per connection, not twice per query");
          check(fetchSize==2,"single-row operations keep bounded lookahead fetches");
        failReadOnly=true;
        try {ro.invoke(s,true);throw new AssertionError("unverified read-only must fail");}catch(InvocationTargetException expected){check(expected.getCause() instanceof SQLException,"unsupported server rejected");}
        // 默认 schema：名字是标识符、绑不进绑定变量，只能拼串 —— 所以拼之前必须卡字符集，
        // 空串必须回落到登录账号，大小写必须归一（Oracle 不带引号的标识符一律大写）。
        Method apply=c.getDeclaredMethod("applySchema",String.class);apply.setAccessible(true);
        apply.invoke(s,"aier633");
        check("alter session set current_schema = AIER633".equals(schemaSql),"schema is upper-cased and concatenated once");
        schemaSql="";
        apply.invoke(s,"");
        check("alter session set current_schema = AIER633".equals(schemaSql),"empty schema falls back to the login account");
        schemaSql="";
        try {apply.invoke(s,"x; drop table t");throw new AssertionError("bad schema must be rejected");}
        catch(InvocationTargetException expected){check(expected.getCause() instanceof SQLException,"identifier injection rejected");}
        check(schemaSql.isEmpty(),"rejected schema never reaches the database");
        Method ddl=c.getDeclaredMethod("ddl",String.class,String.class);ddl.setAccessible(true);
        ddl.invoke(s,"idx_t","INDEX");
        check(executed.contains("get_ddl('INDEX', ?)"),"index DDL uses the INDEX type, not the TABLE fallback");
        check("IDX_T".equals(bound.get(1)),"index name remains a bound value");
        independentCursorContracts();
        System.out.println("JDBC contracts passed: parameters, precision, NULL, read-only, schema, independent result cursors, paging failure, cursor limits and cleanup.");
    }
}
