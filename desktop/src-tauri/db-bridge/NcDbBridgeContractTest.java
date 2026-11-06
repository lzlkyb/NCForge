import java.lang.reflect.*;
import java.sql.*;
import java.util.*;
import java.math.BigDecimal;

/** Offline JDBC contract test: no driver, credentials or real database are involved. */
public class NcDbBridgeContractTest {
    static boolean auto=true, failReadOnly=false;
    static int readonlyStatements=0;
    static int probes=0;
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
                // 默认 schema 契约要读登录账号名（空串 = 切回它）
                if (n.equals("getMetaData")) return proxy(DatabaseMetaData.class);
                if (n.equals("getUserName")) return "AIER633";
                if (n.equals("getDatabaseProductName")) return "Oracle";
                if (n.equals("getDatabaseProductVersion")) return "19.0.0";
                if (n.equals("prepareStatement")) {executed=(String)a[0];return proxy(PreparedStatement.class);}
                if (n.equals("prepareCall")) return proxy(CallableStatement.class);
                if (n.equals("executeQuery")) {
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
        System.out.println("JDBC contracts passed: parameters, precision, NULL, pending writes, transaction restart, unsupported read-only, default schema.");
    }
}
