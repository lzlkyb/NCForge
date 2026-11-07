//! 生成链性能基线（手动跑，不参与默认测试）。
//!
//! 目的：在写生成中心之前先拿到真实数字，避免「UI 做完才发现架构慢」。
//! 计时分三段：读文件 + 解析、规则校验、现有生成（DDL/VO/注册清单）。
//!
//! 跑法（在 desktop/ 下）：
//! ```text
//! node scripts/rust-gate.mjs test --release --test bmf_gen_perf -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 真实语料默认取 `D:\ncc\1909home\modules`，可用 `NC_HOME` 覆盖；目录不存在时
//! 只跑合成大样本并明确标注「未采到真实语料」，不把环境缺失算成通过。
//!
//! release 数字才有意义。debug 下只验证能找到文件、能跑通，不对外承诺耗时。

use std::path::{Path, PathBuf};
use std::time::Instant;

use nc_forge::bmf_gen;
use nc_forge::bmf_gen_plan;
use nc_forge::bmf_gen_types::GenProfile;
use nc_forge::bmf_index;
use nc_forge::bmf_model::BmfDoc;
use nc_forge::bmf_rules;

const REAL_SAMPLE_TARGET: usize = 20;
const ROUNDS: usize = 5;

/// 性能预算的唯一来源：`benchmarks/bmf-gen-budget.json`。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Budget {
    open_center_ms: f64,
    generate_p95_ms: f64,
    pathological_max_ms: f64,
    /// §12.2：任何阶段不得出现无反馈等待超过 1 秒（病态语料也适用）。
    pathological_feedback_ms: f64,
}

fn budget() -> Budget {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../benchmarks/bmf-gen-budget.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到性能预算 {}：{e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("性能预算不是合法 JSON：{e}"))
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    read_parse_ms: f64,
    check_ms: f64,
    gen_ms: f64,
    /// 生成中心新链路：只读 `BmfDoc`，一次产出全部产物（不含规则校验）。
    plan_ms: f64,
    artifacts: usize,
}

impl Sample {
    fn total(&self) -> f64 {
        self.read_parse_ms + self.check_ms + self.gen_ms
    }

    /// 生成中心端到端：读+解析 + 规则校验 + 产物图/渲染。
    /// UI 里校验与产物图并行，这里按串行相加计，口径偏保守。
    fn center(&self) -> f64 {
        self.read_parse_ms + self.check_ms + self.plan_ms
    }
}

#[test]
#[ignore = "性能基线：手动 release 运行，避免拖慢普通门禁"]
fn measure_generation_pipeline() {
    let release = !cfg!(debug_assertions);
    println!(
        "\n[perf] 模式 = {}；预算按 release 口径（典型 P95 ≤ 800ms 打开 / ≤ 3s 生成）",
        if release {
            "release"
        } else {
            "debug（仅跑通，数字不作承诺）"
        }
    );

    let root = real_root();
    let files = match &root {
        Some(home) => pick_real_samples(home),
        None => Vec::new(),
    };
    if root.is_none() {
        println!("[perf] 未找到 NC_HOME，跳过真实语料；只跑合成大样本");
    } else if files.is_empty() {
        println!("[perf] NC_HOME 下没有扫到 BMF，跳过真实语料");
    } else {
        println!("[perf] 真实语料 {} 个，每个 {} 轮", files.len(), ROUNDS);
    }

    let mut samples = Vec::new();
    for path in &files {
        for _ in 0..ROUNDS {
            match measure_one(path) {
                Ok(s) => samples.push(s),
                Err(e) => println!("[perf] 跳过 {}：{e}", path.display()),
            }
        }
    }
    if !samples.is_empty() {
        report(
            "真实 BMF（读+解析 / 校验 / 旧生成 / 生成中心）",
            &samples,
            release,
        );
    }

    // 病态样本：100 实体 × 50 属性 = 5000 属性。用它验证不存在 O(n²) 爆炸。
    let big = synthetic_large(100, 50);
    let mut big_samples = Vec::new();
    for _ in 0..3 {
        big_samples.push(measure_bytes(
            PathBuf::from("<synthetic-large>.bmf"),
            big.as_bytes(),
        ));
    }
    report("合成大样本 100×50（5000 属性）", &big_samples, release);
    let big_max = big_samples.iter().map(|s| s.center()).fold(0.0, f64::max);
    if release {
        let b = budget();
        assert!(
            big_max <= b.pathological_feedback_ms,
            "病态样本超过 1s 无反馈上限：{big_max:.1}ms > {:.0}ms（多半是又出现 O(n²)）",
            b.pathological_feedback_ms
        );
        assert!(
            big_max <= b.pathological_max_ms,
            "病态样本超过硬上限：{big_max:.1}ms > {:.0}ms",
            b.pathological_max_ms
        );
    }

    // 典型合成样本：主子表 + 枚举，模拟最常见的单据组件。
    let typical = synthetic_typical();
    let mut typical_samples = Vec::new();
    for _ in 0..ROUNDS {
        typical_samples.push(measure_bytes(
            PathBuf::from("<synthetic-typical>.bmf"),
            typical.as_bytes(),
        ));
    }
    let s = report("合成典型主子表", &typical_samples, release);
    if release {
        let b = budget();
        let center: Vec<f64> = typical_samples.iter().map(|s| s.center()).collect();
        let center_p95 = percentile(&center, 0.95);
        let center_max = center.iter().copied().fold(0.0, f64::max);
        assert!(
            center_p95 <= b.open_center_ms,
            "典型样本打开生成中心 P95 超预算：{center_p95:.1}ms > {:.0}ms（阶段：{}）",
            b.open_center_ms,
            phase_line(&s)
        );
        assert!(
            center_p95 <= b.generate_p95_ms,
            "典型样本生成中心 P95 超预算：{center_p95:.1}ms > {:.0}ms（阶段：{}）",
            b.generate_p95_ms,
            phase_line(&s)
        );
        assert!(
            center_max <= b.pathological_max_ms,
            "典型样本生成中心最大值超硬上限：{center_max:.1}ms > {:.0}ms",
            b.pathological_max_ms
        );
        assert!(
            s.total() <= 3_000.0,
            "典型样本旧生成超过 3s 预算：{:.1}ms",
            s.total()
        );
    }
}

fn percentile(values: &[f64], p: f64) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn phase_line(s: &Sample) -> String {
    format!(
        "读+解析={:.2}ms 校验={:.2}ms 旧生成={:.2}ms 新生成={:.2}ms",
        s.read_parse_ms, s.check_ms, s.gen_ms, s.plan_ms
    )
}

fn real_root() -> Option<PathBuf> {
    let root = std::env::var_os("NC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\ncc\1909home"));
    let modules = root.join("modules");
    modules.is_dir().then_some(root)
}

/// 按文件大小均匀抽样：既覆盖小文件，也覆盖几十 KB 的大组件。
fn pick_real_samples(home: &Path) -> Vec<PathBuf> {
    let mut all = bmf_index::list_bmfs(&home.join("modules"));
    all.retain(|p| std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false));
    if all.len() <= REAL_SAMPLE_TARGET {
        return all;
    }
    all.sort_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
    let last = all.len() - 1;
    (0..REAL_SAMPLE_TARGET)
        .map(|i| all[i * last / (REAL_SAMPLE_TARGET - 1)].clone())
        .collect()
}

fn measure_one(path: &Path) -> Result<Sample, String> {
    let ts = Instant::now();
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let read_ms = ts.elapsed().as_secs_f64() * 1000.0;
    Ok(measure_loaded(path, bytes, read_ms))
}

fn measure_bytes(path: PathBuf, bytes: &[u8]) -> Sample {
    measure_loaded(&path, bytes.to_vec(), 0.0)
}

fn measure_loaded(path: &Path, bytes: Vec<u8>, read_ms: f64) -> Sample {
    let ts = Instant::now();
    let doc = BmfDoc::from_bytes(path.to_path_buf(), bytes).expect("性能样本必须可解析");
    let parse_ms = ts.elapsed().as_secs_f64() * 1000.0;

    let ts = Instant::now();
    let _issues = bmf_rules::check_doc(&doc, &path.display().to_string());
    let check_ms = ts.elapsed().as_secs_f64() * 1000.0;

    let ts = Instant::now();
    let _gen = bmf_gen::generate(&doc, &[]);
    let gen_ms = ts.elapsed().as_secs_f64() * 1000.0;

    let profile = GenProfile::from_bmf(&doc);
    let ts = Instant::now();
    let plan = bmf_gen_plan::plan(&doc, &profile, &[]);
    let plan_ms = ts.elapsed().as_secs_f64() * 1000.0;

    Sample {
        read_parse_ms: read_ms + parse_ms,
        check_ms,
        gen_ms,
        plan_ms,
        artifacts: plan.artifacts.len(),
    }
}

fn report(label: &str, samples: &[Sample], release: bool) -> Sample {
    let mut totals: Vec<f64> = samples.iter().map(Sample::total).collect();
    totals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut centers: Vec<f64> = samples.iter().map(Sample::center).collect();
    centers.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |v: &[f64], p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    let avg = |f: fn(&Sample) -> f64| samples.iter().map(f).sum::<f64>() / samples.len() as f64;
    let max = *totals.last().unwrap();
    let center_max = *centers.last().unwrap();
    println!(
        "[perf] {label}: n={} 旧链 P50={:.2}ms P95={:.2}ms max={:.2}ms；\
         生成中心 P50={:.2}ms P95={:.2}ms max={:.2}ms；产物={:.0} 个；\
         均值 读+解析={:.2}ms 校验={:.2}ms 旧生成={:.2}ms 新生成={:.2}ms",
        totals.len(),
        pct(&totals, 0.5),
        pct(&totals, 0.95),
        max,
        pct(&centers, 0.5),
        pct(&centers, 0.95),
        center_max,
        avg(|s| s.artifacts as f64),
        avg(|s| s.read_parse_ms),
        avg(|s| s.check_ms),
        avg(|s| s.gen_ms),
        avg(|s| s.plan_ms),
    );
    if !release {
        println!("[perf] 以上为 debug 数字，不能用于性能承诺");
    }
    Sample {
        read_parse_ms: avg(|s| s.read_parse_ms),
        check_ms: avg(|s| s.check_ms),
        gen_ms: avg(|s| s.gen_ms),
        plan_ms: avg(|s| s.plan_ms),
        artifacts: 0,
    }
}

fn synthetic_typical() -> String {
    let nl = "\n";
    let mut s = String::with_capacity(64 * 1024);
    s.push_str(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<component id="c1" name="perf_bill" displayName="性能单据" namespace="uapbd" ownModule="uapbd" gencodestyle="NC传统样式" version="1" mainEntity="e0">
  <celllist>
"#,
    );
    for e in 0..3 {
        s.push_str(&format!(
            r#"    <entity id="e{e}" name="Perf{e}VO" displayName="实体{e}" fullClassName="nc.vo.uapbd.perf.Perf{e}VO" tableName="perf_t{e}" isPrimary="{}" keyAttributeId="e{e}a0">
      <attributelist>
"#,
            if e == 0 { "true" } else { "false" }
        ));
        for a in 0..30 {
            s.push_str(&format!(
                r#"        <attribute id="e{e}a{a}" name="field{a}" fieldName="field{a}" displayName="字段{a}" typeName="String" dataType="BS000010000100001001" dbtype="varchar2" length="50" sequence="{a}"/>{nl}"#,
            ));
        }
        s.push_str("      </attributelist>\n    </entity>\n");
    }
    s.push_str(
        r#"    <Enumerate id="en1" name="state" displayName="状态" dataType="BS000010000100001001" typeName="String">
      <enumitemlist>
        <enumitem id="i1" enumValue="0" enumDisplay="启用"/>
        <enumitem id="i2" enumValue="1" enumDisplay="停用"/>
      </enumitemlist>
    </Enumerate>
  </celllist>
  <connectlist>
    <AggregationRelation id="r1" source="e0" target="e1"/>
  </connectlist>
</component>
"#,
    );
    s
}

fn synthetic_large(entities: usize, attrs: usize) -> String {
    let nl = "\n";
    let mut s = String::with_capacity(entities * attrs * 160);
    s.push_str(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<component id="c0" name="perf_large" displayName="性能大组件" namespace="uapbd" ownModule="uapbd" version="1" mainEntity="e0">
  <celllist>
"#,
    );
    for e in 0..entities {
        s.push_str(&format!(
            r#"    <entity id="e{e}" name="Large{e}VO" displayName="实体{e}" fullClassName="nc.vo.uapbd.large.Large{e}VO" tableName="large_t{e}" isPrimary="{}" keyAttributeId="e{e}a0">
      <attributelist>
"#,
            if e == 0 { "true" } else { "false" }
        ));
        for a in 0..attrs {
            s.push_str(&format!(
                r#"        <attribute id="e{e}a{a}" name="field{a}" fieldName="field{a}" displayName="字段{a}" typeName="String" dataType="BS000010000100001001" dbtype="varchar2" length="50" sequence="{a}"/>{nl}"#,
            ));
        }
        s.push_str("      </attributelist>\n    </entity>\n");
    }
    s.push_str("  </celllist>\n</component>\n");
    s
}
