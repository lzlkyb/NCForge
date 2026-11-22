import org.eclipse.jdt.internal.compiler.batch.FileSystem;
import org.eclipse.jdt.internal.compiler.env.NameEnvironmentAnswer;

public class FsProbe {
    public static void main(String[] args) throws Exception {
        FileSystem fs = new FileSystem(new String[0], args, "GBK");
        String[] names = {
            "nc.bs.ct.aier.daily.BaseSignCtDaily",
            "nc.bs.ct.aier.daily.AierPrintCtDailyBO",
            "nc.itf.ct.aier.service.IAierApiDailyService",
            "java.lang.Object",
        };
        for (String n : names) {
            char[][] cn = new char[n.split("\\.").length][];
            String[] parts = n.split("\\.");
            for (int i = 0; i < parts.length; i++) cn[i] = parts[i].toCharArray();
            NameEnvironmentAnswer ans = fs.findType(cn);
            System.out.println(n + " => " + (ans == null ? "NULL"
                    : (ans.isCompilationUnit() ? "CU:" + new String(ans.getCompilationUnit().getFileName())
                            : ans.isBinaryType() ? "BINARY:" + new String(ans.getBinaryType().getName())
                                    : "other")));
        }
    }
}
