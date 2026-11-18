//! XLSX 里的日期：Excel 把它存成「1900 基准的天数」，只有 numFmt 才知道那是日期。
//!
//! **为什么必须自己判**：`xlsx_read` 原来一律给文本（这是对的——不给文本就会被
//! 「18 位单据号变成 f64」这种事坑），但日期同样落在数值通道里，原样给出去就是
//! `45900` 这种天数序列。用户拿到一列 `45900` 只能自己回 Excel 把列设成文本再导一遍。
//!
//! 判定分两步：先看单元格样式里的 `numFmtId` 是不是日期格式（[`date_kind`]），
//! 是的话再把序列号换成 `YYYY-MM-DD HH24:MI:SS`（[`serial_text`]）。
//!
//! 两条**故意保守**的口径：
//! - 认不出的格式一律返回 `None`，让调用方保留原数字。猜错一次就是整列脏数据，
//!   而给原值用户至少看得见 `45900` 并知道要回去改。
//! - 序列号 60（Excel 那个不存在的 1900-02-29）也返回 `None`。它没有正确的映射。

/// 单元格的日期类型，决定输出成纯日期还是带时间。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateKind {
    Date,
    DateTime,
    Time,
}

/// 内置 `numFmtId` → 代表格式串。只列日期时间相关的，其余（货币/百分比/文本/
/// 东亚洲年号等）返回 `None`：那些 id 的具体样式各区域实现不一，猜它不如给原数字。
pub fn builtin_fmt(id: u32) -> Option<&'static str> {
    Some(match id {
        14 => "m/d/yyyy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        _ => return None,
    })
}

/// 格式串 → 日期类型。`None` 表示「不是日期」。
///
/// 清洗规则：`"…"` 引号里的字面量、`\x` 转义、`_x` 占位、`*x` 填充、`[…]`
/// （颜色 / 条件 / 区域码 / 累计时长）全部先剔掉，只看剩下的格式码。
/// 这条对中文格式是必须的：`[$-804]yyyy"年"m"月"d"日"` 里既有区域码又有「年」字，
/// 不先剔掉就永远判不对。
pub fn date_kind(fmt: &str) -> Option<DateKind> {
    let mut clean = String::with_capacity(fmt.len());
    let mut it = fmt.chars();
    while let Some(c) = it.next() {
        match c {
            '"' => {
                for k in it.by_ref() {
                    if k == '"' {
                        break;
                    }
                }
            }
            '\\' | '_' | '*' => {
                it.next();
            }
            '[' => {
                for k in it.by_ref() {
                    if k == ']' {
                        break;
                    }
                }
            }
            _ => clean.push(c.to_ascii_lowercase()),
        }
    }
    let has = |c: char| clean.contains(c);
    // 只认 y / d 为日期、h / s 为时间。单靠 `m` 判不了（月份还是分钟取决于上下文），
    // 那种格式宁可当数字。
    match (has('y') || has('d'), has('h') || has('s')) {
        (true, true) => Some(DateKind::DateTime),
        (true, false) => Some(DateKind::Date),
        (false, true) => Some(DateKind::Time),
        (false, false) => None,
    }
}

/// 1899-12-30 距 1970-01-01 的天数（Excel 序列号的基准，含 1900 闰年补偿）。
const SERIAL_EPOCH: i64 = 25_569;
/// 9999-12-31 的序列号，再大就是坏数据。
const MAX_SERIAL: f64 = 2_958_465.0;

/// 序列号 → 文本。`None` = 这个值不该被当成日期。
pub fn serial_text(serial: f64, kind: DateKind) -> Option<String> {
    if !serial.is_finite() || !(0.0..=MAX_SERIAL).contains(&serial) {
        return None;
    }
    let base = serial.floor();
    let mut days = base as i64;
    let mut secs = (serial.fract() * 86_400.0).round() as i64;
    // 0.9999999 会四舍五入成整整一天：进位到次日，而不是给出 24:00:00
    if secs >= 86_400 {
        secs -= 86_400;
        days += 1;
    }
    let hms = || {
        format!(
            "{:02}:{:02}:{:02}",
            secs / 3600,
            secs % 3600 / 60,
            secs % 60
        )
    };

    if kind == DateKind::Time {
        // 累计时长（`[h]`，序列号 ≥ 1）没法写成 DATE，给原值让用户自己判断
        if base >= 1.0 {
            return None;
        }
        return Some(hms());
    }

    // 1900 闰年补偿：Excel 认为 1900-02-29 存在（serial 60），所以
    // ≤59 要用 1899-12-31 作基准，≥61 才是 1899-12-30。漏了这一步，2020 年以前的
    // 日期全部偏一天——而且是那种「看起来对」的错。
    let offset = if serial >= 61.0 {
        days - SERIAL_EPOCH
    } else if serial < 60.0 {
        days + 1 - SERIAL_EPOCH
    } else {
        return None;
    };
    let (y, m, d) = civil_from_days(offset);
    if kind == DateKind::Date && secs == 0 {
        return Some(format!("{y:04}-{m:02}-{d:02}"));
    }
    Some(format!("{y:04}-{m:02}-{d:02} {}", hms()))
}

/// 1970-01-01 起的天数 → (年, 月, 日)。Howard Hinnant 的 `civil_from_days`。
///
/// 不引 chrono：整条链路只需要这一次换算，为一列日期多一个依赖不值。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (y + i64::from(m <= 2), m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认常见日期格式() {
        assert_eq!(date_kind("yyyy-mm-dd"), Some(DateKind::Date));
        assert_eq!(date_kind("yyyy/m/d"), Some(DateKind::Date));
        assert_eq!(date_kind("yyyy-mm-dd hh:mm:ss"), Some(DateKind::DateTime));
        assert_eq!(date_kind("m/d/yy h:mm"), Some(DateKind::DateTime));
        assert_eq!(date_kind("hh:mm:ss"), Some(DateKind::Time));
        assert_eq!(date_kind("[h]:mm:ss"), Some(DateKind::Time));
    }

    #[test]
    fn 中文区域码与字面量不影响判定() {
        // [$-804] 是区域码，「年」「月」「日」是引号里的字面量，都不该参与判定
        assert_eq!(
            date_kind(r#"[$-804]yyyy"年"m"月"d"日""#),
            Some(DateKind::Date)
        );
        assert_eq!(date_kind(r#"h"时"mm"分"ss"秒""#), Some(DateKind::Time));
        // 引号里的 m 是「米」，不是月份
        assert_eq!(date_kind(r#"0.00"m""#), None);
    }

    #[test]
    fn 非日期格式一律不认() {
        for fmt in ["General", "@", "#,##0.00", "0%", "[Red]0.00", "0.00E+00"] {
            assert_eq!(date_kind(fmt), None, "{fmt}");
        }
    }

    #[test]
    fn 内置编号只认日期时间那一批() {
        assert_eq!(builtin_fmt(14), Some("m/d/yyyy"));
        assert_eq!(builtin_fmt(22), Some("m/d/yy h:mm"));
        assert_eq!(builtin_fmt(46), Some("[h]:mm:ss"));
        // 0 = General，49 = 文本，这些不能当日期
        assert_eq!(builtin_fmt(0), None);
        assert_eq!(builtin_fmt(49), None);
        assert_eq!(builtin_fmt(164), None);
    }

    #[test]
    fn 序列号边界与1900闰年补偿() {
        // Excel 的四个锚点：1 = 1900-01-01，59 = 02-28，60 不存在，61 = 03-01
        assert_eq!(
            serial_text(1.0, DateKind::Date).as_deref(),
            Some("1900-01-01")
        );
        assert_eq!(
            serial_text(59.0, DateKind::Date).as_deref(),
            Some("1900-02-28")
        );
        assert_eq!(serial_text(60.0, DateKind::Date), None);
        assert_eq!(
            serial_text(61.0, DateKind::Date).as_deref(),
            Some("1900-03-01")
        );
        // 现代日期：1970-01-01 与 2000-01-01 是 Excel 界的标准值
        assert_eq!(
            serial_text(25_569.0, DateKind::Date).as_deref(),
            Some("1970-01-01")
        );
        assert_eq!(
            serial_text(36_526.0, DateKind::Date).as_deref(),
            Some("2000-01-01")
        );
    }

    #[test]
    fn 时间部分与进位() {
        assert_eq!(
            serial_text(25_569.25, DateKind::DateTime).as_deref(),
            Some("1970-01-01 06:00:00")
        );
        // 纯日期格式但真的存了时间：不能悄悄丢掉
        assert_eq!(
            serial_text(25_569.5, DateKind::Date).as_deref(),
            Some("1970-01-01 12:00:00")
        );
        // 0.9999999 四舍五入到 86400 秒 → 进位到次日，而不是 24:00:00
        assert_eq!(
            serial_text(25_570.0 - 1e-9, DateKind::Date).as_deref(),
            Some("1970-01-02")
        );
    }

    #[test]
    fn 纯时间与累计时长() {
        assert_eq!(
            serial_text(0.5, DateKind::Time).as_deref(),
            Some("12:00:00")
        );
        // [h]:mm:ss 的序列号 ≥ 1 表示超过一天，写成 DATE 会错，给原值
        assert_eq!(serial_text(1.5, DateKind::Time), None);
    }

    #[test]
    fn 越界值不当日期() {
        assert_eq!(serial_text(-1.0, DateKind::Date), None);
        assert_eq!(serial_text(f64::INFINITY, DateKind::Date), None);
        assert_eq!(serial_text(3_000_000.0, DateKind::Date), None);
    }

    #[test]
    fn 天数换年月日() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-25_569), (1899, 12, 30));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
