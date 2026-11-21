// jar 侧声明索引探针（一次性，不进产品）
//
// 测：1162 个 jar 里的 .class 全部抽出「类型 + 方法 + 字段」签名要多久。
// 与 jdt.ls 的区别：不做语义解析、不建继承图、不合并同名类型，只读 class 文件的常量池与签名。
//
// 跑法：
//   java -cp out;<jdt.core> JarProbe jars.txt 8

import org.eclipse.jdt.internal.compiler.classfmt.ClassFileReader;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public final class JarProbe {

    static final AtomicLong classes = new AtomicLong();
    static final AtomicLong methods = new AtomicLong();
    static final AtomicLong fields = new AtomicLong();
    static final AtomicLong bytes = new AtomicLong();
    static final AtomicLong badJars = new AtomicLong();
    static final AtomicLong badClasses = new AtomicLong();
    static final List<String> samples = Collections.synchronizedList(new ArrayList<String>());

    public static void main(String[] args) throws Exception {
        Path listFile = Paths.get(args[0]);
        int threads = args.length > 1 ? Integer.parseInt(args[1]) : Runtime.getRuntime().availableProcessors();
        final List<String> jars = new ArrayList<String>();
        for (String line : Files.readAllLines(listFile)) {
            line = line.trim();
            if (!line.isEmpty()) jars.add(line);
        }
        System.out.println("jars=" + jars.size() + " threads=" + threads);

        final int n = jars.size();
        final AtomicLong cursor = new AtomicLong();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        long t0 = System.nanoTime();
        List<Future<Long>> tasks = new ArrayList<Future<Long>>(threads);
        for (int i = 0; i < threads; i++) {
            tasks.add(pool.submit(new Callable<Long>() {
                @Override
                public Long call() {
                    long wall = 0L;
                    while (true) {
                        int idx = (int) cursor.getAndIncrement();
                        if (idx >= n) break;
                        long a = System.nanoTime();
                        oneJar(jars.get(idx));
                        wall += System.nanoTime() - a;
                    }
                    return Long.valueOf(wall);
                }
            }));
        }
        long cpuSum = 0L;
        for (Future<Long> f : tasks) cpuSum += f.get().longValue();
        pool.shutdown();
        long wallMs = (System.nanoTime() - t0) / 1000000L;

        System.out.println("---- 结果 ----");
        System.out.println("jar 索引 wall   = " + wallMs + "ms");
        System.out.println("cpu 累加        = " + (cpuSum / 1000000L) + "ms  (并行度 "
                + String.format("%.2f", wallMs == 0 ? 0 : (cpuSum / 1000000.0) / wallMs) + "x)");
        System.out.println("class 数        = " + classes.get());
        System.out.println("bytes           = " + (bytes.get() / 1024 / 1024) + " MB (解压后)");
        System.out.println("methods         = " + methods.get());
        System.out.println("fields          = " + fields.get());
        System.out.println("坏 jar          = " + badJars.get() + "  解析失败 class = " + badClasses.get());
        for (String s : samples) System.out.println("  > " + s);
        if (wallMs > 0) {
            System.out.println("class 吞吐      = " + (classes.get() * 1000L / wallMs) + " class/s");
        }
    }

    static void oneJar(String path) {
        ZipFile zf = null;
        try {
            zf = new ZipFile(path);
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String name = e.getName();
                if (!name.endsWith(".class") || e.isDirectory()) continue;
                if (name.startsWith("META-INF/")) continue;   // module-info / 版本号副本
                byte[] raw;
                try {
                    raw = readAll(zf.getInputStream(e));
                } catch (Exception ex) {
                    badClasses.incrementAndGet();
                    continue;
                }
                bytes.addAndGet(raw.length);
                try {
                    ClassFileReader r = ClassFileReader.read(new java.io.ByteArrayInputStream(raw), name);
                    if (r == null) {
                        badClasses.incrementAndGet();
                        continue;
                    }
                    classes.incrementAndGet();
                    org.eclipse.jdt.internal.compiler.env.IBinaryMethod[] ms = r.getMethods();
                    if (ms != null) methods.addAndGet(ms.length);
                    org.eclipse.jdt.internal.compiler.env.IBinaryField[] fs = r.getFields();
                    if (fs != null) fields.addAndGet(fs.length);
                } catch (Throwable t) {
                    badClasses.incrementAndGet();
                    if (samples.size() < 8) samples.add(name + " : " + t);
                }
            }
        } catch (Throwable t) {
            badJars.incrementAndGet();
            if (samples.size() < 8) samples.add(path + " : " + t);
        } finally {
            if (zf != null) {
                try {
                    zf.close();
                } catch (Exception ignore) {
                }
            }
        }
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[8192];
        int k;
        while ((k = in.read(buf)) > 0) bos.write(buf, 0, k);
        in.close();
        return bos.toByteArray();
    }
}
