use std::collections::VecDeque;

use crate::core::{LatLon, distance_m};

use crate::env::metocean::MetOcean;

#[derive(Debug, Clone)]
pub struct SampleCache {
    max_len: usize,
    samples: VecDeque<MetOcean>,
}

impl SampleCache {
    pub fn new(max_len: usize) -> Self {
        Self {
            max_len: max_len.max(1),
            samples: VecDeque::new(),
        }
    }

    pub fn push(&mut self, sample: MetOcean) {
        if self.samples.len() >= self.max_len {
            self.samples.pop_front();
        }
        self.samples.push_back(sample);
    }

    pub fn nearest(&self, pos: LatLon, max_distance_m: f64) -> Option<&MetOcean> {
        self.samples
            .iter()
            .filter_map(|sample| {
                let d = distance_m(sample.pos, pos);
                (d <= max_distance_m).then_some((d, sample))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, sample)| sample)
    }
}
