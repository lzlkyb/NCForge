import java.io.BufferedReader;
import java.io.FileReader;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 只扫 jar 的中央目录（条目名），不读 class 内容 —— 用来验证「按包名精选 jar」的代价。
 *
 * 判据：如果 4367 个 jar 的条目扫描能在 10 秒内完成，那么「先扫包、再只解析命中的 jar」
 * 就是可行的；否则 jar 侧索引整体不划算。
 */
public final class EntryScanProbe {
    public static void main(String[] args) throws Exception {
        final List<Path> jars = new ArrayList<Path>();
        BufferedReader r = new BufferedReader(new FileReader(args[0]));
        for (String line; (line = r.readLine()) != null; ) {
            if (!line.trim().isEmpty()) jars.add(Paths.get(line.trim()));
        }
        r.close();
        final int threads = args.length > 1 ? Integer.parseInt(args[1]) : 8;

        final ConcurrentHashMap<String, AtomicLong> pkgCount = new ConcurrentHashMap<String, AtomicLong>();
        final AtomicLong entries = new AtomicLong();
        final AtomicLong bytes = new AtomicLong();

        long t0 = System.nanoTime();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        List<Future<?>> fs = new ArrayList<Future<?>>();
        for (int i = 0; i < threads; i++) {
            final int stride = threads;
            final int offset = i;
            fs.add(pool.submit(new java.util.concurrent.Callable<Void>() {
                @Override
                public Void call() {
                    for (int k = offset; k < jars.size(); k += stride) {
                        Path jar = jars.get(k);
                        ZipFile zf = null;
                        try {
                            zf = new ZipFile(jar.toFile());
                            Enumeration<? extends ZipEntry> en = zf.entries();
                            while (en.hasMoreElements()) {
                                ZipEntry e = en.nextElement();
                                String n = e.getName();
                                if (!n.endsWith(".class")) continue;
                                entries.incrementAndGet();
                                int slash = n.lastIndexOf('/');
                                String pkg = slash < 0 ? "" : n.substring(0, slash);
                                AtomicLong c = pkgCount.get(pkg);
                                if (c == null) {
                                    c = new AtomicLong();
                                    AtomicLong old = pkgCount.putIfAbsent(pkg, c);
                                    if (old != null) c = old;
                                }
                                c.incrementAndGet();
                            }
                        } catch (Throwable t) {
                            // 坏 jar 跳过：与索引器一致
                        } finally {
                            if (zf != null) try { zf.close(); } catch (Exception ignored) {}
                        }
                    }
                    return null;
                }
            }));
        }
        for (Future<?> f : fs) f.get();
        pool.shutdown();
        long ms = (System.nanoTime() - t0) / 1000000L;

        System.out.println("jar 数      = " + jars.size());
        System.out.println("class 条目  = " + entries.get());
        System.out.println("不同包数    = " + pkgCount.size());
        System.out.println("扫描耗时    = " + ms + " ms");
    }
}
