pub fn seconds_to_millis_i64(seconds: f64) -> i64 {
    (seconds * 1000.0).round() as i64
}
