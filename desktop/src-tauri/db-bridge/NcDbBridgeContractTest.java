import java.lang.reflect.*;
import java.sql.*;
import java.util.*;
import java.math.BigDecimal;

/** Offline JDBC contract test: no driver, credentials or real database are involved. */
public class NcDbBridgeContractTest {
    static boolean auto=true, failReadOnly=false;
    static int readonlyStatements=0;
    static String executed="";
    static Map<Integer,Object> bound=new HashMap<Integer,Object>();
    static Object proxy(final Class<?> type) {
        return Proxy.newProxyInstance(type.getClassLoader(),new Class<?>[]{type},new InvocationHandler() {
            public Object invoke(Object p,Method m,Object[] a) throws Throwable {
                String n=m.getName();
                if (n.equals("getAutoCommit")) return auto;
                if (n.equals("setAutoCommit")) {auto=(Boolean)a[0];return null;}
                if (n.equals("createStatement")) return proxy(Statement.class);
                if (n.equals("prepareStatement")) {executed=(String)a[0];return proxy(PreparedStatement.class);}
                if (n.equals("prepareCall")) return proxy(CallableStatement.class);
                if (n.equals("executeQuery")) return proxy(ResultSet.class);
                if (n.equals("execute")) {
                    if (a!=null && a.length>0 && String.valueOf(a[0]).equals("set transaction read only")) {
                        if(failReadOnly) throw new SQLException("read-only not supported");
                        readonlyStatements++;
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
        System.out.println("JDBC contracts passed: parameters, precision, NULL, pending writes, transaction restart, unsupported read-only.");
    }
}
